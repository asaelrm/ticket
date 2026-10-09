import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';

const SHORT_PASSWORD = 'OnceChars1!';
const VALID_PASSWORD = 'DoceCaracteres1!';

describe('Política de contraseñas de doce caracteres', () => {
  it('mantiene el inicio de sesión de una cuenta existente con contraseña corta', async () => {
    const legacy = createClient();
    assert.equal((await legacy.login('admin', '123456')).status, 200);
  });

  it('exige doce caracteres al crear usuarios nuevos', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const roleId = (await admin.get('/api/users/roles')).body.roles.find((role) => role.code === 'EMPLOYEE').id;
    const base = {
      name: 'Política', last_name: 'Contraseña', username: `policy${Date.now()}`,
      email: `policy${Date.now()}@test.local`, role_id: roleId,
    };

    const short = await admin.post('/api/users', { ...base, password: SHORT_PASSWORD });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /12 caracteres/);

    const accepted = await admin.post('/api/users', { ...base, username: `${base.username}ok`, email: `ok.${base.email}`, password: VALID_PASSWORD });
    assert.equal(accepted.status, 201);
  });

  it('exige doce caracteres al cambiar una contraseña', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const short = await admin.post('/api/auth/change-password', {
      current_password: '123456', new_password: SHORT_PASSWORD,
    });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.new_password, /12 caracteres/);

    const accepted = await admin.post('/api/auth/change-password', {
      current_password: '123456', new_password: VALID_PASSWORD,
    });
    assert.equal(accepted.status, 200);
  });

  it('exige doce caracteres al restablecer una contraseña', async () => {
    const client = createClient();
    const forgot = await client.post('/api/auth/forgot-password', { account: 'empleado' });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.body.token);

    const short = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: SHORT_PASSWORD });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /12 caracteres/);

    const accepted = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: VALID_PASSWORD });
    assert.equal(accepted.status, 200);
  });
});
