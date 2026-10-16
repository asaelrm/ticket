import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

const PASSWORD = 'Prueba1234!';

let admin;
let tech;
let emp;

let seq = 0;
const uniq = (prefix) => `${prefix} ${Date.now()}-${seq++}`;

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  tech = createClient();
  await tech.login('tecnico', 'Tecnico1234!');
  emp = createClient();
  await emp.login('empleado', 'Empleado1234!');
});

async function createCategory(over = {}) {
  const res = await admin.post('/api/kb-categories', { name: uniq('Nueva'), ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.category;
}

describe('catálogo de categorías de conocimiento', () => {
  it('viene sembrado con las siete categorías iniciales', async () => {
    const res = await tech.get('/api/kb-categories');
    assert.equal(res.status, 200);
    const names = res.body.data.map((c) => c.name);
    const expected = [
      'Hardware y equipos',
      'Redes y conectividad',
      'Sistemas y software',
      'Cuentas y accesos',
      'Correo y comunicación',
      'Procedimientos',
      'General',
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `falta ${name}`);
    }
  });

  it('exige kb.view para leer el catálogo', async () => {
    const no = await admin.get('/api/kb-categories');
    assert.equal(no.status, 200);
  });

  it('cuenta solo los artículos publicados de cada categoría', async () => {
    const category = await createCategory({ name: uniq('Contada') });
    assert.equal(category.articles_count, 0);

    const draft = await tech.post('/api/kb-articles', {
      title: uniq('Borrador'),
      summary: 's',
      description: 'd',
      solution: 'sol',
      category_id: category.id,
    });
    await tech.post(`/api/kb-articles/${draft.body.article.id}/publish`);

    const after = await admin.get(`/api/kb-categories/${category.id}`);
    assert.equal(after.body.category.articles_count, 1);
  });

  it('exige kb.manage para crear y editar', async () => {
    const category = await createCategory({ name: uniq('Protegida') });
    const forbid = await tech.post('/api/kb-categories', { name: uniq('No autorizado') });
    assert.equal(forbid.status, 403);
    const forbidPatch = await tech.patch(`/api/kb-categories/${category.id}`, { name: uniq('Tampoco') });
    assert.equal(forbidPatch.status, 403);
  });

  it('crea con color por defecto y acepta un color hexadecimal válido', async () => {
    const plain = await createCategory({ name: uniq('Sin color') });
    assert.equal(plain.color, '#64748b');

    const colored = await createCategory({ name: uniq('Coloreada'), color: '#0ea5e9' });
    assert.equal(colored.color, '#0ea5e9');
  });

  it('descarta un color que no sea un hexadecimal de seis dígitos', async () => {
    const evil = await createCategory({ name: uniq('Color malo'), color: 'red;background:url(x)' });
    assert.equal(evil.color, '#64748b');
  });

  it('exige nombre y limita su longitud', async () => {
    const empty = await admin.post('/api/kb-categories', { name: '  ' });
    assert.equal(empty.status, 400);

    const long = await admin.post('/api/kb-categories', { name: 'a'.repeat(101) });
    assert.equal(long.status, 400);
  });

  it('rechaza nombres duplicados sin distinguir mayúsculas', async () => {
    const name = uniq('Única');
    await createCategory({ name });
    const dup = await admin.post('/api/kb-categories', { name: name.toUpperCase() });
    assert.equal(dup.status, 409);
  });

  it('rechaza renombrar a una categoría ya existente', async () => {
    const a = await createCategory({ name: uniq('A') });
    const b = await createCategory({ name: uniq('B') });
    const res = await admin.patch(`/api/kb-categories/${b.id}`, { name: a.name });
    assert.equal(res.status, 409);
  });

  it('renombra, recolorea y desactiva sin romper los artículos que la usan', async () => {
    const category = await createCategory({ name: uniq('Original') });
    const article = await tech.post('/api/kb-articles', {
      title: uniq('Con categoría viva'),
      summary: 's',
      description: 'd',
      solution: 'sol',
      category_id: category.id,
    });
    assert.equal(article.status, 201);

    const res = await admin.patch(`/api/kb-categories/${category.id}`, {
      name: uniq('Renombrada'),
      color: '#be123c',
      active: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.category.active, 0);
    assert.equal(res.body.category.color, '#be123c');

    // El artículo conserva su categoría aunque esta deje de ser elegible.
    const detail = await tech.get(`/api/kb-articles/${article.body.article.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.article.category_id, category.id);

    // Y ya no se puede asignar a artículos nuevos.
    const nuevo = await tech.post('/api/kb-articles', {
      title: uniq('No puede usar la inactiva'),
      summary: 's',
      description: 'd',
      solution: 'sol',
      category_id: category.id,
    });
    assert.equal(nuevo.status, 400);
  });

  it('oculta las categorías desactivadas a quien no puede gestionarlas', async () => {
    const category = await createCategory({ name: uniq('Oculta') });
    await admin.patch(`/api/kb-categories/${category.id}`, { active: false });

    const visible = await tech.get('/api/kb-categories');
    assert.equal(visible.status, 200);
    assert.equal(visible.body.data.map((c) => c.id).includes(category.id), false);
    assert.equal(visible.body.data.every((c) => c.active === 1), true);

    // `active=0` no eleva permisos: kb.view no autoriza a enumerar inactivas.
    const forgedFilter = await tech.get('/api/kb-categories?active=0');
    assert.equal(forgedFilter.status, 200);
    assert.equal(forgedFilter.body.data.map((c) => c.id).includes(category.id), false);
    assert.equal(forgedFilter.body.data.every((c) => c.active === 1), true);

    const direct = await tech.get(`/api/kb-categories/${category.id}`);
    assert.equal(direct.status, 404);

    // Quien administra sí puede enumerarlas y abrirlas.
    const manager = await admin.get('/api/kb-categories?active=0');
    assert.equal(manager.body.data.map((c) => c.id).includes(category.id), true);
    assert.equal((await admin.get(`/api/kb-categories/${category.id}`)).status, 200);
  });

  it('devuelve 404 para una categoría inexistente', async () => {
    const res = await admin.get('/api/kb-categories/999999');
    assert.equal(res.status, 404);
    const patch = await admin.patch('/api/kb-categories/999999', { name: uniq('Fantasma') });
    assert.equal(patch.status, 404);
  });

  it('no tiene ruta de borrado: las categorías se desactivan', async () => {
    const category = await createCategory({ name: uniq('Indesestructible') });
    const res = await admin.del(`/api/kb-categories/${category.id}`);
    assert.equal(res.status, 404);
    assert.equal((await admin.get(`/api/kb-categories/${category.id}`)).status, 200);
  });

  it('mantiene los artículos publicados visibles al navegar por una categoría desactivada', async () => {
    const category = await createCategory({ name: uniq('Histórica') });
    const article = await tech.post('/api/kb-articles', {
      title: uniq('Histórico'),
      summary: 's',
      description: 'd',
      solution: 'sol',
      category_id: category.id,
    });
    await tech.post(`/api/kb-articles/${article.body.article.id}/publish`);
    await admin.patch(`/api/kb-categories/${category.id}`, { active: false });

    // El filtro por id sigue funcionando: el artículo no desaparece del índice.
    const res = await emp.get(`/api/kb-articles?category=${category.id}&perPage=100`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.map((a) => a.id).includes(article.body.article.id), true);
  });
});
