import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

describe('Autenticación', () => {
  it('login con credenciales válidas devuelve el usuario', async () => {
    const c = createClient();
    const res = await c.login('admin', '123456');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'ADMIN');
    assert.equal(res.body.user.username, 'admin');
    assert.ok(Array.isArray(res.body.user.permissions), 'el login debe incluir permissions');
    assert.ok(res.body.user.permissions.includes('ticket.create'));
    assert.ok(res.body.user.permissions.includes('user.manage'));
  });

  it('login con credenciales incorrectas devuelve 401', async () => {
    const c = createClient();
    const res = await c.login('admin', 'wrong');
    assert.equal(res.status, 401);
  });

  it('GET /api/auth/me devuelve el usuario autenticado', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const res = await c.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
  });

  it('GET /api/auth/me sin sesión devuelve 401', async () => {
    const c = createClient();
    const res = await c.get('/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('logout destruye la sesión', async () => {
    const c = createClient();
    await c.login('admin', '123456');
    const out = await c.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 401);
  });

  it('forgot-password genera token en modo dev', async () => {
    const c = createClient();
    await c.get('/api/health');
    const res = await c.post('/api/auth/forgot-password', { account: 'admin' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.ok(res.body.resetUrl);
  });

  it('forgot-password con cuenta inexistente responde ok (no revela)', async () => {
    const c = createClient();
    await c.get('/api/health');
    const res = await c.post('/api/auth/forgot-password', { account: 'no_existe_xyz' });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(!res.body.token);
  });

  it('reset-password con token válido funciona', async () => {
    const c = createClient();
    await c.get('/api/health');
    const forgot = await c.post('/api/auth/forgot-password', { account: 'admin' });
    const token = forgot.body.token;
    const c2 = createClient();
    await c2.get('/api/health');
    const res = await c2.post('/api/auth/reset-password', { token, password: 'Nueva1234!' });
    assert.equal(res.status, 200);
    // Login con nueva contraseña funciona
    const c3 = createClient();
    const login = await c3.login('admin', 'Nueva1234!');
    assert.equal(login.status, 200);
    // Restaurar contraseña original
    await c3.get('/api/health');
    await c3.post('/api/auth/reset-password', { token, password: '123456' }).catch(() => {});
    // Usar forgot para restaurar
    const c4 = createClient();
    await c4.get('/api/health');
    const f2 = await c4.post('/api/auth/forgot-password', { account: 'admin' });
    if (f2.body.token) {
      const c5 = createClient();
      await c5.get('/api/health');
      await c5.post('/api/auth/reset-password', { token: f2.body.token, password: '123456' });
    }
  });

  it('login con empleado funciona', async () => {
    const c = createClient();
    const res = await c.login('empleado', 'Empleado1234!');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'EMPLOYEE');
  });
});