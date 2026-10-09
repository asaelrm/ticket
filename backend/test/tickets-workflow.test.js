import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createSuperadminClient } from './helpers.js';
import db from '../src/db.js';

const IMG_JPG = {
  name: 'foto.jpg',
  mime: 'image/jpeg',
  buffer: Buffer.from('ffd8ffe000104a464946', 'hex'),
};

const PASSWORD = 'Prueba1234!';

let adminC;
let empleadoC;
let tecnicoC;
let tecnicoRoleId;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');
  tecnicoC = createClient();
  await tecnicoC.login('tecnico', 'Tecnico1234!');
  const roles = (await adminC.get('/api/roles')).body.roles;
  tecnicoRoleId = roles.find((r) => r.code === 'TECHNICIAN').id;
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

/** Ticket que llega hasta RESOLVED pasando por los endpoints dedicados. */
async function ticketResuelto(client = adminC) {
  const t = await newTicket(client);
  const res = await client.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Arreglado' });
  assert.equal(res.status, 200);
  return t;
}

/** Ticket que llega hasta CLOSED: exige una resolución previa registrada. */
async function ticketCerrado(client = adminC) {
  const t = await ticketResuelto(client);
  const res = await client.post(`/api/tickets/${t.id}/close`, {});
  assert.equal(res.status, 200);
  return t;
}

/**
 * Ejecuta `fn` con unos permisos temporales en el rol de técnico y los restaura
 * pase lo que pase. Los permisos se releen en cada petición, así que la sesión
 * ya abierta ve el cambio. Sirve para probar el caso "tiene ticket.update.any
 * pero NO ticket.reopen", que ningún rol del seed cubre.
 * V2: la matriz de permisos es global (compartida entre organizaciones), así
 * que este canal está reservado al SUPERADMIN.
 */
let superadminCache = null;
async function superadminClient() {
  if (!superadminCache) superadminCache = await createSuperadminClient();
  return superadminCache;
}

async function conPermisos(permisos, fn) {
  const sa = await superadminClient();
  const roles = (await adminC.get('/api/roles')).body.roles;
  const original = roles.find((r) => r.id === tecnicoRoleId).permissions;
  try {
    const patch = await sa.patch(`/api/roles/${tecnicoRoleId}/permissions`, { permissions: permisos });
    assert.equal(patch.status, 200);
    await fn();
  } finally {
    const restore = await sa.patch(`/api/roles/${tecnicoRoleId}/permissions`, { permissions: original });
    assert.equal(restore.status, 200);
  }
}

describe('La reapertura sólo se puede hacer por POST /:id/reopen', () => {
  // Bypass corregido: PATCH /api/tickets/:id calculaba
  //   canReopen = canManage || hasPerm('ticket.reopen')
  // de modo que `ticket.update.any` bastaba para reabrir. Eso esquivaba el
  // permiso propio del endpoint dedicado, el `reason` obligatorio y el rastro
  // de auditoría (reopened_at / reopened_by / reopen_reason quedaban sin
  // escribir). Estos tests fijan que la única vía es el endpoint dedicado.
  it('ticket.update.any NO permite reabrir un RESOLVED con el PATCH genérico', async () => {
    const t = await ticketResuelto();

    const patch = await adminC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });
    assert.equal(patch.status, 400);
    assert.match(patch.body.error, /reapertura/i);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'RESOLVED', 'el ticket sigue resuelto');
    assert.ok(detail.body.ticket.resolved_at, 'no se pierde la fecha de resolución');
  });

  it('tampoco deja saltarse el flujo desde CLOSED', async () => {
    const t = await ticketCerrado();

    const patch = await adminC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });
    assert.equal(patch.status, 400);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'CLOSED');
    assert.ok(detail.body.ticket.closed_at);
  });

  it('tampoco acepta otros destinos desde un RESOLVED para esquivar el flujo', async () => {
    // ASSIGNED / IN_PROGRESS / PENDING tampoco son válidas desde un terminal:
    // tampoco así se puede devolver el ticket a la cola saltándose /reopen.
    const t = await ticketResuelto();
    for (const status of ['ASSIGNED', 'IN_PROGRESS', 'PENDING']) {
      const patch = await adminC.patch(`/api/tickets/${t.id}`, { status });
      assert.equal(patch.status, 400, `no debe aceptar ${status} sobre un RESOLVED`);
    }
    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'RESOLVED');
  });
  it('un rechazo por PATCH no escribe nada en el historial ni borra la resolución', async () => {
    const t = await ticketResuelto();
    const antes = await adminC.get(`/api/tickets/${t.id}`);

    await adminC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });

    const despues = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(despues.body.ticket.resolution, 'Arreglado', 'la resolución anterior no se borra');
    assert.equal(despues.body.history.length, antes.body.history.length, 'no se registra ninguna reapertura');
    assert.ok(!despues.body.history.some((h) => h.action === 'REOPENED'));
    assert.equal(despues.body.ticket.reopened_at, null);
    assert.equal(despues.body.ticket.reopened_by, null);
    assert.equal(despues.body.ticket.reopen_reason, null);
  });

  it('un usuario con ticket.update.any pero SIN ticket.reopen tampoco puede hacerlo', async () => {
    const t = await ticketResuelto();
    // Se le quita ticket.reopen: con el bypass anterior, ticket.update.any solo
    // ya le habría bastado para reabrir por PATCH.
    await conPermisos(
      ['ticket.create', 'ticket.view.all', 'ticket.comment', 'ticket.update.any'],
      async () => {
        const patch = await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });
        assert.equal(patch.status, 400, 'ni siquiera un update.any puede reabrir por PATCH');

        const dedicated = await tecnicoC.post(`/api/tickets/${t.id}/reopen`, { reason: 'Volvió a fallar' });
        assert.equal(dedicated.status, 403, 'y tampoco por el endpoint dedicado: le falta ticket.reopen');
      }
    );
  });

  it('ni siquiera con ticket.reopen se puede reabrir por PATCH: el motivo es obligatorio', async () => {
    const t = await ticketResuelto();
    // El técnico del seed sí tiene ticket.reopen: aun así el PATCH no sirve,
    // porque por aquí se reabriría sin poder exigir el `reason`.
    const patch = await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });
    assert.equal(patch.status, 400);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'RESOLVED');
  });

  it('CANCELLED conserva su regla propia: tampoco se puede reabrir', async () => {
    const t = await newTicket(adminC);
    const cancel = await adminC.post(`/api/tickets/${t.id}/cancel`, { reason: 'Duplicado' });
    assert.equal(cancel.status, 200);

    // Un cancelado nunca es reabrible: el mensaje es el suyo, no el de /reopen.
    const patch = await adminC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' });
    assert.equal(patch.status, 400);
    assert.match(patch.body.error, /cancelado/i);

    // Ni siquiera el endpoint dedicado lo toca.
    const dedicated = await adminC.post(`/api/tickets/${t.id}/reopen`, { reason: 'x' });
    assert.equal(dedicated.status, 400);
  });

  it('el endpoint dedicado sigue funcionando con el permiso correcto', async () => {
    const t = await ticketCerrado();

    const res = await adminC.post(`/api/tickets/${t.id}/reopen`, { reason: 'El fallo volvió a aparecer' });
    assert.equal(res.status, 200);
    const tk = res.body.ticket;
    assert.equal(tk.status, 'OPEN');
    assert.ok(tk.reopened_at, 'la auditoría sí se escribe por la vía dedicada');
    assert.ok(tk.reopened_by);
    assert.equal(tk.reopen_reason, 'El fallo volvió a aparecer');
    assert.equal(tk.closed_at, null);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.history.some((h) => h.action === 'REOPENED'));
  });

  it('el endpoint dedicado sigue exigiendo el motivo', async () => {
    const t = await ticketResuelto();
    assert.equal((await adminC.post(`/api/tickets/${t.id}/reopen`, {})).status, 400);
    assert.equal((await adminC.post(`/api/tickets/${t.id}/reopen`, { reason: '   ' })).status, 400);
  });

  it('el empleado sigue sin poder reabrir por ningún lado', async () => {
    const t = await ticketResuelto();
    // 404 y no 403 a propósito: el PATCH no revela la existencia de un ticket
    // que el actor no puede ver, así que el permiso ni siquiera se llega a mirar.
    assert.equal((await empleadoC.patch(`/api/tickets/${t.id}`, { status: 'OPEN' })).status, 404);
    assert.equal((await empleadoC.post(`/api/tickets/${t.id}/reopen`, { reason: 'x' })).status, 403);
  });
});

describe('Regresiones I1-I3: exportación, avisos y tickets terminales', () => {
  it('I1: ticket.export sin ticket.view.all solo exporta tickets propios', async () => {
    await conPermisos(['ticket.create', 'ticket.export'], async () => {
      const propio = await newTicket(tecnicoC, { title: 'Exportación propia I1' });
      const ajeno = await newTicket(adminC, { title: 'Exportación ajena I1' });

      const res = await tecnicoC.get('/api/tickets/export?format=csv');
      assert.equal(res.status, 200);
      assert.match(res.text, new RegExp(propio.ticket_number), 'incluye el ticket del exportador');
      assert.doesNotMatch(res.text, new RegExp(ajeno.ticket_number), 'no expone tickets ajenos');
    });
  });

  it('I2/I3: un PATCH sobre un CANCELLED no lo modifica ni duplica sus avisos', async () => {
    const ticket = await newTicket(empleadoC, { title: 'Cancelación única I2' });
    const cancelled = await adminC.post(`/api/tickets/${ticket.id}/cancel`, { reason: 'Duplicado de prueba' });
    assert.equal(cancelled.status, 200);

    const emailsBefore = db.prepare('SELECT COUNT(*) AS n FROM email_logs WHERE ticket_id = ?').get(ticket.id).n;
    const notificationsBefore = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ?').get(ticket.id).n;
    const patch = await adminC.patch(`/api/tickets/${ticket.id}`, { title: 'No debe cambiar' });
    assert.equal(patch.status, 400);

    const emailsAfter = db.prepare('SELECT COUNT(*) AS n FROM email_logs WHERE ticket_id = ?').get(ticket.id).n;
    const notificationsAfter = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ?').get(ticket.id).n;
    assert.equal(emailsAfter, emailsBefore, 'no reenvía el correo de cancelación');
    assert.equal(notificationsAfter, notificationsBefore, 'no duplica avisos in-app de cancelación');

    const detail = await adminC.get(`/api/tickets/${ticket.id}`);
    assert.equal(detail.body.ticket.status, 'CANCELLED');
    assert.equal(detail.body.ticket.title, 'Cancelación única I2');
  });

  it('I2/I3: un PATCH sobre un CLOSED no lo modifica ni duplica sus avisos', async () => {
    const ticket = await newTicket(empleadoC, { title: 'Cierre único I2' });
    assert.equal((await adminC.post(`/api/tickets/${ticket.id}/resolve`, { resolution: 'Resuelto para cerrar' })).status, 200);
    assert.equal((await adminC.post(`/api/tickets/${ticket.id}/close`, {})).status, 200);

    const notificationsBefore = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ?').get(ticket.id).n;
    const patch = await adminC.patch(`/api/tickets/${ticket.id}`, { priority: 'CRITICAL' });
    assert.equal(patch.status, 400);
    const notificationsAfter = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = ?').get(ticket.id).n;
    assert.equal(notificationsAfter, notificationsBefore, 'no duplica avisos de cierre');

    const detail = await adminC.get(`/api/tickets/${ticket.id}`);
    assert.equal(detail.body.ticket.status, 'CLOSED');
    assert.equal(detail.body.ticket.priority, 'MEDIUM');
  });

  it('I3: un PATCH tampoco modifica campos de negocio de un RESOLVED', async () => {
    const ticket = await newTicket(adminC, { title: 'Resuelto inmutable I3' });
    assert.equal((await adminC.post(`/api/tickets/${ticket.id}/resolve`, { resolution: 'Solución final' })).status, 200);

    const patch = await adminC.patch(`/api/tickets/${ticket.id}`, { description: 'No debe cambiar' });
    assert.equal(patch.status, 400);
    const detail = await adminC.get(`/api/tickets/${ticket.id}`);
    assert.equal(detail.body.ticket.status, 'RESOLVED');
    assert.equal(detail.body.ticket.description, 'Descripción de flujo');
  });
});

describe('Las transiciones legítimas del PATCH siguen funcionando', () => {
  // El bloqueo es sólo sobre cualquier salida desde RESOLVED/CLOSED. Todo lo que
  // usa la Bandeja tiene que seguir pasando por el PATCH genérico.
  it('permite OPEN → IN_PROGRESS (iniciar atención)', async () => {
    const t = await newTicket(tecnicoC);
    const res = await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'IN_PROGRESS' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.status, 'IN_PROGRESS');

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.history.some((h) => h.action === 'STATUS_CHANGED'));
  });

  it('permite IN_PROGRESS → PENDING con su motivo (poner en espera)', async () => {
    const t = await newTicket(tecnicoC);
    await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'IN_PROGRESS' });

    const res = await tecnicoC.patch(`/api/tickets/${t.id}`, {
      status: 'PENDING',
      pending_reason: 'Esperando al proveedor',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.status, 'PENDING');
    assert.equal(res.body.ticket.pending_reason, 'Esperando al proveedor');
  });

  it('permite PENDING → IN_PROGRESS (reanudar)', async () => {
    const t = await newTicket(tecnicoC);
    await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'IN_PROGRESS' });
    await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'PENDING', pending_reason: 'x' });

    const res = await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'IN_PROGRESS' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.status, 'IN_PROGRESS');
    // Al volver a trabajar, el motivo de espera deja de aplicar.
    assert.equal(res.body.ticket.pending_reason, null);
  });

  it('permite OPEN → ASSIGNED al tomar el ticket', async () => {
    const t = await newTicket(tecnicoC);
    const yo = (await tecnicoC.get('/api/auth/me')).body.user.id;

    const res = await tecnicoC.patch(`/api/tickets/${t.id}`, { status: 'ASSIGNED', assigned_to_id: yo });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.status, 'ASSIGNED');
    assert.equal(res.body.ticket.assigned_to_id, yo);
  });

  it('resolver, cerrar y cancelar siguen yendo por sus endpoints dedicados', async () => {
    const t = await newTicket(tecnicoC);

    const resolve = await tecnicoC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Arreglado' });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.body.ticket.status, 'RESOLVED');

    const close = await tecnicoC.post(`/api/tickets/${t.id}/close`, {});
    assert.equal(close.status, 200);
    assert.equal(close.body.ticket.status, 'CLOSED');

    const otro = await newTicket(tecnicoC);
    const cancel = await tecnicoC.post(`/api/tickets/${otro.id}/cancel`, { reason: 'Duplicado' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.ticket.status, 'CANCELLED');
  });
});

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

  it('las notas internas y sus adjuntos se ocultan al empleado', async () => {
    const t = await newTicket(empleadoC, { title: 'Nota interna' });

    const nota = await adminC.postMultipart(`/api/tickets/${t.id}/comments`, {
      message: 'Nota interna: validar garantía del equipo',
      is_internal: '1',
    }, [IMG_JPG]);
    assert.equal(nota.status, 201);
    assert.equal(nota.body.comment.is_internal, true);

    const adminDetail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(adminDetail.body.comments.some((c) => c.is_internal === 1));
    assert.ok(adminDetail.body.history.some((h) => h.action === 'NOTE_ADDED'));

    const empDetail = await empleadoC.get(`/api/tickets/${t.id}`);
    assert.ok(empDetail.body.comments.every((c) => !c.is_internal), 'el empleado no ve notas internas');
    assert.ok(empDetail.body.history.every((h) => h.action !== 'NOTE_ADDED'), 'el historial no expone notas internas');
    assert.ok(empDetail.body.attachments.every((a) => a.comment_id !== nota.body.comment.id), 'el empleado no ve adjuntos internos');
    const download = await empleadoC.get(`/api/files/${nota.body.attachments[0].id}`);
    assert.equal(download.status, 404, 'el empleado no descarga adjuntos internos');

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

  it('no permite usar PATCH para resolver, cerrar o cancelar', async () => {
    const t = await newTicket(adminC);
    for (const status of ['RESOLVED', 'CLOSED', 'CANCELLED']) {
      const res = await adminC.patch(`/api/tickets/${t.id}`, { status });
      assert.equal(res.status, 400);
    }
    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.equal(detail.body.ticket.status, 'OPEN');
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
