import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';

let adminC;
let tecnicoC;
let empleadoC;

const SECRETO = 'contraseña-interna-2026.txt';

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  tecnicoC = createClient();
  await tecnicoC.login('tecnico', 'Tecnico1234!');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');
});

function archivo() {
  return { buffer: Buffer.from(SECRETO), name: SECRETO, mime: 'text/plain' };
}

async function createTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Ticket ${Math.random().toString(36).slice(2, 8)}`,
    description: 'Descripción de prueba',
    category_id: 1,
    priority: 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

describe('El adjunto de una nota interna no se filtra al reportante', () => {
  it('el historial del reportante no menciona el archivo interno', async () => {
    const ticket = await createTicket(empleadoC, { title: 'Fuga por nota interna' });

    const nota = await tecnicoC.postMultipart(
      `/api/tickets/${ticket.id}/comments`,
      { message: 'Revisando el equipo internamente', is_internal: '1' },
      [archivo()]
    );
    assert.equal(nota.status, 201);

    const vistoPorEmpleado = await empleadoC.get(`/api/tickets/${ticket.id}`);
    assert.equal(vistoPorEmpleado.status, 200);

    const historial = vistoPorEmpleado.body.history;
    const descripciones = historial.map((h) => String(h.description || ''));
    assert.ok(
      !descripciones.some((d) => d.includes(SECRETO)),
      `el reportante no debe ver el nombre del archivo: ${JSON.stringify(descripciones)}`
    );
    assert.ok(
      !historial.some((h) => h.action === 'NOTE_ATTACHMENT_ADDED'),
      'el evento de adjunto interno tampoco debe existir en su historial'
    );
    assert.ok(!historial.some((h) => h.action === 'NOTE_ADDED'), 'la nota interna sigue oculta');
    assert.ok(
      !vistoPorEmpleado.body.comments.some((c) => c.is_internal),
      'el comentario interno sigue oculto'
    );
  });

  it('el adjunto interno se registra con acción propia y la ve quien tiene permiso', async () => {
    const ticket = await createTicket(empleadoC, { title: 'Nota interna visible para técnicos' });

    await tecnicoC.postMultipart(
      `/api/tickets/${ticket.id}/comments`,
      { message: 'Adjunto para el equipo', is_internal: '1' },
      [archivo()]
    );

    const admin = await adminC.get(`/api/tickets/${ticket.id}`);
    assert.equal(admin.status, 200);

    const evento = admin.body.history.find((h) => h.action === 'NOTE_ATTACHMENT_ADDED');
    assert.ok(evento, 'el evento se registra para quien puede ver notas internas');
    assert.ok(evento.description.includes(SECRETO), 'con el detalle del archivo');
    assert.notEqual(evento.action, 'ATTACHMENT_ADDED', 'no se confunde con un adjunto público');

    const nota = admin.body.comments.find((c) => c.is_internal);
    assert.ok(nota, 'el técnico ve la nota interna');
    assert.equal(nota.attachments.length, 1, 'y el archivo sigue siendo accesible');
    assert.equal(nota.attachments[0].original_name, SECRETO);
  });

  it('un comentario público con adjunto mantiene su evento visible', async () => {
    const ticket = await createTicket(empleadoC, { title: 'Comentario público con adjunto' });

    const res = await empleadoC.postMultipart(
      `/api/tickets/${ticket.id}/comments`,
      { message: 'Comparto el log del fallo' },
      [archivo()]
    );
    assert.equal(res.status, 201);

    const visto = await empleadoC.get(`/api/tickets/${ticket.id}`);
    const evento = visto.body.history.find((h) => h.action === 'ATTACHMENT_ADDED');
    assert.ok(evento, 'el adjunto público sí se registra como ATTACHMENT_ADDED');
    assert.ok(evento.description.includes(SECRETO), 'y el reportante puede ver su propio archivo');
  });

  it('el listado de adjuntos del ticket no expone los internos', async () => {
    const ticket = await createTicket(empleadoC, { title: 'Adjuntos del ticket' });
    await tecnicoC.postMultipart(
      `/api/tickets/${ticket.id}/comments`,
      { message: 'Evidencia interna', is_internal: '1' },
      [archivo()]
    );

    const visto = await empleadoC.get(`/api/tickets/${ticket.id}`);
    const nombres = (visto.body.attachments || []).map((a) => a.original_name);
    assert.ok(!nombres.includes(SECRETO), 'el adjunto interno no aparece en la lista');
  });
});

describe('El historial devuelve el autor real de cada evento', () => {
  it('no duplica eventos ni atribuye al usuario equivocado', async () => {
    const ticket = await createTicket(empleadoC, { title: 'Autoría del historial' });

    await adminC.patch(`/api/tickets/${ticket.id}`, { priority: 'HIGH' });
    await tecnicoC.post(`/api/tickets/${ticket.id}/comments`, { message: 'Comentario de prueba' });

    const visto = await adminC.get(`/api/tickets/${ticket.id}`);
    assert.equal(visto.status, 200);

    const history = visto.body.history;
    const ids = history.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, `no debe haber ids repetidos: ${JSON.stringify(ids)}`);

    const evento = history.find((h) => h.action === 'PRIORITY_CHANGED');
    assert.ok(evento);
    assert.equal(evento.user_name, 'Administrador Sistema');

    // El comentario público lo escribió el técnico: su evento debe llevar su nombre.
    const comentario = history.find((h) => h.action === 'COMMENT_ADDED');
    assert.ok(comentario);
    assert.equal(comentario.user_name, 'Técnico Soporte');
  });
});

describe('Reabrir un ticket reinicia la encuesta CSAT', () => {
  async function ticketResueltoYMegusto() {
    const ticket = await createTicket(empleadoC, { title: 'CSAT que debe reiniciarse' });
    const asignado = await adminC.patch(`/api/tickets/${ticket.id}`, { assigned_to_id: null });
    assert.equal(asignado.status, 200);

    const resuelto = await adminC.post(`/api/tickets/${ticket.id}/resolve`, {
      resolution: 'Se corrigió la configuración.',
    });
    assert.equal(resuelto.status, 200);

    const csat = await empleadoC.post(`/api/tickets/${ticket.id}/csat`, {
      rating: 1,
      comment: 'Seguía sin funcionar',
    });
    assert.equal(csat.status, 200);

    return ticket;
  }

  function leerCsat(ticketId) {
    return db.prepare('SELECT csat_rating, csat_comment, csat_answered_at FROM tickets WHERE id = ?').get(ticketId);
  }

  it('la encuesta se guarda antes de reabrir', async () => {
    const ticket = await ticketResueltoYMegusto();
    const fila = leerCsat(ticket.id);
    assert.equal(fila.csat_rating, 1);
    assert.equal(fila.csat_comment, 'Seguía sin funcionar');
    assert.ok(fila.csat_answered_at);
  });

  it('POST /reopen borra la valoración, el comentario y la fecha', async () => {
    const ticket = await ticketResueltoYMegusto();

    const reopen = await adminC.post(`/api/tickets/${ticket.id}/reopen`, { reason: 'El fallo volvió' });
    assert.equal(reopen.status, 200);

    const fila = leerCsat(ticket.id);
    assert.equal(fila.csat_rating, null, 'la valoración anterior ya no describe el servicio actual');
    assert.equal(fila.csat_comment, null);
    assert.equal(fila.csat_answered_at, null);
  });

  it('PATCH a OPEN también borra la valoración', async () => {
    const ticket = await ticketResueltoYMegusto();

    const reopen = await adminC.patch(`/api/tickets/${ticket.id}`, { status: 'OPEN' });
    assert.equal(reopen.status, 200);

    const fila = leerCsat(ticket.id);
    assert.equal(fila.csat_rating, null);
    assert.equal(fila.csat_comment, null);
    assert.equal(fila.csat_answered_at, null);
  });

  it('el ticket reabierto vuelve a aceptar una encuesta nueva', async () => {
    const ticket = await ticketResueltoYMegusto();
    await adminC.post(`/api/tickets/${ticket.id}/reopen`, { reason: 'Reabierto' });

    // Con el ticket abierto la encuesta debe rechazarse: solo aplica a resueltos.
    const whilstOpen = await empleadoC.post(`/api/tickets/${ticket.id}/csat`, { rating: 5 });
    assert.equal(whilstOpen.status, 400);

    await adminC.post(`/api/tickets/${ticket.id}/resolve`, { resolution: 'Ahora sí corregido.' });
    const nuevo = await empleadoC.post(`/api/tickets/${ticket.id}/csat`, { rating: 5, comment: 'Perfecto' });
    assert.equal(nuevo.status, 200);

    const fila = leerCsat(ticket.id);
    assert.equal(fila.csat_rating, 5);
    assert.equal(fila.csat_comment, 'Perfecto');
  });
});
