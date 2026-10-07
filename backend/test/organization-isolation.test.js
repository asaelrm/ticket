import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
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

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de aislamiento');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser(orgId, username, roleCode, { dept = null, active = 1 } = {}) {
  const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode).id;
  db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

before(() => {
  ids.orgA = insertOrg(ORGA, 'Organización A de aislamiento');
  ids.orgB = insertOrg(ORGB, 'Organización B de aislamiento');
  adminA = insertUser(ids.orgA, 'admin_aisl_a', 'ADMIN');
  adminB = insertUser(ids.orgB, 'admin_aisl_b', 'ADMIN');
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
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('EMPLOYEE').id,
      department_id: deptA,
    });
    assert.equal(ua.status, 201, JSON.stringify(ua.body));
    assert.equal(ua.body.user.organization_id, ids.orgA);
    userA = ua.body.user.id;

    const ub = await cB.post('/api/users', {
      name: 'UsuarioB', last_name: 'Aislamiento', username: 'usuario_b_aisl', email: 'ub@aisl.test',
      password: 'Temporal1234!',
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('EMPLOYEE').id,
      department_id: deptB,
    });
    assert.equal(ub.status, 201, JSON.stringify(ub.body));
    assert.equal(ub.body.user.organization_id, ids.orgB);
    userB = ub.body.user.id;

    const ta = await cA.post('/api/users', {
      name: 'TecnicoA', last_name: 'Aislamiento', username: 'tecnico_a_aisl', email: 'ta@aisl.test',
      password: 'Temporal1234!',
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('TECHNICIAN').id,
    });
    assert.equal(ta.status, 201, JSON.stringify(ta.body));
    techA = ta.body.user.id;

    const inactiveA = await cA.post('/api/users', {
      name: 'InactivoA', last_name: 'Aislamiento', username: 'inactivo_a_aisl', email: 'ia@aisl.test',
      password: 'Temporal1234!',
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('EMPLOYEE').id,
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
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('EMPLOYEE').id,
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
      role_id: db.prepare('SELECT id FROM roles WHERE code = ?').get('EMPLOYEE').id,
      organization_id: ids.orgB,
    });
    assert.equal(res.status, 400);
  });

  it('12c) PATCH con organization_id forjado responde 400 sin alterar la org', async () => {
    const c = createClient();
    await c.login('admin_aisl_a', pass('admin_aisl_a'));
    const res = await c.patch(`/api/users/${userA}`, { organization_id: ids.orgB });
    assert.equal(res.status, 400);
    const org = db.prepare('SELECT organization_id FROM users WHERE id = ?').get(userA).organization_id;
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
    const expectedAdminA = db.prepare(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?) AND u.organization_id = ?'
    ).get('ADMIN', ids.orgA).n;
    const expectedEmpA = db.prepare(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?) AND u.organization_id = ?'
    ).get('EMPLOYEE', ids.orgA).n;
    const globalAdmin = db.prepare(
      'SELECT COUNT(*) AS n FROM users u WHERE u.role_id = (SELECT id FROM roles WHERE code = ?)'
    ).get('ADMIN').n;

    assert.equal(adminRole.users, expectedAdminA, 'el conteo debe ser el de su organización');
    assert.equal(empRole.users, expectedEmpA);
    assert.ok(globalAdmin > expectedAdminA, 'deben existir administradores de otras orgs que no se filtran');
    assert.notEqual(adminRole.users, globalAdmin, 'el conteo no puede ser el global');
  });
});

describe('SUPERADMIN sin bypass accidental (ETAPA 2)', () => {
  let superId;
  let c;
  before(() => {
    superId = insertUser(null, 'super_aisl', 'SUPERADMIN');
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
    const inexistente = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM users').get().n;
    const res = await c.get(`/api/users/${inexistente}`);
    assert.equal(res.status, 404);
    const lista = await c.get('/api/users');
    assert.equal(lista.body.data.length, 0);
  });

  it('el SUPERADMIN no puede asociarse a un departamento (no pertenece a ninguno)', async () => {
    const res = await c.patch(`/api/users/${superId}`, { department_id: deptA });
    assert.equal(res.status, 400);
    const dept = db.prepare('SELECT department_id FROM users WHERE id = ?').get(superId).department_id;
    assert.equal(dept, null);
  });
});

describe('El directorio preserva la organización (ETAPA 2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-aislamiento-'));
  const file = path.join(tmp, 'directory.json');

  it('el snapshot lleva organization_code en usuarios y departamentos', () => {
    assert.equal(saveDirectorySnapshot({ enabled: true, file }), true);
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

  it('restaurar borra y recrea debajo de una organización: ninguna cuenta queda huérfana', () => {
    const userA = db.prepare('SELECT id FROM users WHERE username = ?').get('usuario_a_aisl');
    db.prepare('DELETE FROM users WHERE id = ?').run(userA.id);

    const resultado = restoreDirectorySnapshot({ enabled: true, file });
    assert.equal(resultado.applied, true);
    assert.deepEqual(resultado.nuevas, ['usuario_a_aisl']);

    const back = db.prepare(
      'SELECT u.id, u.organization_id, o.code AS org FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.username = ?'
    ).get('usuario_a_aisl');
    assert.equal(back.org, ORGA, 'la cuenta restaurada vuelve a su organización');
  });

  it('un snapshot con organización desconocida aborta sin ensuciar la base', () => {
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
    const antes = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    assert.throws(() => restoreDirectorySnapshot({ enabled: true, file: malo }), /Organización desconocida/);
    const despues = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    assert.equal(despues, antes, 'el restore fallido no debe dejar cuentas huérfanas');
  });

  it('un departamento que no coincide con la organización no se impone', () => {
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
    const resultado = restoreDirectorySnapshot({ enabled: true, file: malo });
    assert.ok(resultado.avisos.length >= 1, 'debe avisar del departamento descartado');
    const row = db.prepare('SELECT department_id FROM users WHERE username = ?').get(resultado.nuevas[0]);
    assert.equal(row.department_id, null);
  });
});