import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

const IMG_PNG = {
  name: 'captura.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

const IMG_JPG = {
  name: 'foto.jpg',
  mime: 'image/jpeg',
  buffer: Buffer.from('ffd8ffe000104a464946', 'hex'),
};

describe('Tickets, adjuntos y filtros', () => {
  it('crear ticket con múltiples adjuntos válidos', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const res = await c.postMultipart(
      '/api/tickets',
      { title: 'Ticket con archivos', description: 'Prueba adjuntos', category_id: 1, priority: 'HIGH' },
      [IMG_PNG, IMG_JPG]
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.attachments.length, 2);
    assert.ok(res.body.ticket.attachment_count >= 2);
  });

  it('rechaza archivo cuyo contenido no coincide con la extensión', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const bad = {
      name: 'malicioso.png',
      mime: 'image/png',
      buffer: Buffer.from('%PDF-1.7 this is actually a pdf', 'latin1'),
    };
    const res = await c.postMultipart(
      '/api/tickets',
      { title: 'Ticket malo', description: 'D', category_id: 1, priority: 'LOW' },
      [bad]
    );
    assert.equal(res.status, 400);
  });

  it('descarga de adjunto requiere autenticación', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const t = await c.postMultipart(
      '/api/tickets',
      { title: 'Con adjunto', description: 'D', category_id: 1, priority: 'LOW' },
      [IMG_PNG]
    );
    const id = t.body.attachments[0].id;

    const anon = createClient();
    const dl = await anon.get(`/api/files/${id}`);
    assert.equal(dl.status, 401);
  });

  it('filtros combinados funcionan', async () => {
    const c = createClient();
    await c.login('admin', '123456');

    // Crear varios tickets en distintas categorías
    await c.post('/api/tickets', { title: 'Filtro A', description: 'Desc A', category_id: 1, priority: 'LOW' });
    await c.post('/api/tickets', { title: 'Filtro B', description: 'Desc B', category_id: 2, priority: 'HIGH' });

    const res = await c.get('/api/tickets?category=1&priority=LOW');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.every((t) => t.category_id === 1 && t.priority === 'LOW'));
    assert.ok(res.body.data.length >= 1 && res.body.data.some((t) => t.title === 'Filtro A'));

    const search = await c.get('/api/tickets?search=Filtro%20B');
    assert.ok(search.body.data.every((t) => t.title.includes('Filtro B')));
  });

  it('historial registra cambios de estado y prioridad', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const t = await c.post('/api/tickets', { title: 'Historico', description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;

    await c.post(`/api/tickets/${id}/resolve`, { resolution: 'Resolución de prueba' });
    await c.patch(`/api/tickets/${id}`, { priority: 'CRITICAL' });

    const detail = await c.get(`/api/tickets/${id}`);
    assert.equal(detail.status, 200);
    const actions = detail.body.history.map((h) => h.action);
    assert.ok(actions.includes('CREATED'));
    assert.ok(actions.includes('RESOLVED'));
    assert.ok(actions.includes('PRIORITY_CHANGED'));
  });

  it('cerrar un ticket registra resolución en historial', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const t = await c.post('/api/tickets', { title: 'Cierre', description: 'D', category_id: 1, priority: 'MEDIUM' });
    const id = t.body.ticket.id;

    await c.post(`/api/tickets/${id}/resolve`, { resolution: 'Resolución de prueba' });
    const detail = await c.get(`/api/tickets/${id}`);
    assert.ok(detail.body.ticket.resolved_at);
  });

  it('export CSV devuelve archivo', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const res = await c.get('/api/tickets/export');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
  });

  it('empleado no puede exportar', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const res = await c.get('/api/tickets/export');
    assert.equal(res.status, 403);
  });

  it('comentario con adjunto queda vinculado', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const t = await c.post('/api/tickets', { title: 'Comentario archivo', description: 'D', category_id: 1, priority: 'LOW' });
    const id = t.body.ticket.id;

    const cm = await c.postMultipart(`/api/tickets/${id}/comments`, { message: 'Con adjunto' }, [IMG_JPG]);
    assert.equal(cm.status, 201);
    assert.equal(cm.body.attachments.length, 1);

    const detail = await c.get(`/api/tickets/${id}`);
    const att = detail.body.attachments.find((a) => a.comment_id === cm.body.comment.id);
    assert.ok(att, 'El adjunto debe estar ligado al comentario');
  });
});
