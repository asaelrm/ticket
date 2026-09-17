import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

let adminC;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', 'Admin1234!');
});

describe('Smoke Auditoría + Bandeja', () => {
  it('GET /api/audit devuelve filas con filtros y paginación', async () => {
    const created = await adminC.post('/api/tickets', {
      title: 'Audit smoke',
      description: 'Para auditoría',
      category_id: 1,
      priority: 'MEDIUM',
    });
    assert.equal(created.status, 201);

    const res = await adminC.get('/api/audit?perPage=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(Array.isArray(res.body.actions));
    const mine = res.body.data.find((r) => r.ticket_number === created.body.ticket.ticket_number);
    assert.ok(mine, 'debe aparecer el ticket creado');
    assert.equal(mine.action, 'CREATED');
    assert.equal(res.body.perPage, 10);
  });

  it('GET /api/audit filtra por acción y rango de fechas', async () => {
    const res = await adminC.get('/api/audit?action=CREATED&perPage=5');
    assert.equal(res.status, 200);
    for (const row of res.body.data) assert.equal(row.action, 'CREATED');

    const bad = await adminC.get('/api/audit?from=2026-13-99');
    assert.equal(bad.status, 200);
  });

  it('el empleado no puede ver auditoría', async () => {
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');
    const res = await emp.get('/api/audit');
    assert.equal(res.status, 403);
  });

  it('vistas de bandeja: mine, my-teams, open y assigned=none', async () => {
    const mine = await adminC.get('/api/tickets?view=mine&perPage=5');
    assert.equal(mine.status, 200);

    const teams = await adminC.get('/api/tickets?view=my-teams&perPage=5');
    assert.equal(teams.status, 200);

    const open = await adminC.get('/api/tickets?view=open&perPage=5');
    assert.equal(open.status, 200);

    const unassigned = await adminC.get('/api/tickets?view=open&assigned=none&perPage=5');
    assert.equal(unassigned.status, 200);
    for (const t of unassigned.body.data) {
      assert.equal(t.assigned_to_id, null, `${t.ticket_number} no debe tener asignado`);
    }
  });

  it('al resolverse/cerrarse un ticket sale de la bandeja (active=1)', async () => {
    const created = await adminC.post('/api/tickets', {
      title: 'Bandeja active',
      description: 'Debe salir de la bandeja al resolverse',
      category_id: 1,
      priority: 'MEDIUM',
    });
    assert.equal(created.status, 201);
    const t = created.body.ticket;

    const me = await adminC.get('/api/auth/me');
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: me.body.user.id });
    const mine = await adminC.get('/api/tickets?view=mine&perPage=100');
    assert.ok(mine.body.data.some((x) => x.id === t.id), 'view=mine debe ver el ticket asignado');

    // Resuelto: sale de la bandeja con active=1 pero sigue visible sin active.
    await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Listo', notify: '0' });
    const active = await adminC.get('/api/tickets?view=mine&active=1&perPage=100');
    assert.equal(
      active.body.data.some((x) => x.id === t.id),
      false,
      'un ticket resuelto no debe aparecer en la bandeja (active=1)'
    );
    const afterResolve = await adminC.get('/api/tickets?view=mine&perPage=100');
    assert.ok(afterResolve.body.data.some((x) => x.id === t.id), 'sin active=1 sí aparece (es histórico)');

    // Cerrado: tampoco debe salir en la bandeja.
    await adminC.post(`/api/tickets/${t.id}/close`, {});
    const closedActive = await adminC.get('/api/tickets?view=mine&active=1&perPage=100');
    assert.equal(
      closedActive.body.data.some((x) => x.id === t.id),
      false,
      'un ticket cerrado no debe aparecer en la bandeja (active=1)'
    );
  });
});