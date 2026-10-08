import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import { sentEmails } from '../src/utils/mailer.js';
import db from '../src/db.js';
import { runMaintenance } from '../src/utils/jobs.js';
import { SLA_AT_RISK_HOURS } from '../src/utils/sla.js';

let adminC;
let empC;
let adminId;
let techId;
let techEmail;

function emailsOf(kind) {
  return sentEmails.filter((e) => e.kind === kind);
}

function notificationsOf(userId) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC').all(userId);
}

async function newTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Feature ${Math.random().toString(36).slice(2, 7)}`,
    description: 'Descripción de feature',
    category_id: 1,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  const me = await adminC.get('/api/auth/me');
  adminId = me.body.user.id;

  empC = createClient();
  await empC.login('empleado', 'Empleado1234!');

  const roles = await adminC.get('/api/users/roles');
  const techRole = roles.body.roles.find((r) => r.code === 'TECHNICIAN');
  assert.ok(techRole, 'el rol Técnico debe existir en el seed');

  const res = await adminC.post('/api/users', {
    name: 'Técnico',
    last_name: 'Feature',
    username: `tecnico${Math.random().toString(36).slice(2, 7)}`,
    email: `tecnico${Math.random().toString(36).slice(2, 7)}@empresa.com`,
    password: 'Tecnico1234!',
    position: 'Soporte técnico',
    role_id: techRole.id,
  });
  assert.equal(res.status, 201);
  techId = res.body.user.id;
  techEmail = res.body.user.email;
});

beforeEach(() => {
  sentEmails.length = 0;
});

describe('Cancelación de tickets', () => {
  it('cancela con motivo y notifica por correo + in-app', async () => {
    const t = await newTicket(empC);
    const res = await adminC.post(`/api/tickets/${t.id}/cancel`, { reason: 'El usuario ya no lo necesita' });
    assert.equal(res.status, 200);

    const ticket = res.body.ticket;
    assert.equal(ticket.status, 'CANCELLED');
    assert.equal(ticket.cancel_reason, 'El usuario ya no lo necesita');
    assert.equal(ticket.cancelled_by, adminId);
    assert.ok(ticket.cancelled_at, 'debe registrar la fecha de cancelación');

    const mails = emailsOf('cancel');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'empleado@empresa.com');
    assert.match(mails[0].subject, /cancelado/i);

    const n = notificationsOf(t.reporter_id).find((x) => x.type === 'CANCELLED');
    assert.ok(n, 'el reportante debe recibir notificación in-app');
    assert.equal(n.ticket_id, t.id);

    const hist = db.prepare('SELECT * FROM ticket_history WHERE ticket_id = ? AND action = ?').get(t.id, 'CANCELLED');
    assert.ok(hist, 'debe registrarse en el historial');
  });

  it('rechaza cancelar sin motivo', async () => {
    const t = await newTicket(empC);
    const res = await adminC.post(`/api/tickets/${t.id}/cancel`, {});
    assert.equal(res.status, 400);
    const still = db.prepare('SELECT status FROM tickets WHERE id = ?').get(t.id);
    assert.notEqual(still.status, 'CANCELLED');
  });

  it('no permite cancelar dos veces ni tickets resueltos/cerrados', async () => {
    const t = await newTicket(empC);
    await adminC.post(`/api/tickets/${t.id}/cancel`, { reason: 'Motivo' });
    const again = await adminC.post(`/api/tickets/${t.id}/cancel`, { reason: 'Otro' });
    assert.equal(again.status, 400);

    const r = await newTicket(empC);
    await adminC.post(`/api/tickets/${r.id}/resolve`, { resolution: 'Solución lista', notify: '1' });
    const resR = await adminC.post(`/api/tickets/${r.id}/cancel`, { reason: 'Intento' });
    assert.equal(resR.status, 400);

    const c = await newTicket(empC);
    await adminC.post(`/api/tickets/${c.id}/resolve`, { resolution: 'Solución', notify: '1' });
    await adminC.post(`/api/tickets/${c.id}/close`, {});
    const resC = await adminC.post(`/api/tickets/${c.id}/cancel`, { reason: 'Intento' });
    assert.equal(resC.status, 400);
  });

  it('el empleado no puede cancelar', async () => {
    const t = await newTicket(empC);
    const res = await empC.post(`/api/tickets/${t.id}/cancel`, { reason: 'Intento' });
    assert.equal(res.status, 403);
  });
});

describe('Encuesta de satisfacción (CSAT)', () => {
  it('el reportante califica una vez su ticket resuelto', async () => {
    const t = await newTicket(empC);
    await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Solución', notify: '1' });

    const res = await empC.post(`/api/tickets/${t.id}/csat`, { rating: 4, comment: 'Buen servicio' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.csat_rating, 4);
    assert.equal(res.body.ticket.csat_comment, 'Buen servicio');
    assert.ok(res.body.ticket.csat_answered_at);

    const twice = await empC.post(`/api/tickets/${t.id}/csat`, { rating: 5 });
    assert.equal(twice.status, 400);
  });

  it('solo el reportante puede calificar', async () => {
    const t = await newTicket(empC);
    await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Solución', notify: '1' });
    const res = await adminC.post(`/api/tickets/${t.id}/csat`, { rating: 3 });
    assert.equal(res.status, 403);
  });

  it('solo admite tickets resueltos o cerrados y calificación 1-5', async () => {
    const t = await newTicket(empC);
    const open = await empC.post(`/api/tickets/${t.id}/csat`, { rating: 5 });
    assert.equal(open.status, 400);

    const r = await newTicket(empC);
    await adminC.post(`/api/tickets/${r.id}/resolve`, { resolution: 'Solución', notify: '1' });
    assert.equal((await empC.post(`/api/tickets/${r.id}/csat`, { rating: 0 })).status, 400);
    assert.equal((await empC.post(`/api/tickets/${r.id}/csat`, { rating: 6 })).status, 400);
  });

  it('la desactivación de CSAT impide calificar', async () => {
    await adminC.patch('/api/settings', { enable_csat: '0' });
    try {
      const t = await newTicket(empC);
      await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Solución', notify: '1' });
      const res = await empC.post(`/api/tickets/${t.id}/csat`, { rating: 5 });
      assert.equal(res.status, 400);
    } finally {
      await adminC.patch('/api/settings', { enable_csat: '1' });
    }
  });
});

describe('Notificaciones in-app', () => {
  it('al asignar notifica al asignado y al reportante', async () => {
    const t = await newTicket(empC);
    const res = await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });
    assert.equal(res.status, 200);

    const forTech = notificationsOf(techId).find((x) => x.type === 'ASSIGNED' && x.ticket_id === t.id);
    assert.ok(forTech, 'el técnico debe recibir notificación de asignación');

    const forReporter = notificationsOf(t.reporter_id).find((x) => x.type === 'ASSIGNED' && x.ticket_id === t.id);
    assert.ok(forReporter, 'el reportante debe recibir notificación de asignación');
  });

  it('un comentario público notifica a los participantes y excluye al autor', async () => {
    const t = await newTicket(empC);
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });

    const res = await adminC.post(`/api/tickets/${t.id}/comments`, { message: 'Comentario público' });
    assert.equal(res.status, 201);

    const forTech = notificationsOf(techId).find((x) => x.type === 'COMMENT' && x.ticket_id === t.id);
    assert.ok(forTech, 'el técnico debe recibir notificación de comentario');

    const forReporter = notificationsOf(t.reporter_id).find((x) => x.type === 'COMMENT' && x.ticket_id === t.id);
    assert.ok(forReporter, 'el reportante debe recibir notificación de comentario');

    const forAdmin = notificationsOf(adminId).find((x) => x.type === 'COMMENT' && x.ticket_id === t.id);
    assert.equal(forAdmin, undefined, 'el autor no recibe su propia notificación');
  });

  it('la API expone listado, contador y marcar leídas', async () => {
    const t = await newTicket(empC);
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });

    const list = await adminC.get('/api/notifications');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.data));
    assert.ok(list.body.unread >= 1);

    const tea = createClient();
    await tea.login(techEmail, 'Tecnico1234!');
    const unread = await tea.get('/api/notifications/unread-count');
    assert.equal(unread.status, 200);
    assert.ok(unread.body.unread >= 1);

    const mark = await tea.post('/api/notifications/read', { all: true });
    assert.equal(mark.status, 200);
    assert.equal(mark.body.unread, 0);

    const after = await tea.get('/api/notifications/unread-count');
    assert.equal(after.body.unread, 0);

    await tea.del('/api/notifications/read');
    const empty = await tea.get('/api/notifications');
    assert.equal(empty.body.data.length, 0, 'las leídas se pueden limpiar');
  });
});

describe('Jobs de escalación automática', () => {
  it('escala tickets sin asignar según las reglas de configuración', async () => {
    await adminC.patch('/api/settings', { rule_unassigned_hours: '1', rule_unassigned_priority: 'HIGH' });

    const t = await newTicket(empC, { priority: 'LOW' });
    db.prepare("UPDATE tickets SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(t.id);

    const result = await runMaintenance();
    assert.ok(Number.isFinite(result.escalated));

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id);
    assert.equal(ticket.priority, 'HIGH', 'la prioridad debe subir a HIGH');

    const hist = db.prepare('SELECT * FROM ticket_history WHERE ticket_id = ? AND action = ?').get(t.id, 'ESCALATED');
    assert.ok(hist, 'debe quedar auditada la escalación');

    const alert = db.prepare('SELECT * FROM notifications WHERE ticket_id = ? AND type = ?').all(t.id, 'ESCALATED');
    assert.ok(alert.length >= 1, 'los administradores deben recibir la alerta');

    await adminC.patch('/api/settings', { rule_unassigned_hours: '8' });
  });

  it('con horas en 0 la regla queda desactivada', async () => {
    await adminC.patch('/api/settings', { rule_unassigned_hours: '0' });
    try {
      const t = await newTicket(empC, { priority: 'LOW' });
      db.prepare("UPDATE tickets SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(t.id);
      await runMaintenance();
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id);
      assert.equal(ticket.priority, 'LOW');
    } finally {
      await adminC.patch('/api/settings', { rule_unassigned_hours: '8' });
    }
  });
});

describe('Dashboard SLA', () => {
  it('calcula vencidos, próximos 24h, dentro de plazo y top de urgencia', async () => {
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    const t = await newTicket(adminC, { priority: 'HIGH' });
    await adminC.patch(`/api/tickets/${t.id}`, { status: 'IN_PROGRESS', assigned_to_id: adminId });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(-3 * 3600000), t.id);

    const t2 = await newTicket(adminC, { priority: 'MEDIUM' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(5 * 3600000), t2.id);

    const t3 = await newTicket(adminC, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(3 * 86400000), t3.id);

    const res = await adminC.get('/api/dashboard/sla');
    assert.equal(res.status, 200);
    assert.ok(res.body.overdue >= 1, 'debe existir al menos un vencido');
    assert.ok(res.body.atRisk >= 1, 'debe existir al menos una próxima a 24h');
    assert.ok(res.body.healthy >= 1, 'debe existir al menos una dentro de plazo');
    assert.ok(Array.isArray(res.body.top) && res.body.top.length > 0, 'debe devolver el top de urgencia');
    const first = res.body.top[0];
    assert.equal(first.is_overdue, 1, 'el primer ticket debe ser el más urgente (vencido)');
    assert.ok(first.ticket_number && first.sla_due_at, 'debe incluir número y fecha SLA');
  });

  // El tablero y el listado ofrecen el mismo enlace ("Vencen pronto" lleva a
  // ?sla=due_soon). Si cada uno calculara su propia ventana, el técnico vería
  // un número en el tablero y, al pincharlo, una lista que no cuadra. Los tres
  // sitios comparten SLA_AT_RISK_HOURS; esto lo fija para que no vuelvan a
  // separarse al tocar cualquiera de ellos.
  it('la ventana de "próximos a vencer" es la misma en el tablero y en el listado', async () => {
    const iso = (ms) => new Date(Date.now() + ms).toISOString();

    const atRiskBefore = (await adminC.get('/api/dashboard/sla')).body.atRisk;
    const dueSoonBefore = (await adminC.get('/api/dashboard/needs-attention')).body.totals.dueSoon;

    // Justo dentro y justo fuera de la ventana compartida.
    const dentro = await newTicket(adminC, { priority: 'HIGH' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso((SLA_AT_RISK_HOURS - 1) * 3600000), dentro.id);
    const fuera = await newTicket(adminC, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso((SLA_AT_RISK_HOURS + 1) * 3600000), fuera.id);

    const listado = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=due_soon');
    const ids = new Set(listado.body.data.map((t) => t.id));
    assert.ok(ids.has(dentro.id), 'el ticket dentro de la ventana debe salir en ?sla=due_soon');
    assert.ok(!ids.has(fuera.id), 'el ticket fuera de la ventana no debe salir en ?sla=due_soon');

    const atRiskAfter = (await adminC.get('/api/dashboard/sla')).body.atRisk;
    const dueSoonAfter = (await adminC.get('/api/dashboard/needs-attention')).body.totals.dueSoon;

    // Cada endpoint cuenta exactamente el mismo conjunto que el listado.
    assert.equal(atRiskAfter - atRiskBefore, 1, '/dashboard/sla debe sumar el mismo ticket que el listado');
    assert.equal(dueSoonAfter - dueSoonBefore, 1, '/dashboard/needs-attention debe sumar el mismo ticket que el listado');
  });
});

describe('Dashboard por técnico', () => {
  async function load() {
    const res = await adminC.get('/api/dashboard/by-technician');
    assert.equal(res.status, 200);
    const rowOf = (id) => res.body.data.find((r) => r.id === id);
    return { ...res.body, rowOf };
  }

  it('reparte la carga por estado y cuenta aparte los que no tienen dueño', async () => {
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    const before = await load();

    // Un ticket por cada estado, todos del mismo técnico.
    const assigned = await newTicket(adminC);
    const progress = await newTicket(adminC);
    const pending = await newTicket(adminC);
    for (const [ticket, status] of [[assigned, 'ASSIGNED'], [progress, 'IN_PROGRESS'], [pending, 'PENDING']]) {
      const res = await adminC.patch(`/api/tickets/${ticket.id}`, { status, assigned_to_id: techId });
      assert.equal(res.status, 200, `debe poder pasar el ticket a ${status}`);
    }
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(-2 * 3600000), assigned.id);
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(6 * 3600000), progress.id);
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(iso(-30 * 60000), pending.id);

    // Este sí se queda abierto y sin dueño, así que debe sumar uno a `unassigned`.
    const orphan = await newTicket(adminC);
    assert.equal(orphan.status, 'OPEN');

    const after = await load();
    assert.equal(after.unassigned, before.unassigned + 1, 'el OPEN sin dueño se cuenta aparte');

    const row = after.rowOf(techId);
    assert.ok(row, 'el técnico con carga debe aparecer en el reparto');
    assert.equal(row.technician, 'Técnico Feature', 'debe traer el nombre completo');

    const prev = before.rowOf(techId);
    assert.equal(row.assigned - (prev?.assigned || 0), 1);
    assert.equal(row.in_progress - (prev?.in_progress || 0), 1);
    assert.equal(row.pending - (prev?.pending || 0), 1);
    assert.equal(row.overdue - (prev?.overdue || 0), 2, 'solo los dos con plazo pasado cuentan como vencidos');
    assert.equal(
      row.active,
      row.open + row.assigned + row.in_progress + row.pending,
      'el total debe ser la suma de los cuatro estados'
    );

    // Los totales se calculan sobre todos los técnicos, no solo sobre las filas
    // que devuelve el endpoint, así que deben cuadrar con la suma de la lista.
    assert.ok(after.totals.technicians >= 1);
    assert.equal(after.totals.active, after.data.reduce((a, b) => a + b.active, 0));
    assert.equal(after.totals.overdue, after.data.reduce((a, b) => a + b.overdue, 0));
  });

  it('cuenta como carga el OPEN que ya tiene dueño sin haber cambiado de estado', async () => {
    // Reproduce el caso de DEV: "Asignarme" en Inbox/Tickets envía solo
    // assigned_to_id, y tickets.js NO mueve el status al asignar. Queda un
    // OPEN con dueño, que antes no aparecía en ninguna fila ni en `unassigned`.
    const t = await newTicket(adminC);
    assert.equal(t.status, 'OPEN');

    const patch = await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: techId });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.ticket.assigned_to_id, techId, 'el ticket ya tiene dueño');
    assert.equal(patch.body.ticket.status, 'OPEN', 'pero sigue OPEN: asignar no cambia el estado');

    const row = (await load()).rowOf(techId);
    assert.ok(row, 'un OPEN con dueño debe aparecer en la carga del técnico');
    assert.ok(row.open >= 1, 'y computar entre sus abiertos');
    assert.ok(
      row.active >= row.open + row.assigned + row.in_progress + row.pending - 1e-9,
      'el OPEN con dueño está dentro del total'
    );
  });

  it('no deja ningún ticket abierto fuera de la sección', async () => {
    // Mezcla exacta de DEV: un OPEN sin dueño y un OPEN ya asignado.
    const orphan = await newTicket(adminC);
    const taken = await newTicket(adminC);
    assert.equal(orphan.status, 'OPEN');
    await adminC.patch(`/api/tickets/${taken.id}`, { assigned_to_id: techId });

    const dash = await load();
    const summary = await adminC.get('/api/dashboard/summary');
    assert.equal(summary.status, 200);

    // Invariante de la sección: cada ticket abierto está en la fila de un
    // técnico o en el contador de sin dueño. Si falta uno, los dos números
    // muestran menos de lo que el resumen dice que hay abiertos.
    assert.equal(
      dash.totals.active + dash.unassigned,
      summary.body.openTotal,
      'activos + sin asignar debe igualar el total de abiertos del resumen'
    );
  });
});

describe('Dashboard · Requieren atención', () => {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  // El SLA se fija por SQL porque depende de un instante concreto (vencido hace
  // 3 h, vence en 5 h) y la API no permite escribirlo.
  const setSla = (id, when) => db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(when, id);
  const setPriority = (id, priority) =>
    db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run(priority, id);

  async function attention(limit = 100) {
    const res = await adminC.get(`/api/dashboard/needs-attention?limit=${limit}`);
    assert.equal(res.status, 200);
    return {
      ...res.body,
      byId: (id) => res.body.data.find((t) => t.id === id),
      ids: res.body.data.map((t) => t.id),
    };
  }

  it('lista el SLA vencido con su motivo y su técnico', async () => {
    const t = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: techId });
    setSla(t.id, iso(-3 * 3600000));

    const dash = await attention();
    const row = dash.byId(t.id);
    assert.ok(row, 'un ticket con el SLA vencido debe requerir atención');
    assert.ok(row.reasons.includes('SLA_OVERDUE'), 'y traer el motivo SLA_OVERDUE');
    assert.equal(row.urgency, 0, 'vencido es el nivel de urgencia más alto');
    assert.equal(row.technician_name, 'Técnico Feature', 'debe traer el nombre del técnico');
    assert.ok(row.ticket_number && row.title && row.created_at, 'y los datos de identificación');
    assert.ok(row.sla_due_at, 'además del plazo');

    assert.ok(dash.totals.overdue >= 1, 'el total de vencidos debe contarlo');
    assert.ok(dash.totals.total >= 1, 'y el total de la sección también');
  });

  it('lista un CRITICAL que siga activo', async () => {
    const t = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: techId });
    setPriority(t.id, 'CRITICAL');
    // SLA sano y con dueño: si no fuera por la prioridad, no entraría.
    setSla(t.id, iso(72 * 3600000));

    const dash = await attention();
    const row = dash.byId(t.id);
    assert.ok(row, 'un CRITICAL activo debe requerir atención');
    assert.deepEqual(row.reasons, ['CRITICAL'], 'y su único motivo es la prioridad');
    assert.equal(row.urgency, 1, 'queda por detrás de un vencido, pero delante del resto');
    assert.ok(dash.totals.critical >= 1);
  });

  it('lista el que va a vencer dentro de 24 horas y no el que está lejos', async () => {
    const soon = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${soon.id}`, { assigned_to_id: techId });
    setSla(soon.id, iso(5 * 3600000));

    const far = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${far.id}`, { assigned_to_id: techId });
    setPriority(far.id, 'LOW');
    setSla(far.id, iso(72 * 3600000));

    const dash = await attention();
    const row = dash.byId(soon.id);
    assert.ok(row, 'el que vence en 5 h debe requerir atención');
    assert.deepEqual(row.reasons, ['SLA_DUE_SOON']);
    assert.equal(row.urgency, 2);
    assert.equal(dash.byId(far.id), undefined, 'el que vence en 72 h y no tiene otra señal, no');
    assert.ok(dash.totals.dueSoon >= 1);
  });

  it('lista el ticket abierto sin técnico, y no confunde OPEN con "sin asignar"', async () => {
    const orphan = await newTicket(adminC);
    assert.equal(orphan.status, 'OPEN');

    // OPEN CON dueño: es el caso de DEV. Asignar no mueve el estado, así que si
    // la sección tradujera OPEN a "sin técnico" entraría aquí por error.
    const owned = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${owned.id}`, { assigned_to_id: techId });
    assert.equal(owned.status, 'OPEN');
    setSla(owned.id, iso(96 * 3600000));
    setPriority(owned.id, 'LOW');

    const dash = await attention();
    const row = dash.byId(orphan.id);
    assert.ok(row, 'el abierto sin dueño debe requerir atención');
    assert.deepEqual(row.reasons, ['UNASSIGNED'], 'y su motivo es la falta de técnico');
    assert.equal(row.urgency, 3);
    assert.equal(row.assigned_to_id, null);
    assert.equal(row.technician_name, null, 'sin dueño no hay nombre de técnico');

    assert.equal(
      dash.byId(owned.id),
      undefined,
      'un OPEN con dueño, SLA lejano y prioridad baja no requiere atención'
    );
    assert.ok(dash.totals.unassigned >= 1);
  });

  it('no repite un ticket que cumple varias condiciones y conserva todos sus motivos', async () => {
    // Vencido + crítico + sin dueño: cumple las tres a la vez.
    const t = await newTicket(adminC);
    setSla(t.id, iso(-30 * 60000));
    setPriority(t.id, 'CRITICAL');

    const dash = await attention();
    const matches = dash.data.filter((x) => x.id === t.id);
    assert.equal(matches.length, 1, 'debe aparecer exactamente una vez');
    assert.deepEqual(
      matches[0].reasons,
      ['SLA_OVERDUE', 'CRITICAL', 'UNASSIGNED'],
      'con todos los motivos, del más grave al menos grave'
    );
    assert.equal(matches[0].urgency, 0, 'y con la urgencia del motivo más grave');

    // Los ids de la lista no pueden repetirse: es lo que haría "no repetir" falso
    // si un mismo ticket saliera por dos rutas distintas.
    assert.equal(new Set(dash.ids).size, dash.ids.length, 'la lista no debe tener ids repetidos');
  });

  it('excluye los terminales aunque hayan tenido prioridad crítica o SLA vencido', async () => {
    const resolved = await newTicket(adminC);
    setPriority(resolved.id, 'CRITICAL');
    setSla(resolved.id, iso(-100 * 3600000));
    const r = await adminC.post(`/api/tickets/${resolved.id}/resolve`, { resolution: 'Listo', notify: '0' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket.status, 'RESOLVED');

    const closed = await newTicket(adminC);
    setPriority(closed.id, 'CRITICAL');
    setSla(closed.id, iso(-100 * 3600000));
    // /close exige una resolución previa (regla del flujo), así que el ticket
    // pasa por RESOLVED antes de quedar CLOSED.
    await adminC.post(`/api/tickets/${closed.id}/resolve`, { resolution: 'Listo', notify: '0' });
    const rc = await adminC.post(`/api/tickets/${closed.id}/close`, {});
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.equal(rc.body.ticket.status, 'CLOSED');

    const cancelled = await newTicket(adminC);
    setPriority(cancelled.id, 'CRITICAL');
    setSla(cancelled.id, iso(-100 * 3600000));
    const rx = await adminC.post(`/api/tickets/${cancelled.id}/cancel`, { reason: 'No procede' });
    assert.equal(rx.status, 200, JSON.stringify(rx.body));
    assert.equal(rx.body.ticket.status, 'CANCELLED');

    const dash = await attention();
    for (const id of [resolved.id, closed.id, cancelled.id]) {
      assert.equal(dash.byId(id), undefined, 'un ticket terminal no debe requerir atención');
    }
    assert.ok(
      !dash.data.some((x) => ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(x.status)),
      'ninguna fila puede traer un estado terminal'
    );
  });

  it('ordena de más a menos urgente y de forma determinista', async () => {
    // Uno por nivel, con plazo y antigüedad propios para poder desempatar.
    const overdue = await newTicket(adminC);
    setSla(overdue.id, iso(-2 * 3600000));
    const critical = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${critical.id}`, { assigned_to_id: techId });
    setPriority(critical.id, 'CRITICAL');
    const soon = await newTicket(adminC);
    await adminC.patch(`/api/tickets/${soon.id}`, { assigned_to_id: techId });
    setSla(soon.id, iso(3 * 3600000));

    const first = await attention();
    const rank = (id) => first.ids.indexOf(id);
    assert.ok(first.ids.includes(overdue.id) && first.ids.includes(critical.id) && first.ids.includes(soon.id));
    assert.ok(rank(overdue.id) < rank(critical.id), 'vencido antes que crítico');
    assert.ok(rank(critical.id) < rank(soon.id), 'crítico antes que próximo a vencer');

    // Los urgentes de la sección (nivel 0) deben ir por delante de los demás.
    const firstZero = first.data.findIndex((x) => x.urgency === 0);
    const lastNonZero = first.data.map((x) => x.urgency).lastIndexOf(0);
    if (lastNonZero > -1) {
      assert.equal(
        first.data.slice(firstZero, lastNonZero + 1).every((x) => x.urgency === 0),
        true,
        'todos los de nivel 0 deben ir juntos al principio'
      );
    }

    // Mismo reloj, dos llamadas: la lista no puede reordenarse sola.
    const second = await attention();
    assert.deepEqual(second.ids, first.ids, 'el orden debe ser estable entre llamadas');
  });

  it('devuelve los totales de toda la sección aunque la lista venga recortada', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await newTicket(adminC);
      setSla(t.id, iso(-(i + 1) * 3600000));
    }
    const full = await attention(100);
    const short = await attention(1);

    assert.equal(short.data.length, 1, 'el límite se respeta');
    assert.deepEqual(
      short.totals,
      full.totals,
      'los totales son de la sección completa, no de las filas mostradas'
    );
    assert.ok(full.totals.total >= 4);
  });

  it('el límite se acota y los totales no dependen de él', async () => {
    const dash = await attention(9999);
    assert.ok(Array.isArray(dash.data));
    assert.ok(dash.totals.total >= 0);

    const clamped = await attention(0);
    assert.ok(clamped.data.length <= 1, 'un límite de 0 se eleva al mínimo de 1');

    const noParam = await adminC.get('/api/dashboard/needs-attention');
    assert.equal(noParam.status, 200, 'sin límite debe usar el valor por defecto');
    assert.ok(noParam.body.data.length <= 8, 'el valor por defecto es 8');
    assert.deepEqual(noParam.body.totals, dash.totals, 'los totales son los mismos');
  });
});
