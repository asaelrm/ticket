import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

describe('Permisos', () => {
  it('admin puede acceder a usuarios, dashboard, categorías, roles', async () => {
    const c = createClient();
    await c.login('admin', 'Admin1234!');
    const endpoints = ['/api/users', '/api/dashboard/summary', '/api/categories', '/api/roles'];
    for (const url of endpoints) {
      const res = await c.get(url);
      assert.equal(res.status, 200, `${url} debería devolver 200 para admin`);
    }
  });

  it('empleado NO puede acceder a endpoints admin', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const forbidden = [
      ['/api/users', 403],
      ['/api/dashboard/summary', 403],
      ['/api/roles', 403],
      ['/api/categories', 200],     // GET abierto a cualquier autenticado
      ['/api/departments', 200],    // GET abierto a cualquier autenticado
    ];
    for (const [url, expected] of forbidden) {
      const res = await c.get(url);
      assert.equal(res.status, expected, `${url} debería devolver ${expected} para empleado`);
    }
  });

  it('empleado puede crear y ver sus propios tickets', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');

    const create = await c.post('/api/tickets', {
      title: 'Ticket de prueba empleado',
      description: 'Descripción de prueba',
      category_id: 1,
      priority: 'LOW',
    });
    assert.equal(create.status, 201);
    assert.ok(create.body.ticket.ticket_number.startsWith('TCK-'));
    const ticketId = create.body.ticket.id;

    const detail = await c.get(`/api/tickets/${ticketId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.ticket.id, ticketId);
  });

  it('empleado NO puede ver tickets de otros (y un id inexistente devuelve 404)', async () => {
    const admin = createClient();
    await admin.login('admin', 'Admin1234!');
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');

    // Admin crea ticket
    const t = await admin.post('/api/tickets', {
      title: 'Ticket admin-only',
      description: 'Desc',
      category_id: 1,
      priority: 'MEDIUM',
    });
    assert.equal(t.status, 201);
    const id = t.body.ticket.id;

    // Empleado intenta verlo — debería fallar (su query solo ve reporter_id = su.id)
    const res = await emp.get(`/api/tickets/${id}`);
    assert.equal(res.status, 404, 'Empleado no debería ver ticket de admin');
  });

  it('empleado NO puede cambiar estado de tickets', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    // Crear su propio ticket
    const t = await c.post('/api/tickets', { title: 'T', description: 'D', category_id: 1, priority: 'LOW' });
    const id = t.body.ticket.id;

    const patch = await c.patch(`/api/tickets/${id}`, { status: 'RESOLVED' });
    assert.equal(patch.status, 403);
  });

  it('admin puede cambiar estado y asignar tickets', async () => {
    const c = createClient();
    await c.login('admin', 'Admin1234!');
    const t = await c.post('/api/tickets', { title: 'T Admin', description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;

    const patch = await c.patch(`/api/tickets/${id}`, { status: 'IN_PROGRESS' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.ticket.status, 'IN_PROGRESS');

    const assign = await c.patch(`/api/tickets/${id}`, { assigned_to_id: 1 });
    assert.equal(assign.status, 200);
  });

  it('empleado puede agregar comentario', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const t = await c.post('/api/tickets', { title: 'T', description: 'D', category_id: 1, priority: 'LOW' });

    const comment = await c.post(`/api/tickets/${t.body.ticket.id}/comments`, { message: 'Comentario de prueba' });
    assert.equal(comment.status, 201);
    assert.equal(comment.body.comment.message, 'Comentario de prueba');
  });

  it('forgot-password con cuenta inexistente no revela información', async () => {
    const c = createClient();
    await c.get('/api/health');
    const res = await c.post('/api/auth/forgot-password', { account: 'usuario_inexistente_xyz' });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(!res.body.token, 'No debe devolver token para cuenta inexistente');
  });
});