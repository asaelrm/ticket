import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createSuperadminClient } from './helpers.js';

const SHORT_PASSWORD = '12345'; // 5 chars - too short for all roles
const VALID_PASSWORD_NORMAL = 'Valida123'; // 9 chars - valid for normal users and admins
const VALID_PASSWORD_SUPERADMIN = 'SuperAdmin123!'; // 14 chars - valid for SUPERADMIN

describe('Política de contraseñas por rol', () => {
  it('mantiene el inicio de sesión de una cuenta existente con contraseña corta', async () => {
    const legacy = createClient();
    assert.equal((await legacy.login('admin', '123456')).status, 200);
  });

  it('exige 6 caracteres al crear usuarios normales (EMPLOYEE)', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const roleId = (await admin.get('/api/users/roles')).body.roles.find((role) => role.code === 'EMPLOYEE').id;
    const base = {
      name: 'Política', last_name: 'Contraseña', username: `policy${Date.now()}`,
      email: `policy${Date.now()}@test.local`, role_id: roleId,
    };

    const short = await admin.post('/api/users', { ...base, password: SHORT_PASSWORD });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /6 caracteres/);

    const accepted = await admin.post('/api/users', { ...base, username: `${base.username}ok`, email: `ok.${base.email}`, password: VALID_PASSWORD_NORMAL });
    assert.equal(accepted.status, 201);
  });

  it('exige 6 caracteres al crear administradores de empresa (ADMIN)', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const roleId = (await admin.get('/api/users/roles')).body.roles.find((role) => role.code === 'ADMIN').id;
    const base = {
      name: 'Admin', last_name: 'Empresa', username: `admin${Date.now()}`,
      email: `admin${Date.now()}@test.local`, role_id: roleId,
    };

    const short = await admin.post('/api/users', { ...base, password: SHORT_PASSWORD });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /6 caracteres/);

    const accepted = await admin.post('/api/users', { ...base, username: `${base.username}ok`, email: `ok.${base.email}`, password: VALID_PASSWORD_NORMAL });
    assert.equal(accepted.status, 201);
  });

  it('exige 12 caracteres al crear SUPERADMIN', async () => {
    const superClient = await createSuperadminClient();
    const roleId = (await superClient.get('/api/users/roles')).body.roles.find((role) => role.code === 'SUPERADMIN').id;
    const base = {
      name: 'Super', last_name: 'Admin', username: `super${Date.now()}`,
      email: `super${Date.now()}@test.local`, role_id: roleId,
    };

    const short = await superClient.post('/api/users', { ...base, password: VALID_PASSWORD_NORMAL }); // 9 chars - valid for normal but not SUPERADMIN
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /12 caracteres/);

    const accepted = await superClient.post('/api/users', { ...base, username: `${base.username}ok`, email: `ok.${base.email}`, password: VALID_PASSWORD_SUPERADMIN });
    assert.equal(accepted.status, 201);
  });

  it('exige 6 caracteres al cambiar contraseña de usuario normal', async () => {
    const client = createClient();
    await client.login('empleado', 'Empleado1234!');
    const short = await client.post('/api/auth/change-password', {
      current_password: 'Empleado1234!', new_password: SHORT_PASSWORD,
    });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.new_password, /6 caracteres/);

    const accepted = await client.post('/api/auth/change-password', {
      current_password: 'Empleado1234!', new_password: VALID_PASSWORD_NORMAL,
    });
    assert.equal(accepted.status, 200);
  });

  it('exige 12 caracteres al cambiar contraseña de SUPERADMIN', async () => {
    const superClient = await createSuperadminClient();
    const short = await superClient.post('/api/auth/change-password', {
      current_password: 'SuperClave123!', new_password: VALID_PASSWORD_NORMAL, // 9 chars - valid for normal but not SUPERADMIN
    });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.new_password, /12 caracteres/);

    const accepted = await superClient.post('/api/auth/change-password', {
      current_password: 'SuperClave123!', new_password: VALID_PASSWORD_SUPERADMIN,
    });
    assert.equal(accepted.status, 200);
  });

  it('exige 6 caracteres al restablecer contraseña de usuario normal', async () => {
    const client = createClient();
    const forgot = await client.post('/api/auth/forgot-password', { account: 'empleado' });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.body.token);

    const short = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: SHORT_PASSWORD });
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /6 caracteres/);

    const accepted = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: VALID_PASSWORD_NORMAL });
    assert.equal(accepted.status, 200);
  });

  it('exige 12 caracteres al restablecer contraseña de SUPERADMIN', async () => {
    const client = createClient();
    const forgot = await client.post('/api/auth/forgot-password', { account: 'super_roles_test' });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.body.token);

    const short = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: VALID_PASSWORD_NORMAL }); // 9 chars
    assert.equal(short.status, 400);
    assert.match(short.body.fields.password, /12 caracteres/);

    const accepted = await client.post('/api/auth/reset-password', { token: forgot.body.token, password: VALID_PASSWORD_SUPERADMIN });
    assert.equal(accepted.status, 200);
  });
});
