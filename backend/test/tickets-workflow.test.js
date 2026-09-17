import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

const IMG_JPG = {
  name: 'foto.jpg',
  mime: 'image/jpeg',
  buffer: Buffer.from('ffd8ffe000104a464946', 'hex'),
};

let adminC;
let empleadoC;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', 'Admin1234!');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');
});

async function newTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Flujo ${Math.random().toString(36).slice(2, 7)}`,
    description: 'Descripción de flujo',
    category_id: 1,
    priority: 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

describe('Flujo de resolución de tickets', () => {
  it('resolver guarda solución, causa, tiempo y auditoría', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.post(`/api/tickets/${t.id}/resolve`, {
      resolution: 'Se reemplazó el mouse defectuoso y se probó su funcionamiento.',
      resolution_category: 'Reemplazo',
      root_cause: 'Falla de hardware',
      time_spent_minutes: 45,
      notify: '1',
    });
    assert.equal(res.status, 200);
    const tk = res.body.ticket;
    assert.equal(tk.status, 'RESOLVED');
    assert.ok(tk.resolved_at);
    assert.equal(tk.resolved_by, 1);
    assert.equal(tk.resolved_by_name, 'Administrador Sistema');
    assert.equal(tk.resolution_category, 'Reemplazo');
    assert.equal(tk.root_cause, 'Falla de hardware');
    assert.equal(tk.time_spent_minutes, 45);
    assert.equal(tk.resolution_notified, 1);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.history.some((h) => h.action === 'RESOLVED'));
    assert.ok(detail.body.comments.some((c) => c.message.includes('resuelto')));
    assert.ok(detail.body.history.some((h) => h.action === 'COMMENT_ADDED'));
  });

  it('resolver exige el campo solución', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: '   ' });
    assert.equal(res.status, 400);
    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'OPEN');
  });

  it('adjuntar evidencia al resolver', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.postMultipart(
      `/api/tickets/${t.id}/resolve`,
      { resolution: 'Se adjunta evidencia de la reparación', resolution_category: 'Reparación' },
      [IMG_JPG]
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.attachments.length, 1);
    assert.equal(res.body.attachments[0].comment_id, null);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.attachments.some((a) => a.original_name === 'foto.jpg'));
  });

  it('no permite cerrar sin resolución (regla por defecto)', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.post(`/api/tickets/${t.id}/close`, {});
    assert.equal(res.status, 400);
    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'OPEN');
  });

  it('cerrar tras resolver y reabrir conservando la resolución', async () => {
    const t = await newTicket(adminC);
    await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Arreglado', resolution_category: 'Reparación' });

    const close = await adminC.post(`/api/tickets/${t.id}/close`, {});
    assert.equal(close.status, 200);
    assert.equal(close.body.ticket.status, 'CLOSED');
    assert.ok(close.body.ticket.closed_at);
    assert.equal(close.body.ticket.closed_by, 1);

    const again = await adminC.post(`/api/tickets/${t.id}/close`, {});
    assert.equal(again.status, 400);

    const noReason = await adminC.post(`/api/tickets/${t.id}/reopen`, {});
    assert.equal(noReason.status, 400);

    const reopen = await adminC.post(`/api/tickets/${t.id}/reopen`, {
      reason: 'El usuario reporta que volvió a fallar',
    });
    assert.equal(reopen.status, 200);
    const rk = reopen.body.ticket;
    assert.equal(rk.status, 'OPEN');
    assert.ok(rk.reopened_at);
    assert.equal(rk.reopened_by, 1);
    assert.equal(rk.reopen_reason, 'El usuario reporta que volvió a fallar');
    assert.equal(rk.resolved_at, null);
    assert.equal(rk.closed_at, null);
    assert.equal(rk.resolution, 'Arreglado', 'no se borra la resolución anterior');

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    const actions = detail.body.history.map((h) => h.action);
    assert.ok(actions.includes('RESOLVED'));
    assert.ok(actions.includes('CLOSED'));
    assert.ok(actions.includes('REOPENED'));
  });

  it('las notas internas se ocultan al empleado', async () => {
    const t = await newTicket(empleadoC, { title: 'Nota interna' });

    const nota = await adminC.post(`/api/tickets/${t.id}/comments`, {
      message: 'Nota interna: validar garantía del equipo',
      is_internal: '1',
    });
    assert.equal(nota.status, 201);
    assert.equal(nota.body.comment.is_internal, true);

    const adminDetail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(adminDetail.body.comments.some((c) => c.is_internal === 1));
    assert.ok(adminDetail.body.history.some((h) => h.action === 'NOTE_ADDED'));

    const empDetail = await empleadoC.get(`/api/tickets/${t.id}`);
    assert.ok(empDetail.body.comments.every((c) => !c.is_internal), 'el empleado no ve notas internas');
    assert.ok(empDetail.body.history.every((h) => h.action !== 'NOTE_ADDED'), 'el historial no expone notas internas');

    const forbidden = await empleadoC.post(`/api/tickets/${t.id}/comments`, { message: 'x', is_internal: '1' });
    assert.equal(forbidden.status, 403);
  });

  it('el motivo de pendiente queda auditado', async () => {
    const t = await newTicket(adminC);
    const res = await adminC.patch(`/api/tickets/${t.id}`, {
      status: 'PENDING',
      pending_reason: 'Esperando proveedor',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.status, 'PENDING');
    assert.equal(res.body.ticket.pending_reason, 'Esperando proveedor');

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.history.some((h) => h.action === 'PENDING_REASON_SET'));
  });

  it('el empleado no puede resolver, cerrar ni reabrir', async () => {
    const t = await newTicket(adminC);
    assert.equal((await empleadoC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'x' })).status, 403);
    assert.equal((await empleadoC.post(`/api/tickets/${t.id}/close`, {})).status, 403);
    assert.equal((await empleadoC.post(`/api/tickets/${t.id}/reopen`, { reason: 'x' })).status, 403);
  });

  it('expone las opciones configurables del flujo', async () => {
    const res = await adminC.get('/api/tickets/options');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.resolution_categories) && res.body.resolution_categories.length > 0);
    assert.ok(Array.isArray(res.body.root_causes) && res.body.root_causes.length > 0);
    assert.ok(Array.isArray(res.body.pending_reasons) && res.body.pending_reasons.length > 0);
    assert.equal(res.body.require_resolution_to_close, true);
  });
});
