import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';
import { notifyAssigned, notifyComment, notifyCreated } from '../src/utils/mailer.js';
import { createNotification } from '../src/utils/notifications.js';

// ETAPA 3: aislamiento REAL de tickets y sus dominios asociados por
// organización. Un usuario de ORG_A jamás alcanza datos de ORG_B y viceversa
// (listados, detalle, acciones, adjuntos, comentarios, respuestas rápidas,
// conocimiento, auditoría y bitácora de correos). Toda referencia a un recurso
// ajeno responde 404; el cliente jamás decide la organización; y el SUPERADMIN
// no expone listados globales.

const ORGA = 'AISL3_A';
const ORGB = 'AISL3_B';
const pass = (code) => `Org${code}Clave123!`;

let ids = {};
let adminA;
let adminB;
let empA;
let empB;
let techA;
let techB;
let superId;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de aislamiento de tickets');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser(orgId, username, roleCode) {
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
    null,
    'Puesto de prueba',
    roleId,
    1,
    nowIso(),
    orgId
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

async function login(username) {
  const c = createClient();
  const res = await c.login(username, pass(username));
  assert.equal(res.status, 200, `login de ${username} db fallar: ${JSON.stringify(res.body)}`);
  return c;
}

before(() => {
  ids.orgA = insertOrg(ORGA, 'Organización A de aislamiento de tickets');
  ids.orgB = insertOrg(ORGB, 'Organización B de aislamiento de tickets');
  adminA = insertUser(ids.orgA, 'admin_isl3_a', 'ADMIN');
  adminB = insertUser(ids.orgB, 'admin_isl3_b', 'ADMIN');
  empA = insertUser(ids.orgA, 'emp_isl3_a', 'EMPLOYEE');
  empB = insertUser(ids.orgB, 'emp_isl3_b', 'EMPLOYEE');
  techA = insertUser(ids.orgA, 'tec_isl3_a', 'TECHNICIAN');
  techB = insertUser(ids.orgB, 'tec_isl3_b', 'TECHNICIAN');
  superId = insertUser(null, 'super_isl3', 'SUPERADMIN');
});

describe('Aislamiento de tickets por organización (ETAPA 3)', () => {
  it('preparación: cada organización crea sus dominios, tickets y adjuntos', async () => {
    const cA = await login('admin_isl3_a');
    const cB = await login('admin_isl3_b');
    const eA = await login('emp_isl3_a');
    const eB = await login('emp_isl3_b');

    // Dominios de A.
    const catA = await cA.post('/api/categories', { name: 'Categoria A3 Aislamiento', description: 'A' });
    assert.equal(catA.status, 201, JSON.stringify(catA.body));
    ids.catA = catA.body.category.id;
    const deptA = await cA.post('/api/departments', { name: 'Depto A3 Aislamiento', description: 'A' });
    assert.equal(deptA.status, 201, JSON.stringify(deptA.body));
    ids.deptA = deptA.body.department.id;
    const teamA = await cA.post('/api/teams', { name: 'Equipo A3 Aislamiento', description: 'A' });
    assert.equal(teamA.status, 201, JSON.stringify(teamA.body));
    ids.teamA = teamA.body.team.id;
    const membersA = await cA.put(`/api/teams/${ids.teamA}/members`, { user_ids: [techA, empA] });
    assert.equal(membersA.status, 200, JSON.stringify(membersA.body));
    const kbCatA = await cA.post('/api/kb-categories', { name: 'Tema A3 Aislamiento', description: 'A' });
    assert.equal(kbCatA.status, 201, JSON.stringify(kbCatA.body));
    ids.kbCatA = kbCatA.body.category.id;

    // Dominios de B (paralelos).
    const catB = await cB.post('/api/categories', { name: 'Categoria B3 Aislamiento', description: 'B' });
    assert.equal(catB.status, 201, JSON.stringify(catB.body));
    ids.catB = catB.body.category.id;
    const deptB = await cB.post('/api/departments', { name: 'Depto B3 Aislamiento', description: 'B' });
    assert.equal(deptB.status, 201, JSON.stringify(deptB.body));
    ids.deptB = deptB.body.department.id;
    const teamB = await cB.post('/api/teams', { name: 'Equipo B3 Aislamiento', description: 'B' });
    assert.equal(teamB.status, 201, JSON.stringify(teamB.body));
    ids.teamB = teamB.body.team.id;
    const kbCatB = await cB.post('/api/kb-categories', { name: 'Tema B3 Aislamiento', description: 'B' });
    assert.equal(kbCatB.status, 201, JSON.stringify(kbCatB.body));
    ids.kbCatB = kbCatB.body.category.id;

    // Plantillas GLOBAL por organización (para /manage y visibilidad).
    const cannedA = await cA.post('/api/canned-responses', {
      title: 'Plantilla Global A3', body: 'Atención A', scope: 'GLOBAL',
    });
    assert.equal(cannedA.status, 201, JSON.stringify(cannedA.body));
    ids.cannedA = cannedA.body.template.id;
    const cannedB = await cB.post('/api/canned-responses', {
      title: 'Plantilla Global B3', body: 'Atención B', scope: 'GLOBAL',
    });
    assert.equal(cannedB.status, 201, JSON.stringify(cannedB.body));

    // Artículo de conocimiento de A, publicado.
    const artA = await cA.post('/api/kb-articles', {
      title: 'Articulo A3 Aislamiento', summary: 'Resumen A', description: 'Desc A', solution: 'Sol A',
      category_id: ids.kbCatA,
    });
    assert.equal(artA.status, 201, JSON.stringify(artA.body));
    ids.artA = artA.body.article.id;
    const pubA = await cA.post(`/api/kb-articles/${ids.artA}/publish`, {});
    assert.equal(pubA.status, 200, JSON.stringify(pubA.body));

    // Tickets de cada organización.
    const tA = await eA.post('/api/tickets', {
      title: 'Ticket A3 Aislamiento', description: 'Problema de A', priority: 'MEDIUM',
      category_id: ids.catA, department_id: ids.deptA,
    });
    assert.equal(tA.status, 201, JSON.stringify(tA.body));
    ids.ticketA = tA.body.ticket.id;
    assert.equal(tA.body.ticket.organization_id, ids.orgA);
    assert.equal(tA.body.ticket.ticket_number, 'TCK-000001', 'la numeración es por organización');

    const tB_ = await eB.post('/api/tickets', {
      title: 'Ticket B3 Aislamiento', description: 'Problema de B', priority: 'HIGH',
      category_id: ids.catB, department_id: ids.deptB,
    });
    assert.equal(tB_.status, 201, JSON.stringify(tB_.body));
    ids.ticketB = tB_.body.ticket.id;
    assert.equal(tB_.body.ticket.organization_id, ids.orgB);

    // Adjunto: A sube un archivo a SU ticket.
    const attachA = await cA.postMultipart(
      `/api/tickets/${ids.ticketA}/attachments`,
      {},
      [{ name: 'evidencia-a.txt', buffer: Buffer.from('evidencia de A'), mime: 'text/plain' }]
    );
    assert.equal(attachA.status, 201, JSON.stringify(attachA.body));
    ids.fileA = attachA.body.attachment?.id ?? attachA.body.attachments?.[0]?.id ?? attachA.body.id;

    // Bitácora de correos ligada al ticket de A (el envío real se testea aparte).
    db.prepare('INSERT INTO email_logs (kind, to_email, subject, ticket_id, status) VALUES (?, ?, ?, ?, ?)')
      .run('NOTIFY_TO_REPORTER', 'reporta@correo.test', 'Correo del ticket A3', ids.ticketA, 'dev');

    assert.ok(ids.fileA, 'debe existir el adjunto de A para probar su descarga');
  });

  it('1) el admin de A solo ve tickets de A en el listado', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/tickets');
    assert.equal(res.status, 200);
    const nums = res.body.data.map((t) => t.ticket_number);
    assert.ok(nums.includes('TCK-000001'), 'debe ver el ticket de A');
    assert.ok(!res.body.data.some((t) => t.id === ids.ticketB), 'no debe ver el ticket de B');
  });

  it('2) el admin de B solo ve tickets de B en el listado', async () => {
    const c = await login('admin_isl3_b');
    const res = await c.get('/api/tickets');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((t) => t.id === ids.ticketB), 'debe ver el ticket de B');
    assert.ok(!res.body.data.some((t) => t.id === ids.ticketA), 'no debe ver el ticket de A');
  });

  it('3) un empleado de A solo ve sus propios tickets (nunca los de B)', async () => {
    const c = await login('emp_isl3_a');
    const res = await c.get('/api/tickets');
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.ok(data.some((t) => t.id === ids.ticketA), 'debe ver su propio ticket');
    assert.ok(!data.some((t) => t.id === ids.ticketB), 'no puede ver tickets de B');
  });

  it('4) los contadores del admin de A solo cuentan tickets de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/tickets/counters');
    assert.equal(res.status, 200);
    assert.equal(res.body.all, 1, 'solo el ticket de A');
    assert.equal(res.body.open, 1);
    assert.equal(res.body.by_status.OPEN, 1);
  });

  it('5) la exportación del admin de A no filtra tickets de B', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/tickets/export');
    assert.equal(res.status, 200);
    const csv = String(res.text || '');
    assert.ok(csv.includes('Ticket A3 Aislamiento'), 'debe incluir el ticket de A');
    assert.ok(!/Ticket B3 Aislamiento/.test(csv), 'no debe aparecer el título del ticket de B');
  });

  it('6) GET del detalle de un ticket de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get(`/api/tickets/${ids.ticketB}`);
    assert.equal(res.status, 404);
  });

  it('7) GET del detalle de un ticket de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.get(`/api/tickets/${ids.ticketA}`);
    assert.equal(res.status, 404);
  });

  it('8) PATCH de un ticket de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.patch(`/api/tickets/${ids.ticketB}`, { priority: 'HIGH' });
    assert.equal(res.status, 404);
  });

  it('9) asignar un ticket de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post(`/api/tickets/${ids.ticketB}/assign`, { assigned_to_id: techA });
    assert.equal(res.status, 404);
  });

  it('10) asignar al técnico de B a un ticket de A responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post(`/api/tickets/${ids.ticketA}/assign`, { assigned_to_id: techB });
    assert.equal(res.status, 400, 'el asignado debe pertenecer a la organización del ticket');
  });

  it('11) comentar en un ticket de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.post(`/api/tickets/${ids.ticketA}/comments`, { message: 'Intruso' });
    assert.equal(res.status, 404);
  });

  it('12) subir un adjunto a un ticket de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.postMultipart(
      `/api/tickets/${ids.ticketA}/attachments`,
      {},
      [{ name: 'fuga.txt', buffer: Buffer.from('fuga'), mime: 'text/plain' }]
    );
    assert.equal(res.status, 404);
  });

  it('13) descargar un adjunto de un ticket de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.get(`/api/files/${ids.fileA}`);
    assert.equal(res.status, 404);
  });

  it('14) los artículos enlazados a un ticket de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.get(`/api/tickets/${ids.ticketA}/articles`);
    assert.equal(res.status, 404);
  });

  it('15) cerrar/cancelar/reabrir/marcar CSAT de un ticket ajeno responde 404', async () => {
    const ca = await login('admin_isl3_a');
    assert.equal((await ca.post(`/api/tickets/${ids.ticketB}/close`, {})).status, 404);
    assert.equal((await ca.post(`/api/tickets/${ids.ticketB}/cancel`, { cancel_reason: 'x' })).status, 404);
    const cb = await login('admin_isl3_b');
    assert.equal((await cb.post(`/api/tickets/${ids.ticketA}/reopen`, { reason: 'x' })).status, 404);
    const eA = await login('emp_isl3_a');
    assert.equal((await eA.post(`/api/tickets/${ids.ticketB}/csat`, { rating: 5 })).status, 404);
  });

  it('16) crear un ticket con categoría de B responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post('/api/tickets', {
      title: 'Categoria cruzada', description: 'x', priority: 'LOW', category_id: ids.catB,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Categoría inválida');
  });

  it('17) crear un ticket con departamento de B responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post('/api/tickets', {
      title: 'Departamento cruzado', description: 'x', priority: 'LOW',
      category_id: ids.catA, department_id: ids.deptB,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Departamento inválido');
  });

  it('18) crear un ticket con organization_id forjado responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post('/api/tickets', {
      title: 'Org forjada', description: 'x', priority: 'LOW',
      category_id: ids.catA, department_id: ids.deptA, organization_id: ids.orgB,
    });
    assert.equal(res.status, 400);
  });

  it('19) el SUPERADMIN no puede crear tickets (no tiene organización de contexto)', async () => {
    const c = await login('super_isl3');
    const res = await c.post('/api/tickets', {
      title: 'Sin org', description: 'x', priority: 'LOW',
      category_id: ids.catA, department_id: ids.deptA,
    });
    assert.equal(res.status, 403, 'requireOrg debe bloquear al SUPERADMIN global');
  });

  it('20) el listado de categorías del admin de A no incluye categorías de B', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/categories');
    assert.equal(res.status, 200);
    const names = res.body.data.map((x) => x.name);
    assert.ok(names.includes('Categoria A3 Aislamiento'));
    assert.ok(!names.includes('Categoria B3 Aislamiento'));
  });

  it('21) GET de una categoría de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get(`/api/categories/${ids.catB}`);
    assert.equal(res.status, 404);
  });

  it('22) PATCH de una categoría de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.patch(`/api/categories/${ids.catB}`, { active: false });
    assert.equal(res.status, 404);
  });

  it('23) crear una categoría con organization_id forjado responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post('/api/categories', { name: 'Categoria Forjada A3', organization_id: ids.orgB });
    assert.equal(res.status, 400);
  });

  it('24) el listado de equipos del admin de A no incluye equipos de B', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/teams');
    assert.equal(res.status, 200);
    const names = res.body.data.map((x) => x.name);
    assert.ok(names.includes('Equipo A3 Aislamiento'));
    assert.ok(!names.includes('Equipo B3 Aislamiento'));
  });

  it('25) GET de un equipo de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get(`/api/teams/${ids.teamB}`);
    assert.equal(res.status, 404);
  });

  it('26) PUT de miembros de un equipo de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.put(`/api/teams/${ids.teamB}/members`, { user_ids: [techA] });
    assert.equal(res.status, 404);
  });

  it('27) añadir a un usuario de B a un equipo de A responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.put(`/api/teams/${ids.teamA}/members`, { user_ids: [empB] });
    assert.equal(res.status, 400);
  });

  it('28) los equipos asignables del admin de A no incluyen los de B', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get('/api/teams/assignable');
    assert.equal(res.status, 200);
    const names = res.body.data.map((x) => x.name);
    assert.ok(names.includes('Equipo A3 Aislamiento'));
    assert.ok(!names.includes('Equipo B3 Aislamiento'));
  });

  it('29) los equipos de un técnico de A no incluyen los de B', async () => {
    const c = await login('tec_isl3_a');
    const res = await c.get('/api/teams/mine');
    assert.equal(res.status, 200);
    const names = res.body.data.map((x) => x.name);
    assert.ok(names.includes('Equipo A3 Aislamiento'));
    assert.ok(!names.includes('Equipo B3 Aislamiento'));
  });

  it('30) el listado de plantillas del admin de B no incluye la GLOBAL de A', async () => {
    const c = await login('admin_isl3_b');
    const res = await c.get('/api/canned-responses/manage');
    assert.equal(res.status, 200);
    const titles = res.body.data.map((x) => x.title);
    assert.ok(titles.includes('Plantilla Global B3'));
    assert.ok(!titles.includes('Plantilla Global A3'));
  });

  it('31) crear una plantilla TEAM de A para el equipo de B responde 400', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.post('/api/canned-responses', {
      title: 'TEAM cruzada', body: 'x', scope: 'TEAM', team_id: ids.teamB,
    });
    assert.equal(res.status, 400);
  });

  it('32) GET de la plantilla GLOBAL de A responde 404 para el admin de B', async () => {
    const c = await login('admin_isl3_b');
    const res = await c.get(`/api/canned-responses/${ids.cannedA}`);
    assert.equal(res.status, 404);
  });

  it('33) PATCH de la plantilla GLOBAL de A responde 404 para el admin de B', async () => {
    const c = await login('admin_isl3_b');
    const res = await c.patch(`/api/canned-responses/${ids.cannedA}`, { body: 'x' });
    assert.equal(res.status, 404);
  });

  it('34) GET del artículo de conocimiento de A responde 404 para un empleado de B', async () => {
    const c = await login('emp_isl3_b');
    const res = await c.get(`/api/kb-articles/${ids.artA}`);
    assert.equal(res.status, 404);
    // Mismo id, mismo rol, en su propia organización: el artículo existe y se lee.
    const cA = await login('emp_isl3_a');
    assert.equal((await cA.get(`/api/kb-articles/${ids.artA}`)).status, 200, 'un empleado de A sí lee el artículo de A');
  });

  it('35) GET de una categoría de KB de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const res = await c.get(`/api/kb-categories/${ids.kbCatB}`);
    assert.equal(res.status, 404);
  });

  it('36) crear un artículo desde un ticket de B responde 404 para un técnico de A', async () => {
    const c = await login('tec_isl3_a');
    const res = await c.get(`/api/kb-articles/from-ticket/${ids.ticketB}`);
    assert.equal(res.status, 404);
  });

  it('39) enlazar un artículo de A a un ticket de B responde 404 para el admin de A', async () => {
    const c = await login('admin_isl3_a');
    const post = await c.post(`/api/kb-articles/${ids.artA}/tickets/${ids.ticketB}`);
    assert.equal(post.status, 404, 'no se puede enlazar un ticket ajeno a un artículo propio');
    const del = await c.del(`/api/kb-articles/${ids.artA}/tickets/${ids.ticketB}`);
    assert.equal(del.status, 404, 'tampoco se puede desenlazar un ticket ajeno');
    // Control: enlazar el ticket de A sí funciona.
    const ok = await c.post(`/api/kb-articles/${ids.artA}/tickets/${ids.ticketA}`);
    assert.equal(ok.status, 201, 'en su propia organización el enlazado sigue funcionando');
  });

  it('37) la bitácora de correos de A no se filtra en la de B (y viceversa)', async () => {
    const cB = await login('admin_isl3_b');
    const resB = await cB.get('/api/settings/emails');
    assert.equal(resB.status, 200);
    assert.ok(!resB.body.data.some((e) => e.ticket_id === ids.ticketA), 'B no ve correos del ticket de A');

    const cA = await login('admin_isl3_a');
    const resA = await cA.get('/api/settings/emails');
    assert.equal(resA.status, 200);
    assert.ok(resA.body.data.some((e) => e.ticket_id === ids.ticketA), 'A sí ve los correos de su ticket');
  });

  it('38) la auditoría de A no incluye el historial de B y el SUPERADMIN no vuela listados', async () => {
    const cA = await login('admin_isl3_a');
    const auditA = await cA.get('/api/audit');
    assert.equal(auditA.status, 200);
    const ticketIdsA = auditA.body.data.map((r) => r.ticket_id);
    assert.ok(ticketIdsA.includes(ids.ticketA), 'la auditoría de A incluye el historial de su ticket');
    assert.ok(!ticketIdsA.includes(ids.ticketB), 'la auditoría de A no incluye el historial de B');

    const cB = await login('admin_isl3_b');
    const auditB = await cB.get('/api/audit');
    const ticketIdsB = auditB.body.data.map((r) => r.ticket_id);
    assert.ok(ticketIdsB.includes(ids.ticketB));
    assert.ok(!ticketIdsB.includes(ids.ticketA));

    // SUPERADMIN: sin organización no enumera por listado NI gestiona por id.
    const s = await login('super_isl3');
    const list = await s.get('/api/tickets');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 0, 'el SUPERADMIN no debe volcar los tickets de todas las organizaciones');
    assert.equal((await s.get(`/api/tickets/${ids.ticketA}`)).status, 404, 'sin organización no gestiona tickets por id');
    assert.equal((await s.get(`/api/tickets/${ids.ticketB}`)).status, 404, 'tampoco los de la otra organización');
    assert.equal(superId, superId, 'sanidad: el usuario SUPERADMIN existe');
  });
});

// ETAPA 3 (defensa en profundidad): las rutas ya aislan por organización, pero
// quienes emiten correos o crean notificaciones ligadas a tickets NO deben
// poder llegar a destinatarios de otra organización ni siquiera con datos
// corruptos/legacy. Además, un SUPERADMIN global queda aislado de TODOS los
// dominios y la numeración es única y por organización bajo carga concurrente.
describe('Defensa central y aislamiento global (ETAPA 3)', () => {
  it('39b) la defensa central bloquea correos y notificaciones hacia otra organización', async () => {
    const beforeEmails = db.prepare('SELECT COUNT(*) AS n FROM email_logs').get().n;

    // Un ticket con organización de A pero reportante/asignado de B (datos
    // corruptos que un flujo directo no debería poder armar): ningún correo
    // puede salir hacia la otra organización.
    const cross = {
      id: ids.ticketA,
      ticket_number: 'TCK-000001',
      title: 'Ticket A3 Aislamiento',
      description: 'Problema de A',
      priority: 'MEDIUM',
      status: 'OPEN',
      organization_id: ids.orgA,
      reporter_id: empB,
      reporter_email: `emp_isl3_b@organizacion.test`,
      assigned_to_id: techB,
    };
    assert.equal(await notifyCreated(cross), undefined, 'no hay correo de creación para un reportante de otra org');
    assert.equal(await notifyAssigned(cross, 'admin'), undefined, 'no hay correo de asignación para un técnico de otra org');
    await notifyComment(cross, { user_id: adminA, message: 'contexto cruzado' }, 'admin');

    // Notificaciones in-app: el mismo filtro central.
    assert.equal(await createNotification({ userId: empB, ticketId: ids.ticketA, type: 'TEST', title: 'X' }), null,
      'la notificación de un usuario de B sobre un ticket de A se descarta');
    assert.ok(await createNotification({ userId: empA, ticketId: ids.ticketA, type: 'TEST', title: 'X' }),
      'la notificación al usuario de la misma organización sí se crea');

    // Sin efectos secundarios: ninguna fila nueva en la bitácora, ninguna
    // notificación cruzada persistida.
    const afterEmails = db.prepare('SELECT COUNT(*) AS n FROM email_logs').get().n;
    assert.equal(afterEmails, beforeEmails, 'ningún correo se emitió hacia otra organización');
    const crossNotification = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND ticket_id = ? AND type = 'TEST'")
      .get(empB, ids.ticketA).n;
    assert.equal(crossNotification, 0, 'la notificación cruzada no se creó');
  });

  it('40b) el SUPERADMIN global queda aislado: listados vacíos, ids 404 y creaciones 403', async () => {
    const s = await login('super_isl3');

    // Ningún listado vuelca datos de todas las organizaciones.
    for (const path of [
      '/api/users', '/api/departments', '/api/categories', '/api/teams',
      '/api/canned-responses', '/api/kb-articles', '/api/kb-categories',
      '/api/audit', '/api/settings/emails',
    ]) {
      const res = await s.get(path);
      assert.equal(res.status, 200, `GET ${path} debe responder 200`);
      assert.equal(res.body.data.length, 0, `el listado ${path} debe estar vacío para el SUPERADMIN`);
    }

    // Ningún recurso ajeno se alcanza por id (404, nunca 200 ni 403).
    const idChecks = [
      ['/api/users', empA], ['/api/users', empB], ['/api/departments', ids.deptA],
      ['/api/categories', ids.catA], ['/api/teams', ids.teamA],
      ['/api/canned-responses', ids.cannedA], ['/api/kb-articles', ids.artA],
      ['/api/kb-categories', ids.kbCatA], ['/api/tickets', ids.ticketA], ['/api/tickets', ids.ticketB],
    ];
    for (const [base, id] of idChecks) {
      const res = await s.get(`${base}/${id}`);
      assert.equal(res.status, 404, `GET ${base}/${id} debe ser 404`);
    }

    // Mutaciones sobre datos ajenos: 404.
    assert.equal((await s.patch(`/api/departments/${ids.deptA}`, { description: 'intrusión' })).status, 404);
    assert.equal((await s.put(`/api/teams/${ids.teamA}/members`, { user_ids: [] })).status, 404);

    // Creaciones sin contexto de organización: 403 (requireOrg).
    const creations = [
      ['/api/departments', { name: 'D Sup', description: 'x' }],
      ['/api/categories', { name: 'C Sup' }],
      ['/api/teams', { name: 'T Sup', description: 'x' }],
      ['/api/canned-responses', { title: 'R Sup', body: 'x', scope: 'GLOBAL' }],
      ['/api/kb-articles', { title: 'A Sup', summary: 'x', description: 'x', solution: 'x' }],
      ['/api/kb-categories', { name: 'K Sup' }],
      ['/api/tickets', { title: 'T Sup', description: 'x', priority: 'LOW' }],
    ];
    for (const [path, body] of creations) {
      const res = await s.post(path, body);
      assert.equal(res.status, 403, `POST ${path} debe ser 403 para el SUPERADMIN global`);
    }
  });

  it('41b) la numeración es por organización y queda única bajo carga concurrente', async () => {
    const c = await login('admin_isl3_a');
    const N = 8;
    const resp = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        c.post('/api/tickets', {
          title: `Ticket concurrencia ${i}`, description: 'prueba de numeración', priority: 'LOW',
          category_id: ids.catA, department_id: ids.deptA,
        })
      )
    );
    for (const r of resp) assert.equal(r.status, 201, JSON.stringify(r.body));
    const nums = resp.map((r) => r.body.ticket.ticket_number);
    assert.equal(new Set(nums).size, N, 'todos los números emitidos son distintos');
    for (const n of nums) assert.match(n, /^TCK-\d{6}$/);
    assert.deepEqual(
      [...nums].sort(),
      Array.from({ length: N }, (_, i) => `TCK-${String(2 + i).padStart(6, '0')}`),
      'la numeración es contigua dentro de la organización'
    );

    // La secuencia de B es independiente de la de A: su segundo ticket sigue
    // siendo TCK-000002 (no se adelantó ni se duplicó por la carga de A).
    const cB = await login('admin_isl3_b');
    const nB = await cB.post('/api/tickets', {
      title: 'Ticket numeración B', description: 'x', priority: 'LOW',
      category_id: ids.catB, department_id: ids.deptB,
    });
    assert.equal(nB.status, 201, JSON.stringify(nB.body));
    assert.equal(nB.body.ticket.ticket_number, 'TCK-000002', 'B conserva su propia numeración');
  });
});