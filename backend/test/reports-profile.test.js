import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';

let adminC;
let empleadoC;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');
});

async function createTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Ticket ${Math.random().toString(36).slice(2, 8)}`,
    description: over.description || 'Descripción de prueba',
    category_id: over.category_id ?? 1,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('Reportes con filtro de fecha', () => {
  it('el resumen respeta el rango de fechas de creación', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const before = await adminC.get('/api/reports/summary');
    assert.equal(before.status, 200);

    const t1 = await createTicket(adminC);
    const t2 = await createTicket(adminC);
    db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(isoDaysAgo(10), t2.id);

    const all = await adminC.get('/api/reports/summary');
    assert.equal(all.body.total - before.body.total, 2);

    const filtered = await adminC.get(`/api/reports/summary?from=${today}&to=${today}`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.total - before.body.total, 1, 'solo el ticket de hoy entra en el rango');
    assert.equal(filtered.body.range.from, today);
    assert.ok(t1.id);

    const older = await adminC.get(`/api/reports/summary?to=${today}`);
    assert.equal(older.body.total - before.body.total, 2, 'sin "from" incluye históricos');
  });

  it('los desgloses aceptan rango de fechas', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await adminC.get(`/api/reports/by-status?from=${today}&to=${today}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it('/full devuelve todas las secciones en una sola llamada', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await adminC.get(`/api/reports/full?from=${today}&to=${today}`);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.summary.total, 'number');
    for (const key of ['byStatus', 'byPriority', 'byCategory', 'byDepartment', 'byDay', 'byUser']) {
      assert.ok(Array.isArray(res.body[key]), `${key} debe ser un arreglo`);
    }
  });

  it('el detalle del reporte respeta los filtros de prioridad', async () => {
    const ticket = await createTicket(adminC, { priority: 'CRITICAL' });
    const res = await adminC.get('/api/reports/full?priority=CRITICAL');
    assert.equal(res.status, 200);
    assert.ok(res.body.details.some((item) => item.ticket_number === ticket.ticket_number));
    assert.ok(res.body.details.every((item) => item.priority === 'CRITICAL'));
  });

  it('empleado tampoco puede usar /full', async () => {
    const res = await empleadoC.get('/api/reports/full');
    assert.equal(res.status, 403);
  });

  it('exporta el reporte en CSV organizado por secciones', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await adminC.get(`/api/reports/export?from=${today}&to=${today}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
    assert.match(String(res.headers['content-disposition']), /reporte-tickets-/);

    const body = String(res.text);
    assert.ok(body.includes('REPORTE DE TICKETS'));
    assert.ok(body.includes('RESUMEN'));
    assert.ok(body.includes('TICKETS POR ESTADO'));
    assert.ok(body.includes('TICKETS POR CATEGORÍA'));
    assert.ok(body.includes('TOP REPORTEROS'));
    assert.ok(body.includes(';'), 'usa punto y coma como separador (Excel ES)');
  });

  it('exporta únicamente las secciones seleccionadas', async () => {
    const res = await adminC.get('/api/reports/export?sections=details,status');
    assert.equal(res.status, 200);
    const body = String(res.text);
    assert.ok(body.includes('DETALLE DE TICKETS'));
    assert.ok(body.includes('TICKETS POR ESTADO'));
    assert.ok(!body.includes('TICKETS POR CATEGORÍA'));
    assert.ok(!body.includes('RESUMEN'));
  });

  it('empleado no puede ver reportes', async () => {
    const res = await empleadoC.get('/api/reports/summary');
    assert.equal(res.status, 403);
  });
});

describe('Historial de tickets por usuario', () => {
  it('el empleado ve sus propios tickets reportados', async () => {
    const me = await empleadoC.get('/api/auth/me');
    const id = me.body.user.id;

    const t = await createTicket(empleadoC, { title: 'Mi incidencia de historial' });

    const res = await empleadoC.get(`/api/users/${id}/tickets?scope=reported`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, id);
    assert.ok(res.body.data.some((x) => x.id === t.id));
    assert.ok(res.body.total >= 1);
    assert.ok(res.body.by_status);
  });

  it('el empleado ve los tickets asignados a él y no los de otros', async () => {
    const me = await empleadoC.get('/api/auth/me');
    const empleadoId = me.body.user.id;
    const adminMe = await adminC.get('/api/auth/me');
    const adminId = adminMe.body.user.id;

    const t = await createTicket(adminC, { title: 'Asignado al empleado' });
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: empleadoId });

    const assigned = await empleadoC.get(`/api/users/${empleadoId}/tickets?scope=assigned`);
    assert.equal(assigned.status, 200);
    assert.ok(assigned.body.data.some((x) => x.id === t.id));

    const forbidden = await empleadoC.get(`/api/users/${adminId}/tickets`);
    assert.equal(forbidden.status, 403);
  });

  it('el admin puede ver el historial de cualquier usuario', async () => {
    const me = await empleadoC.get('/api/auth/me');
    const res = await adminC.get(`/api/users/${me.body.user.id}/tickets?perPage=5`);
    assert.equal(res.status, 200);
    assert.equal(res.body.perPage, 5);
    assert.ok(Array.isArray(res.body.data));
  });

  it('404 si el usuario no existe', async () => {
    const res = await adminC.get('/api/users/99999/tickets');
    assert.equal(res.status, 404);
  });
});
