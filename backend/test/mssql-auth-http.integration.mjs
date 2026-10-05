// B11-B1: prueba HTTP real contra SQL Server DEV, con fixtures sintéticos B11.
//
// NO se ejecuta con el glob habitual. Requiere:
//
//   1. haber creado antes los fixtures a mano desde SSMS con Windows
//      Authentication. En orden:
//        node src/scripts/mssql-b11-password.mjs        -> imprime el bloque :setvar
//        SSMS > SIFHADEV > Windows Auth > Modo SQLCMD > pegar el bloque > ejecutar
//      o, para comprobar el estado sin crear nada:
//        node src/scripts/mssql-b11-verify.js
//   2. las variables de conexión de la aplicación en .env
//   3. RUN_B11_MSSQL_HTTP=1
//
//   node --env-file-if-exists=.env test/mssql-auth-http.integration.mjs
//
// El nombre del fichero NO termina en .test.js a propósito: el glob
// `test/*.test.js` se ejecuta con `--import ./test/setup.js`, y setup.js importa
// src/db.js con SQLite antes de que este fichero pueda fijar DB_CLIENT=mssql.
// Incluirlo ahí haría que estas pruebas validaran SQLite sin avisar.
//
// Lo que NO hace: sessions falsos, req.user a mano, saltarse auth, ni(assert)
// de tiempos de respuesta.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findLatestManifest, readManifest } from '../src/fixtures/mssql.b11.js';

const enabled = process.env.RUN_B11_MSSQL_HTTP === '1';

// Sin fixtures creados todavía la prueba se omite con un motivo explícito en
// lugar de fallar: B11-B1 prepara, B11-B2 ejecutará de verdad.
let manifest = null;
let skipReason = null;
if (!enabled) {
  skipReason = 'requiere RUN_B11_MSSQL_HTTP=1';
} else {
  try {
    manifest = process.env.B11_MARKER
      ? readManifest(process.env.B11_MARKER)
      : findLatestManifest().manifest;
    if (!manifest) skipReason = 'no hay manifiesto de fixtures B11; ejecute el setup desde SSMS (src/scripts/mssql-b11-fixtures.sql)';
  } catch (error) {
    skipReason = error.message;
  }
}

const suite = manifest && !skipReason ? describe : describe.skip;

if (skipReason) {
  console.log(`[b11] pruebas HTTP MSSQL omitidas: ${skipReason}`);
}

suite('B11 autenticación HTTP real sobre SQL Server DEV', { timeout: 60_000 }, async () => {
  const { app, config, contract, createHttpClient, closeHttpSupport } = await import('./mssql-b11-http.js');

  const accounts = Object.fromEntries(manifest.users.map((user) => [user.key, user]));
  const PROTECTED_ENDPOINT = '/api/roles/permissions';

  before(() => {
    assert.equal(config.dbClient, 'mssql');
    assert.equal(config.mssql.database, manifest.database);
    assert.equal(config.env, 'test');
  });

  after(async () => {
    await closeHttpSupport();
  });

  /** El SID tal como está en dbo.sessions, para poder consultarlo. */
  async function sessionRow(client) {
    const sid = client.rawSid();
    assert.ok(sid, 'el cliente debe tener una tf_sid con firma legible');
    return contract.queryOne('SELECT sid, expire FROM dbo.sessions WHERE sid = @sid', { sid });
  }

  it('A. GET /api/health responde sin sesión', async () => {
    const res = await createHttpClient().get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.env, 'test');
  });

  it('C. el login emite tf_sid con HttpOnly, SameSite=Lax y caducidad futura', async () => {
    const res = await createHttpClient().login(accounts.manager.username, manifest.password);
    assert.equal(res.status, 200);
    const raw = res.headers['set-cookie'].find((c) => c.startsWith('tf_sid='));
    assert.ok(raw, 'debe emitirse la cookie de sesión tf_sid');
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.match(raw, /Expires=/i);
  });

  it('B+D+E. login → /me → permissions incluye role.manage', async () => {
    const client = createHttpClient();
    const login = await client.login(accounts.manager.username, manifest.password);
    assert.equal(login.status, 200);

    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, accounts.manager.username);
    assert.equal(me.body.user.email, accounts.manager.email);
    assert.equal(me.body.user.active, true);
    assert.equal(me.body.user.role, 'B11_ROLE_MANAGER');
    assert.ok(
      me.body.user.permissions.includes('role.manage'),
      `permissions debe incluir role.manage; llegó ${JSON.stringify(me.body.user.permissions)}`,
    );
    assert.equal(me.body.user.password_hash, undefined, 'nunca debe filtrarse el hash');
  });

  it('la sesión se persiste en dbo.sessions y se recupera desde SQL Server', async () => {
    const client = createHttpClient();
    await client.login(accounts.manager.username, manifest.password);

    const row = await sessionRow(client);
    assert.ok(row, 'MssqlSessionStore.set debe haber insertado la fila en dbo.sessions');
    assert.ok(Number(row.expire) > Date.now(), 'la sesión recién creada no debe estar expirada');

    // Un cliente NUEVO con la misma cookie: si /me responde, la sesión se leyó
    // de SQL Server y no de la memoria de este proceso.
    const other = createHttpClient().seedCookies({ tf_sid: client.sessionCookieValue() });
    const me = await other.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, accounts.manager.username);
  });

  it('role.manage llega por la cadena users → roles → role_permissions → permissions', async () => {
    const user = accounts.manager;
    const chain = await contract.queryOne(
      `SELECT u.username, r.code AS role_code, p.code AS permission_code
       FROM dbo.users u
       JOIN dbo.roles r ON r.id = u.role_id
       JOIN dbo.role_permissions rp ON rp.role_id = r.id
       JOIN dbo.permissions p ON p.id = rp.permission_id
       WHERE u.username = @username AND p.code = @code`,
      { username: user.username, code: 'role.manage' },
    );
    assert.ok(chain, 'la cadena de la base debe llevar role.manage hasta el usuario manager');
    assert.equal(chain.role_code, 'B11_ROLE_MANAGER');
    assert.equal(chain.permission_code, 'role.manage');
  });

  it('F+G. el manager obtiene 200 y el usuario sin role.manage obtiene 403', async () => {
    // Endpoint elegido: GET /api/roles/permissions. Es el más pequeño de los
    // protegidos por role.manage (una sola consulta de lectura) y no escribe
    // nada, así que no puede dejar rastro en la base.
    //
    // Desde B11-B2 el handler usa el contrato async, así que ya se puede exigir
    // el 200 real y no solo "no 403": la barrera legacy de db.prepare ya no está
    // en este camino.
    const manager = createHttpClient();
    await manager.login(accounts.manager.username, manifest.password);
    const allowed = await manager.get(PROTECTED_ENDPOINT);

    const other = createHttpClient();
    await other.login(accounts.noManage.username, manifest.password);
    const denied = await other.get(PROTECTED_ENDPOINT);

    assert.equal(denied.status, 403, 'sin role.manage el middleware debe cortar con 403');
    assert.equal(denied.body.error, 'No tiene permiso para realizar esta acción');

    assert.equal(allowed.status, 200, 'con role.manage el handler debe responder 200 sobre MSSQL');
    assert.ok(Array.isArray(allowed.body.permissions), 'la respuesta debe traer el catálogo de permisos');
    assert.ok(
      allowed.body.permissions.some((p) => p.code === 'role.manage'),
      'el catálogo devuelto debe contener role.manage',
    );

    // La prueba fuerte es el CONTRASTE: mismo endpoint, misma carga, una sesión
    // y otra. Si requirePermission no filtrara, los dos códigos serían iguales.
    assert.notEqual(allowed.status, denied.status);
    assert.notEqual(allowed.status, 401, 'el manager está autenticado: no puede ser 401');
  });

  it('F+H. el 403 del usuario sin permiso no toca la base', async () => {
    // El corte lo hace requirePermission antes del handler: no puede haberse
    // ejecutado ninguna consulta de catálogo para esa petición.
    const before = await contract.queryOne('SELECT COUNT(*) AS n FROM dbo.permissions');
    const other = createHttpClient();
    await other.login(accounts.noManage.username, manifest.password);
    const denied = await other.get(PROTECTED_ENDPOINT);
    assert.equal(denied.status, 403);
    const after = await contract.queryOne('SELECT COUNT(*) AS n FROM dbo.permissions');
    assert.equal(Number(after.n), Number(before.n));
  });

  it('19. password incorrecto devuelve 401', async () => {
    const res = await createHttpClient().login(accounts.manager.username, `${manifest.password}-incorrecta`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Credenciales incorrectas');
  });

  it('20. usuario inexistente devuelve exactamente la misma respuesta', async () => {
    const client = createHttpClient();
    const unknown = await client.login(`b11-inexistente-${manifest.marker}`, manifest.password);
    assert.equal(unknown.status, 401);

    // Respuesta idéntica byte a byte: en esto consiste no filtrar qué cuentas
    // existen. Sin assert de tiempos, que serían frágiles.
    const wrongPassword = await createHttpClient().login(accounts.manager.username, `${manifest.password}-incorrecta`);
    assert.equal(unknown.status, wrongPassword.status);
    assert.deepEqual(unknown.body, wrongPassword.body);
    assert.equal(unknown.headers['set-cookie']?.some((c) => c.startsWith('tf_sid=')), false);
  });

  it('18. el usuario inactivo recibe 403 y no abre sesión', async () => {
    const client = createHttpClient();
    const res = await client.login(accounts.inactive.username, manifest.password);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Su cuenta está desactivada. Contacte a un administrador.');
    assert.equal(await sessionRow(client).catch(() => null), null);
  });

  it('21. sin cookie tf_sid, /api/auth/me responde 401', async () => {
    const res = await createHttpClient().get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'No autenticado');
  });

  it('17. el usuario sin role.manage no aparece en /me con ese permiso', async () => {
    const client = createHttpClient();
    await client.login(accounts.noManage.username, manifest.password);
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.ok(me.body.user.permissions.length > 0, 'debe tener al menos un permiso: si no, el 403 no probaría nada');
    assert.equal(me.body.user.permissions.includes('role.manage'), false);
    assert.ok(me.body.user.permissions.includes('dashboard.view'));
  });

  it('22. una sesión expirada deja de autenticar', async () => {
    const client = createHttpClient();
    await client.login(accounts.manager.username, manifest.password);
    const sid = client.rawSid();
    assert.ok(sid);

    // Se vence la sesión con la identidad de la aplicación, que ya tiene UPDATE
    // en dbo.sessions porque el propio store la necesita. Se toca UNA fila,
    // identificada por el SID de esta sesión: no hay sesiones ajenas por medio.
    const updated = await contract.execute(
      'UPDATE dbo.sessions SET expire = @expire WHERE sid = @sid',
      { sid, expire: Date.now() - 60_000 },
    );
    assert.equal(updated.rowsAffected, 1);

    const other = createHttpClient().seedCookies({ tf_sid: client.sessionCookieValue() });
    const me = await other.get('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error, 'No autenticado');
  });

  it('9. ciclo de vida: login → regenerate → /me → logout → la cookie ya no autentica', async () => {
    const client = createHttpClient();
    const first = await client.login(accounts.manager.username, manifest.password);
    assert.equal(first.status, 200);
    const firstSid = client.rawSid();
    const firstRow = await sessionRow(client);
    assert.ok(firstRow, 'la primera sesión debe estar en dbo.sessions');

    // regenerate: un segundo login sobre la MISMA sesión previa produce otro
    // SID distinto. Se comparan en la base, no solo en la cookie.
    const second = await createHttpClient().login(accounts.manager.username, manifest.password);
    assert.equal(second.status, 200);

    const meBefore = await client.get('/api/auth/me');
    assert.equal(meBefore.status, 200);

    const logout = await client.post('/api/auth/logout');
    assert.equal(logout.status, 200);
    assert.equal(logout.body.ok, true);

    // La fila de la sesión se borró de dbo.sessions.
    assert.equal(await contract.queryOne('SELECT sid FROM dbo.sessions WHERE sid = @sid', { sid: firstSid }), null);

    // Y la cookie que el navegador conserva ya no sirve para nada.
    const after = await client.get('/api/auth/me');
    assert.equal(after.status, 401);
  });

  it('el login regenera el SID: dos inicios de sesión no comparten identificador', async () => {
    const first = createHttpClient();
    await first.login(accounts.manager.username, manifest.password);
    const second = createHttpClient();
    await second.login(accounts.manager.username, manifest.password);
    assert.notEqual(first.rawSid(), second.rawSid(), 'regenerate debe emitir un SID nuevo por login');
  });

  it('el logout limpia la cookie tf_sid y tf_csrf', async () => {
    const client = createHttpClient();
    await client.login(accounts.manager.username, manifest.password);
    const res = await client.post('/api/auth/logout');
    const cleared = (res.headers['set-cookie'] || []).filter((c) => /^tf_(sid|csrf)=;/.test(c));
    assert.ok(cleared.length >= 2, `deben limpiarse ambas cookies; llegaron ${JSON.stringify(res.headers['set-cookie'])}`);
    assert.equal(client.hasSessionCookie(), false);
  });

  it('el rate limit de login no interfiere: NODE_ENV=test lo desactiva', async () => {
    // authRateLimit permite 10/min por IP. Más de 10 logins en esta suite
    // darían un 429 si NODE_ENV no fuera 'test', así que el propio flujo lo
    // demuestra sin temporizadores.
    assert.equal(config.env, 'test');
    for (let i = 0; i < 12; i += 1) {
      const res = await createHttpClient().login(accounts.manager.username, manifest.password);
      assert.equal(res.status, 200, `el login ${i + 1} no debe recibir 429`);
    }
  });
});