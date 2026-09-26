import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';

let adminC;
let tecnicoC;
let empleadoC;
let tecnicoId;
let equipoId;
let equipoVacioId;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  tecnicoC = createClient();
  await tecnicoC.login('tecnico', 'Tecnico1234!');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');

  const me = await tecnicoC.get('/api/auth/me');
  tecnicoId = me.body.user.id;

  const equipo = await adminC.post('/api/teams', { name: 'Equipo Soporte Norte' });
  assert.equal(equipo.status, 201);
  equipoId = equipo.body.team.id;

  const vacio = await adminC.post('/api/teams', { name: 'Equipo Sin Tickets' });
  equipoVacioId = vacio.body.team.id;
});

async function crearTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Ticket ${Math.random().toString(36).slice(2, 8)}`,
    description: 'Descripción de prueba',
    category_id: over.category_id ?? 1,
    priority: 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

// Fija el resultado del servicio para poder medirlo sin esperar al reloj.
function registrarResolucion(ticketId, { tecnico, minutos, csat, team, slaDueAt, answeredAt }) {
  const ahora = '2026-03-15T12:00:00.000Z';
  db.prepare(
    `UPDATE tickets
        SET status = 'CLOSED', resolved_at = ?, closed_at = ?, resolved_by = ?, closed_by = ?,
            time_spent_minutes = ?, assigned_team_id = COALESCE(?, assigned_team_id),
            sla_due_at = ?, csat_rating = ?, csat_comment = ?, csat_answered_at = ?
      WHERE id = ?`
  ).run(
    ahora,
    ahora,
    tecnico,
    tecnico,
    minutos,
    team ?? null,
    slaDueAt ?? '2026-03-15T18:00:00.000Z',
    csat ?? null,
    csat ? 'Comentario de prueba' : null,
    answeredAt ?? (csat ? ahora : null),
    ticketId
  );
}

describe('Métricas de satisfacción (CSAT)', () => {
  it('sin respuestas no inventa una media ni una tasa cero', async () => {
    const ticket = await crearTicket(empleadoC, { title: 'Sin encuesta para CSAT' });
    registrarResolucion(ticket.id, { tecnico: tecnicoId, minutos: 30 });

    const res = await adminC.get('/api/reports/csat');
    assert.equal(res.status, 200);
    assert.equal(res.body.average, null, 'sin respuestas la media es null, no 0');
    assert.equal(res.body.response_rate, 0, 'el denominador existe pero nadie respondió: 0% real');
    assert.equal(res.body.responses, 0);
    assert.equal(res.body.has_data, false);
    assert.equal(res.body.distribution.length, 5);
    assert.ok(res.body.distribution.every((d) => d.n === 0), 'la distribución existe y está a cero');
    assert.deepEqual(res.body.by_technician, [], 'sin respuestas no hay desglose que mostrar');
  });

  it('la tasa es null cuando no hay tickets elegibles', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const res = await adminC.get(`/api/reports/csat?from=${hoy}&to=${hoy}&status=OPEN`);
    assert.equal(res.status, 200);
    assert.equal(res.body.eligible, 0);
    assert.equal(res.body.response_rate, null, 'no hay base: la tasa se desconoce');
    assert.equal(res.body.average, null);
  });

  it('calcula media, respuestas, tasa y distribución con datos reales', async () => {
    const t1 = await crearTicket(empleadoC, { title: 'CSAT 5 estrellas' });
    registrarResolucion(t1.id, { tecnico: tecnicoId, minutos: 45, csat: 5 });
    const t2 = await crearTicket(empleadoC, { title: 'CSAT 1 estrella' });
    registrarResolucion(t2.id, { tecnico: tecnicoId, minutos: 90, csat: 1 });
    // Resuelto sin encuesta: entra en el denominador, no en el numerador.
    const t3 = await crearTicket(empleadoC, { title: 'CSAT sin contestar' });
    registrarResolucion(t3.id, { tecnico: tecnicoId, minutos: 20 });

    const res = await adminC.get('/api/reports/csat');
    assert.equal(res.status, 200);

    const cinco = res.body.distribution.find((d) => d.rating === 5);
    const uno = res.body.distribution.find((d) => d.rating === 1);
    assert.ok(cinco.n >= 1, 'acumula las respuestas de 5 estrellas');
    assert.ok(uno.n >= 1, 'y las de 1 estrella');
    assert.equal(
      res.body.distribution.reduce((suma, d) => suma + d.n, 0),
      res.body.responses,
      'la distribución suma exactamente las respuestas'
    );
    assert.equal(res.body.has_data, true);
    assert.ok(res.body.average > 0 && res.body.average <= 5);
    assert.ok(res.body.eligible >= res.body.responses, 'el denominador incluye a quien no respondió');
    assert.equal(
      res.body.response_rate,
      Math.round((res.body.responses / res.body.eligible) * 1000) / 10
    );
  });

  it('desglosa el CSAT por técnico, departamento y categoría', async () => {
    const res = await adminC.get('/api/reports/csat');
    assert.equal(res.status, 200);

    for (const clave of ['by_technician', 'by_department', 'by_category']) {
      assert.ok(Array.isArray(res.body[clave]), `${clave} debe ser un arreglo`);
    }

    const mio = res.body.by_technician.find((x) => x.label === 'Técnico Soporte');
    assert.ok(mio, 'el desglose por técnico usa el nombre, no el id');
    assert.ok(mio.responses > 0);
    assert.ok(mio.average > 0 && mio.average <= 5);
    assert.ok(res.body.by_technician.every((x) => x.responses > 0), 'solo filas con respuestas');
  });

  it('la evolución se agrupa por el mes en que se respondió', async () => {
    const res = await adminC.get('/api/reports/csat');
    assert.equal(res.status, 200);
    assert.ok(res.body.by_month.length > 0);
    assert.ok(res.body.by_month.every((m) => /^\d{4}-\d{2}$/.test(m.month)));
    assert.ok(res.body.by_month.some((m) => m.month === '2026-03'), 'la respuesta secontó en marzo');
    const meses = res.body.by_month.map((m) => m.month);
    assert.deepEqual(meses, [...meses].sort(), 'va en orden cronológico');
  });

  it('reabrir un ticket saca su valoración de las métricas', async () => {
    const ticket = await crearTicket(empleadoC, { title: 'CSAT que se reinicia' });
    registrarResolucion(ticket.id, { tecnico: tecnicoId, minutos: 30, csat: 4 });

    const conCsat = await adminC.get('/api/reports/csat');
    const antes = conCsat.body.responses;

    await adminC.post(`/api/tickets/${ticket.id}/reopen`, { reason: 'Volvió a fallar' });

    const trasReapertura = await adminC.get('/api/reports/csat');
    assert.equal(trasReapertura.body.responses, antes - 1, 'la valoración obsoleta sale del reporte');
  });
});

describe('Rendimiento por técnico', () => {
  it('cuenta asignados, abiertos, resueltos, cerrados y tiempo dedicado', async () => {
    const abierto = await crearTicket(empleadoC, { title: 'Carga viva del técnico' });
    await adminC.patch(`/api/tickets/${abierto.id}`, { assigned_to_id: tecnicoId, assigned_team_id: equipoId });

    const cerrado = await crearTicket(empleadoC, { title: 'Trabajo ya cerrado' });
    registrarResolucion(cerrado.id, { tecnico: tecnicoId, minutos: 120, team: equipoId });

    const res = await adminC.get('/api/reports/performance');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.by_technician));

    const mio = res.body.by_technician.find((x) => x.id === tecnicoId);
    assert.ok(mio, 'aparece el técnico con nombre completo');
    assert.equal(mio.technician, 'Técnico Soporte');
    assert.ok(mio.assigned >= 1, 'cuenta el ticket que tiene asignado');
    assert.ok(mio.open >= 1, 'y distingue el que sigue abierto');
    assert.ok(mio.resolved >= 1, 'cuenta los que resolvió');
    assert.ok(mio.closed >= 1, 'y los que cerró');
    assert.ok(mio.total_time_minutes >= 120, 'suma el tiempo dedicado');
    assert.ok(mio.avg_time_minutes > 0, 'y su media');
    assert.ok(mio.avg_resolution_hours > 0, 'incluye el tiempo medio de resolución');
  });

  it('el cumplimiento de SLA se expresa sobre los tickets comparables', async () => {
    const aTiempo = await crearTicket(empleadoC, { title: 'Resuelto dentro del SLA' });
    registrarResolucion(aTiempo.id, {
      tecnico: tecnicoId,
      minutos: 10,
      slaDueAt: '2026-03-15T18:00:00.000Z', // se resolvió a las 12:00
    });
    const tarde = await crearTicket(empleadoC, { title: 'Resuelto fuera del SLA' });
    registrarResolucion(tarde.id, {
      tecnico: tecnicoId,
      minutos: 10,
      slaDueAt: '2026-03-15T09:00:00.000Z', // se resolvió a las 12:00
    });

    const res = await adminC.get('/api/reports/performance');
    const mio = res.body.by_technician.find((x) => x.id === tecnicoId);
    assert.ok(mio.sla_comparable >= 2, 'los dos casos anteriores son comparables');
    assert.ok(mio.sla_breached >= 1, 'detecta el incumplimiento');
    assert.equal(mio.sla_breached + mio.sla_within, mio.sla_comparable, 'el total cuadra');
    assert.equal(mio.sla_pct, Math.round((mio.sla_within / mio.sla_comparable) * 1000) / 10);
    assert.ok(mio.sla_pct < 100, 'el incumplimiento baja el porcentaje');
  });

  it('no se cuela un ticket en el rendimiento de otro técnico', async () => {
    const ticket = await crearTicket(empleadoC, { title: 'Atribución exacta' });
    await adminC.patch(`/api/tickets/${ticket.id}`, { assigned_to_id: tecnicoId });
    registrarResolucion(ticket.id, { tecnico: tecnicoId, minutos: 15 });

    const res = await adminC.get('/api/reports/performance');
    const admin = await adminC.get('/api/auth/me');
    const mio = res.body.by_technician.find((x) => x.id === tecnicoId);

    const ajena = res.body.by_technician.find((x) => x.id === admin.body.user.id);
    if (ajena) {
      assert.ok(ajena.assigned !== 1 || ajena.resolved === 0, 'el admin no resolvió este ticket');
    }
    assert.ok(mio.resolved >= 1);
  });
});

describe('Rendimiento por equipo', () => {
  it('la carga abierta del equipo es un dato fiable', async () => {
    const ticket = await crearTicket(empleadoC, { title: 'Carga del equipo' });
    await adminC.patch(`/api/tickets/${ticket.id}`, { assigned_team_id: equipoId });

    const res = await adminC.get('/api/reports/performance');
    assert.equal(res.status, 200);
    assert.equal(res.body.by_team.basis, 'current_assignment', 'la base de cálculo va declarada');
    assert.ok(res.body.by_team.note.length > 0, 'y se explica la limitación');

    const mio = res.body.by_team.data.find((x) => x.id === equipoId);
    assert.ok(mio, 'aparece el equipo con tickets');
    assert.equal(mio.team, 'Equipo Soporte Norte');
    assert.ok(mio.assigned >= 1);
    assert.ok(mio.open >= 1, 'la carga abierta no depende de histórico');

    const vacio = res.body.by_team.data.find((x) => x.id === equipoVacioId);
    assert.equal(vacio, undefined, 'un equipo sin tickets no genera una fila de ceros');
  });

  it('los tickets completados se atribuyen al equipo actual y se advierte', async () => {
    const ticket = await crearTicket(empleadoC, { title: 'Completado en equipo' });
    registrarResolucion(ticket.id, { tecnico: tecnicoId, minutos: 60, team: equipoId });

    const res = await adminC.get('/api/reports/performance');
    const mio = res.body.by_team.data.find((x) => x.id === equipoId);
    assert.ok(mio.completed >= 1);
    assert.equal(
      res.body.by_team.basis,
      'current_assignment',
      'no se presenta como si fuera el equipo histórico'
    );
  });
});

describe('Las nuevas secciones se exponen y se protegen por permiso', () => {
  it('/full incluye CSAT, técnicos y equipos', async () => {
    const res = await adminC.get('/api/reports/full');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.byTechnician));
    assert.ok(Array.isArray(res.body.byTeam.data));
    assert.equal(typeof res.body.csat.average, 'number');
    assert.ok(Array.isArray(res.body.csat.distribution));
  });

  it('el empleado sin report.view no llega a ninguna de ellas', async () => {
    for (const ruta of ['/api/reports/csat', '/api/reports/performance', '/api/reports/full']) {
      const res = await empleadoC.get(ruta);
      assert.equal(res.status, 403, `${ruta} debe seguir protegida`);
    }
  });

  it('el CSV incluye las secciones nuevas cuando se piden', async () => {
    const res = await adminC.get('/api/reports/export?sections=technicians,teams,csat');
    assert.equal(res.status, 200);
    const body = String(res.text);
    assert.ok(body.includes('RENDIMIENTO POR TÉCNICO'));
    assert.ok(body.includes('RENDIMIENTO POR EQUIPO'));
    assert.ok(body.includes('SATISFACCIÓN (CSAT)'));
    assert.ok(body.includes('Técnico') && body.includes('Equipo Soporte Norte'));
    assert.ok(!body.includes('DETALLE DE TICKETS'), 'solo exporta las secciones pedidas');
  });
});
