import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';
import {
  MAX_ARTICLE_TITLE,
  MAX_ARTICLE_SUMMARY,
  MAX_ARTICLE_KEYWORDS,
  normalizeKeywords,
  validateArticleFields,
} from '../src/utils/articleLimits.js';

const PASSWORD = 'Prueba1234!';

let admin;
let tech;
let techId;
let tech2;
let tech2Id;
let emp;
let empId;
let empRoleId;
let techRoleId;
let catId;

let seq = 0;
const uniq = (prefix) => `${prefix} ${Date.now()}-${seq++}`;

async function createUser({ username, roleId }) {
  const res = await admin.post('/api/users', {
    name: username,
    last_name: 'Prueba',
    username,
    email: `${username}@empresa.com`,
    password: PASSWORD,
    role_id: roleId,
    active: true,
  });
  assert.equal(res.status, 201);
  const client = createClient();
  await client.login(username, PASSWORD);
  return { client, id: res.body.user.id };
}

/**
 * Aplica permisos temporales a un rol y los restaura pase lo que pase. Los
 * permisos se releen en cada petición, así que las sesiones ya abiertas ven el
 * cambio sin volver a iniciar sesión.
 */
async function withRolePermissions(roleId, permissions, fn) {
  const roles = (await admin.get('/api/roles')).body.roles;
  const original = roles.find((r) => r.id === roleId).permissions;
  try {
    const patch = await admin.patch(`/api/roles/${roleId}/permissions`, { permissions });
    assert.equal(patch.status, 200);
    await fn(original);
  } finally {
    const restore = await admin.patch(`/api/roles/${roleId}/permissions`, { permissions: original });
    assert.equal(restore.status, 200);
  }
}

const VALID = {
  title: 'Restablecer la contraseña de Outlook',
  summary: 'Pasos para restablecer la credencial de correo corporativo.',
  description: '## Síntomas\n\nEl usuario no puede acceder a su buzón.',
  solution: '1. Verificar la identidad del usuario.\n2. Restablecer en el portal.',
  keywords: 'correo, contraseña, outlook',
};

function articlePayload(over = {}) {
  return { ...VALID, ...over };
}

/** Crea un artículo borrador y devuelve su id. */
async function createDraft(client, over = {}) {
  const res = await client.post('/api/kb-articles', articlePayload(over));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.article;
}

async function publish(client, id) {
  const res = await client.post(`/api/kb-articles/${id}/publish`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.article;
}

async function makeTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: 'Impresora sin papel',
    description: 'La impresora no imprime',
    category_id: 1,
    priority: 'HIGH',
    ...over,
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

async function resolveTicket(client, id, over = {}) {
  const res = await client.post(`/api/tickets/${id}/resolve`, {
    resolution: 'Se reestableció la cola de impresión y se reinició el servicio.',
    ...over,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.ticket;
}

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  tech = createClient();
  await tech.login('tecnico', 'Tecnico1234!');
  emp = createClient();
  await emp.login('empleado', 'Empleado1234!');

  techId = (await tech.get('/api/auth/me')).body.user.id;
  empId = (await emp.get('/api/auth/me')).body.user.id;
  const roles = (await admin.get('/api/roles')).body.roles;
  techRoleId = roles.find((r) => r.code === 'TECHNICIAN').id;
  empRoleId = roles.find((r) => r.code === 'EMPLOYEE').id;

  tech2 = await createUser({ username: `kbtec${Date.now() % 100000}`, roleId: techRoleId });
  tech2Id = tech2.id;

  const cats = (await tech.get('/api/kb-categories')).body.data;
  catId = cats[0].id;
});

// ------------------------------------------------------------------ utilidades

describe('contrato de artículos', () => {
  it('expone los mismos límites que validan el esquema y el formulario', () => {
    assert.equal(MAX_ARTICLE_TITLE, 200);
    assert.equal(MAX_ARTICLE_SUMMARY, 500);
    assert.equal(MAX_ARTICLE_KEYWORDS, 200);
  });

  it('admite exactamente los tres estados del ciclo de vida', async () => {
    const { ARTICLE_STATUSES } = await import('../src/utils/articleLimits.js');
    assert.deepEqual(ARTICLE_STATUSES, ['DRAFT', 'PUBLISHED', 'ARCHIVED']);
  });

  it('normaliza las palabras clave recortando, colapsando espacios y limitando', () => {
    assert.equal(normalizeKeywords('  red ,  LAN ,, switch  '), 'red, LAN, switch');
    assert.equal(normalizeKeywords(''), '');
    assert.equal(normalizeKeywords('a'.repeat(400)).length, MAX_ARTICLE_KEYWORDS);
  });

  it('exige título, resumen, descripción y solución', () => {
    const bad = validateArticleFields({ title: '', summary: 'x', description: 'y', solution: 'z' });
    assert.equal(bad.ok, false);
    assert.ok(bad.fields['El título']);

    const tooLong = validateArticleFields({
      title: 'a'.repeat(MAX_ARTICLE_TITLE + 1),
      summary: 'x',
      description: 'y',
      solution: 'z',
    });
    assert.equal(tooLong.ok, false);

    const good = validateArticleFields(VALID);
    assert.equal(good.ok, true);
  });
});

describe('creación de artículos', () => {
  it('crea siempre un borrador, nunca un artículo publicado', async () => {
    const article = await createDraft(tech);
    assert.equal(article.status, 'DRAFT');
    assert.equal(article.published_at, null);
    assert.equal(article.view_count, 0);
    assert.equal(article.is_featured, 0);
  });

  it('toma el autor de la sesión e ignora el que venga en el cuerpo', async () => {
    const article = await createDraft(tech, {
      title: uniq('Inyección de campos'),
      author_id: empId,
      status: 'PUBLISHED',
      view_count: 999,
      published_at: '2020-01-01T00:00:00.000Z',
      is_featured: 1,
    });
    assert.equal(article.author_id, techId);
    assert.equal(article.status, 'DRAFT');
    assert.equal(article.view_count, 0);
    assert.equal(article.published_at, null);
    assert.equal(article.is_featured, 0);
  });

  it('devuelve el cuerpo completo en la respuesta de creación', async () => {
    const article = await createDraft(tech, { title: uniq('Con cuerpo') });
    assert.equal(article.description, VALID.description);
    assert.equal(article.solution, VALID.solution);
    assert.equal(article.keywords, VALID.keywords);
  });

  it('rechaza campos vacíos o demasiado largos', async () => {
    const empty = await tech.post('/api/kb-articles', articlePayload({ title: '   ' }));
    assert.equal(empty.status, 400);
    assert.ok(empty.body.fields['El título']);

    const long = await tech.post('/api/kb-articles', articlePayload({ title: 'a'.repeat(201) }));
    assert.equal(long.status, 400);

    const noSolution = await tech.post('/api/kb-articles', articlePayload({ solution: '' }));
    assert.equal(noSolution.status, 400);
    assert.ok(noSolution.body.fields['La solución']);
  });

  it('acepta un artículo sin categoría pero rechaza una categoría inexistente', async () => {
    const without = await createDraft(tech, { title: uniq('Sin categoría'), category_id: null });
    assert.equal(without.category_id, null);

    const bad = await tech.post('/api/kb-articles', articlePayload({ title: uniq('Cat mala'), category_id: 999999 }));
    assert.equal(bad.status, 400);
  });

  it('no deja duplicar el título entre los artículos no archivados del mismo autor', async () => {
    const title = uniq('Duplicado');
    await createDraft(tech, { title });
    const dup = await tech.post('/api/kb-articles', articlePayload({ title }));
    assert.equal(dup.status, 409);
  });

  it('permite el mismo título a otro autor', async () => {
    const title = uniq('Compartido');
    await createDraft(tech, { title });
    const other = await tech2.client.post('/api/kb-articles', articlePayload({ title }));
    assert.equal(other.status, 201);
  });
});

describe('permisos por rol', () => {
  it('un empleado sin kb.create no puede crear artículos', async () => {
    const res = await emp.post('/api/kb-articles', articlePayload({ title: uniq('Empleado') }));
    assert.equal(res.status, 403);
  });

  it('un empleado ni siquiera alcanza la ruta: 403 y el artículo queda intacto', async () => {
    const article = await createDraft(tech, { title: uniq('Privado') });
    const patch = await emp.patch(`/api/kb-articles/${article.id}`, { summary: 'Secuestrado' });
    assert.equal(patch.status, 403);
    const pub = await emp.post(`/api/kb-articles/${article.id}/publish`);
    assert.equal(pub.status, 403);
    const feature = await emp.post(`/api/kb-articles/${article.id}/feature`);
    assert.equal(feature.status, 403);

    const fresh = await tech.get(`/api/kb-articles/${article.id}`);
    assert.equal(fresh.body.article.summary, VALID.summary);
    assert.equal(fresh.body.article.status, 'DRAFT');
    assert.equal(fresh.body.article.is_featured, 0);
  });

  it('un usuario sin ningún permiso de kb recibe 403 en el listado', async () => {
    await withRolePermissions(empRoleId, ['ticket.create', 'ticket.view.own', 'ticket.comment'], async () => {
      const list = await emp.get('/api/kb-articles');
      assert.equal(list.status, 403);
      const cats = await emp.get('/api/kb-categories');
      assert.equal(cats.status, 403);
    });
  });

  it('un técnico no edita ni publica el artículo de otro técnico', async () => {
    const article = await createDraft(tech, { title: uniq('De otro') });
    const patch = await tech2.client.patch(`/api/kb-articles/${article.id}`, { summary: 'Cambio ajeno' });
    assert.equal(patch.status, 404);
    const pub = await tech2.client.post(`/api/kb-articles/${article.id}/publish`);
    assert.equal(pub.status, 404);
  });

  it('un kb.manage administra artículos de cualquier autor', async () => {
    const article = await createDraft(tech, { title: uniq('Moderable') });
    const patch = await admin.patch(`/api/kb-articles/${article.id}`, { summary: 'Corregido por administración' });
    assert.equal(patch.status, 200);
    const pub = await admin.post(`/api/kb-articles/${article.id}/publish`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.article.status, 'PUBLISHED');
  });

  it('un kb.create sin kb.publish no puede publicar', async () => {
    const article = await createDraft(tech, { title: uniq('Sin publicar') });
    await withRolePermissions(techRoleId, ['kb.view', 'kb.create'], async () => {
      const res = await tech.post(`/api/kb-articles/${article.id}/publish`);
      assert.equal(res.status, 403);
    });
    // Ni siquiera su propio borrador cambia de estado.
    assert.equal((await tech.get(`/api/kb-articles/${article.id}`)).body.article.status, 'DRAFT');
  });

  it('un kb.publish sin kb.create no publica artículos ajenos', async () => {
    const article = await createDraft(tech, { title: uniq('Sin crear') });
    await withRolePermissions(techRoleId, ['kb.view', 'kb.publish'], async () => {
      // Alcanza la ruta (tiene kb.publish) pero no es el autor: 404, no 403.
      const res = await tech2.client.post(`/api/kb-articles/${article.id}/publish`);
      assert.equal(res.status, 404);
    });
  });
});

describe('visibilidad de borradores y archivados', () => {
  it('el borrador de otro autor responde 404 y no 403', async () => {
    const article = await createDraft(tech, { title: uniq('Secreto') });
    const res = await tech2.client.get(`/api/kb-articles/${article.id}`);
    assert.equal(res.status, 404);
  });

  it('el autor sí ve su propio borrador y un kb.manage también', async () => {
    const article = await createDraft(tech, { title: uniq('Mio') });
    assert.equal((await tech.get(`/api/kb-articles/${article.id}`)).status, 200);
    assert.equal((await admin.get(`/api/kb-articles/${article.id}`)).status, 200);
  });

  it('el listado público nunca incluye borradores ni archivados, ni en el total', async () => {
    const draft = await createDraft(tech, { title: uniq('Borrador oculto') });
    const archived = await createDraft(tech, { title: uniq('Archivado oculto') });
    await publish(tech, archived.id);
    assert.equal((await tech.post(`/api/kb-articles/${archived.id}/archive`)).status, 200);

    const res = await emp.get('/api/kb-articles?perPage=100');
    assert.equal(res.status, 200);
    const ids = res.body.data.map((a) => a.id);
    assert.ok(!ids.includes(draft.id));
    assert.ok(!ids.includes(archived.id));
  });

  it('?status=DRAFT no abre un canal al listado público', async () => {
    const draft = await createDraft(tech, { title: uniq('Truco de estado') });
    const res = await emp.get('/api/kb-articles?status=DRAFT&perPage=100');
    assert.equal(res.status, 200);
    assert.ok(!res.body.data.map((a) => a.id).includes(draft.id));
  });

  it('rechaza un estado inválido', async () => {
    const res = await emp.get('/api/kb-articles?status=BORRADOR');
    assert.equal(res.status, 400);
  });

  it('el archivado sigue visible en /mine y en /manage pero no en el público', async () => {
    const article = await createDraft(tech, { title: uniq('Archivado visible') });
    await publish(tech, article.id);
    await tech.post(`/api/kb-articles/${article.id}/archive`);

    const mine = await tech.get('/api/kb-articles/mine?perPage=100');
    assert.equal(mine.body.data.map((a) => a.id).includes(article.id), true);
    assert.equal(mine.body.data.find((a) => a.id === article.id).status, 'ARCHIVED');

    const manage = await admin.get('/api/kb-articles/manage?perPage=100');
    assert.equal(manage.body.data.map((a) => a.id).includes(article.id), true);

    const publicList = await emp.get('/api/kb-articles?perPage=100');
    assert.equal(publicList.body.data.map((a) => a.id).includes(article.id), false);
  });

  it('un artículo archivado sigue siendo legible por quien podía verlo', async () => {
    const article = await createDraft(tech, { title: uniq('Archivado legible') });
    await publish(tech, article.id);
    await tech.post(`/api/kb-articles/${article.id}/archive`);
    assert.equal((await tech.get(`/api/kb-articles/${article.id}`)).status, 200);
  });
});

describe('ciclo de vida', () => {
  it('publicar sella published_at y despublicar vuelve al borrador', async () => {
    const article = await createDraft(tech, { title: uniq('Ciclo') });
    const published = await publish(tech, article.id);
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(published.published_at);

    const back = await tech.post(`/api/kb-articles/${article.id}/unpublish`);
    assert.equal(back.status, 200);
    assert.equal(back.body.article.status, 'DRAFT');
  });

  it('rechaza publicar dos veces o despublicar algo que no está publicado', async () => {
    const article = await createDraft(tech, { title: uniq('Transición inválida') });
    await publish(tech, article.id);
    assert.equal((await tech.post(`/api/kb-articles/${article.id}/publish`)).status, 400);
    assert.equal((await tech.post(`/api/kb-articles/${article.id}/unpublish`)).status, 200);
    assert.equal((await tech.post(`/api/kb-articles/${article.id}/unpublish`)).status, 400);
  });

  it('archiva desde publicado y vuelve a publicar desde archivado', async () => {
    const article = await createDraft(tech, { title: uniq('Archivo') });
    await publish(tech, article.id);
    assert.equal((await tech.post(`/api/kb-articles/${article.id}/archive`)).status, 200);
    const again = await tech.post(`/api/kb-articles/${article.id}/publish`);
    assert.equal(again.status, 200);
    assert.equal(again.body.article.status, 'PUBLISHED');
  });

  it('al archivar se libera el título para reutilizarlo', async () => {
    const title = uniq('Título reciclable');
    const first = await createDraft(tech, { title });
    await tech.post(`/api/kb-articles/${first.id}/archive`);
    const second = await tech.post('/api/kb-articles', articlePayload({ title }));
    assert.equal(second.status, 201);
  });

  it('no existe ninguna ruta de borrado', async () => {
    const article = await createDraft(tech, { title: uniq('Sin borrar') });
    const res = await tech.del(`/api/kb-articles/${article.id}`);
    assert.equal(res.status, 404);
  });

  it('editar un artículo publicado no lo despublica', async () => {
    const article = await createDraft(tech, { title: uniq('Editado en vivo') });
    await publish(tech, article.id);
    const patch = await tech.patch(`/api/kb-articles/${article.id}`, { summary: 'Resumen corregido' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.article.status, 'PUBLISHED');
  });

  it('el PATCH ignora status, author_id, view_count y published_at', async () => {
    const article = await createDraft(tech, { title: uniq('Patch acotado') });
    await publish(tech, article.id);
    const patch = await tech.patch(`/api/kb-articles/${article.id}`, {
      summary: 'Nuevo resumen',
      author_id: empId,
      status: 'ARCHIVED',
      view_count: 500,
      published_at: null,
      is_featured: 1,
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.article.author_id, techId);
    assert.equal(patch.body.article.status, 'PUBLISHED');
    assert.equal(patch.body.article.view_count, 0);
    assert.ok(patch.body.article.published_at);
    assert.equal(patch.body.article.is_featured, 0);
  });

  it('el PATCH no renombra a un título ya usado por el mismo autor', async () => {
    const first = await createDraft(tech, { title: uniq('A') });
    const second = await createDraft(tech, { title: uniq('B') });
    const res = await tech.patch(`/api/kb-articles/${second.id}`, { title: first.title });
    assert.equal(res.status, 409);
  });

  it('alterna el destacado', async () => {
    const article = await createDraft(tech, { title: uniq('Destacado') });
    await publish(tech, article.id);
    const on = await tech.post(`/api/kb-articles/${article.id}/feature`);
    assert.equal(on.body.article.is_featured, 1);
    const off = await tech.post(`/api/kb-articles/${article.id}/feature`);
    assert.equal(off.body.article.is_featured, 0);
  });
});

describe('contador de visitas', () => {
  it('solo cuenta lecturas de artículos publicados y nunca las del autor', async () => {
    const article = await createDraft(tech, { title: uniq('Contado') });
    await publish(tech, article.id);

    const before = (await emp.get(`/api/kb-articles/${article.id}`)).body.article.view_count;
    const after = (await emp.get(`/api/kb-articles/${article.id}`)).body.article.view_count;
    assert.equal(after, before + 1);

    const authorSees = (await tech.get(`/api/kb-articles/${article.id}`)).body.article.view_count;
    assert.equal(authorSees, after);
  });

  it('no cuenta la lectura de un borrador', async () => {
    const article = await createDraft(tech, { title: uniq('Borrador no contado') });
    await tech.get(`/api/kb-articles/${article.id}`);
    const fresh = await tech.get(`/api/kb-articles/${article.id}`);
    assert.equal(fresh.body.article.view_count, 0);
  });
});

describe('búsqueda, filtros y paginación', () => {
  it('encuentra por cada campo de texto', async () => {
    const article = await createDraft(tech, {
      title: uniq('Buscable'),
      summary: 'resumen conneedle',
      description: 'descripción conneedle',
      solution: 'solución conneedle',
      keywords: 'aguja',
    });
    await publish(tech, article.id);

    for (const term of ['Buscable', 'needle', 'aguja']) {
      const res = await emp.get(`/api/kb-articles?q=${term}&perPage=100`);
      assert.equal(res.status, 200);
      assert.ok(res.body.data.map((a) => a.id).includes(article.id), `no encuentra ${term}`);
    }
  });

  it('es insensible a mayúsculas y tolera espacios sobrantes', async () => {
    const article = await createDraft(tech, { title: uniq('Mayúsculas'), summary: '  NeedleUpper  ' });
    await publish(tech, article.id);
    const res = await emp.get('/api/kb-articles?q=needleupper&perPage=100');
    assert.ok(res.body.data.map((a) => a.id).includes(article.id));
  });

  it('escapa los comodines de SQL en el término', async () => {
    const article = await createDraft(tech, { title: uniq('Comodín') });
    await publish(tech, article.id);
    const res = await emp.get('/api/kb-articles?q=%25&perPage=100');
    assert.equal(res.status, 200);
    assert.ok(!res.body.data.map((a) => a.id).includes(article.id));
  });

  it('una búsqueda en blanco no filtra nada', async () => {
    const res = await emp.get('/api/kb-articles?q=%20%20&perPage=100');
    assert.equal(res.status, 200);
    assert.ok(res.body.total > 0);
  });

  it('filtra por categoría', async () => {
    const other = (await tech.get('/api/kb-categories')).body.data[1];
    const article = await createDraft(tech, { title: uniq('Con filtro'), category_id: other.id });
    await publish(tech, article.id);

    const mine = await emp.get(`/api/kb-articles?category=${other.id}&perPage=100`);
    assert.ok(mine.body.data.map((a) => a.id).includes(article.id));

    const other2 = await emp.get(`/api/kb-articles?category=${catId}&perPage=100`);
    assert.ok(!other2.body.data.map((a) => a.id).includes(article.id));
  });

  it('filtra solo por destacados', async () => {
    const plain = await createDraft(tech, { title: uniq('Sin destacar') });
    const star = await createDraft(tech, { title: uniq('Con destaque') });
    await publish(tech, plain.id);
    await publish(tech, star.id);
    await tech.post(`/api/kb-articles/${star.id}/feature`);

    const res = await emp.get('/api/kb-articles?featured=1&perPage=100');
    const ids = res.body.data.map((a) => a.id);
    assert.ok(ids.includes(star.id));
    assert.ok(!ids.includes(plain.id));
  });

  it('acepta los tres órdenes y elude las claves heredadas de Object.prototype', async () => {
    for (const sort of ['recent', 'popular', 'title', 'constructor', 'toString', '__proto__', 'inventado', '']) {
      const res = await emp.get(`/api/kb-articles?sort=${sort}`);
      assert.equal(res.status, 200, `sort=${sort}`);
      assert.ok(Array.isArray(res.body.data));
    }
  });

  it('ordena por más consultados y por título', async () => {
    const a = await createDraft(tech, { title: uniq('ZZZ Alpha') });
    const b = await createDraft(tech, { title: uniq('AAA Beta') });
    await publish(tech, a.id);
    await publish(tech, b.id);
    await emp.get(`/api/kb-articles/${a.id}`);
    await emp.get(`/api/kb-articles/${a.id}`);

    const popular = await emp.get('/api/kb-articles?sort=popular&perPage=100');
    const ids = popular.body.data.map((x) => x.id);
    assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id));

    const byTitle = await emp.get('/api/kb-articles?sort=title&perPage=100');
    const titles = byTitle.body.data.map((x) => x.title);
    assert.deepEqual(titles, [...titles].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });

  it('limita perPage a 100 y page a 1 como mínimo', async () => {
    const res = await emp.get('/api/kb-articles?perPage=9999&page=0');
    assert.equal(res.body.perPage, 100);
    assert.equal(res.body.page, 1);
  });

  it('aplica el filtro antes de contar: el total no revela borradores ajenos', async () => {
    const mine = await createDraft(tech, { title: uniq('Fuga por el total') });
    const res = await tech2.client.get(`/api/kb-articles?q=${encodeURIComponent(mine.title)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.equal(res.body.data.length, 0);
  });

  it('pagina sin repetir ni perder filas', async () => {
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const a = await createDraft(tech, { title: uniq(`Página ${i}`) });
      await publish(tech, a.id);
      created.push(a.id);
    }
    const first = await emp.get('/api/kb-articles?perPage=2&page=1');
    const second = await emp.get('/api/kb-articles?perPage=2&page=2');
    assert.equal(first.body.data.length, 2);
    const seen = [...first.body.data, ...second.body.data].map((a) => a.id);
    assert.equal(new Set(seen).size, seen.length);
    for (const id of created) assert.ok(seen.includes(id));
  });

  it('/mine filtra por autor y /manage lo ve todo', async () => {
    const mine = await createDraft(tech, { title: uniq('Solo mío') });
    const mineList = await tech.get('/api/kb-articles/mine?perPage=100');
    assert.equal(mineList.body.data.every((a) => a.author_id === techId), true);
    assert.ok(mineList.body.data.map((a) => a.id).includes(mine.id));

    const manage = await admin.get(`/api/kb-articles/manage?author=${techId}&perPage=100`);
    assert.equal(manage.body.data.every((a) => a.author_id === techId), true);
  });
});

describe('historial de cambios', () => {
  it('registra creación, edición, publicación y archivado', async () => {
    const article = await createDraft(tech, { title: uniq('Con historial') });
    await tech.patch(`/api/kb-articles/${article.id}`, { summary: 'Resumen v2' });
    await publish(tech, article.id);
    await tech.post(`/api/kb-articles/${article.id}/archive`);

    const res = await tech.get(`/api/kb-articles/${article.id}/history`);
    assert.equal(res.status, 200);
    const actions = res.body.data.map((h) => h.action);
    assert.deepEqual(actions, ['CREATED', 'UPDATED', 'PUBLISHED', 'ARCHIVED']);
    const updated = res.body.data.find((h) => h.action === 'UPDATED');
    assert.equal(updated.field, 'Resumen');
    assert.equal(updated.new_value, 'Resumen v2');
    assert.equal(updated.user_name.length > 0, true);
  });

  it('guarda un recorte del contenido, nunca el cuerpo completo', async () => {
    const article = await createDraft(tech, { title: uniq('Recorte') });
    const largo = 'x'.repeat(5000);
    await tech.patch(`/api/kb-articles/${article.id}`, { description: largo });
    const res = await tech.get(`/api/kb-articles/${article.id}/history`);
    const updated = res.body.data.find((h) => h.action === 'UPDATED');
    // 117 caracteres + elipsis, nunca los 5000 enviados.
    assert.equal(updated.new_value.length, 118);
    assert.equal(updated.new_value.endsWith('\u2026'), true);
    assert.equal(largo.length > updated.new_value.length, true);
  });

  it('el historial de otro artículo es 404', async () => {
    const article = await createDraft(tech, { title: uniq('Historial ajeno') });
    assert.equal((await tech2.client.get(`/api/kb-articles/${article.id}/history`)).status, 404);
  });
});

describe('almacenamiento verbatim y XSS', () => {
  it('guarda el Markdown sin transformarlo ni escaparlo', async () => {
    const raw = '<script>alert(1)</script> **negrita** [x](javascript:alert(2))';
    const article = await createDraft(tech, { title: uniq('XSS'), solution: raw });
    const res = await tech.get(`/api/kb-articles/${article.id}`);
    assert.equal(res.body.article.solution, raw);
  });
});

describe('relación con tickets', () => {
  it('enlaza y desenlaza un artículo con un ticket visible', async () => {
    const article = await createDraft(tech, { title: uniq('Enlazable') });
    await publish(tech, article.id);
    const ticket = await makeTicket(tech);

    const link = await tech.post(`/api/kb-articles/${article.id}/tickets/${ticket.id}`);
    assert.equal(link.status, 201);

    const dup = await tech.post(`/api/kb-articles/${article.id}/tickets/${ticket.id}`);
    assert.equal(dup.status, 409);

    const list = await tech.get(`/api/kb-articles/${article.id}/tickets`);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.data[0].ticket_number, ticket.ticket_number);
    assert.equal('reporter_id' in list.body.data[0], false);

    const fromTicket = await tech.get(`/api/tickets/${ticket.id}/articles`);
    assert.equal(fromTicket.status, 200);
    assert.equal(fromTicket.body.data.map((a) => a.id).includes(article.id), true);

    const unlink = await tech.del(`/api/kb-articles/${article.id}/tickets/${ticket.id}`);
    assert.equal(unlink.status, 200);
    assert.equal((await tech.get(`/api/kb-articles/${article.id}/tickets`)).body.total, 0);
  });

  it('no enlaza con un ticket que el usuario no puede ver', async () => {
    const article = await createDraft(tech, { title: uniq('Enlace ajeno') });
    await publish(tech, article.id);
    const ticket = await makeTicket(tech2.client);
    assert.equal((await emp.post(`/api/kb-articles/${article.id}/tickets/${ticket.id}`)).status, 404);
  });

  it('el listado de artículos de un ticket ajeno responde 404', async () => {
    const ticket = await makeTicket(tech2.client);
    assert.equal((await emp.get(`/api/tickets/${ticket.id}/articles`)).status, 404);
  });

  it('solo muestra artículos publicados aunque el borrador esté enlazado', async () => {
    const article = await createDraft(tech, { title: uniq('Borrador enlazado') });
    const ticket = await makeTicket(tech);
    await tech.post(`/api/kb-articles/${article.id}/tickets/${ticket.id}`);
    const res = await tech.get(`/api/tickets/${ticket.id}/articles`);
    assert.equal(res.body.data.length, 0);
  });

  it('al borrarse el ticket se limpia el enlace por ON DELETE CASCADE', async () => {
    const article = await createDraft(tech, { title: uniq('Ticket efímero') });
    await publish(tech, article.id);
    const ticket = await makeTicket(tech);
    await tech.post(`/api/kb-articles/${article.id}/tickets/${ticket.id}`);
    assert.equal((await tech.get(`/api/kb-articles/${article.id}/tickets`)).body.total, 1);

    // La API no expone borrado de tickets: se borra la fila para verificar la
    // IntegrityAction del esquema (PRAGMA foreign_keys = ON en db.js).
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    assert.equal((await tech.get(`/api/kb-articles/${article.id}/tickets`)).body.total, 0);
  });

  it('al borrarse el autor el artículo se conserva sin autor (ON DELETE SET NULL)', async () => {
    const usuario = await createUser({ username: `kbsale${Date.now() % 100000}`, roleId: techRoleId });
    const article = await createDraft(usuario.client, { title: uniq('Heredado') });
    await publish(usuario.client, article.id);

    // La API solo desactiva usuarios, no los borra: se borra la fila para
    // verificar la IntegrityAction del esquema.
    db.prepare('DELETE FROM users WHERE id = ?').run(usuario.id);

    const after = await tech.get(`/api/kb-articles/${article.id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.article.author_id, null);
    assert.equal(after.body.article.status, 'PUBLISHED');
    assert.equal((await emp.get('/api/kb-articles?perPage=100')).body.data.map((a) => a.id).includes(article.id), true);
  });
});

describe('previsualización desde un ticket resuelto', () => {
  it('devuelve la solución y la descripción del problema', async () => {
    const ticket = await makeTicket(tech, { title: 'WiFi cae en el almacén' });
    await resolveTicket(tech, ticket.id, { resolution: 'Se reinició el punto de acceso y se actualizó el firmware.' });

    const res = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.preview.title, 'WiFi cae en el almacén');
    assert.equal(res.body.preview.solution, 'Se reinició el punto de acceso y se actualizó el firmware.');
    assert.equal(res.body.preview.description, 'La impresora no imprime');
    assert.equal(res.body.preview.ticket_number, ticket.ticket_number);
  });

  it('no escribe ningún artículo: la previsualización es de solo lectura', async () => {
    const before = (await admin.get('/api/kb-articles/manage?perPage=1')).body.total;
    const ticket = await makeTicket(tech);
    await resolveTicket(tech, ticket.id);
    await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    const after = (await admin.get('/api/kb-articles/manage?perPage=1')).body.total;
    assert.equal(after, before);
  });

  it('nunca copia notas internas, datos del reportante ni adjuntos', async () => {
    const ticket = await makeTicket(tech, {
      title: 'Fuga de credenciales',
      description: 'El usuario perdió su clave',
    });
    await resolveTicket(tech, ticket.id, { resolution: 'Se restableció la contraseña en el portal.' });

    const nota = await tech.post(`/api/tickets/${ticket.id}/comments`, {
      message: 'NOTAINTERNA_CLAVE_MESTRA_ZXCVBNM',
      is_internal: true,
    });
    assert.equal(nota.status, 201);

    const res = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    const dump = JSON.stringify(res.body);
    assert.equal(dump.includes('NOTAINTERNA_CLAVE_MESTRA_ZXCVBNM'), false);
    assert.equal('comments' in res.body.preview, false);
    assert.equal('attachments' in res.body.preview, false);
    assert.equal('reporter_id' in res.body.preview, false);
    assert.equal('reporter_email' in res.body.preview, false);
    assert.equal('pending_reason' in res.body.preview, false);
    assert.equal('reopen_reason' in res.body.preview, false);
    assert.equal('cancel_reason' in res.body.preview, false);
    assert.equal('csat_rating' in res.body.preview, false);
  });

  it('tampoco filtra los motivos internos añadidos tras resolver', async () => {
    const ticket = await makeTicket(tech);
    await resolveTicket(tech, ticket.id);
    await tech.patch(`/api/tickets/${ticket.id}`, { pending_reason: 'MOTIVOINTERNO_SENSIBLE' });
    const res = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    assert.equal(JSON.stringify(res.body).includes('MOTIVOINTERNO_SENSIBLE'), false);
  });

  it('no ofrece un ticket abierto ni uno reabierto con solución residual', async () => {
    const open = await makeTicket(tech);
    const resOpen = await tech.get(`/api/kb-articles/from-ticket/${open.id}`);
    assert.equal(resOpen.status, 400);

    const ticket = await makeTicket(tech);
    await resolveTicket(tech, ticket.id);
    await tech.post(`/api/tickets/${ticket.id}/reopen`, { reason: 'Volvió a fallar' });
    const resReopened = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    assert.equal(resReopened.status, 400);
    assert.equal(JSON.stringify(resReopened.body).includes('Solución anterior'), false);
  });

  it('rechaza un ticket sin solución registrada', async () => {
    const ticket = await makeTicket(tech);
    const res = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    assert.equal(res.status, 400);
  });

  it('no revela un ticket ajeno y exige kb.create', async () => {
    const ticket = await makeTicket(tech2.client);
    await resolveTicket(tech2.client, ticket.id);
    assert.equal((await emp.get(`/api/kb-articles/from-ticket/${ticket.id}`)).status, 403);

    await withRolePermissions(empRoleId, ['kb.view'], async () => {
      assert.equal((await emp.get(`/api/kb-articles/from-ticket/${ticket.id}`)).status, 403);
    });
  });

  it('con notify la solución no se duplica en la previsualización', async () => {
    const ticket = await makeTicket(tech);
    const resolution = 'Se cambió la contraseña y se verificó el acceso.';
    await resolveTicket(tech, ticket.id, { resolution, notify: true });
    const res = await tech.get(`/api/kb-articles/from-ticket/${ticket.id}`);
    assert.equal(res.body.preview.solution, resolution);
  });
});
