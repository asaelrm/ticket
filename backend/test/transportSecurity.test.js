import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { resolveTrustProxy, normalizeHost, isPublicHost, shouldSendHsts } from '../src/transportSecurity.js';

// Topología de la instalación described por el usuario: HTTPS por Cloudflare y
// HTTP desde la red local, contra la MISMA instancia Express.
const CF_HOST = 'tickets.example.com';
const LAN_HOST = 'ticket.lan';
const ADMIN = { account: 'admin', password: '123456' };

describe('política de transporte (lógica pura)', () => {
  it('no confía en cabeceras de proxy por defecto', () => {
    for (const v of [undefined, '', 'false', 'off']) {
      expect(resolveTrustProxy(v).value, `valor: ${v}`).toBe(false);
    }
  });

  it('acepta una IP o una lista de IP/CIDR de proxies reales', () => {
    expect(resolveTrustProxy('172.18.0.1').value).toEqual(['172.18.0.1']);
    expect(resolveTrustProxy('172.18.0.1, 10.0.0.0/8').value).toEqual(['172.18.0.1', '10.0.0.0/8']);
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

    // Un mixto se queda solo con la parte válida, y lo dice.
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

describe('confianza en el proxy con sockets reales', () => {
  // Express decide si cree en X-Forwarded-Proto mirando la IP del SOCKET, no la
  // cabecera. Con supertest todas las peticiones vendrían de 127.0.0.1 y no
  // habría forma de exercised el caso "cliente no confiable". Por eso se levanta
  // un servidor real y se entra por dos interfaces distintas: la de loopback
  // hace de proxy confiable y la de red hace de cliente no confiable.
  let server;
  let port;
  let lanAddr;

  const TRUSTED = { trustProxy: 'loopback', publicHosts: CF_HOST };

  function freePort() {
    return new Promise((resolve) => {
      const s = os.createServer();
      s.listen(0, '0.0.0.0', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }

  function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
    return null;
  }

  beforeAll(async () => {
    server = createApp(TRUSTED).listen(0, '0.0.0.0');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
    lanAddr = lanAddress();
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  // `via` decide por qué interfaz entra la petición y, por tanto, qué IP de
  // socket ve Express.
  function hit(via, { path = '/api/health', host, proto, cookie, csrf } = {}) {
    const base = via === 'lan' && lanAddr ? `http://${lanAddr}:${port}` : `http://127.0.0.1:${port}`;
    const headers = { Host: host };
    if (proto) headers['X-Forwarded-Proto'] = proto;
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    return fetch(base + path, { headers });
  }

  it('el proxy de confianza ve HTTPS y el cliente no confiable no', async () => {
    if (!lanAddr) {
      // Sin segunda interfaz no se puede discriminating; no se da el test por
      // bueno en silencio, se hace explícito.
      throw new Error('Se necesita una interfaz de red además de loopback para esta prueba');
    }

    const viaProxy = await hit('loopback', { host: CF_HOST, proto: 'https' });
    const viaClient = await hit('lan', { host: CF_HOST, proto: 'https' });

    // Por loopback, la IP de socket sí está en la lista: Express cree el HTTPS.
    expect(viaProxy.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);

    // Desde la LAN la cabecera se ignora: no hay HSTS y la cookie no se marca.
    expect(viaClient.headers.get('strict-transport-security')).toBeNull();
    const csrfCookie = viaClient.headers.get('set-cookie');
    if (csrfCookie) expect(csrfCookie).not.toMatch(/;\s*Secure/i);
  });

  it('una cabecera X-Forwarded-Proto falsificada no degrada la cookie CSRF', async () => {
    // Aunque el proxy sea de confianza y la cabecera diga "http", la política
    // de la cookie es estática: depende de COOKIE_SECURE, no de la petición.
    const lying = await hit('loopback', { host: CF_HOST, proto: 'http', path: '/api/auth/me' });
    const honest = await hit('loopback', { host: CF_HOST, proto: 'https', path: '/api/auth/me' });

    const secure = (r) => /;\s*Secure/i.test(r.headers.get('set-cookie') || '');
    expect(secure(lying)).toBe(secure(honest));
  });

  it('no se emite HSTS para el host interno de la LAN aunque llegue cifrado', async () => {
    const res = await hit('loopback', { host: LAN_HOST, proto: 'https' });
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('HSTS solo con hosts declarados: por defecto no se emite ninguno', async () => {
    const noHosts = createApp({ trustProxy: 'loopback' }).listen(0, '127.0.0.1');
    await new Promise((r) => noHosts.once('listening', r));
    try {
      const p = noHosts.address().port;
      const res = await fetch(`http://127.0.0.1:${p}/api/health`, {
        headers: { Host: CF_HOST, 'X-Forwarded-Proto': 'https' },
      });
      expect(res.headers.get('strict-transport-security')).toBeNull();
    } finally {
      await new Promise((r) => noHosts.close(r));
    }
  });
});

describe('sesión de producción: usable por HTTPS, no por HTTP', () => {
  // Con COOKIE_SECURE=true la cookie tf_sid solo viaja por HTTPS, así que la
  // red local no puede reutilizarla. Se comprueba con la regla del navegador
  // (no se envía una cookie Secure por http://), porque supertest no la aplica.
  let server;
  let port;
  let lanAddr;
  let secureValue;

  function cookieJar() {
    const jar = new Map();
    return {
      absorb(res) {
        for (const raw of res.headers.getSetCookie?.() || []) {
          const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
          const i = pair.indexOf('=');
          jar.set(pair.slice(0, i), {
            value: pair.slice(i + 1),
            secure: attrs.some((a) => a.toLowerCase() === 'secure'),
          });
        }
      },
      header({ https }) {
        return [...jar.entries()]
          .filter(([, c]) => https || !c.secure)
          .map(([n, c]) => `${n}=${c.value}`)
          .join('; ');
      },
    };
  }

  beforeAll(async () => {
    secureValue = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    const { default: config } = await import('../src/config.js');
    config.session.secure = true;

    server = createApp({ trustProxy: 'loopback', publicHosts: CF_HOST }).listen(0, '0.0.0.0');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) lanAddr = i.address;
      }
    }
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    if (secureValue === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = secureValue;
  });

  async function loginByHttps() {
    const jar = cookieJar();
    const csrfRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Host: CF_HOST, 'X-Forwarded-Proto': 'https' },
    });
    jar.absorb(csrfRes);
    const csrf = jar.header({ https: true }).match(/tf_csrf=([a-f0-9]+)/)[1];

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: {
        Host: CF_HOST,
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
        Cookie: jar.header({ https: true }),
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ ...ADMIN, remember: false }),
    });
    jar.absorb(res);
    return { jar, res, csrf };
  }

  it('la cookie de sesión sale con Secure y HttpOnly', async () => {
    const { res } = await loginByHttps();
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('tf_sid='));
    expect(raw, 'debe emitir tf_sid').toBeTruthy();
    expect(raw).toMatch(/;\s*Secure/i);
    expect(raw).toMatch(/;\s*HttpOnly/i);
    expect(raw).toMatch(/;\s*SameSite=Lax/i);
  });

  it('esa sesión NO se envía por HTTP, así que el acceso por HTTP no lausable', async () => {
    const { jar } = await loginByHttps();
    // El navegador no manda una cookie Secure por http://.
    expect(jar.header({ https: false })).not.toContain('tf_sid');

    const base = lanAddr ? `http://${lanAddr}:${port}` : `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Host: LAN_HOST, Cookie: jar.header({ https: false }) },
    });
    expect(res.status).toBe(401);
  });

  it('esa misma sesión sí funciona por HTTPS', async () => {
    const { jar } = await loginByHttps();
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Host: CF_HOST, 'X-Forwarded-Proto': 'https', Cookie: jar.header({ https: true }) },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe('admin');
  });
});

describe('CSRF sigue funcionando con la política estática', () => {
  const app = createApp({ trustProxy: 'loopback', publicHosts: CF_HOST });

  it('exige cookie y cabecera coincidentes, y acepta la válida', async () => {
    const first = await request(app).get('/api/auth/me').set('X-Forwarded-Proto', 'https');
    const csrf = (first.headers['set-cookie'] || [])
      .find((c) => c.startsWith('tf_csrf='))
      .split(';')[0]
      .split('=')[1];
    expect(csrf).toMatch(/^[a-f0-9]{48}$/);

    const login = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `tf_csrf=${csrf}`)
      .set('x-csrf-token', csrf)
      .send({ ...ADMIN, remember: false });
    expect(login.status).toBe(200);

    const sessionCookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('tf_sid=')).split(';')[0];
    const cookie = `tf_csrf=${csrf}; ${sessionCookie}`;

    const bad = await request(app)
      .post('/api/tickets')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookie)
      .set('x-csrf-token', 'f'.repeat(48))
      .send({ title: 'sin csrf valido', description: 'x', category_id: 1 });
    expect(bad.status).toBe(403);

    const good = await request(app)
      .post('/api/tickets')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ title: 'con csrf valido', description: 'x', category_id: 1 });
    expect(good.status).toBe(201);
  });
});
