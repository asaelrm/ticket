// Pruebas de integración MSSQL: autenticación, sesiones y flujos básicos
// Ejecutar: npm run test:mssql
// Requiere .env.mssql-test con credenciales válidas

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient, createEmpleadoClient, createTecnicoClient, uniqueSuffix, IMG_PNG } from './helpers-mssql.js';
import { ensureMssqlTestSetup } from './setup-mssql.js';

const IMG_PNG_LOCAL = {
  name: 'captura.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

let adminClient;
let empleadoClient;
let tecnicoClient;
let testSuffix;

before(async () => {
  await ensureMssqlTestSetup();
  testSuffix = uniqueSuffix();
  
  adminClient = await createAdminClient(testSuffix);
  empleadoClient = await createEmpleadoClient(testSuffix);
  tecnicoClient = await createTecnicoClient(testSuffix);
});

describe('MSSQL Integration: Autenticación y sesiones', () => {
  it('login con credenciales válidas devuelve el usuario', async () => {
    const c = await createAdminClient(uniqueSuffix());
    const res = await c.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'ADMIN');
    assert.equal(res.body.user.username, TEST_ADMIN_USER || 'admin');
    assert.ok(Array.isArray(res.body.user.permissions));
  });

  it('login con credenciales incorrectas devuelve 401', async () => {
    const c = await createAdminClient(uniqueSuffix());
    // El login falla en el helper, probamos directamente
    const c2 = (await import('./helpers-mssql.js')).createClient();
    const res = await c2.post('/api/auth/login', { 
      account: TEST_ADMIN_USER || 'admin', 
      password: 'wrong', 
      remember: false 
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/auth/me devuelve el usuario autenticado', async () => {
    const res = await adminClient.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, TEST_ADMIN_USER || 'admin');
  });

  it('logout destruye la sesión', async () => {
    const c = await createAdminClient(uniqueSuffix());
    const out = await c.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 401);
  });
});

describe('MSSQL Integration: Tickets CRUD', () => {
  it('crear ticket con adjuntos', async () => {
    const title = `Ticket MSSQL ${testSuffix}`;
    const res = await adminClient.postMultipart(
      '/api/tickets',
      { title, description: 'Prueba MSSQL', category_id: 1, priority: 'HIGH' },
      [IMG_PNG_LOCAL]
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.attachments.length, 1);
    assert.ok(res.body.ticket.id);
    assert.ok(res.body.ticket.ticket_number.startsWith('TCK-'));
  });

  it('listar tickets con filtros', async () => {
    const titleA = `Filtro A ${testSuffix}`;
    const titleB = `Filtro B ${testSuffix}`;
    await adminClient.post('/api/tickets', { title: titleA, description: 'D', category_id: 1, priority: 'LOW' });
    await adminClient.post('/api/tickets', { title: titleB, description: 'D', category_id: 2, priority: 'HIGH' });
    
    const res = await adminClient.get('/api/tickets?category=1&priority=LOW');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((t) => t.title === titleA));
  });

  it('historial registra cambios', async () => {
    const title = `Historial MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { title, description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;
    
    await adminClient.patch(`/api/tickets/${id}`, { priority: 'CRITICAL' });
    await adminClient.post(`/api/tickets/${id}/resolve`, { resolution: `Resuelto MSSQL ${testSuffix}` });
    
    const detail = await adminClient.get(`/api/tickets/${id}`);
    assert.equal(detail.status, 200);
    const actions = detail.body.history.map((h) => h.action);
    assert.ok(actions.includes('CREATED'));
    assert.ok(actions.includes('RESOLVED'));
    assert.ok(actions.includes('PRIORITY_CHANGED'));
  });

  it('empleado solo ve sus propios tickets', async () => {
    const empTitle = `Ticket Empleado MSSQL ${testSuffix}`;
    const adminTitle = `Ticket Admin MSSQL ${testSuffix}`;
    const empTicket = await empleadoClient.post('/api/tickets', { title: empTitle, description: 'D', category_id: 1, priority: 'LOW' });
    const adminTicket = await adminClient.post('/api/tickets', { title: adminTitle, description: 'D', category_id: 1, priority: 'LOW' });
    
    const res = await empleadoClient.get('/api/tickets');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((t) => t.id === empTicket.body.ticket.id));
    assert.ok(!res.body.data.some((t) => t.id === adminTicket.body.ticket.id));
  });
});

describe('MSSQL Integration: Flujo de resolución', () => {
  it('resolver, cerrar y reabrir', async () => {
    const title = `Flujo MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { title, description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;
    
    const resolve = await adminClient.post(`/api/tickets/${id}/resolve`, { 
      resolution: `Arreglado MSSQL ${testSuffix}`, 
      resolution_category: 'Reparación' 
    });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.body.ticket.status, 'RESOLVED');
    
    const close = await adminClient.post(`/api/tickets/${id}/close`, {});
    assert.equal(close.status, 200);
    assert.equal(close.body.ticket.status, 'CLOSED');
    
    const reopen = await adminClient.post(`/api/tickets/${id}/reopen`, { 
      reason: `Volvió a fallar MSSQL ${testSuffix}` 
    });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.body.ticket.status, 'OPEN');
    assert.ok(reopen.body.ticket.reopened_at);
  });

  it('empleado no puede resolver ni cerrar', async () => {
    const title = `Sin permiso MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { title, description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;
    
    assert.equal((await empleadoClient.post(`/api/tickets/${id}/resolve`, { resolution: 'x' })).status, 403);
    assert.equal((await empleadoClient.post(`/api/tickets/${id}/close`, {})).status, 403);
  });
});

describe('MSSQL Integration: Comentarios y adjuntos', () => {
  it('comentario con adjunto queda vinculado', async () => {
    const title = `Comentario MSSQL ${testSuffix}`;
    const t = await adminClient.post('/api/tickets', { title, description: 'D', category_id: 1, priority: 'LOW' });
    const id = t.body.ticket.id;
    
    const cm = await adminClient.postMultipart(`/api/tickets/${id}/comments`, { 
      message: `Con adjunto MSSQL ${testSuffix}` 
    }, [IMG_PNG_LOCAL]);
    assert.equal(cm.status, 201);
    assert.equal(cm.body.attachments.length, 1);
    
    const detail = await adminClient.get(`/api/tickets/${id}`);
    const att = detail.body.attachments.find((a) => a.comment_id === cm.body.comment.id);
    assert.ok(att, 'El adjunto debe estar ligado al comentario');
  });

  it('notas internas se ocultan al empleado', async () => {
    const title = `Nota interna MSSQL ${testSuffix}`;
    const t = await empleadoClient.post('/api/tickets', { title, description: 'D', category_id: 1, priority: 'LOW' });
    const id = t.body.ticket.id;
    
    const nota = await adminClient.postMultipart(`/api/tickets/${id}/comments`, { 
      message: `Nota interna MSSQL ${testSuffix}`, 
      is_internal: '1' 
    }, [IMG_PNG_LOCAL]);
    assert.equal(nota.status, 201);
    assert.equal(nota.body.comment.is_internal, true);
    
    const empDetail = await empleadoClient.get(`/api/tickets/${id}`);
    assert.ok(empDetail.body.comments.every((c) => !c.is_internal), 'el empleado no ve notas internas');
    assert.ok(empDetail.body.attachments.every((a) => a.comment_id !== nota.body.comment.id), 'el empleado no ve adjuntos internos');
  });
});

describe('MSSQL Integration: Exportación', () => {
  it('export CSV devuelve archivo', async () => {
    const res = await adminClient.get('/api/tickets/export');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
  });

  it('empleado no puede exportar', async () => {
    const res = await empleadoClient.get('/api/tickets/export');
    assert.equal(res.status, 403);
  });
});