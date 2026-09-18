import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import { sentEmails } from '../src/utils/mailer.js';

let adminC;
let empleadoC;
let techId;
let techEmail;

function emailsOf(kind) {
  return sentEmails.filter((e) => e.kind === kind);
}

afterEach(() => {
  sentEmails.length = 0;
});

async function newTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Notif ${Math.random().toString(36).slice(2, 7)}`,
    description: 'Descripción de notificación',
    category_id: 1,
    priority: 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');

  const roles = await adminC.get('/api/users/roles');
  const techRole = roles.body.roles.find((r) => r.code === 'TECHNICIAN');
  assert.ok(techRole, 'el rol Técnico debe existir en el seed');

  const res = await adminC.post('/api/users', {
    name: 'Técnico',
    last_name: 'Demo',
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

describe('Notificaciones por correo', () => {
  it('asignar un ticket envía correo al asignado (POST /assign)', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.assigned_to_id, techId);

    const mails = emailsOf('assign');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, techEmail);
    assert.match(mails[0].subject, new RegExp(t.ticket_number));
    assert.match(mails[0].subject, /asignado/i);
  });

  it('asignar un ticket envía correo al asignado (PATCH)', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: techId });
    assert.equal(res.status, 200);

    const mails = emailsOf('assign');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, techEmail);
  });

  it('quitar la asignación (null) no envía correo', async () => {
    const t = await newTicket(adminC);
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });
    const res = await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: null });
    assert.equal(res.status, 200);

    const mails = emailsOf('assign');
    assert.equal(mails.length, 1, 'solo debe contar el correo de la asignación, no la remoción');
  });

  it('un comentario notifica al reportante y al asignado (excepto el autor)', async () => {
    const t = await newTicket(empleadoC);
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });

    const res = await adminC.post(`/api/tickets/${t.id}/comments`, {
      message: 'Estamos revisando el caso',
    });
    assert.equal(res.status, 201);

    const mails = emailsOf('comment');
    assert.equal(mails.length, 2);
    assert.deepEqual(
      mails.map((e) => e.to).sort(),
      ['empleado@empresa.com', techEmail].sort()
    );
  });

  it('el autor de un comentario no recibe su propio correo', async () => {
    const t = await newTicket(empleadoC);
    const res = await empleadoC.post(`/api/tickets/${t.id}/comments`, { message: 'Añado contexto' });
    assert.equal(res.status, 201);
    assert.equal(emailsOf('comment').length, 0, 'no hay otros usuarios a notificar');
  });

  it('resolver con notify envía correo al reportante y marca resolution_notified', async () => {
    const t = await newTicket(empleadoC);
    const res = await adminC.post(`/api/tickets/${t.id}/resolve`, {
      resolution: 'Se reemplazó el equipo defectuoso y se probó su funcionamiento.',
      resolution_category: 'Reemplazo',
      notify: '1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.resolution_notified, 1);

    const mails = emailsOf('resolve');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'empleado@empresa.com');
    assert.match(mails[0].subject, /resuelto/i);
    assert.match(mails[0].subject, new RegExp(t.ticket_number));
  });

  it('resolver sin notify no envía correo', async () => {
    const t = await newTicket(empleadoC);
    const res = await adminC.post(`/api/tickets/${t.id}/resolve`, {
      resolution: 'Solución sin notificar',
      notify: '0',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.resolution_notified, 0);
    assert.equal(emailsOf('resolve').length, 0);
  });

  it('forgot-password registra un correo de recuperación', async () => {
    const res = await empleadoC.post('/api/auth/forgot-password', { account: 'empleado@empresa.com' });
    assert.equal(res.status, 200);

    const mails = emailsOf('password_reset');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'empleado@empresa.com');
    assert.match(mails[0].subject, /recuperación/i);
  });

  it('los toggles de Configuración desactivan el correo', async () => {
    await adminC.patch('/api/settings', { notify_on_assign: '0' });
    const t = await newTicket(adminC);
    const res = await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });
    assert.equal(res.status, 200);
    assert.equal(emailsOf('assign').length, 0);

    await adminC.patch('/api/settings', { notify_on_assign: '1' });
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: null });
  });

  it('el admin consulta la bitácora de correos y el estado SMTP', async () => {
    const t = await newTicket(adminC);
    await adminC.post(`/api/tickets/${t.id}/assign`, { assigned_to_id: techId });

    const logs = await adminC.get('/api/settings/emails');
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.body.data));
    assert.ok(logs.body.data.some((e) => e.kind === 'assign' && e.to_email === techEmail));

    const mail = await adminC.get('/api/settings/mail');
    assert.equal(mail.status, 200);
    assert.equal(mail.body.data.enabled, false);
    assert.equal(mail.body.data.useSmtp, false);
  });

  it('el empleado no puede ver la bitácora de correos', async () => {
    const res = await empleadoC.get('/api/settings/emails');
    assert.equal(res.status, 403);
  });
});