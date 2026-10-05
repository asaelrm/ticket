import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

// Tests de A3 sobre `routes/categories.js`, el primer consumidor real que usa
// el contrato. La mayoría de este archivo ya estaba cubierto de forma
// indirecta; lo que se verifica aquí es justo lo que la migración podía
// romper: que las respuestas HTTP no cambien, que los errores sigan llegando al
// error handler (handlers async) y que los valores del usuario sigan yendo
// enlazados y no concatenados.

let admin;
let tech;

let seq = 0;
const uniq = (prefix) => `${prefix} ${Date.now()}-${seq++}`;

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  tech = createClient();
  await tech.login('tecnico', 'Tecnico1234!');
});

async function createCategory(over = {}) {
  const res = await admin.post('/api/categories', { name: uniq('Nueva'), ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.category;
}

describe('categorías sobre el contrato de datos', () => {
  it('crea y devuelve la categoría con la misma forma de respuesta', async () => {
    const res = await admin.post('/api/categories', {
      name: uniq('Contrato'),
      description: 'creada vía contract.insertAndGetId',
      color: '#0ea5e9',
    });

    assert.equal(res.status, 201);
    // `insertAndGetId` devuelve `id` como número, no como el `bigint` crudo de
    // node:sqlite. Sin esto, `res.json` habría perdido el id por serializar
    // un BigInt.
    assert.equal(typeof res.body.category.id, 'number');
    assert.equal(res.body.category.color, '#0ea5e9');

    const detail = await admin.get(`/api/categories/${res.body.category.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.category.name, res.body.category.name);
  });

  it('el listado sale en el mismo orden por nombre', async () => {
    const res = await admin.get('/api/categories');
    assert.equal(res.status, 200);
    const names = res.body.data.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'es')));
  });

  it('filtra por active y añade tickets_count sin cambiar el JSON', async () => {
    const base = await createCategory({ name: uniq('Conteo') });

    const plain = await admin.get('/api/categories');
    assert.equal(plain.status, 200);
    assert.equal('tickets_count' in plain.body.data[0], false);

    const withCounts = await admin.get('/api/categories?withCounts=1');
    assert.equal(withCounts.status, 200);
    const row = withCounts.body.data.find((c) => c.id === base.id);
    // Categoría recién creada: cero tickets, no `undefined`.
    assert.equal(row.tickets_count, 0);
  });

  it('los errores de validación siguen llegando al error handler como 400', async () => {
    // Este es el test que fija el wrapper asyncHandler: Express 4 no reenvía
    // rechazos de promesas, así que sin él esta petición se quedaría colgada.
    const empty = await admin.post('/api/categories', { name: '   ' });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields);

    const long = await admin.post('/api/categories', { name: 'a'.repeat(101) });
    assert.equal(long.status, 400);
  });

  it('devuelve 404 con el mismo cuerpo para un id inexistente o no numérico', async () => {
    const missing = await admin.get('/api/categories/999999');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Categoría no encontrada' });

    const patch = await admin.patch('/api/categories/999999', { name: uniq('Fantasma') });
    assert.equal(patch.status, 404);
    assert.deepEqual(patch.body, { error: 'Categoría no encontrada' });
  });

  it('mantiene el 409 por nombre duplicado sin distinguir mayúsculas', async () => {
    const name = uniq('Única');
    await createCategory({ name });
    const dup = await admin.post('/api/categories', { name: name.toUpperCase() });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.body, { error: 'Ya existe una categoría con ese nombre' });

    const renamed = await admin.patch('/api/categories', { name: uniq('Nada') });
    assert.equal(renamed.status, 404);
  });

  it('exige category.manage para crear y editar', async () => {
    const category = await createCategory({ name: uniq('Protegida') });

    const forbidPost = await tech.post('/api/categories', { name: uniq('No autorizado') });
    assert.equal(forbidPost.status, 403);

    const forbidPatch = await tech.patch(`/api/categories/${category.id}`, { name: uniq('Tampoco') });
    assert.equal(forbidPatch.status, 403);

    // Un 403 no debe haber tocado nada.
    const after = await admin.get(`/api/categories/${category.id}`);
    assert.equal(after.body.category.name, category.name);
  });

  it('exige autenticación', async () => {
    const anon = createClient();
    const res = await anon.get('/api/categories');
    assert.equal(res.status, 401);
  });

  it('trata el nombre del usuario como valor, nunca como SQL', async () => {
    const hostile = `${uniq('Injection')}') OR 1=1 --`;
    const created = await admin.post('/api/categories', { name: hostile });
    assert.equal(created.status, 201);
    // El texto se guardó tal cual: si el valor se hubiera concatenado en el
    // SQL, el INSERT habría affectado otras filas o fallado.
    assert.equal(created.body.category.name, hostile);

    const detail = await admin.get(`/api/categories/${created.body.category.id}`);
    assert.equal(detail.body.category.name, hostile);

    // Y el listado sigue devolviendo exactamente las filas que existen.
    const list = await admin.get('/api/categories');
    const match = list.body.data.filter((c) => c.name === hostile);
    assert.equal(match.length, 1);
  });

  it('el PATCH actualiza solo los campos enviados', async () => {
    const category = await createCategory({ name: uniq('Parcial'), description: 'original', color: '#123456' });

    const res = await admin.patch(`/api/categories/${category.id}`, { description: 'cambiada' });
    assert.equal(res.status, 200);
    assert.equal(res.body.category.description, 'cambiada');
    assert.equal(res.body.category.name, category.name);
    assert.equal(res.body.category.color, '#123456');
    // `active` sigue siendo el entero de SQLite, no un booleano.
    assert.equal(res.body.category.active, 1);
  });

  it('desactiva con active:false manteniendo el 0 numérico', async () => {
    const category = await createCategory({ name: uniq('Desactivable') });

    const res = await admin.patch(`/api/categories/${category.id}`, { active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.category.active, 0);

    const listed = await admin.get('/api/categories?active=1');
    assert.equal(listed.body.data.some((c) => c.id === category.id), false);
  });
});