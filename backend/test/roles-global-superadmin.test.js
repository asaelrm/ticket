import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createSuperadminClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';

// V2 (aislamiento multiempresa): `roles` y `role_permissions` no tienen
// `organization_id`, de modo que cualquier cambio en la matriz de permisos
// alcanza a las organizaciones de TODAS las empresas. El permiso `role.manage`
// lo tienen los administradores de cada organización, así que por sí solo no
// protege este canal. Estas pruebas fijan que la modificación queda reservada
// al SUPERADMIN global, que los intentos denegados no tocan `role_permissions`
// y que las protecciones preexistentes sobre los roles SUPERADMIN y ADMIN
// siguen en pie.

const ORG_A = 'V2ROL_A';
const ORG_B = 'V2ROL_B';
const pass = (username) => `Org${username}Clave123!`;

let ids = {};
let adminA;
let adminB;
let empB;
let techRole;
let empRole;
let adminRole;
let superRole;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de roles globales');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser(orgId, username, roleCode) {
  const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode).id;
  db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, NULL, 'Puesto de prueba', ?, 1, ?, ?)`
  ).run(
    `Nombre ${username}`,
    `Apellido ${username}`,
    username,
    `${username}@organizacion.test`,
    hashPassword(pass(username)),
    roleId,
    nowIso(),
    orgId
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

/** Códigos de permisos de un rol, ordenados. */
function permsOf(roleId) {
  return db
    .prepare(
      `SELECT p.code FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.code`
    )
    .all(roleId)
    .map((r) => r.code);
}

/** Fotografía completa de la tabla, para detectar cualquier escritura. */
function fullMatrix() {
  return db
    .prepare(
      `SELECT rp.role_id, rp.permission_id FROM role_permissions rp
       ORDER BY rp.role_id, rp.permission_id`
    )
    .all();
}

before(() => {
  ids.orgA = insertOrg(ORG_A, 'Organización A de roles');
  ids.orgB = insertOrg(ORG_B, 'Organización B de roles');
  adminA = insertUser(ids.orgA, 'admin_roles_a', 'ADMIN');
  adminB = insertUser(ids.orgB, 'admin_roles_b', 'ADMIN');
  empB = insertUser(ids.orgB, 'empleado_roles_b', 'EMPLOYEE');
  techRole = db.prepare("SELECT id FROM roles WHERE code = 'TECHNICIAN'").get();
  empRole = db.prepare("SELECT id FROM roles WHERE code = 'EMPLOYEE'").get();
  adminRole = db.prepare("SELECT id FROM roles WHERE code = 'ADMIN'").get();
  superRole = db.prepare("SELECT id FROM roles WHERE code = 'SUPERADMIN'").get();
});

describe('V2: la matriz de permisos globales solo la toca el SUPERADMIN', () => {
  it('el administrador de ORG_A recibe 403 y role_permissions no cambia', async () => {
    const c = createClient();
    assert.equal((await c.login('admin_roles_a', pass('admin_roles_a'))).status, 200);

    const before = permsOf(techRole.id);
    const res = await c.patch(`/api/roles/${techRole.id}/permissions`, {
      permissions: ['ticket.create', 'ticket.view.all', 'user.manage'],
    });

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error, /superadministrador/i);
    assert.deepEqual(permsOf(techRole.id), before, 'la matriz no debe cambiar');
  });

  it('el administrador de ORG_B tampoco puede modificarlos (403 y sin cambios)', async () => {
    const c = createClient();
    assert.equal((await c.login('admin_roles_b', pass('admin_roles_b'))).status, 200);

    const before = permsOf(empRole.id);
    const res = await c.patch(`/api/roles/${empRole.id}/permissions`, {
      permissions: ['ticket.create'],
    });

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error, /superadministrador/i);
    assert.deepEqual(permsOf(empRole.id), before, 'la matriz no debe cambiar');
  });

  it('un usuario de ORG_B sin role.manage también recibe 403', async () => {
    const c = createClient();
    assert.equal((await c.login('empleado_roles_b', pass('empleado_roles_b'))).status, 200);

    const before = permsOf(techRole.id);
    const res = await c.patch(`/api/roles/${techRole.id}/permissions`, {
      permissions: ['ticket.view.all'],
    });

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(permsOf(techRole.id), before, 'la matriz no debe cambiar');
  });

  it('ningún intento denegado escribe en role_permissions (tabla completa)', async () => {
    const matrixBefore = fullMatrix();

    const a = createClient();
    assert.equal((await a.login('admin_roles_a', pass('admin_roles_a'))).status, 200);
    const b = createClient();
    assert.equal((await b.login('admin_roles_b', pass('admin_roles_b'))).status, 200);

    for (const [client, roleId] of [[a, techRole.id], [b, empRole.id], [a, adminRole.id]]) {
      const denied = await client.patch(`/api/roles/${roleId}/permissions`, { permissions: [] });
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
    }

    assert.deepEqual(fullMatrix(), matrixBefore, 'role_permissions debe quedar intacta');
  });

  it('el SUPERADMIN autorizado conserva las operaciones permitidas', async () => {
    const superadmin = await createSuperadminClient();
    const original = permsOf(techRole.id);
    assert.ok(original.length > 0, 'el rol TECHNICIAN debe nacer con permisos');

    try {
      const reduced = ['ticket.create', 'ticket.view.all'];
      const patch = await superadmin.patch(`/api/roles/${techRole.id}/permissions`, {
        permissions: reduced,
      });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      assert.deepEqual(permsOf(techRole.id), [...reduced].sort(), 'el cambio se persiste');

      // La lectura sigue funcionando para cualquiera con role.manage.
      const read = await superadmin.get('/api/roles');
      assert.equal(read.status, 200);
      const seen = read.body.roles.find((r) => r.id === techRole.id);
      assert.deepEqual([...seen.permissions].sort(), [...reduced].sort());
    } finally {
      const restore = await superadmin.patch(`/api/roles/${techRole.id}/permissions`, {
        permissions: original,
      });
      assert.equal(restore.status, 200, JSON.stringify(restore.body));
      assert.deepEqual(permsOf(techRole.id), [...original].sort(), 'la matriz queda restaurada');
    }
  });

  it('se conservan las protecciones existentes sobre ADMIN y SUPERADMIN', async () => {
    const superadmin = await createSuperadminClient();

    // El rol ADMIN no se puede recortar ni desde el SUPERADMIN (400)...
    const adminBefore = permsOf(adminRole.id);
    const deniedAdmin = await superadmin.patch(`/api/roles/${adminRole.id}/permissions`, {
      permissions: ['ticket.create'],
    });
    assert.equal(deniedAdmin.status, 400);
    assert.match(deniedAdmin.body.error, /Administrador/i);
    assert.deepEqual(permsOf(adminRole.id), adminBefore, 'el rol ADMIN queda intacto');

    // ...y el rol SUPERADMIN sigue inaccesible para un administrador de org.
    const c = createClient();
    assert.equal((await c.login('admin_roles_a', pass('admin_roles_a'))).status, 200);
    const superBefore = permsOf(superRole.id);
    const deniedSuper = await c.patch(`/api/roles/${superRole.id}/permissions`, {
      permissions: ['ticket.view.own'],
    });
    assert.equal(deniedSuper.status, 403);
    assert.match(deniedSuper.body.error, /superadministrador/i);
    assert.deepEqual(permsOf(superRole.id), superBefore, 'el rol SUPERADMIN queda intacto');

    // Un SUPERADMIN sí puede tocar su propio rol (la barrera no es total).
    const selfPatch = await superadmin.patch(`/api/roles/${superRole.id}/permissions`, {
      permissions: superBefore,
    });
    assert.equal(selfPatch.status, 200, JSON.stringify(selfPatch.body));
    assert.deepEqual(permsOf(superRole.id), superBefore);
  });

  it('el canal de solo lectura de roles sigue abierto a los administradores de org', async () => {
    const c = createClient();
    assert.equal((await c.login('admin_roles_a', pass('admin_roles_a'))).status, 200);

    const roles = await c.get('/api/roles');
    assert.equal(roles.status, 200);
    assert.ok(roles.body.roles.length >= 4, 'debe listar las plantillas de rol');

    // El conteo de usuarios sigue siendo el de SU organización, no el global.
    const adminCount = roles.body.roles.find((r) => r.code === 'ADMIN').users;
    const expected = db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'ADMIN' AND u.organization_id = ?`
      )
      .get(ids.orgA).n;
    assert.equal(adminCount, expected, 'el conteo debe ser el de ORG_A');

    const perms = await c.get('/api/roles/permissions');
    assert.equal(perms.status, 200);
    assert.ok(perms.body.permissions.length > 0);
  });

  it('la sesión de un administrador de org no obtiene is_superadmin por acceder al canal', async () => {
    const c = createClient();
    assert.equal((await c.login('admin_roles_a', pass('admin_roles_a'))).status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.is_superadmin, false);
    assert.equal(me.body.user.organization_id, ids.orgA);
    assert.equal(me.body.user.permissions.includes('organization.manage'), false);
  });
});
