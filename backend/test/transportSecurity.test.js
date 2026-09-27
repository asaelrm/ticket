import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { resolveTrustProxy, normalizeHost, isPublicHost, shouldSendHsts } from '../src/transportSecurity.js';

// Topología de la instalación described por el usuario: HTTPS por Cloudflare y
// HTTP desde la red local, contra la MISMA instancia Express.
const CF_HOST = 'tickets.example.com';
const LAN_HOST = 'ticket.lan';
const ADMIN = { account: 'admin', password: '123456' };

// `fetch` no deja fijar la cabecera Host (es *forbidden header name*), así que
// el host que ve el servidor acababa siendo 127.0.0.1 y HSTS no se podía
// comprobar. Con node:http el Host se manda tal cual, como hace un proxy real.
// `connectHost` permite entrar por otra interfaz para cambiar la IP de socket.
function httpReq({ port, host, connectHost = '127.0.0.1', method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connectHost, port, method, path, headers: { Host: host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] || [],
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function cookieAttr(setCookie, name, attr) {
  const raw = setCookie.find((c) => c.startsWith(`${name}=`));
  if (raw === undefined) return null;
  return raw
    .split(';')
    .slice(1)
    .map((s) => s.trim().toLowerCase())
    .includes(attr.toLowerCase());
}

// Emula al navegador: una cookie con Secure NO se envía por http://.
// supertest no aplica esa regla y sin ella no se puede demostrar que una
// sesión de producción no es utilizable desde la red local.
function browserJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const raw of res.setCookie) {
        const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i), {
          value: pair.slice(i + 1),
          secure: attrs.some((a) => a.toLowerCase() === 'secure'),
        });
      }
    },
    get(name) {
      return jar.get(name)?.value;
    },
    header({ https }) {
      return [...jar.entries()]
        .filter(([, c]) => https || !c.secure)
        .map(([n, c]) => `${n}=${c.value}`)
        .join('; ');
    },
  };
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

function listen(app, host = '0.0.0.0') {
  const server = app.listen(0, host);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('política de transporte: resolución de TRUST_PROXY', () => {
  it('no confía en cabeceras de proxy por defecto', () => {
    for (const v of [undefined, '', 'false', 'off']) {
      assert.equal(resolveTrustProxy(v).value, false, `valor: ${v}`);
    }
  });

  it('acepta una IP, un CIDR o una lista de proxies reales', () => {
    assert.deepEqual(resolveTrustProxy('172.18.0.1').value, ['172.18.0.1']);
    assert.deepEqual(resolveTrustProxy('172.18.0.1, 10.0.0.0/8').value, ['172.18.0.1', '10.0.0.0/8']);
    assert.deepEqual(resolveTrustProxy('loopback').value, ['loopback']);
  });

  it('advierte si se configura en modo ciego, sin aceptarlo en silencio', () => {
    for (const v of ['true', 'yes', 'on', 'all']) {
      const r = resolveTrustProxy(v);
      assert.equal(r.value, true);
      assert.match(r.warning, /cualquier cliente/i);
    }
  });

  it('advierte también al contar saltos de proxy', () => {
    assert.match(resolveTrustProxy('1').warning, /X-Forwarded-Proto/);
  });

  it('descarta valores no válidos en lugar de abrir la puerta por sorpresa', () => {
    const r = resolveTrustProxy('todo-el-mundo');
    assert.equal(r.value, false);
    assert.match(r.warning, /válido/i);

    const mixed = resolveTrustProxy('10.0.0.0/8,_basura_');
    assert.deepEqual(mixed.value, ['10.0.0.0/8']);
    assert.match(mixed.warning, /no válidas/i);
  });

  it('rechaza octetos y prefijos imposibles', () => {
    assert.equal(resolveTrustProxy('999.1.1.1').value, false);
    assert.equal(resolveTrustProxy('10.0.0.0/99').value, false);
  });
});

describe('política de transporte: HSTS por host', () => {
  it('normaliza hostnames quitando puerto y mayúsculas', () => {
    assert.deepEqual(normalizeHost('TICKETS.example.com:8443'), ['tickets.example.com']);
    assert.equal(isPublicHost('tickets.example.com:443', 'tickets.example.com,otro.com'), true);
    assert.equal(isPublicHost('ticket.lan', 'tickets.example.com'), false);
  });

  it('solo lo propone para host público y petición cifrada', () => {
    const base = { publicHosts: CF_HOST };
    assert.equal(shouldSendHsts({ host: CF_HOST, isHttps: true, ...base }), true);
    assert.equal(shouldSendHsts({ host: CF_HOST, isHttps: false, ...base }), false);
    assert.equal(shouldSendHsts({ host: LAN_HOST, isHttps: true, ...base }), false);
  });
});

describe('confianza en el proxy, con sockets reales', () => {
  // Express decide si cree en X-Forwarded-Proto por la IP del SOCKET, no por la
  // cabecera. Se levanta un servidor real y se entra por dos interfaces: la de
  // loopback hace de proxy confiable y la de red, de cliente no confiable.
  let server;
  let port;
  const lan = lanAddress();

  before(async () => {
    server = await listen(createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }));
    port = server.address().port;
  });

  after(() => close(server));

  it('el proxy de confianza ve HTTPS y recibe HSTS', async () => {
    const res = await httpReq({
      port,
      host: CF_HOST,
      path: '/api/health',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
  });

  it('un cliente de la LAN no puede declararse HTTPS con una cabecera', async () => {
    assert.ok(lan, 'se necesita una interfaz de red además de loopback para esta prueba');

    const res = await httpReq({
      port,
      connectHost: lan,
      host: CF_HOST,
      path: '/api/health',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(res.headers['strict-transport-security'], undefined);
  });

  it('un cliente no confiable tampoco consigue que su cookie CSRF sea Secure', async () => {
    const res = await httpReq({
      port,
      connectHost: lan,
      host: CF_HOST,
      path: '/api/auth/me',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(cookieAttr(res.setCookie, 'tf_csrf', 'Secure'), false);
  });

  it('una cabecera X-Forwarded-Proto falsificada no degrada la cookie CSRF', async () => {
    // Aunque el socket sea de confianza y la cabecera diga "http", la cookie
    // sale igual: la política es estática (COOKIE_SECURE), no por petición.
    const lying = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'http' } });
    const honest = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    const secure = (r) => cookieAttr(r.setCookie, 'tf_csrf', 'Secure');
    assert.equal(secure(lying), secure(honest));
  });

  it('no emite HSTS para el host interno de la LAN aunque llegue cifrado', async () => {
    const res = await httpReq({
      port,
      host: LAN_HOST,
      path: '/api/health',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(res.headers['strict-transport-security'], undefined);
  });
});

describe('con la configuración por defecto nada cambia', () => {
  let server;
  let port;

  before(async () => {
    server = await listen(createApp(), '127.0.0.1');
    port = server.address().port;
  });

  after(() => close(server));

  it('sin TRUST_PROXY ni PUBLIC_HOSTS no se emite HSTS ni se marca Secure', async () => {
    const health = await httpReq({
      port,
      host: CF_HOST,
      path: '/api/health',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(health.headers['strict-transport-security'], undefined);

    const me = await httpReq({
      port,
      host: CF_HOST,
      path: '/api/auth/me',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(cookieAttr(me.setCookie, 'tf_csrf', 'Secure'), false);
  });
});

describe('sesión de producción: por HTTPS sí, por HTTP no', () => {
  let server;
  let port;
  let savedSecure;
  let savedConfig;

  before(async () => {
    savedSecure = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    savedConfig = (await import('../src/config.js')).default.session.secure;
    (await import('../src/config.js')).default.session.secure = true;
    server = await listen(createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }));
    port = server.address().port;
  });

  after(async () => {
    await close(server);
    if (savedSecure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = savedSecure;
    (await import('../src/config.js')).default.session.secure = savedConfig;
  });

  async function loginByHttps() {
    const jar = browserJar();
    const first = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    jar.absorb(first);
    const res = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
        Cookie: jar.header({ https: true }),
        'x-csrf-token': jar.get('tf_csrf'),
      },
      body: { ...ADMIN, remember: false },
    });
    jar.absorb(res);
    return { jar, res };
  }

  it('la cookie de sesión sale con Secure, HttpOnly y SameSite', async () => {
    const { res } = await loginByHttps();
    assert.equal(res.status, 200);
    assert.equal(cookieAttr(res.setCookie, 'tf_sid', 'Secure'), true);
    assert.equal(cookieAttr(res.setCookie, 'tf_sid', 'HttpOnly'), true);
    assert.equal(cookieAttr(res.setCookie, 'tf_sid', 'SameSite=Lax'), true);
  });

  it('esa sesión NO se envía por HTTP, así que por HTTP no se accede', async () => {
    const { jar } = await loginByHttps();
    assert.equal(jar.header({ https: false }).includes('tf_sid'), false, 'el navegador no manda cookies Secure por http://');

    const res = await httpReq({
      port,
      host: LAN_HOST,
      path: '/api/auth/me',
      headers: { Cookie: jar.header({ https: false }) },
    });
    assert.equal(res.status, 401);
  });

  it('esa misma sesión sí funciona por HTTPS', async () => {
    const { jar } = await loginByHttps();
    const res = await httpReq({
      port,
      host: CF_HOST,
      path: '/api/auth/me',
      headers: { 'X-Forwarded-Proto': 'https', Cookie: jar.header({ https: true }) },
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).user.username, 'admin');
  });
});

describe('CSRF sigue funcionando con la política estática', () => {
  let server;
  let port;

  before(async () => {
    server = await listen(createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }), '127.0.0.1');
    port = server.address().port;
  });

  after(() => close(server));

  it('exige cookie y cabecera coincidentes, rechaza la inválida y acepta la buena', async () => {
    const jar = browserJar();
    const first = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    jar.absorb(first);
    const csrf = jar.get('tf_csrf');
    assert.match(csrf, /^[a-f0-9]{48}$/);

    const login = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Cookie: jar.header({ https: true }), 'x-csrf-token': csrf },
      body: { ...ADMIN, remember: false },
    });
    assert.equal(login.status, 200);
    jar.absorb(login);
    const cookie = jar.header({ https: true });

    const bad = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/tickets',
      headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': 'f'.repeat(48) },
      body: { title: 'sin csrf valido', description: 'x', category_id: 1 },
    });
    assert.equal(bad.status, 403);

    const good = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/tickets',
      headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrf },
      body: { title: 'con csrf valido', description: 'x', category_id: 1 },
    });
    assert.equal(good.status, 201);
  });
});
