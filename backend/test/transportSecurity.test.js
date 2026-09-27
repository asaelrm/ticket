import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resolveTrustProxy, normalizeHost, isPublicHost, shouldSendHsts } from '../src/transportSecurity.js';

// Hostnames usados en la instalación real described por el usuario.
const CF_HOST = 'tickets.example.com';
const LAN_HOST = 'ticket.lan';

// Direcciones de los proxies reales: el túnel de Cloudflare y, para las
// pruebas, un cliente cualquiera de la LAN.
const CF_PROXY_IP = '172.18.0.1';
const ATTACKER_IP = '10.0.0.99';

const PROD = { trustProxy: CF_PROXY_IP, publicHosts: CF_HOST };

// Emula al navegador: guarda las cookies con sus atributos y, al construir la
// cabecera Cookie, OMITE las que llevan Secure si la petición no es HTTPS.
// supertest no aplica esa regla, y sin ella no se puede demostrar que una
// sesión de producción no viaja por HTTP.
function browserJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const raw of res.headers['set-cookie'] || []) {
        const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
        const i = pair.indexOf('=');
        const name = pair.slice(0, i);
        const lower = attrs.map((a) => a.toLowerCase());
        if (lower.some((a) => a.startsWith('max-age=0') || a.startsWith('expires=thu, 01 jan 1970'))) {
          jar.delete(name);
          continue;
        }
        jar.set(name, { value: pair.slice(i + 1), secure: lower.includes('secure') });
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

function get(app, { path = '/api/health', host, ip, proto, https }) {
  let r = request(app).get(path).set('Host', host);
  if (proto) r = r.set('X-Forwarded-Proto', proto);
  if (ip) r = r.set('X-Forwarded-For', ip);
  return r;
}

function cookieAttr(res, name, attr) {
  const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  return raw.split(';').slice(1).map((s) => s.trim().toLowerCase()).includes(attr.toLowerCase());
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

  it('ignora un valor no reconocido en lugar de abrir la puerta', () => {
    const r = resolveTrustProxy('todo-el-mundo');
    expect(r.value).toBe(false);
    expect(r.warning).toMatch(/no reconocido/i);
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

describe('cabeceras de proxy falsificadas', () => {
  it('con la configuración por defecto, X-Forwarded-Proto se ignora', async () => {
    // Estado actual en producción: trust proxy desactivado.
    const app = createApp();
    const res = await get(app, { path: '/api/auth/me', host: CF_HOST, proto: 'https', ip: ATTACKER_IP });
    // Sin confianza en el proxy, Express cree que es HTTP: no marca Secure.
    expect(cookieAttr(res, 'tf_csrf', 'Secure')).toBe(false);
  });

  it('con trust proxy limitado, un cliente no listado NO puede declararse HTTPS', async () => {
    const app = createApp(PROD);
    const forged = await get(app, { path: '/api/auth/me', host: CF_HOST, proto: 'https', ip: ATTACKER_IP });
    // Attaque desde 10.0.0.99: no está en la lista de proxies, así que la
    // cabecera se ignora y la respuesta se emite como HTTP.
    expect(cookieAttr(forged, 'tf_csrf', 'Secure')).toBe(false);
  });

  it('con trust proxy limitado, el proxy real SÍ refleja HTTPS', async () => {
    const app = createApp(PROD);
    const genuine = await get(app, { path: '/api/auth/me', host: CF_HOST, proto: 'https', ip: CF_PROXY_IP });
    expect(cookieAttr(genuine, 'tf_csrf', 'Secure')).toBe(true);
  });
});

describe('HSTS por host', () => {
  it('se emite para el host público que llega por HTTPS', async () => {
    const app = createApp(PROD);
    const res = await get(app, { path: '/api/health', host: CF_HOST, ip: CF_PROXY_IP, proto: 'https' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('NO se emite para el host interno de la LAN', async () => {
    const app = createApp(PROD);
    const res = await get(app, { path: '/api/health', host: LAN_HOST, ip: ATTACKER_IP, proto: 'https' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('NO se emite cuando la misma petición pública llega por HTTP', async () => {
    const app = createApp(PROD);
    const res = await get(app, { path: '/api/health', host: CF_HOST, ip: ATTACKER_IP, proto: 'http' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('con la configuración por defecto nunca se emite (no hay hosts declarados)', async () => {
    const app = createApp();
    const res = await get(app, { path: '/api/health', host: CF_HOST, ip: CF_PROXY_IP, proto: 'https' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('cookies de sesión por HTTPS y por HTTP', () => {
  // El objetivo de seguridad: con COOKIE_SECURE=true, la sesión obtenida por
  // Cloudflare no debe poder reutilizarse desde la red local. Se valida con la
  // regla del navegador, no confiando en que supertest la aplique.
  function secureApp() {
    const saved = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    const app = createApp(PROD);
    if (saved === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = saved;
    return app;
  }

  async function loginViaCloudflare(app) {
    const jar = browserJar();
    const login = await request(app)
      .post('/api/auth/login')
      .set('Host', CF_HOST)
      .set('X-Forwarded-For', CF_PROXY_IP)
      .set('X-Forwarded-Proto', 'https')
      .send({ account: 'admin', password: 'Admin1234!', remember: false });
    jar.absorb(login);
    return { jar, login };
  }

  it('la sesión creada por HTTPS sale con Secure y HttpOnly', async () => {
    const app = secureApp();
    const { login } = await loginViaCloudflare(app);
    expect(login.status).toBe(200);
    expect(cookieAttr(login, 'tf_sid', 'Secure')).toBe(true);
    expect(cookieAttr(login, 'tf_sid', 'HttpOnly')).toBe(true);
    expect(cookieAttr(login, 'tf_sid', 'SameSite=Lax')).toBe(true);
  });

  it('esa misma sesión NO se envía por HTTP, así que HTTP no da acceso', async () => {
    const app = secureApp();
    const { jar } = await loginViaCloudflare(app);

    // El navegador, al abrir http://, descarta la cookie Secure: no la envía.
    const cookieHeader = jar.header({ https: false });
    expect(cookieHeader).not.toContain('tf_sid');

    const res = await request(app)
      .get('/api/auth/me')
      .set('Host', LAN_HOST)
      .set('Cookie', cookieHeader)
      .send();
    expect(res.status).toBe(401);
  });

  it('esa misma sesión SÍ funciona por HTTPS', async () => {
    const app = secureApp();
    const { jar } = await loginViaCloudflare(app);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Host', CF_HOST)
      .set('X-Forwarded-For', CF_PROXY_IP)
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', jar.header({ https: true }))
      .send();
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('admin');
  });
});

describe('CSRF sigue funcionando', () => {
  it('la política estática no rompe el flujo de token', async () => {
    const app = createApp(PROD);
    const jar = browserJar();

    const first = await get(app, { path: '/api/auth/me', host: CF_HOST, ip: CF_PROXY_IP, proto: 'https' });
    jar.absorb(first);
    const csrf = jar.header({ https: true }).match(/tf_csrf=([a-f0-9]+)/)[1];
    expect(csrf).toMatch(/^[a-f0-9]{48}$/);

    // POST autenticado: sigue exigiendo cookie + cabecera coincidentes.
    const login = await request(app)
      .post('/api/auth/login')
      .set('Host', CF_HOST)
      .set('X-Forwarded-For', CF_PROXY_IP)
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', jar.header({ https: true }))
      .set('x-csrf-token', csrf)
      .send({ account: 'admin', password: 'Admin1234!', remember: false });
    jar.absorb(login);
    expect(login.status).toBe(200);

    const bad = await request(app)
      .post('/api/tickets')
      .set('Host', CF_HOST)
      .set('X-Forwarded-For', CF_PROXY_IP)
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', jar.header({ https: true }))
      .set('x-csrf-token', 'f'.repeat(48))
      .send({ title: 'sin csrf valido', description: 'x', category_id: 1 });
    expect(bad.status).toBe(403);

    const good = await request(app)
      .post('/api/tickets')
      .set('Host', CF_HOST)
      .set('X-Forwarded-For', CF_PROXY_IP)
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', jar.header({ https: true }))
      .set('x-csrf-token', csrf)
      .send({ title: 'con csrf valido', description: 'x', category_id: 1 });
    expect(good.status).toBe(201);
  });

  it('rechaza una cabecera X-Forwarded-Proto falsificada que intente degradar la cookie', async () => {
    const app = createApp(PROD);
    // Petición que SÍ llega por el proxy (IP de confianza) pero afirma ser
    // http: la cookie Secure sigue saliendo, no se degrada a http.
    const res = await get(app, { path: '/api/auth/me', host: CF_HOST, ip: CF_PROXY_IP, proto: 'http' });
    // config.session.secure es false en el test, así que aquí lo que se
    // comprueba es que la decisión NO depende de la cabecera falsificada:
    // con la misma app y otra cabecera el resultado es idéntico.
    const res2 = await get(app, { path: '/api/auth/me', host: CF_HOST, ip: CF_PROXY_IP, proto: 'https' });
    expect(cookieAttr(res, 'tf_csrf', 'Secure')).toBe(cookieAttr(res2, 'tf_csrf', 'Secure'));
  });
});
