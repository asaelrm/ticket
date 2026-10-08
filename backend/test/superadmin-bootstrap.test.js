import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db, { runMigrations, nowIso } from '../src/db.js';
import { seed } from '../src/seed.js';
import { hashPassword } from '../src/utils/password.js';
import { bootstrapSuperadmin } from '../src/scripts/bootstrap-superadmin.js';
import {
  SUPERADMIN_ROLE_CODE,
  orgStateError,
  auditOrganizationConsistency,
} from '../src/orgPolicy.js';

function superRole() {
  return db.prepare('SELECT id, code FROM roles WHERE code = ?').get(SUPERADMIN_ROLE_CODE);
}

function uceId() {
  return db.prepare("SELECT id FROM organizations WHERE code = 'UCE'").get().id;
}

function techRole() {
  return db.prepare('SELECT id FROM roles WHERE code = ?').get('TECHNICIAN');
}

function allPermCodes() {
  return db.prepare('SELECT code FROM permissions').all().map((p) => p.code);
}

function insertUser({ username, email, roleCode, password, organizationId }) {
  const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode);
  return db
    .prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run('Audit', 'Test', username, email, hashPassword(password), role.id, nowIso(), organizationId).lastInsertRowid;
}

describe('ETAPA 1B: Bootstrap del primer SUPERADMIN', () => {
  it('orgStateError aplica la regla de consistencia', async () => {
    assert.ok(await orgStateError({ roleCode: 'EMPLOYEE', organizationId: null }), 'normal sin org es inválido');
    assert.ok(await orgStateError({ roleCode: 'EMPLOYEE', organizationId: 999999 }), 'normal con org inexistente es inválido');
    assert.ok(await orgStateError({ roleCode: SUPERADMIN_ROLE_CODE, organizationId: uceId() }), 'súper con org es inválido');
    assert.equal(await orgStateError({ roleCode: SUPERADMIN_ROLE_CODE, organizationId: null }), null);
    assert.equal(await orgStateError({ roleCode: 'EMPLOYEE', organizationId: uceId() }), null);
  });

  it('el bootstrap se niega a ejecutarse en producción sin autorización explícita', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const save = process.env.BOOTSTRAP_SUPERADMIN_PROD_ALLOWED;
    delete process.env.BOOTSTRAP_SUPERADMIN_PROD_ALLOWED;
    await assert.rejects(
      () =>
        bootstrapSuperadmin({
          username: 'prod_lock',
          email: 'prod_lock@empresa.com',
          name: 'Prod',
          lastName: 'Lock',
          password: 'ProdClave123!',
          production: true,
        }),
      /refusing production/
    );
    if (save !== undefined) process.env.BOOTSTRAP_SUPERADMIN_PROD_ALLOWED = save;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'el fallo no debe crear nada');
  });

  it('rechaza datos inválidos y no crea nada', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    await assert.rejects(
      () =>
        bootstrapSuperadmin({
          username: 'x',
          email: 'boot_invalid@empresa.com',
          name: 'Inválido',
          lastName: 'Test',
          password: 'Clave1234!',
        }),
      /datos inválidos/
    );
    await assert.rejects(
      () =>
        bootstrapSuperadmin({
          username: 'boot_corto',
          email: 'short@empresa.com',
          name: 'Corto',
          lastName: 'Test',
          password: '123',
        }),
      /datos inválidos/
    );
    await assert.rejects(
      () =>
        bootstrapSuperadmin({
          username: 'boot_sinemail',
          email: '',
          name: 'Sin',
          lastName: 'Mail',
          password: 'Clave1234!',
        }),
      /datos inválidos/
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
  });

  it('crea la PRIMERA cuenta SUPERADMIN global sin exponer la contraseña', async () => {
    const consoleLog = console.log;
    const consoleError = console.error;
    const output = [];
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    let created;
    try {
      created = await bootstrapSuperadmin({
        username: 'bootstrap_super',
        email: 'bootstrap_super@empresa.com',
        name: 'Rafa',
        lastName: 'Global',
        password: 'BootstrapClave123!',
      });
    } finally {
      console.log = consoleLog;
      console.error = consoleError;
    }

    assert.equal(created.username, 'bootstrap_super');
    assert.equal(created.role, SUPERADMIN_ROLE_CODE);
    assert.ok(created.id, 'debe devolver el id creado');
    assert.ok(!('password' in created), 'el resultado no debe contener la contraseña');
    const printed = output.join('\n');
    assert.ok(!printed.includes('BootstrapClave123!'), 'nada impreso debe contener la contraseña');

    const row = db
      .prepare(`SELECT u.* FROM users u WHERE u.username = ? AND u.id = ?`)
      .get('bootstrap_super', created.id);
    assert.ok(row, 'la cuenta debe existir');
    assert.equal(row.role_id, superRole().id);
    assert.equal(row.organization_id, null, 'el SUPERADMIN nace global (organization_id null)');
    assert.notEqual(row.password_hash, 'BootstrapClave123!', 'solo se guarda el hash');

    const c = createClient();
    const login = await c.login('bootstrap_super', 'BootstrapClave123!');
    assert.equal(login.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.is_superadmin, true);
    assert.equal(me.body.user.organization_id, null);
  });

  it('se niega a crear una segunda cuenta: el bootstrap es solo para la primera', async () => {
    await assert.rejects(
      () =>
        bootstrapSuperadmin({
          username: 'segundo_super',
          email: 'segundo_super@empresa.com',
          name: 'Segundo',
          lastName: 'Global',
          password: 'SegundaClave123!',
        }),
      /ya existe/
    );
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get('segundo_super');
    assert.equal(row, undefined, 'la segunda cuenta no debe crearse');
  });
});

describe('ETAPA 1B: Protección del rol SUPERADMIN', () => {
  const superClient = () => {
    const c = createClient();
    return c;
  };

  it('un admin normal no puede modificar los permisos del rol SUPERADMIN', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const res = await admin.patch(`/api/roles/${superRole().id}/permissions`, { permissions: ['ticket.view.own'] });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /superadministrador/);
  });

  it('otro SUPERADMIN sí puede (la barrera es por rol, no total)', async () => {
    const c = superClient();
    await c.login('bootstrap_super', 'BootstrapClave123!');
    const res = await c.patch(`/api/roles/${superRole().id}/permissions`, { permissions: allPermCodes() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

describe('ETAPA 1B: Consistencia de organización en la API', () => {
  it('un SUPERADMIN sin organización no puede crear usuarios de organización', async () => {
    const c = createClient();
    await c.login('bootstrap_super', 'BootstrapClave123!');
    const res = await c.post('/api/users', {
      name: 'OrgSin',
      last_name: 'Contexto',
      username: `orgsin.${Date.now()}`,
      email: `orgsin.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: techRole().id,
    });
    assert.equal(res.status, 400, 'el contexto de organización sale de la sesión y aquí no existe');
  });

  it('un SUPERADMIN sin contexto no toca usuarios de organización; la vía global explícita sí funciona', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const created = await admin.post('/api/users', {
      name: 'Promovible',
      last_name: 'Usuario',
      username: `promovible.${Date.now()}`,
      email: `promovible.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: techRole().id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const targetId = created.body.user.id;
    assert.equal(created.body.user.organization_id, uceId(), 'nace en la org de la sesión');

    const superAdmin = createClient();
    await superAdmin.login('bootstrap_super', 'BootstrapClave123!');

    // ETAPA 3: las rutas tenant NO confían en "sin organización = todas". Un
    // SUPERADMIN global no puede modificar a un usuario de ninguna
    // organización por PATCH /api/users/:id (404, sin revelar el recurso).
    const intrusion = await superAdmin.patch(`/api/users/${targetId}`, { role_id: superRole().id });
    assert.equal(intrusion.status, 404, 'el SUPERADMIN sin org no modifica un usuario de organización');
    const unchanged = db.prepare('SELECT organization_id, role_id FROM users WHERE id = ?').get(targetId);
    assert.equal(unchanged.role_id, techRole().id, 'el rol del usuario de organización no cambia');
    assert.equal(unchanged.organization_id, uceId(), 'sigue en su organización');

    // La vía GLOBAL explícita sigue existiendo: crear directamente un
    // SUPERADMIN global desde el canal SUPERADMIN.
    const global = await superAdmin.post('/api/users', {
      name: 'Global',
      last_name: 'Nuevo',
      username: `global.nuevo.${Date.now()}`,
      email: `global.nuevo.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: superRole().id,
    });
    assert.equal(global.status, 201, JSON.stringify(global.body));
    assert.equal(global.body.user.organization_id, null, 'el nuevo SUPERADMIN nace global');
    assert.equal(global.body.user.is_superadmin, true);
    const globalId = global.body.user.id;

    const demote = await superAdmin.patch(`/api/users/${globalId}`, { role_id: techRole().id });
    assert.equal(demote.status, 400, 'quitar SUPERADMIN exige aprovisionar organización');
    assert.match(demote.body.error, /Convertir un SUPERADMIN/);

    const stillGlobal = db.prepare('SELECT organization_id FROM users WHERE id = ?').get(globalId);
    assert.equal(stillGlobal.organization_id, null, 'el descenso falla y nada cambia');
    const orgEnd = db.prepare('SELECT organization_id FROM users WHERE id = ?').get(targetId);
    assert.equal(orgEnd.organization_id, uceId(), 'la cuenta de organización queda intacta');
  });

  it('un cambio normal->normal conserva la organización del usuario', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const emp = db.prepare('SELECT id, organization_id FROM users WHERE username = ?').get('empleado');
    const res = await admin.patch(`/api/users/${emp.id}`, { role_id: techRole().id, position: 'Soporte' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.organization_id, uceId());
    const after = db.prepare('SELECT organization_id FROM users WHERE id = ?').get(emp.id);
    assert.equal(after.organization_id, uceId());
  });
});

describe('ETAPA 1B: Auditoría de organizaciones (solo lectura)', () => {
  it('sobre datos consistentes no detecta nada y no modifica nada', async () => {
    const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const orgsBefore = db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
    const issues = await auditOrganizationConsistency();
    assert.equal(issues.length, 0, JSON.stringify(issues));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, orgsBefore);
  });

  it('detecta los cuatro tipos de inconsistencia', async () => {
    const stamp = Date.now();
    insertUser({
      username: `audit.sinorg.${stamp}`,
      email: `audit.sinorg.${stamp}@empresa.com`,
      roleCode: 'EMPLOYEE',
      password: 'Clave1234!',
      organizationId: null,
    });
    insertUser({
      username: `audit.superorg.${stamp}`,
      email: `audit.superorg.${stamp}@empresa.com`,
      roleCode: 'SUPERADMIN',
      password: 'Clave1234!',
      organizationId: uceId(),
    });
    db.prepare(
      "INSERT INTO organizations (code, name, description, active) VALUES (?, ?, '', 0) ON CONFLICT(code) DO NOTHING"
    ).run(`INACTIVA_${stamp}`, 'Org inactiva de prueba');
    const inactiveOrg = db.prepare('SELECT id FROM organizations WHERE code = ?').get(`INACTIVA_${stamp}`).id;
    insertUser({
      username: `audit.inactiva.${stamp}`,
      email: `audit.inactiva.${stamp}@empresa.com`,
      roleCode: 'TECHNICIAN',
      password: 'Clave1234!',
      organizationId: inactiveOrg,
    });

    // La referencia a una organización inexistente exige pasar por encima de la
    // FK de SQLite solo para sembrar el caso; se restaura al salir.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      insertUser({
        username: `audit.inexistente.${stamp}`,
        email: `audit.inexistente.${stamp}@empresa.com`,
        roleCode: 'EMPLOYEE',
        password: 'Clave1234!',
        organizationId: 999999,
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const issues = await auditOrganizationConsistency();
    const types = issues.map((i) => [i.type, i.username]);
    assert.ok(types.some(([t, u]) => t === 'USUARIO_SIN_ORGANIZACION' && u === `audit.sinorg.${stamp}`));
    assert.ok(types.some(([t, u]) => t === 'SUPERADMIN_CON_ORGANIZACION' && u === `audit.superorg.${stamp}`));
    assert.ok(types.some(([t, u]) => t === 'ORGANIZACION_INACTIVA' && u === `audit.inactiva.${stamp}`));
    assert.ok(types.some(([t, u]) => t === 'ORGANIZACION_INEXISTENTE' && u === `audit.inexistente.${stamp}`));
    assert.equal(issues.length, 4, JSON.stringify(issues));

    db.prepare(`DELETE FROM users WHERE username LIKE 'audit.%.${stamp}'`).run();
    db.prepare('DELETE FROM organizations WHERE id = ?').run(inactiveOrg);
    assert.equal((await auditOrganizationConsistency()).length, 0, 'la auditoría sobre datos limpios no reporta');
  });
});