import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
// el hostSeen por el servidor acababa siendo 127.0.0.1 y HSTS nunca se podía
// comprobar. Con node:http el Host se manda tal cual, que es lo que hace un
// proxy real.
function httpReq({ port, host, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } },
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
  if (!raw) return null;
  return raw
    .split(';')
    .slice(1)
    .map((s) => s.trim().toLowerCase())
    .includes(attr.toLowerCase());
}

// Emula al navegador: una cookie con Secure NO se envía por http://.
// supertest no aplica esa regla, y sin ella no se puede demostrar que una
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

describe('política de transporte (lógica pura)', () => {
  it('no confía en cabeceras de proxy por defecto', () => {
    for (const v of [undefined, '', 'false', 'off']) {
      expect(resolveTrustProxy(v).value, `valor: ${v}`).toBe(false);
    }
  });

  it('acepta una IP o una lista de IP/CIDR de proxies reales', () => {
    expect(resolveTrustProxy('172.18.0.1').value).toEqual(['172.18.0.1']);
    expect(resolveTrustProxy('172.18.0.1, 10.0.0.0/8').value).toEqual(['172.18.0.1', '10.0.0.0/8']);
    expect(resolveTrustProxy('loopback').value).toEqual(['loopback']);
  });

  it('advierte si se configura en modo ciego, sin aceptarlo en silencio', () => {
    for (const v of ['true', 'yes', 'on', 'all']) {
      const r = resolveTrustProxy(v);
      expect(r.value).toBe(true);
      expect(r.warning).toMatch(/cualquier cliente/i);
    }
  });

  it('advierte también al contar saltos de proxy', () => {
    expect(resolveTrustProxy('1').warning).toMatch(/X-Forwarded-Proto/);
  });

  it('descarta valores no válidos en lugar de abrir la puerta por sorpresa', () => {
    const r = resolveTrustProxy('todo-el-mundo');
    expect(r.value).toBe(false);
    expect(r.warning).toMatch(/válido/i);

    const mixed = resolveTrustProxy('10.0.0.0/8,_basura_');
    expect(mixed.value).toEqual(['10.0.0.0/8']);
    expect(mixed.warning).toMatch(/no válidas/i);
  });

  it('rechaza octetos y prefijos imposibles', () => {
    expect(resolveTrustProxy('999.1.1.1').value).toBe(false);
    expect(resolveTrustProxy('10.0.0.0/99').value).toBe(false);
  });

  it('normaliza hostnames quitando puerto y mayúsculas', () => {
    expect(normalizeHost('TICKETS.example.com:8443')).toEqual(['tickets.example.com']);
    expect(isPublicHost('tickets.example.com:443', 'tickets.example.com,otro.com')).toBe(true);
    expect(isPublicHost('ticket.lan', 'tickets.example.com')).toBe(false);
  });

  it('solo propone HSTS para host público y petición cifrada', () => {
    const base = { publicHosts: CF_HOST };
    expect(shouldSendHsts({ host: CF_HOST, isHttps: true, ...base })).toBe(true);
    expect(shouldSendHsts({ host: CF_HOST, isHttps: false, ...base })).toBe(false);
    expect(shouldSendHsts({ host: LAN_HOST, isHttps: true, ...base })).toBe(false);
  });
});

describe('confianza en el proxy, con sockets reales', () => {
  // Express decide si cree en X-Forwarded-Proto por la IP del SOCKET, no por la
  // cabecera. Se levanta un servidor real y se entra por dos interfaces: la de
  // loopback hace de proxy confiable y la de red hace de cliente no confiable.
  let server;
  let port;
  const lan = lanAddress();

  beforeAll(async () => {
    server = createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }).listen(0, '0.0.0.0');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('el proxy de confianza ve HTTPS; el cliente de la LAN no', async () => {
    if (!lan) throw new Error('Se necesita una interfaz de red además de loopback para esta prueba');

    // Entra por loopback: la IP de socket está en la lista de confianza.
    const viaProxy = await httpReq({ port, host: CF_HOST, path: '/api/health', headers: { 'X-Forwarded-Proto': 'https' } });
    expect(viaProxy.headers['strict-transport-security']).toMatch(/max-age=\d+/);

    // Entra por la interfaz de red: la cabecera se ignora aunque afirme https.
    const viaClient = await httpReq({ port, host: CF_HOST, path: '/api/health', headers: { 'X-Forwarded-Proto': 'https' } });
    expect(viaClient.headers['strict-transport-security']).toBeUndefined();

    // Y la cookie CSRF de ese cliente tampoco se marca como Secure.
    const csrf = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    expect(cookieAttr(csrf.setCookie, 'tf_csrf', 'Secure')).toBe(false);
  });

  it('una cabecera X-Forwarded-Proto falsificada no degrada la cookie CSRF', async () => {
    // Aunque el socket sea de confianza y la cabecera diga "http", la cookie
    // sale igual: la política es estática (COOKIE_SECURE), no por petición.
    const lying = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'http' } });
    const honest = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    const secure = (r) => cookieAttr(r.setCookie, 'tf_csrf', 'Secure');
    expect(secure(lying)).toBe(secure(honest));
  });

  it('no se emite HSTS para el host interno de la LAN aunque llegue cifrado', async () => {
    const res = await httpReq({ port, host: LAN_HOST, path: '/api/health', headers: { 'X-Forwarded-Proto': 'https' } });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('con la configuración por defecto (sin TRUST_PROXY) nada cambia', async () => {
    // Estado actual en producción: sin confianza en proxy, sin hosts públicos.
    const plain = createApp().listen(0, '127.0.0.1');
    await new Promise((r) => plain.once('listening', r));
    try {
      const p = plain.address().port;
      const res = await httpReq({ port: p, host: CF_HOST, path: '/api/health', headers: { 'X-Forwarded-Proto': 'https' } });
      expect(res.headers['strict-transport-security']).toBeUndefined();
      const me = await httpReq({ port: p, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
      expect(cookieAttr(me.setCookie, 'tf_csrf', 'Secure')).toBe(false);
    } finally {
      await new Promise((r) => plain.close(r));
    }
  });
});

describe('sesión de producción: por HTTPS sí, por HTTP no', () => {
  let server;
  let port;
  const lan = lanAddress();
  let saved;

  beforeAll(async () => {
    saved = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    const { default: config } = await import('../src/config.js');
    config.session.secure = true;
    server = createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }).listen(0, '0.0.0.0');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    if (saved === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = saved;
  });

  async function loginByHttps() {
    const jar = browserJar();
    const first = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    jar.absorb(first);
    const csrf = jar.get('tf_csrf');
    const res = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
        Cookie: jar.header({ https: true }),
        'x-csrf-token': csrf,
      },
      body: { ...ADMIN, remember: false },
    });
    jar.absorb(res);
    return { jar, res, csrf };
  }

  it('la cookie de sesión sale con Secure y HttpOnly', async () => {
    const { res } = await loginByHttps();
    expect(res.status).toBe(200);
    expect(cookieAttr(res.setCookie, 'tf_sid', 'Secure'), 'tf_sid debe llevar Secure').toBe(true);
    expect(cookieAttr(res.setCookie, 'tf_sid', 'HttpOnly')).toBe(true);
    expect(cookieAttr(res.setCookie, 'tf_sid', 'SameSite=Lax')).toBe(true);
  });

  it('esa sesión NO se envía por HTTP, así que por HTTP no se accede', async () => {
    const { jar } = await loginByHttps();
    expect(jar.header({ https: false }), 'el navegador no manda cookies Secure por http://').not.toContain('tf_sid');

    const res = await httpReq({ port, host: LAN_HOST, path: '/api/auth/me', headers: { Cookie: jar.header({ https: false }) } });
    expect(res.status).toBe(401);
  });

  it('esa misma sesión sí funciona por HTTPS', async () => {
    const { jar } = await loginByHttps();
    const res = await httpReq({
      port,
      host: CF_HOST,
      path: '/api/auth/me',
      headers: { 'X-Forwarded-Proto': 'https', Cookie: jar.header({ https: true }) },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).user.username).toBe('admin');
  });
});

describe('CSRF sigue funcionando con la política estática', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('exige cookie y cabecera coincidentes, y acepta la válida', async () => {
    const jar = browserJar();
    const first = await httpReq({ port, host: CF_HOST, path: '/api/auth/me', headers: { 'X-Forwarded-Proto': 'https' } });
    jar.absorb(first);
    const csrf = jar.get('tf_csrf');
    expect(csrf).toMatch(/^[a-f0-9]{48}$/);

    const login = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Cookie: jar.header({ https: true }), 'x-csrf-token': csrf },
      body: { ...ADMIN, remember: false },
    });
    expect(login.status).toBe(200);
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
    expect(bad.status).toBe(403);

    const good = await httpReq({
      port,
      host: CF_HOST,
      method: 'POST',
      path: '/api/tickets',
      headers: { 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrf },
      body: { title: 'con csrf valido', description: 'x', category_id: 1 },
    });
    expect(good.status).toBe(201);
  });
});
