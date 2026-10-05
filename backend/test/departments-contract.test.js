import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from './helpers.js';
import { saveDirectorySnapshot } from '../src/directorySync.js';
import config from '../src/config.js';

// Tests de A5 sobre `routes/departments.js`, migrada al contrato de datos.
//
// `departments.js` es la primera ruta migrada que dispara un efecto secundario
// (`saveDirectorySnapshot()`) en medio de un handler. La parte que importa
// verificar aquí es que ese efecto sigue:
//   1. ocurriendo (el archivo se reescribe),
//   2. ocurriendo DESPUÉS del INSERT/UPDATE y no antes,
//   3. ocurrir también cuando la operación va a terminar en 409 o 404, igual
//      que antes de la migración,
//   4. seguir siendo un archivo sin `password_hash`.
//
// `test/setup.js` pone NODE_ENV=development y un DIRECTORY_SNAPSHOT_FILE
// temporal, así que `saveDirectorySnapshot()` está activo durante la suite
// (la única condición que lo apaga es `enabled: false` explícito o DIRECTORY_SYNC
// apagado). El archivo real nunca se toca.

let admin;
let tech;

let seq = 0;
const uniq = (prefix) => `${prefix} ${Date.now()}-${seq++}`;

const snapshotPath = () => config.directory.snapshotFile;

function readSnapshot() {
  if (!fs.existsSync(snapshotPath())) return null;
  return JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'));
}

/** Huella del snapshot: si el mtime no cambia, el efecto secundario no corrió. */
function snapshotStamp() {
  try {
    return fs.statSync(snapshotPath()).mtimeMs;
  } catch {
    return null;
  }
}

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  tech = createClient();
  await tech.login('tecnico', 'Tecnico1234!');
  // Garantiza que existe antes de medir nada.
  saveDirectorySnapshot();
});

after(() => {
  // No deja un snapshot de la suite acting como directory.json del repo.
  try {
    fs.rmSync(snapshotPath(), { force: true });
  } catch {
    // si no se puede borrar, que no tumbe la suite
  }
});

async function createDepartment(over = {}) {
  const res = await admin.post('/api/departments', { name: uniq('Nuevo'), ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.department;
}

describe('departamentos sobre el contrato de datos', () => {
  it('crea y devuelve el departamento con la misma forma de respuesta', async () => {
    const res = await admin.post('/api/departments', {
      name: uniq('Contrato'),
      description: 'creado vía contract.insertAndGetId',
    });

    assert.equal(res.status, 201);
    // `insertAndGetId` devuelve `id` como número. Con el `bigint` crudo de
    // node:sqlite, `res.json` habría fallado al serializar.
    assert.equal(typeof res.body.department.id, 'number');
    assert.equal(res.body.department.description, 'creado vía contract.insertAndGetId');

    const detail = await admin.get(`/api/departments/${res.body.department.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.department.name, res.body.department.name);
  });

  it('el listado sale ordenado por nombre y filtra por active', async () => {
    const created = await createDepartment({ name: uniq('Zeta') });

    const all = await admin.get('/api/departments');
    assert.equal(all.status, 200);
    const names = all.body.data.map((d) => d.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'es')));

    const active = await admin.get('/api/departments?active=1');
    assert.equal(active.status, 200);
    assert.equal(active.body.data.every((d) => d.active === 1), true);
    assert.equal(active.body.data.some((d) => d.id === created.id), true);
  });

  it('devuelve 404 con el mismo cuerpo para un id inexistente', async () => {
    const missing = await admin.get('/api/departments/999999');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Departamento no encontrado' });

    const patch = await admin.patch('/api/departments/999999', { name: uniq('Fantasma') });
    assert.equal(patch.status, 404);
    assert.deepEqual(patch.body, { error: 'Departamento no encontrado' });
  });

  it('los errores de validación siguen llegando al error handler como 400', async () => {
    const empty = await admin.post('/api/departments', { name: '   ' });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields);

    const long = await admin.post('/api/departments', { name: 'a'.repeat(101) });
    assert.equal(long.status, 400);
  });

  it('mantiene el 409 por nombre duplicado sin distinguir mayúsculas', async () => {
    const name = uniq('Único');
    await createDepartment({ name });
    const dup = await admin.post('/api/departments', { name: name.toUpperCase() });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.body, { error: 'Ya existe un departamento con ese nombre' });
  });

  it('exige department.manage y autenticación', async () => {
    const forbid = await tech.post('/api/departments', { name: uniq('No autorizado') });
    assert.equal(forbid.status, 403);

    const anon = createClient();
    const list = await anon.get('/api/departments');
    assert.equal(list.status, 401);
  });

  it('trata el nombre del usuario como valor enlazado, nunca como SQL', async () => {
    const hostile = `${uniq('Ataque')}') OR 1=1 --`;
    const created = await admin.post('/api/departments', { name: hostile });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.department.name, hostile);

    const detail = await admin.get(`/api/departments/${created.body.department.id}`);
    assert.equal(detail.body.department.name, hostile);

    // El nombre se guardó una sola vez: si el valor se hubiera concatenado, el
    // INSERT habría tocado otras filas o fallado.
    const list = await admin.get('/api/departments');
    assert.equal(list.body.data.filter((d) => d.name === hostile).length, 1);
  });

  it('el PATCH actualiza solo los campos enviados', async () => {
    const dept = await createDepartment({ name: uniq('Parcial'), description: 'original' });

    const res = await admin.patch(`/api/departments/${dept.id}`, { description: 'cambiada' });
    assert.equal(res.status, 200);
    assert.equal(res.body.department.description, 'cambiada');
    assert.equal(res.body.department.name, dept.name);
    assert.equal(res.body.department.active, 1);
  });

  it('desactiva con active:false y desaparece del listado de activos', async () => {
    const dept = await createDepartment({ name: uniq('Desactivable') });

    const res = await admin.patch(`/api/departments/${dept.id}`, { active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.department.active, 0);

    const active = await admin.get('/api/departments?active=1');
    assert.equal(active.body.data.some((d) => d.id === dept.id), false);
  });
});

describe('departamentos y el efecto secundario del directorio', () => {
  it('saveDirectorySnapshot escribe el archivo tras crear', async () => {
    const dept = await createDepartment({ name: uniq('ConSnapshot') });

    const snap = readSnapshot();
    assert.ok(snap, 'el snapshot debe existir después del POST');
    assert.ok(
      snap.departments.some((d) => d.name === dept.name),
      'el departamento recién creado tiene que estar en el snapshot',
    );
  });

  it('el snapshot refleja el PATCH, no solo el alta', async () => {
    const dept = await createDepartment({ name: uniq('Renombrable') });
    const nuevo = uniq('Renombrada');

    const res = await admin.patch(`/api/departments/${dept.id}`, { name: nuevo });
    assert.equal(res.status, 200);

    const snap = readSnapshot();
    const entry = snap.departments.find((d) => d.name === nuevo);
    assert.ok(entry, 'el nombre nuevo debe estar en el snapshot');
    assert.equal(entry.active, 1);
  });

  it('no escribe contraseñas en el snapshot', async () => {
    await createDepartment({ name: uniq('SinSecretos') });

    const snap = readSnapshot();
    assert.equal(snap.version, 2);
    assert.ok(snap.users.length > 0, 'el snapshot incluye usuarios');
    for (const user of snap.users) {
      assert.equal('password_hash' in user, false, 'el snapshot nunca lleva hashes');
    }
  });

  it('un 409 no crea nada ni reescribe el snapshot', async () => {
    const name = uniq('Repetido');
    await createDepartment({ name });

    // El snapshot ya está escrito por el POST anterior. Se espera un turno de
    // evento para que un eventual mtime más fino no dé un falso positivo.
    await new Promise((r) => setTimeout(r, 20));
    const before = snapshotStamp();

    const dup = await admin.post('/api/departments', { name: name.toUpperCase() });
    assert.equal(dup.status, 409);

    assert.equal(snapshotStamp(), before, 'un 409 no debe reescribir el snapshot');
    const snap = readSnapshot();
    assert.equal(snap.departments.filter((d) => d.name === name).length, 1);
  });

  it('un 404 no reescribe el snapshot', async () => {
    await new Promise((r) => setTimeout(r, 20));
    const before = snapshotStamp();

    const missing = await admin.patch('/api/departments/999999', { name: uniq('Fantasma') });
    assert.equal(missing.status, 404);

    assert.equal(snapshotStamp(), before, 'un 404 no debe reescribir el snapshot');
  });

  it('un 403 no reescribe el snapshot', async () => {
    await new Promise((r) => setTimeout(r, 20));
    const before = snapshotStamp();

    const forbid = await tech.post('/api/departments', { name: uniq('Prohibido') });
    assert.equal(forbid.status, 403);

    assert.equal(snapshotStamp(), before, 'un 403 no debe reescribir el snapshot');
  });

  it('el snapshot se escribe después del INSERT: ya incluye el alta', async () => {
    // Si `saveDirectorySnapshot()` se hubiera movido antes del INSERT, el
    // archivo no contendría el departamento nuevo aunque la respuesta fuera 201.
    const dept = await createDepartment({ name: uniq('Orden') });

    const snap = readSnapshot();
    const entry = snap.departments.find((d) => d.name === dept.name);
    assert.ok(entry, 'el snapshot se escribe después del INSERT, no antes');
    // Y el id del snapshot no viene del lastInsertRowid: guarda el perfil, no la clave.
    assert.equal('id' in entry, false);
    assert.deepEqual(Object.keys(entry).sort(), ['active', 'description', 'name']);
  });
});