import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import db from '../src/db.js';
import { createClient } from './helpers.js';
import {
  loadUser,
  touchLastLogin,
  publicUser,
  requirePermission,
  requireAnyPermission,
} from '../src/middleware/auth.js';

const PASSWORD = 'Prueba1234!';

let seq = 0;
const uniq = (prefix) => `${prefix}_${Date.now()}_${seq++}`;

function userRow(over = {}) {
  return {
    id: 7,
    name: 'Ana',
    last_name: 'Prueba',
    username: 'ana',
    email: 'ana@example.invalid',
    department_id: null,
    position: null,
    role_id: 3,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: null,
    role_code: 'TECHNICIAN',
    role_name: 'Técnico',
    department_name: null,
    ...over,
  };
}

function fakeContract({ user = null, permissions = [] } = {}) {
  const calls = [];
  return {
    calls,
    async queryOne(sql, params) {
      calls.push({ method: 'queryOne', sql, params });
      return user;
    },
    async queryMany(sql, params) {
      calls.push({ method: 'queryMany', sql, params });
      return permissions;
    },
    async execute(sql, params) {
      calls.push({ method: 'execute', sql, params });
      return { rowsAffected: 1 };
    },
  };
}

// --------------------------------------------------------------------------
// Contrato async: qué SQL y qué parámetros viaja, y con qué forma.
// --------------------------------------------------------------------------

describe('Autenticación sobre el contrato async', () => {
  it('sin sesión no consulta nada y devuelve null', async () => {
    const contract = fakeContract({ user: userRow() });
    assert.equal(await loadUser({}, contract), null);
    assert.equal(await loadUser({ session: {} }, contract), null);
    assert.equal(await loadUser({ session: { userId: 0 } }, contract), null);
    assert.equal(contract.calls.length, 0);
  });

  it('carga el usuario por @userId y sus permisos por @roleId', async () => {
    const contract = fakeContract({
      user: userRow(),
      permissions: [{ code: 'ticket.create' }, { code: 'ticket.view.own' }],
    });
    const user = await loadUser({ session: { userId: 7 } }, contract);

    assert.equal(contract.calls.length, 2);
    assert.equal(contract.calls[0].method, 'queryOne');
    assert.match(contract.calls[0].sql, /WHERE u\.id = @userId/);
    assert.deepEqual(contract.calls[0].params, { userId: 7 });
    assert.equal(contract.calls[1].method, 'queryMany');
    assert.match(contract.calls[1].sql, /WHERE rp\.role_id = @roleId/);
    assert.deepEqual(contract.calls[1].params, { roleId: 3 });

    assert.deepEqual(user.permissions, ['ticket.create', 'ticket.view.own']);
    assert.equal(user.inactive, false);
    assert.equal(user.role, 'TECHNICIAN');
    assert.equal(user.role_name, 'Técnico');
    assert.equal(user.department_name, '', 'sin departamento debe serializarse como cadena vacía');
    assert.equal(user.active, true);
  });

  it('un usuario inexistente devuelve null y no consulta permisos', async () => {
    const contract = fakeContract({ user: null });
    assert.equal(await loadUser({ session: { userId: 999 } }, contract), null);
    assert.equal(contract.calls.length, 1);
  });

  it('un usuario inactivo no consulta permisos y no se autentica', async () => {
    const contract = fakeContract({ user: userRow({ active: 0 }), permissions: [{ code: 'ticket.create' }] });
    const user = await loadUser({ session: { userId: 7 } }, contract);
    assert.equal(contract.calls.length, 1, 'un usuario inactivo no debe consultar role_permissions');
    assert.deepEqual(user.permissions, []);
    assert.equal(user.inactive, true);
    assert.equal(user.active, false);
  });

  it('ninguna consulta migrada usa placeholders posicionales', async () => {
    const contract = fakeContract({ user: userRow(), permissions: [] });
    await loadUser({ session: { userId: 7 } }, contract);
    await touchLastLogin(7, contract);
    assert.equal(contract.calls.length, 3);
    for (const call of contract.calls) {
      assert.doesNotMatch(call.sql, /\?/, `SQL con placeholder posicional: ${call.sql}`);
    }
  });

  it('touchLastLogin actualiza por @userId con una Date canónica', async () => {
    const contract = fakeContract();
    const before = Date.now();
    await touchLastLogin(7, contract);
    const call = contract.calls[0];
    assert.equal(call.method, 'execute');
    assert.match(call.sql, /UPDATE users SET last_login_at = @now WHERE id = @userId/);
    assert.equal(call.params.userId, 7);
    // La política canónica entrega una Date; el contrato la normaliza a ISO en
    // el borde del driver. Un string ISO handmade sería la vía antigua.
    assert.ok(call.params.now instanceof Date, 'last_login_at debe viajar como Date');
    assert.ok(call.params.now.getTime() >= before);
  });

  it('las consultas migradas no tocan la API legacy db.prepare', async () => {
    const original = db.prepare;
    let legacyCalls = 0;
    db.prepare = function spy(...args) {
      legacyCalls += 1;
      return original.apply(db, args);
    };
    try {
      // Control positivo: el espía tiene que detectar un uso real de db.prepare,
      // o la comprobación de abajo no probaría nada.
      db.prepare('SELECT 1 AS n').get();
      assert.equal(legacyCalls, 1, 'el espía debe ver el db.prepare del control');

      const contract = fakeContract({ user: userRow(), permissions: [{ code: 'ticket.create' }] });
      const user = await loadUser({ session: { userId: 7 } }, contract);
      await touchLastLogin(7, contract);
      assert.equal(legacyCalls, 1, 'loadUser y touchLastLogin no deben usar db.prepare');
      assert.equal(user.permissions[0], 'ticket.create');
    } finally {
      db.prepare = original;
    }
  });

  it('middleware/auth.js ya no importa la fachada legacy', () => {
    const source = readFileSync(new URL('../src/middleware/auth.js', import.meta.url), 'utf8');
    // Guarda complementaria del espía de db.prepare de arriba: si alguien
    // reintrodujera la API legacy aquí, ambas pruebas lo detectarían.
    assert.doesNotMatch(source, /\bdb\.prepare\b/);
    assert.doesNotMatch(source, /import\s+db\s+from/);
    assert.match(source, /import \{ contract as defaultContract \} from '\.\.\/db\.js'/);
  });
});

// --------------------------------------------------------------------------
// requirePermission / requireAnyPermission: siguen siendo síncronos.
// --------------------------------------------------------------------------

describe('requirePermission y requireAnyPermission', () => {
  function run(middleware, user) {
    return new Promise((resolve) => {
      const req = { user };
      const res = {
        status(code) {
          return {
            json(body) {
              resolve({ status: code, body, next: false });
            },
          };
        },
      };
      middleware(req, res, () => resolve({ status: null, next: true }));
    });
  }

  it('sin req.user responde 401', async () => {
    assert.equal((await run(requirePermission('role.manage'), undefined)).status, 401);
    assert.equal((await run(requireAnyPermission(['role.manage']), undefined)).status, 401);
  });

  it('sin el permiso responde 403 y no llama a next', async () => {
    const user = { permissions: ['ticket.create'] };
    const denied = await run(requirePermission('role.manage'), user);
    assert.equal(denied.status, 403);
    assert.equal(denied.next, false);
    const deniedAny = await run(requireAnyPermission(['role.manage', 'team.manage']), user);
    assert.equal(deniedAny.status, 403);
    assert.equal(deniedAny.next, false);
  });

  it('con el permiso avanza', async () => {
    const user = { permissions: ['ticket.create', 'team.manage'] };
    assert.equal((await run(requirePermission('team.manage'), user)).next, true);
    assert.equal((await run(requireAnyPermission(['role.manage', 'team.manage']), user)).next, true);
    assert.equal((await run(requireAnyPermission('team.manage'), user)).next, true);
  });

  it('publicUser no expone password_hash', () => {
    const shaped = publicUser(userRow({ password_hash: 'nunca-debe-salir' }));
    assert.equal('password_hash' in shaped, false);
    assert.equal(shaped.id, 7);
  });
});

// --------------------------------------------------------------------------
// Flujo HTTP completo sobre SQLite.
// --------------------------------------------------------------------------

describe('Login y sesión sobre el contrato', () => {
  let admin;
  let tecnicoRoleId;

  before(async () => {
    admin = createClient();
    await admin.login('admin', '123456');
    const roles = await admin.get('/api/roles');
    tecnicoRoleId = roles.body.roles.find((r) => r.code === 'TECHNICIAN').id;
  });

  function tfSidOf(res) {
    const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith('tf_sid='));
    assert.ok(raw, 'el login debe emitir la cookie de sesión tf_sid');
    return raw;
  }

  function sidOf(res) {
    return decodeURIComponent(tfSidOf(res).split(';')[0].slice('tf_sid='.length));
  }

  // express-session no emite Max-Age para la sesión, sino Expires. La ventana se
  // mide en segundos restantes, que es lo que la cookie realmente impone.
  function sessionWindowSeconds(res) {
    const match = /Expires=([^;]+)/i.exec(tfSidOf(res));
    assert.ok(match, 'tf_sid debe llevar Expires');
    return Math.round((new Date(match[1]).getTime() - Date.now()) / 1000);
  }

  async function createUser({ active = true } = {}) {
    const username = uniq('b11a');
    const res = await admin.post('/api/users', {
      name: 'B11A',
      last_name: 'Contrato',
      username,
      email: `${username}@example.invalid`,
      password: PASSWORD,
      role_id: tecnicoRoleId,
    });
    assert.equal(res.status, 201);
    if (!active) {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(res.body.user.id);
    }
    return { username, id: res.body.user.id };
  }

  it('login correcto devuelve el usuario con sus permisos', async () => {
    const c = createClient();
    const res = await c.login('admin', '123456');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
    assert.equal(res.body.user.role, 'ADMIN');
    assert.ok(res.body.user.permissions.includes('role.manage'));
    assert.equal('password_hash' in res.body.user, false);
  });

  it('el login acepta usuario en mayúsculas y correo', async () => {
    const { username, id } = await createUser();
    const c = createClient();
    const res = await c.login(username.toUpperCase(), PASSWORD);
    assert.equal(res.status, 200, 'la búsqueda debe ser case-insensitive');
    assert.equal(res.body.user.id, id);

    const c2 = createClient();
    const byEmail = await c2.login(`${username}@EXAMPLE.INVALID`, PASSWORD);
    assert.equal(byEmail.status, 200, 'el login por correo también es case-insensitive');
    assert.equal(byEmail.body.user.id, id);
  });

  it('password incorrecto y usuario inexistente devuelven exactamente lo mismo', async () => {
    const bad = createClient();
    const badPassword = await bad.login('admin', 'no-es-la-clave');
    const missing = createClient();
    const missingUser = await missing.login(uniq('nadie'), 'no-es-la-clave');
    assert.equal(badPassword.status, 401);
    assert.equal(missingUser.status, 401);
    assert.deepEqual(badPassword.body, missingUser.body);
  });

  it('un usuario inactivo recibe 403 y no inicia sesión', async () => {
    const { username } = await createUser({ active: false });
    const c = createClient();
    const res = await c.login(username, PASSWORD);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /desactivada/);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  it('una sesión abierta pierde el acceso al desactivar al usuario', async () => {
    const { username, id } = await createUser();
    const c = createClient();
    assert.equal((await c.login(username, PASSWORD)).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    const after = await c.get('/api/auth/me');
    assert.equal(after.status, 403);
    assert.match(after.body.error, /desactivada/);
  });

  it('/api/auth/me exige sesión y devuelve el usuario con permisos', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const res = await c.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'empleado');
    assert.ok(Array.isArray(res.body.user.permissions));
    assert.equal((await createClient().get('/api/auth/me')).status, 401);
  });

  it('los permisos deciden: un rol sin role.manage recibe 403', async () => {
    const c = createClient();
    const login = await c.login('empleado', 'Empleado1234!');
    assert.equal(login.body.user.permissions.includes('role.manage'), false);
    const res = await c.get('/api/roles');
    assert.equal(res.status, 403);
    assert.equal((await admin.get('/api/roles')).status, 200);
  });

  it('last_login_at se registra al iniciar sesión', async () => {
    const { username, id } = await createUser();
    assert.equal(db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(id).last_login_at, null);
    const c = createClient();
    await c.login(username, PASSWORD);
    const row = db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(id);
    assert.ok(row.last_login_at, 'last_login_at debe quedar escrito tras el login');
    const written = new Date(row.last_login_at).getTime();
    assert.ok(Math.abs(Date.now() - written) < 60_000, 'la fecha debe ser reciente');
  });

  it('recordar extends la cookie a 30 días; sin recordar, 1 hora', async () => {
    const normal = createClient();
    const plain = await normal.login('empleado', 'Empleado1234!');
    const shortWindow = sessionWindowSeconds(plain);
    assert.ok(
      Math.abs(shortWindow - 3600) <= 60,
      `sin recordar la sesión dura una hora (se midió ${shortWindow}s)`,
    );

    const remembered = createClient();
    const long = await remembered.post('/api/auth/login', {
      account: 'empleado',
      password: 'Empleado1234!',
      remember: true,
    });
    assert.equal(long.status, 200);
    const longWindow = sessionWindowSeconds(long);
    assert.ok(
      Math.abs(longWindow - 30 * 24 * 3600) <= 60,
      `recordar son 30 días (se midió ${longWindow}s)`,
    );
    assert.ok(longWindow > shortWindow * 20);
    assert.ok(sidOf(long));
  });

  it('la cookie de sesión conserva HttpOnly y SameSite=Lax', async () => {
    const c = createClient();
    const res = await c.login('empleado', 'Empleado1234!');
    const raw = tfSidOf(res);
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
  });

  it('regenerate emite un SID nuevo en cada inicio de sesión', async () => {
    const c = createClient();
    const first = await c.login('empleado', 'Empleado1234!');
    const firstSid = sidOf(first);
    const second = await c.login('empleado', 'Empleado1234!');
    const secondSid = sidOf(second);
    assert.notEqual(secondSid, firstSid, 'el login debe regenerar el identificador de sesión');
    assert.equal((await c.get('/api/auth/me')).status, 200);
  });

  it('logout destruye la sesión y limpia la cookie', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const out = await c.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    const cleared = (out.headers['set-cookie'] || []).filter((k) => /^tf_(sid|csrf)=;/.test(k));
    assert.ok(cleared.length >= 1, 'logout debe borrar las cookies de sesión y CSRF');
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  it('change-password invalida las sesiones del usuario', async () => {
    const { username } = await createUser();
    const c = createClient();
    await c.login(username, PASSWORD);
    assert.equal((await c.get('/api/auth/me')).status, 200);

    const changed = await c.post('/api/auth/change-password', {
      current_password: PASSWORD,
      new_password: 'Cambiada1234!',
    });
    assert.equal(changed.status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401, 'la sesión previa debe quedar invalidada');

    const relogin = createClient();
    assert.equal((await relogin.login(username, 'Cambiada1234!')).status, 200);
    const oldPassword = createClient();
    assert.equal((await oldPassword.login(username, PASSWORD)).status, 401);
  });

  it('reset-password invalida las sesiones del usuario', async () => {
    const { username } = await createUser();
    const c = createClient();
    await c.login(username, PASSWORD);
    assert.equal((await c.get('/api/auth/me')).status, 200);

    const forgot = await createClient().post('/api/auth/forgot-password', { account: username });
    assert.equal(forgot.status, 200);
    assert.ok(forgot.body.token, 'en desarrollo el token se devuelve para poder probar');

    const reset = await createClient().post('/api/auth/reset-password', {
      token: forgot.body.token,
      password: 'Restablecida1234!',
    });
    assert.equal(reset.status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401, 'la sesión previa debe quedar invalidada');
    assert.equal((await createClient().login(username, 'Restablecida1234!')).status, 200);
  });
});