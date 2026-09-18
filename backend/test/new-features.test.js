import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import { sentEmails } from '../src/utils/mailer.js';
import db from '../src/db.js';
import { runMaintenance } from '../src/utils/jobs.js';

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

    const result = runMaintenance();
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
      runMaintenance();
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
});