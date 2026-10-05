// B11-B2: GET /api/roles/permissions migrado de db.prepare al contrato async.
//
// La prueba que importa no es "devuelve 200", sino que la decisión de
// autorización depende de los permisos LEÍDOS DE LA BASE en cada petición y no
// del código del rol. Si alguien sustituyera `requirePermission('role.manage')`
// por `role.code === 'ADMIN'`, el caso "rol no ADMIN con role.manage" lo
// detectaría.

import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import db, { contract } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';
import { createClient } from './helpers.js';

const ROLE_CODE = 'B11_TEST_ROLE';
const USERNAME = 'b11-test-permiso';
const PASSWORD = 'B11TestPermiso1234!';

let admin;
let tecnico;
let anular;

/** Lo que devolvía el handler legacy: SELECT * FROM permissions ORDER BY id. */
function permisosDesdeLaBase() {
  return db.prepare('SELECT * FROM permissions ORDER BY id').all();
}

function codigoDeRol(userId) {
  return db.prepare('SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId).code;
}

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');

  tecnico = createClient();
  await tecnico.login('tecnico', 'Tecnico1234!');
});

after(async () => {
  db.prepare('DELETE FROM users WHERE username = ?').run(USERNAME);
  const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(ROLE_CODE);
  if (role) {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  }
});

beforeEach(() => {
  anular = undefined;
});

describe('GET /api/roles/permissions · contrato async', () => {
  it('responde 200 a quien tiene role.manage', async () => {
    const res = await admin.get('/api/roles/permissions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.permissions));
    assert.ok(res.body.permissions.length > 0);
  });

  it('conserva exactamente el JSON que devolvía la versión con db.prepare', async () => {
    const res = await admin.get('/api/roles/permissions');
    assert.equal(res.status, 200);
    // El handler legacy también acababa en res.json, así que la comparación
    // justa es contra el mismo paso de serialización: created_at es un Date en
    // la fila cruda y una cadena ISO en el JSON, en las dos versiones.
    const esperado = JSON.parse(JSON.stringify({ permissions: permisosDesdeLaBase() }));
    assert.deepEqual(res.body, esperado);
    // La forma de cada fila tampoco cambia: mismas claves, mismo orden por id.
    assert.deepEqual(Object.keys(res.body.permissions[0]), Object.keys(esperado.permissions[0]));
    assert.deepEqual(
      res.body.permissions.map((p) => p.id),
      esperado.permissions.map((p) => p.id),
    );
    assert.deepEqual(res.body.permissions.map((p) => p.code), esperado.permissions.map((p) => p.code));
  });

  it('devuelve 403 a quien no tiene role.manage', async () => {
    const res = await tecnico.get('/api/roles/permissions');
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'No tiene permiso para realizar esta acción' });
  });

  it('devuelve 401 sin autenticar', async () => {
    const anonimo = createClient();
    const res = await anonimo.get('/api/roles/permissions');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'No autenticado' });
  });

  it('no llama a db.prepare en ese camino y consulta por el contrato', async () => {
    // Aviso sobre el método: bajo SQLite el contrato y la fachada legacy son el
    // MISMO objeto (createSqliteContract envuelve la DatabaseSync), así que aquí
    // no se puede envenenar db.prepare para demostrar nada: la consulta legítima
    // del contrato passaría por él. La demostración real de que el camino no usa
    // la API legacy es la de la Barrier de DB_CLIENT=mssql (db es un Proxy que
    // lanza ante cualquier acceso), y la validación read-only contra MSSQL.
    // Aquí se comprueba lo que sí es comprobable sin falsear el contrato:
    // que la petición llega al contrato y que el handler no menciona db.prepare.
    const sqlVistoPorElContrato = [];
    const queryManyOriginal = contract.queryMany;
    contract.queryMany = (...args) => {
      sqlVistoPorElContrato.push(args[0]);
      return queryManyOriginal.apply(contract, args);
    };

    let res;
    try {
      res = await admin.get('/api/roles/permissions');
    } finally {
      contract.queryMany = queryManyOriginal;
    }
    assert.equal(res.status, 200);

    const consultaDelCatalogo = sqlVistoPorElContrato.filter((sql) => /FROM\s+permissions/i.test(sql));
    assert.equal(consultaDelCatalogo.length, 1, 'el handler debe hacer una consulta de catálogo por el contrato');
    assert.match(consultaDelCatalogo[0], /^\s*SELECT\s+\*\s+FROM\s+permissions/i);
    assert.match(consultaDelCatalogo[0], /ORDER BY\s+id/i);
  });

  it('el handler no menciona db.prepare en su código', () => {
    const fuente = readFileSync(new URL('../src/routes/roles.js', import.meta.url), 'utf8');
    const desde = fuente.indexOf("router.get('/permissions'");
    const hasta = fuente.indexOf('router.patch(');
    assert.ok(desde > -1 && hasta > desde, 'no se encontró el handler GET /permissions en routes/roles.js');
    const handler = fuente.slice(desde, hasta);

    assert.match(handler, /contract\.queryMany\(/, 'el handler debe leer el catálogo por el contrato');
    assert.doesNotMatch(handler, /db\.prepare/, 'el handler no debe usar la API legacy db.prepare');
    assert.doesNotMatch(handler, /db\.exec/, 'el handler no debe usar la API legacy db.exec');
  });
});

describe('GET /api/roles/permissions · la autorización no depende del código del rol', () => {
  before(async () => {
    // Rol nuevo, NO admin, con un único permiso: role.manage.
    db.prepare('INSERT INTO roles (code, name, description) VALUES (?, ?, ?)').run(
      ROLE_CODE,
      'Rol de prueba B11-B2',
      'Solo role.manage',
    );
    const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(ROLE_CODE).id;
    const permId = db.prepare('SELECT id FROM permissions WHERE code = ?').get('role.manage').id;
    db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(roleId, permId);

    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, role_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('B11', 'Test', USERNAME, `${USERNAME}@example.invalid`, await hashPassword(PASSWORD), roleId);
  });

  it('un rol que no es ADMIN pero tiene role.manage obtiene 200', async () => {
    const cliente = createClient();
    await cliente.login(USERNAME, PASSWORD);

    const id = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME).id;
    assert.notEqual(codigoDeRol(id), 'ADMIN', 'el rol de la prueba no debe ser ADMIN');

    const res = await cliente.get('/api/roles/permissions');
    assert.equal(res.status, 200);
  });

  it('el permiso concedido es exactamente role.manage, nada más', async () => {
    // Si el rol tuviera permisos de más, el 200 de arriba no valdría nada: la
    // autorización podría estar viniendo de un permiso distinto al exigido.
    const cliente = createClient();
    await cliente.login(USERNAME, PASSWORD);
    const me = await cliente.get('/api/auth/me');

    assert.equal(me.status, 200);
    assert.deepEqual(me.body.user.permissions, ['role.manage']);
  });

  it('si la base ya no concede role.manage, la misma sesión pasa a 403 sin volver a entrar', async () => {
    const cliente = createClient();
    await cliente.login(USERNAME, PASSWORD);
    assert.equal((await cliente.get('/api/roles/permissions')).status, 200);

    // loadUser relee los permisos en cada petición: quitarlo en la base debe
    // cambiar la respuesta en la sesión ya abierta.
    const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(ROLE_CODE).id;
    const permId = db.prepare('SELECT id FROM permissions WHERE code = ?').get('role.manage').id;
    db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?').run(roleId, permId);

    try {
      const res = await cliente.get('/api/roles/permissions');
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, { error: 'No tiene permiso para realizar esta acción' });
    } finally {
      db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(roleId, permId);
    }

    assert.equal((await cliente.get('/api/roles/permissions')).status, 200, 'al restituirlo vuelve a 200');
  });

  it('restituye el estado de la base tras cada prueba', async () => {
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME).id;
    const roleId = db.prepare('SELECT role_id FROM users WHERE id = ?').get(id).role_id;
    const codes = db.prepare(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? ORDER BY p.code`,
    ).all(roleId).map((r) => r.code);
    assert.deepEqual(codes, ['role.manage']);
  });
});