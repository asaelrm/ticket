import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from './helpers.js';
import db from '../src/db/runtime.js';
import { nowIso } from '../src/utils/time.js';
import { hashPassword } from '../src/utils/password.js';
import { saveDirectorySnapshot, restoreDirectorySnapshot } from '../src/directorySync.js';

// ETAPA 2: aislamiento real de departamentos y usuarios por organización.
// Cada admin (ORG_A/ORG_B) solo debe ver/gestionar lo suyo; un recurso ajeno
// responde 404; el cliente jamás elige la organización; el SUPERADMIN no
// expone listados completos de golpe; y el directorio preserva la
// organización al restaurarse.

const ORGA = 'AISL_A';
const ORGB = 'AISL_B';
const pass = (code) => `Org${code}Clave123!`;

let ids = {};
let deptA;
let deptB;
let userA;
let userB;
let techA;
let adminA;
let adminB;

async function insertOrg(code, name) {
  await db.execute('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)', code, name, 'Organización de prueba de aislamiento');
  const row = await db.queryOne('SELECT id FROM organizations WHERE code = ?', code);
  return row.id;
}

async function insertUser(orgId, username, roleCode, { dept = null, active = 1 } = {}) {
  const role = await db.queryOne('SELECT id FROM roles WHERE code = ?', roleCode);
  const roleId = role.id;
  await db.execute(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `Nombre ${username}`,
    `Apellido ${username}`,
    username,
    `${username}@organizacion.test`,
    hashPassword(pass(username)),
    dept,
    'Puesto de prueba',
    roleId,
    active,
    nowIso(),
    orgId
  );
  const row = await db.queryOne('SELECT id FROM users WHERE username = ?', username);
  return row.id;
}

before(async () => {
  ids.orgA = await insertOrg(ORGA, 'Organización A de aislamiento');
  ids.orgB = await insertOrg(ORGB, 'Organización B de aislamiento');
  adminA = await insertUser(ids.orgA, 'admin_aisl_a', 'ADMIN');
  adminB = await insertUser(ids.orgB, 'admin_aisl_b', 'ADMIN');
});

describe('Departamentos aislados por organización (ETAPA 2)', () => {
  it('preparación: cada admin crea departamentos y usuarios en SU organización', async () => {
    const cA = createClient();
    const cB = createClient();
    assert.equal((await cA.login('admin_aisl_a', pass('admin_aisl_a'))).status, 200);
    assert.equal((await cB.login('admin_aisl_b', pass('admin_aisl_b'))).status, 200);

    const da = await cA.post('/api/departments', { name: 'Depto A Aislamiento', description: 'A' });
    assert.equal(da.status, 201, JSON.stringify(da.body));
    assert.equal(da.body.department.organization_id, ids.orgA);
    deptA = da.body.department.id;

    const db_ = await cB.post('/api/departments', { name: 'Depto B Aislamiento', description: 'B' });
    assert.equal(db_.status, 201, JSON.stringify(db_.body));
    assert.equal(db_.body.department.organization_id, ids.orgB);
    deptB = db_.body.department.id;

    const ua = await cA.post('/api/users', {
      name: 'UsuarioA', last_name: 'Aislamiento', username: 'usuario_a_aisl', email: 'ua@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id,
      department_id: deptA,
    });
    assert.equal(ua.status, 201, JSON.stringify(ua.body));
    assert.equal(ua.body.user.organization_id, ids.orgA);
    userA = ua.body.user.id;

    const ub = await cB.post('/api/users', {
      name: 'UsuarioB', last_name: 'Aislamiento', username: 'usuario_b_aisl', email: 'ub@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id,
      department_id: deptB,
    });
    assert.equal(ub.status, 201, JSON.stringify(ub.body));
    assert.equal(ub.body.user.organization_id, ids.orgB);
    userB = ub.body.user.id;

    const ta = await cA.post('/api/users', {
      name: 'TecnicoA', last_name: 'Aislamiento', username: 'tecnico_a_aisl', email: 'ta@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'TECHNICIAN')).id,
    });
    assert.equal(ta.status, 201, JSON.stringify(ta.body));
    techA = ta.body.user.id;

    const inactiveA = await cA.post('/api/users', {
      name: 'InactivoA', last_name: 'Aislamiento', username: 'inactivo_a_aisl', email: 'ia@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id,
    });
    assert.equal(inactiveA.status, 201);
    await cA.patch(`/api/users/${inactiveA.body.user.id}/status`, { active: false });
  });

  it('1) el admin A solo ve sus departamentos en el listado', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get('/api/departments');
    assert.equal(res.status, 200);
    const names = res.body.data.map((d) => d.name);
    assert.ok(names.includes('Depto A Aislamiento'), 'debe ver su departamento');
    assert.ok(!names.includes('Depto B Aislamiento'), 'no debe ver departamentos de B');
  });

  it('2) GET de un departamento de B responde 404 para el admin A', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get(`/api/departments/${deptB}`);
    assert.equal(res.status, 404);
  });

  it('3) PATCH de un departamento de B responde 404 para el admin A', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.patch(`/api/departments/${deptB}`, { active: false });
    assert.equal(res.status, 404);
  });

  it('12a) crear un departamento con organization_id forjado responde 400', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.post('/api/departments', {
      name: 'Depto Forjado Aislamiento',
      organization_id: ids.orgB,
    });
    assert.equal(res.status, 400, 'el cliente no puede decidir la organización');
  });
});

describe('Usuarios aislados por organización (ETAPA 2)', () => {
  it('4) crear a un usuario con departamento de B responde 400', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.post('/api/users', {
      name: 'Cruce', last_name: 'Fronterizo', username: 'cruce_aisl', email: 'cruce@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id,
      department_id: deptB,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'El departamento debe pertenecer a la organización del usuario');
  });

  it('5) el admin A solo ve usuarios de A en el listado', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get('/api/users?perPage=100');
    assert.equal(res.status, 200);
    const ids_ = res.body.data.map((u) => u.id);
    assert.ok(ids_.includes(userA), 'debe ver sus usuarios');
    assert.ok(ids_.includes(adminA), 'debe verse a sí mismo');
    assert.ok(!ids_.includes(userB), 'no debe ver usuarios de B');
    assert.ok(!ids_.includes(adminB), 'no debe ver al admin de B');
  });

  it('6) GET de un usuario de B responde 404 para el admin A', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get(`/api/users/${userB}`);
    assert.equal(res.status, 404);
  });

  it('7) PATCH de un usuario de B responde 404 para el admin A', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.patch(`/api/users/${userB}`, { name: 'Intruso' });
    assert.equal(res.status, 404);
  });

  it('8) PATCH de status de un usuario de B responde 404', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.patch(`/api/users/${userB}/status`, { active: false });
    assert.equal(res.status, 404);
  });

  it('9) reset-password de un usuario de B responde 404', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.post(`/api/users/${userB}/reset-password`, {});
    assert.equal(res.status, 404);
  });

  it('10) assignable solo trae usuarios de A (activos)', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get('/api/users/assignable');
    assert.equal(res.status, 200);
    const ids_ = res.body.data.map((u) => u.id);
    assert.ok(ids_.includes(userA), 'debe incluir a los empleados de A');
    assert.ok(ids_.includes(techA), 'debe incluir a los técnicos de A');
    assert.ok(!ids_.includes(userB), 'no debe incluir usuarios de B');
  });

  it('11) el historial de tickets de un usuario de B responde 404', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get(`/api/users/${userB}/tickets`);
    assert.equal(res.status, 404);
  });

  it('12b) crear a un usuario con organization_id forjado responde 400', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.post('/api/users', {
      name: 'Forjado', last_name: 'Org', username: 'forja_aisl', email: 'forja@aisl.test',
      password: 'Temporal1234!',
      role_id: (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id,
      organization_id: ids.orgB,
    });
    assert.equal(res.status, 400);
  });

  it('12c) PATCH con organization_id forjado responde 400 sin alterar la org', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.patch(`/api/users/${userA}`, { organization_id: ids.orgB });
    assert.equal(res.status, 400);
    const org = (await db.queryOne('SELECT organization_id FROM users WHERE id = ?', userA)).organization_id;
    assert.equal(org, ids.orgA, 'la organización no debe cambiar');
  });

  it('13) el admin B no alcanza los recursos de A', async () => {
    const c = createClient();
    await c.login('admin_aisl_b', pass('admin_aisl_b'));
    assert.equal((await c.get(`/api/users/${userA}`)).status, 404);
    assert.equal((await c.get(`/api/departments/${deptA}`)).status, 404);
    assert.equal((await c.patch(`/api/users/${userA}`)).status, 404);
  });

  it('14) dentro de la misma organización todo sigue funcionando', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    assert.equal((await c.get(`/api/departments/${deptA}`)).status, 200);
    const detail = await c.get(`/api/users/${userA}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.user.organization_id, ids.orgA);
    const edit = await c.patch(`/api/users/${userA}`, { name: 'UsuarioA Editado' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.user.name, 'UsuarioA Editado');
    const status = await c.patch(`/api/users/${userA}/status`, { active: true });
    assert.equal(status.status, 200);
  });

  it('15) el conteo de usuarios por rol del admin A es solo de A (no expone la masa de B)', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.get('/api/roles');
    assert.equal(res.status, 200);

    const adminRole = res.body.roles.find((r) => r.code === 'ADMIN');
    const empRole = res.body.roles.find((r) => r.code === 'EMPLOYEE');
    const expectedAdminA = (await db.queryOne(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?) AND u.organization_id = ?',
      'ADMIN',
      ids.orgA
    )).n;
    const expectedEmpA = (await db.queryOne(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?) AND u.organization_id = ?',
      'EMPLOYEE',
      ids.orgA
    )).n;
    const globalAdmin = (await db.queryOne(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?)',
      'ADMIN'
    )).n;

    assert.equal(adminRole.users, expectedAdminA, 'el conteo debe ser el de su organización');
    assert.equal(empRole.users, expectedEmpA);
    assert.ok(globalAdmin > expectedAdminA, 'deben existir administradores de otras orgs que no se filtran');
    assert.notEqual(adminRole.users, globalAdmin, 'el conteo no puede ser el global');
  });
});

describe('SUPERADMIN sin bypass accidental (ETAPA 2)', () => {
  let superId;
  let c;
  before(async () => {
    superId = await insertUser(null, 'super_aisl', 'SUPERADMIN');
    c = createClient();
  });

  it('los listados de usuarios y departamentos no exponen todas las orgs', async () => {
    await c.login('super_aisl', pass('super_aisl'));
    const users = await c.get('/api/users');
    assert.equal(users.status, 200);
    assert.equal(Array.isArray(users.body.data), true);
    assert.equal(users.body.data.length, 0, 'el listado normal no debe volcar todas las organizaciones');

    const depts = await c.get('/api/departments');
    assert.equal(depts.status, 200);
    assert.equal(depts.body.data.length, 0, 'el listado normal de departamentos tampoco');

    const assignable = await c.get('/api/users/assignable');
    assert.equal(assignable.status, 200);
    assert.equal(assignable.body.data.length, 0);
  });

  it('un recurso concreto de otra organización es 404 para el SUPERADMIN sin contexto', async () => {
    assert.equal((await c.get(`/api/users/${userA}`)).status, 404);
    assert.equal((await c.get(`/api/users/${userB}`)).status, 404);
  });

  it('sin contexto no hay enumeración ni acceso: el SUPERADMIN solo ve 404', async () => {
    // ETAPA 3: sin organización el SUPERADMIN no gestiona nada por id y el
    // LISTADO vuelve vacío: no existe vector de enumeración masiva ni acceso
    // individual. Un id inexistente responde 404 igual que uno real.
    const inexistente = (await db.queryOne('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM users')).n;
    const res = await c.get(`/api/users/${inexistente}`);
    assert.equal(res.status, 404);
    const lista = await c.get('/api/users');
    assert.equal(lista.body.data.length, 0);
  });

  it('el SUPERADMIN no puede asociarse a un departamento (no pertenece a ninguno)', async () => {
    const res = await c.patch(`/api/users/${superId}`, { department_id: deptA });
    assert.equal(res.status, 400);
    const dept = (await db.queryOne('SELECT department_id FROM users WHERE id = ?', superId)).department_id;
    assert.equal(dept, null);
  });
});

// BLOQUEANTE 2: el bypass `if (org && ...)` dejaba al SUPERADMIN sin
// organización (organization_id NULL) fuera del aislamiento. Un SUPERADMIN
// global NO debe poder tocar usuarios de ninguna organización por las rutas
// tenant normales (editar, activar/desactivar, resetear contraseña): responde
// 404 para no revelar recursos ajenos. Una organización SOLO se gestiona desde
// la propia org de la sesión.
describe('Rutas tenant de usuarios: SUPERADMIN y admins de organización (ETAPA 3)', () => {
  let cSuper;
  let cA;
  let cB;
  before(() => {
    cSuper = createClient();
    cA = createClient();
    cB = createClient();
  });

  it('el SUPERADMIN sin org no modifica usuarios de A ni de B (PATCH, incluso con org forjada)', async () => {
    await cSuper.login('super_aisl', pass('super_aisl'));
    assert.equal((await cSuper.patch(`/api/users/${userA}`, { name: 'Intruso' })).status, 404);
    assert.equal((await cSuper.patch(`/api/users/${userB}`, { name: 'Intruso' })).status, 404);
    // El contexto de organización SIEMPRE sale de la sesión. La organización
    // forjada en el BODY se rechaza (400, nunca da contexto) y la forjada en
    // la QUERY se ignora (el objetivo sigue siendo 404 para un SUPERADMIN sin
    // organización).
    assert.equal(
      (await cSuper.patch(`/api/users/${userA}`, { name: 'Intruso', organization_id: ids.orgA })).status,
      400
    );
    assert.equal(
      (await cSuper.patch(`/api/users/${userA}?organization_id=${ids.orgA}`, { name: 'Intruso' })).status,
      404
    );

    const a = await db.queryOne('SELECT name, active FROM users WHERE id = ?', userA);
    const b = await db.queryOne('SELECT name, active FROM users WHERE id = ?', userB);
    assert.notEqual(a.name, 'Intruso', 'el intento no cambia nada');
    assert.notEqual(b.name, 'Intruso', 'el intento no cambia nada');
  });

  it('el SUPERADMIN sin org no activa/desactiva ni resetea contraseñas de A ni de B', async () => {
    await cSuper.login('super_aisl', pass('super_aisl'));
    assert.equal((await cSuper.patch(`/api/users/${userA}/status`, { active: true })).status, 404);
    assert.equal((await cSuper.patch(`/api/users/${userB}/status`, { active: true })).status, 404);
    assert.equal((await cSuper.post(`/api/users/${userA}/reset-password`, {})).status, 404);
    assert.equal((await cSuper.post(`/api/users/${userB}/reset-password`, {})).status, 404);

    for (const [id, what] of [[userA, 'A'], [userB, 'B']]) {
      const row = await db.queryOne('SELECT active, password_reset_token FROM users WHERE id = ?', id);
      assert.equal(row.active, 1, `el usuario ${what} sigue activo`);
      assert.equal(row.password_reset_token, null, `no se generó token de reset para ${what}`);
    }
  });

  it('ADMIN A edita, activa y resetea a A; siempre 404 con B', async () => {
    await cA.login('admin_aisl_a', pass('admin_aisl_a'));

    const edit = await cA.patch(`/api/users/${userA}`, { name: 'UsuarioA Etapa3' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.user.name, 'UsuarioA Etapa3');

    assert.equal((await cA.patch(`/api/users/${userB}`, { name: 'Intruso' })).status, 404);
    assert.equal((await cA.patch(`/api/users/${userA}/status`, { active: true })).status, 200);
    assert.equal((await cA.patch(`/api/users/${userB}/status`, { active: false })).status, 404);
    assert.equal((await cA.post(`/api/users/${userA}/reset-password`, {})).status, 200);
    assert.equal((await cA.post(`/api/users/${userB}/reset-password`, {})).status, 404);

    const b = await db.queryOne('SELECT active FROM users WHERE id = ?', userB);
    assert.equal(b.active, 1, 'el admin A no pudo desactivar a B');
  });

  it('ADMIN B edita, activa y resetea a B; siempre 404 con A', async () => {
    await cB.login('admin_aisl_b', pass('admin_aisl_b'));

    const edit = await cB.patch(`/api/users/${userB}`, { name: 'UsuarioB Etapa3' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.user.name, 'UsuarioB Etapa3');

    assert.equal((await cB.patch(`/api/users/${userA}`, { name: 'Intruso' })).status, 404);
    assert.equal((await cB.patch(`/api/users/${userB}/status`, { active: true })).status, 200);
    assert.equal((await cB.patch(`/api/users/${userA}/status`, { active: false })).status, 404);
    assert.equal((await cB.post(`/api/users/${userB}/reset-password`, {})).status, 200);
    assert.equal((await cB.post(`/api/users/${userA}/reset-password`, {})).status, 404);

    const a = await db.queryOne('SELECT active FROM users WHERE id = ?', userA);
    assert.equal(a.active, 1, 'el admin B no pudo desactivar a A');
  });

  it('GET /api/roles: conteos solo por organización; SUPERADMIN sin org ve 0 en todos', async () => {
    await cA.login('admin_aisl_a', pass('admin_aisl_a'));
    await cB.login('admin_aisl_b', pass('admin_aisl_b'));
    await cSuper.login('super_aisl', pass('super_aisl'));

    const resA = await cA.get('/api/roles');
    const resB = await cB.get('/api/roles');
    const resS = await cSuper.get('/api/roles');
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    assert.equal(resS.status, 200);

    const count = async (roleCode, org) => (await db.queryOne(
          `SELECT COUNT(*) AS n FROM users WHERE role_id = (SELECT id FROM roles WHERE code = ?) AND organization_id = ?`,
          roleCode,
          org
        )).n;

    const adminRoleA = resA.body.roles.find((r) => r.code === 'ADMIN');
    const adminRoleB = resB.body.roles.find((r) => r.code === 'ADMIN');
    const empRoleA = resA.body.roles.find((r) => r.code === 'EMPLOYEE');
    const empRoleB = resB.body.roles.find((r) => r.code === 'EMPLOYEE');
    assert.equal(adminRoleA.users, await count('ADMIN', ids.orgA), 'ADMIN A cuenta solo su organización');
    assert.equal(adminRoleB.users, await count('ADMIN', ids.orgB), 'ADMIN B cuenta solo su organización');
    assert.equal(empRoleA.users, await count('EMPLOYEE', ids.orgA));
    assert.equal(empRoleB.users, await count('EMPLOYEE', ids.orgB));

    // SUPERADMIN sin contexto de organización: NO obtiene los conteos globales.
    for (const r of resS.body.roles) {
      assert.equal(r.users, 0, `el SUPERADMIN sin org reporta 0 para ${r.code}, nunca el global`);
    }
    // Los roles siguen siendo plantillas globales: sin organization_id alguna.
    assert.equal(Object.prototype.hasOwnProperty.call(resS.body.roles[0], 'organization_id'), false);
  });
});

describe('El directorio preserva la organización (ETAPA 2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-aislamiento-'));
  const file = path.join(tmp, 'directory.json');

  it('el snapshot lleva organization_code en usuarios y departamentos', async () => {
    assert.equal(await saveDirectorySnapshot({ enabled: true, file }), true);
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(snapshot.version, 3);
    const depts = new Map(snapshot.departments.map((d) => [d.name, d.organization_code]));
    assert.equal(depts.get('Depto A Aislamiento'), ORGA);
    assert.equal(depts.get('Depto B Aislamiento'), ORGB);
    const porNombre = new Map(snapshot.users.map((u) => [u.username, u.organization_code]));
    assert.equal(porNombre.get('usuario_a_aisl'), ORGA);
    assert.equal(porNombre.get('usuario_b_aisl'), ORGB);
    assert.equal(porNombre.get('super_aisl'), null, 'el SUPERADMIN se guarda sin organización');
  });

  it('restaurar borra y recrea debajo de una organización: ninguna cuenta queda huérfana', async () => {
    const userA = await db.queryOne('SELECT id FROM users WHERE username = ?', 'usuario_a_aisl');
    await db.execute('DELETE FROM users WHERE id = ?', userA.id);

    const resultado = await restoreDirectorySnapshot({ enabled: true, file });
    assert.equal(resultado.applied, true);
    assert.deepEqual(resultado.nuevas, ['usuario_a_aisl']);

    const back = await db.queryOne(
      'SELECT u.id, u.organization_id, o.code AS org FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.username = ?',
      'usuario_a_aisl'
    );
    assert.equal(back.org, ORGA, 'la cuenta restaurada vuelve a su organización');
  });

  it('un snapshot con organización desconocida aborta sin ensuciar la base', async () => {
    const malo = path.join(tmp, 'malo.json');
    fs.writeFileSync(
      malo,
      JSON.stringify({
        version: 3,
        departments: [],
        users: [
          {
            name: 'Fantasma', last_name: 'Org', username: `fantasma_${Date.now()}`,
            email: 'fantasma@aisl.test', position: 'P', active: 1, role_code: 'EMPLOYEE',
            department_name: null, organization_code: 'ORG_NO_EXISTE',
          },
        ],
      })
    );
    const antes = (await db.queryOne('SELECT COUNT(*) AS n FROM users')).n;
    await assert.rejects(
      restoreDirectorySnapshot({ enabled: true, file: malo }),
      /Organización desconocida/
    );
    const despues = (await db.queryOne('SELECT COUNT(*) AS n FROM users')).n;
    assert.equal(despues, antes, 'el restore fallido no debe dejar cuentas huérfanas');
  });

  it('un departamento que no coincide con la organización no se impone', async () => {
    const malo = path.join(tmp, 'dept-malo.json');
    // Departamento "Depto A Aislamiento" pertenece a A; el usuario es de B: el
    // restore deja al usuario sin departamento y avisa.
    fs.writeFileSync(
      malo,
      JSON.stringify({
        version: 3,
        departments: [{ name: 'Depto A Aislamiento', description: 'A', active: 1, organization_code: ORGA }],
        users: [
          {
            name: 'FueraDeLugar', last_name: 'Depto', username: `sindep_${Date.now()}`,
            email: 'sindep@aisl.test', position: 'P', active: 1, role_code: 'EMPLOYEE',
            department_name: 'Depto A Aislamiento', organization_code: ORGB,
          },
        ],
      })
    );
    const resultado = await restoreDirectorySnapshot({ enabled: true, file: malo });
    assert.ok(resultado.avisos.length >= 1, 'debe avisar del departamento descartado');
    const row = await db.queryOne('SELECT department_id FROM users WHERE username = ?', resultado.nuevas[0]);
    assert.equal(row.department_id, null);
  });

  it('departamentos con el mismo nombre en organizaciones distintas no se mezclan', async () => {
    // En SQLite `departments.name` es UNIQUE GLOBAL (el esquema MSSQL es
    // UNIQUE(organization_id, name)). En cualquier caso, el departamento de A
    // no puede terminar perteneciendo a B ni cambiar de descripción.
    const comparte = `Compartido ${Date.now()}`;
    await db.execute('INSERT INTO departments (name, description, active, organization_id) VALUES (?, ?, 1, ?)',
      comparte, 'de A', ids.orgA);
    const deptAId = (await db.queryOne('SELECT id FROM departments WHERE name = ?', comparte)).id;

    const archivo = path.join(tmp, 'homonimo.json');
    fs.writeFileSync(
      archivo,
      JSON.stringify({
        version: 3,
        departments: [{ name: comparte, description: 'de B', active: 1, organization_code: ORGB }],
        users: [],
      })
    );

    let aplicado = true;
    try {
      await restoreDirectorySnapshot({ enabled: true, file: archivo });
    } catch {
      aplicado = false;
    }

    const filaA = await db.queryOne('SELECT id, organization_id, description FROM departments WHERE id = ?', deptAId);
    assert.equal(filaA.organization_id, ids.orgA, 'el departamento de A jamás se mueve a B');
    assert.equal(filaA.description, 'de A', 'tampoco se sobrescribe su descripción');

    const enB = (await db.queryOne('SELECT COUNT(*) AS n FROM departments WHERE name = ? AND organization_id = ?', comparte, ids.orgB)).n;
    if (aplicado) {
      // Motor con unicidad por organización: el homónimo existe como fila
      // distinta, nunca como la de A reasignada.
      assert.equal(enB, 1);
    } else {
      // SQLite: el nombre es único globalmente y la creación revierte entera.
      assert.equal(enB, 0);
    }
  });

  it('un correo ya usado por otra cuenta aborta la restauración sin fusionar cuentas', async () => {
    const ts = Date.now();
    const archivo = path.join(tmp, 'email-duplicado.json');
    fs.writeFileSync(
      archivo,
      JSON.stringify({
        version: 3,
        departments: [],
        users: [
          {
            name: 'Duplicado', last_name: 'Email', username: `duplicado_${ts}`, email: 'ua@aisl.test',
            position: 'P', active: 1, role_code: 'EMPLOYEE', department_name: null,
            organization_code: ORGB,
          },
        ],
      })
    );

    // 'ua@aisl.test' pertenece a usuario_a_aisl: el restore no puede apropiárselo.
    const antes = (await db.queryOne('SELECT COUNT(*) AS n FROM users')).n;
    await assert.rejects(
      restoreDirectorySnapshot({ enabled: true, file: archivo }),
      /ya pertenece/
    );
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM users')).n, antes);
    const emailOwner = await db.queryOne('SELECT username FROM users WHERE email = ?', 'ua@aisl.test');
    assert.equal(emailOwner.username, 'usuario_a_aisl', 'el correo sigue en su dueño original');
  });

  it('un rol desconocido revierte por completo, incluido el departamento ya insertado', async () => {
    const ts = Date.now();
    const deptNuevo = `Rollback ${ts}`;
    const archivo = path.join(tmp, 'rol-malo.json');
    fs.writeFileSync(
      archivo,
      JSON.stringify({
        version: 3,
        departments: [{ name: deptNuevo, description: 'x', active: 1, organization_code: ORGA }],
        users: [
          {
            name: 'SinRol', last_name: 'Rollback', username: `sinrol_${ts}`, email: `sinrol_${ts}@aisl.test`,
            position: 'P', active: 1, role_code: 'ROL_QUE_NO_EXISTE', department_name: null,
            organization_code: ORGA,
          },
        ],
      })
    );

    const deptAntes = (await db.queryOne('SELECT COUNT(*) AS n FROM departments')).n;
    const userAntes = (await db.queryOne('SELECT COUNT(*) AS n FROM users')).n;
    await assert.rejects(
      restoreDirectorySnapshot({ enabled: true, file: archivo }),
      /Rol no encontrado/
    );
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM departments')).n, deptAntes, 'el departamento insertado se revierte');
    const deptRow = await db.queryOne('SELECT id FROM departments WHERE name = ?', deptNuevo);
    assert.equal(deptRow, undefined);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM users')).n, userAntes);
  });

  describe('SUPERADMIN crea administradores de organización (ETAPA 3)', () => {
    let superadminClient;
    let orgAId;
    let orgBId;
    let roleAdminId;

    before(async () => {
      // Usar las organizaciones ya creadas
      orgAId = ids.orgA;
      orgBId = ids.orgB;
      roleAdminId = (await db.queryOne("SELECT id FROM roles WHERE code = 'ADMIN'")).id;

      // Crear cliente SUPERADMIN
      const { createSuperadminClient } = await import('./helpers.js');
      superadminClient = await createSuperadminClient('superadmin_org_admin_test');
    });

    it('SUPERADMIN puede crear un ADMIN para organización A especificando organization_id', async () => {
      const res = await superadminClient.post('/api/users', {
        name: 'Admin',
        last_name: 'OrgA',
        username: 'admin_orgA_test',
        email: 'admin_orga_test@organizacion.test',
        password: 'AdminOrgA1234!',
        role_id: roleAdminId,
        organization_id: orgAId,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.user.organization_id, orgAId);
      assert.equal(res.body.user.role, 'ADMIN');
      assert.equal(res.body.user.is_superadmin, false);
    });

    it('SUPERADMIN puede crear un ADMIN para organización B especificando organization_id', async () => {
      const res = await superadminClient.post('/api/users', {
        name: 'Admin',
        last_name: 'OrgB',
        username: 'admin_orgB_test',
        email: 'admin_orgb_test@organizacion.test',
        password: 'AdminOrgB1234!',
        role_id: roleAdminId,
        organization_id: orgBId,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.user.organization_id, orgBId);
      assert.equal(res.body.user.role, 'ADMIN');
    });

    it('SUPERADMIN NO puede crear SUPERADMIN con organization_id (debe ser null)', async () => {
      const roleSuperId = (await db.queryOne("SELECT id FROM roles WHERE code = 'SUPERADMIN'")).id;
      const res = await superadminClient.post('/api/users', {
        name: 'Super',
        last_name: 'Admin',
        username: 'superadmin_test',
        email: 'superadmin_test@organizacion.test',
        password: 'SuperAdmin1234!',
        role_id: roleSuperId,
        organization_id: orgAId, // Debe ser ignorado y forzado a null
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.user.organization_id, null, 'SUPERADMIN debe tener organization_id null');
      assert.equal(res.body.user.role, 'SUPERADMIN');
    });

    it('Administrador normal NO puede especificar organization_id al crear usuario', async () => {
      const c = createClient();
      assert.equal((await c.login('admin_aisl_a', pass('admin_aisl_a'))).status, 200);

      const res = await c.post('/api/users', {
        name: 'Forjado',
        last_name: 'Org',
        username: 'forja_admin_test',
        email: 'forja_admin@organizacion.test',
        password: 'Temporal1234!',
        role_id: roleAdminId,
        organization_id: orgBId,
      });
      assert.equal(res.status, 400, 'debe rechazar organization_id forjado');
    });

    it('SUPERADMIN sin organization_id crea usuario en organización por defecto (null para SUPERADMIN, su org para otros)', async () => {
      const roleEmpId = (await db.queryOne("SELECT id FROM roles WHERE code = 'EMPLOYEE'")).id;

      // Sin organization_id, SUPERADMIN crea EMPLOYEE sin org (fallará por orgStateError)
      const res1 = await superadminClient.post('/api/users', {
        name: 'Emp',
        last_name: 'SinOrg',
        username: 'emp_sinorg_test',
        email: 'emp_sinorg@organizacion.test',
        password: 'Empleado1234!',
        role_id: roleEmpId,
        // Sin organization_id
      });
      assert.equal(res1.status, 400, 'EMPLOYEE sin organización debe fallar');

      // Con organization_id explícito, funciona
      const res2 = await superadminClient.post('/api/users', {
        name: 'Emp',
        last_name: 'ConOrg',
        username: 'emp_conorg_test',
        email: 'emp_conorg@organizacion.test',
        password: 'Empleado1234!',
        role_id: roleEmpId,
        organization_id: orgAId,
      });
      assert.equal(res2.status, 201, JSON.stringify(res2.body));
      assert.equal(res2.body.user.organization_id, orgAId);
    });

    it('El administrador creado puede iniciar sesión y solo ve su organización', async () => {
      const c = createClient();
      assert.equal((await c.login('admin_orgA_test', 'AdminOrgA1234!')).status, 200);
      const me = await c.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.organization_id, orgAId);
      assert.equal(me.body.user.organization_name, 'Organización A de aislamiento');
      assert.equal(me.body.user.is_superadmin, false);

      // El admin solo ve usuarios de su organización
      const users = await c.get('/api/users');
      assert.equal(users.status, 200);
      for (const u of users.body.data) {
        assert.equal(u.organization_id, orgAId, 'solo usuarios de su organización');
      }
    });
  });
});
