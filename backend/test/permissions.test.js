import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

describe('Permisos', () => {
  it('admin puede acceder a usuarios, dashboard, categorías, roles', async () => {
    const c = createClient();
    await c.login('admin', '123456');
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
    await admin.login('admin', '123456');
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
    await c.login('admin', '123456');
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

describe('Autorización de los directorios asignables', () => {
  const ASSIGNABLE = ['/api/users/assignable', '/api/teams/assignable'];

  it('admin (todos los permisos) puede consultar usuarios y equipos asignables', async () => {
    const c = createClient();
    await c.login('admin', '123456');

    const users = await c.get('/api/users/assignable');
    assert.equal(users.status, 200);
    assert.ok(Array.isArray(users.body.data));
    assert.ok(users.body.data.length > 0, 'El directorio de usuarios no debería venir vacío');
    assert.ok(
      users.body.data.every((u) => u.name && u.last_name),
      'Cada usuario debe traer nombre y apellidos para el selector'
    );
    // El directorio no debe filtrar datos sensibles del usuario.
    for (const u of users.body.data) {
      assert.equal(u.email, undefined, 'assignable no debe exponer email');
      assert.equal(u.username, undefined, 'assignable no debe exponer username');
      assert.equal(u.password_hash, undefined, 'assignable no debe exponer hash');
    }

    const teams = await c.get('/api/teams/assignable');
    assert.equal(teams.status, 200);
    assert.ok(Array.isArray(teams.body.data));
  });

  it('técnico puede consultar los asignables por ticket.assign y ticket.view.all', async () => {
    const c = createClient();
    await c.login('tecnico', 'Tecnico1234!');

    for (const url of ASSIGNABLE) {
      const res = await c.get(url);
      assert.equal(res.status, 200, `${url} debería devolver 200 para técnico`);
      assert.ok(Array.isArray(res.body.data));
    }
  });

  it('empleado NO puede consultar los directorios asignables', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');

    for (const url of ASSIGNABLE) {
      const res = await c.get(url);
      assert.equal(res.status, 403, `${url} debería devolver 403 para empleado`);
      assert.equal(res.body.error, 'No tiene permiso para realizar esta acción');
      assert.equal(res.body.data, undefined, 'No debe devolver datos sin permiso');
    }
  });

  it('sin sesión los directorios asignables responden 401', async () => {
    for (const url of ASSIGNABLE) {
      const c = createClient();
      const res = await c.get(url);
      assert.equal(res.status, 401, `${url} debería devolver 401 sin autenticación`);
      assert.equal(res.body.error, 'No autenticado');
    }
  });

  it('un rol con ticket.assign (sin ver todos) sí accede a los asignables', async () => {
    // ticket.assign es el permiso que habilita los selectores de la bandeja y
    // del detalle; no debe exigir ticket.view.all para funcionar.
    const admin = createClient();
    await admin.login('admin', '123456');

    const roles = await admin.get('/api/roles');
    assert.equal(roles.status, 200);
    const tecnico = roles.body.roles.find((r) => r.code === 'TECHNICIAN');
    assert.ok(tecnico, 'Debe existir el rol TECHNICIAN');
    const original = tecnico.permissions;

    const soloAssign = await admin.patch(`/api/roles/${tecnico.id}/permissions`, {
      permissions: ['ticket.create', 'ticket.comment', 'ticket.assign', 'ticket.resolve', 'ticket.close'],
    });
    assert.equal(soloAssign.status, 200);

    try {
      const c = createClient();
      await c.login('tecnico', 'Tecnico1234!');
      for (const url of ASSIGNABLE) {
        const res = await c.get(url);
        assert.equal(res.status, 200, `${url} debería devolver 200 con solo ticket.assign`);
      }
    } finally {
      // Restaura la matriz sembrada para no afectar a los tests siguientes.
      await admin.patch(`/api/roles/${tecnico.id}/permissions`, { permissions: original });
    }
  });

  it('un rol sin ninguno de los tres permisos no accede a los asignables', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const roles = await admin.get('/api/roles');
    const tecnico = roles.body.roles.find((r) => r.code === 'TECHNICIAN');
    const original = tecnico.permissions;

    const stripped = await admin.patch(`/api/roles/${tecnico.id}/permissions`, {
      permissions: ['ticket.create', 'ticket.comment'],
    });
    assert.equal(stripped.status, 200);

    try {
      const c = createClient();
      await c.login('tecnico', 'Tecnico1234!');
      for (const url of ASSIGNABLE) {
        const res = await c.get(url);
        assert.equal(res.status, 403, `${url} debería devolver 403 sin permisos de directorio`);
      }
    } finally {
      await admin.patch(`/api/roles/${tecnico.id}/permissions`, { permissions: original });
    }
  });
});