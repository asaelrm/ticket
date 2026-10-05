// B11-B1: cliente HTTP para probar la aplicación REAL contra SQL Server DEV.
//
// Este helper NO importa test/setup.js. A propósito: setup.js migra y siembra
// una base SQLite en cada proceso de prueba, y si se precargara aquí,
// src/db.js y src/config.js quedarían ya evaluados con DB_CLIENT=sqlite. Las
// pruebas entonces pasarían contra SQLite sin darme cuenta, que es el peor
// fallo posible en una integración de base de datos. Por eso el fichero de
// pruebas que usa este helper NO termina en .test.js y el glob `test/*.test.js`
// no lo recoge.
//
// Lo que el helper fija y por qué:
//   NODE_ENV=test        desactiva los rate limit por IP (hasta 10/min en login)
//                        y apaga la instantánea del directorio. Sin esto, la
//                        prueba saltaría a 429 en el cuarto login.
//   DB_CLIENT=mssql      el objetivo de la fase.
//   DATA_DIR/UPLOAD_DIR  temporales: config.js crea esos directorios al
//                        importarse y nada debe tocar data/ ni uploads/.
//   DIRECTORY_SYNC=false defensa extra, además del NODE_ENV=test.
//   SESSION_SECRET       valor sintético de la propia prueba.
//
// NO importa src/server.js, no ejecuta runMigrations, no hace seed, no arranca
// jobs y no usa un store de sesiones falso: createApp() elige el
// MssqlSessionStore real según config.dbClient.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-b11b1-http-'));

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'mssql';
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.DIRECTORY_SNAPSHOT_FILE = path.join(tmp, 'directory.json');
process.env.DIRECTORY_SYNC = 'false';
process.env.SESSION_SECRET = 'b11b1-prueba-http-sesion-sintetica';
process.env.MAIL_ENABLED = 'false';

// Importaciones DINÁMICAS a propósito: las variables anteriores tienen que estar
// puestas antes de que config.js las lea por primera vez.
const config = (await import('../src/config.js')).default;
const { createApp } = await import('../src/app.js');
const { contract } = await import('../src/db.js');
const { isDevelopmentDatabase } = await import('../src/db/mssql.js');

if (config.dbClient !== 'mssql') {
  throw new Error(
    `La configuración se cargó con dbClient="${config.dbClient}". Esta prueba necesita MSSQL: `
    + 'no la ejecute con --import ./test/setup.js, porque setup.js ya importa db.js con SQLite.',
  );
}
if (config.env !== 'test') {
  throw new Error(`NODE_ENV debe ser "test" (vale "${config.env}"); si no, los rate limit Saltan.`);
}
if (!isDevelopmentDatabase(config.mssql.database)) {
  throw new Error(`DB_DATABASE="${config.mssql.database}" no está marcada como DEV/TEST. No se continúa.`);
}

export const app = createApp();
export { config, contract };

/**
 * Cierra el pool de MSSQL al terminar el proceso. Si no, el socket abierto
 * mantiene vivo el event loop y el runner se queda esperando.
 */
export async function closeHttpSupport() {
  await contract.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Que no quede el temporal no puede tumbar el resultado de las pruebas.
  }
}

function parseSetCookie(raw) {
  const [pair, ...attributes] = raw.split(';');
  const i = pair.indexOf('=');
  return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), attributes };
}

/**
 * Cliente con tarro de cookies real. Guarda `tf_sid` y `tf_csrf` como los
 * emitiría un navegador, y recuerda el `Set-Cookie` completo para poder
 * comprobar flags y caducidad.
 */
export function createHttpClient() {
  const jar = new Map();
  let csrf = '';
  const lastRaw = new Map();

  function absorb(res) {
    for (const raw of res.headers['set-cookie'] || []) {
      const { name, value } = parseSetCookie(raw);
      lastRaw.set(name, raw);
      if (value === '') {
        jar.delete(name);
        if (name === 'tf_csrf') csrf = '';
      } else {
        jar.set(name, value);
        if (name === 'tf_csrf') csrf = value;
      }
    }
  }

  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function base(method, url) {
    const builder = request(app)[method](url);
    const cookies = cookieHeader();
    if (cookies) builder.set('Cookie', cookies);
    return builder;
  }

  async function run(builder) {
    const res = await builder;
    absorb(res);
    return res;
  }

  return {
    /** Cookie tf_sid tal como la devolvió el servidor, con sus atributos. */
    rawSessionCookie: () => lastRaw.get('tf_sid') || null,
    /** Solo el valor de tf_sid, que es `s:<sid>.<firma>`. */
    sessionCookieValue: () => jar.get('tf_sid') || null,
    /** El SID sin firma: es la clave primaria de dbo.sessions. */
    rawSid() {
      const value = jar.get('tf_sid');
      if (!value) return null;
      const decoded = decodeURIComponent(value).replace(/^s:/, '');
      const dot = decoded.lastIndexOf('.');
      return dot === -1 ? decoded : decoded.slice(0, dot);
    },
    csrfToken: () => csrf,
    cookieHeader: () => cookieHeader(),
    hasSessionCookie: () => jar.has('tf_sid'),

    /**
     * Siembra cookies manualmente. Sirve para el caso "otra pestaña/navegador
     * con la misma tf_sid": demuestra que la sesión se recupera de SQL Server y
     * no de memoria del proceso, porque este cliente es una instancia nueva con
     * el tarro vacío.
     */
    seedCookies(values) {
      for (const [name, value] of Object.entries(values)) {
        jar.set(name, value);
        if (name === 'tf_csrf') csrf = value;
      }
      return this;
    },

    get: (url) => run(base('get', url)),

    post(url, body) {
      const builder = base('post', url).set('x-csrf-token', csrf);
      if (body !== undefined) builder.send(body);
      return run(builder);
    },

    patch(url, body) {
      const builder = base('patch', url).set('x-csrf-token', csrf);
      if (body !== undefined) builder.send(body);
      return run(builder);
    },

    del(url) {
      return run(base('delete', url).set('x-csrf-token', csrf));
    },

    /**
     * Login con las credenciales del manifiesto. No toca tf_csrf: /auth/login
     * está exento de CSRF por diseño (csrfProtect lo salta), pero se llama
     * antes a /api/health para obtener la cookie, igual que hace un navegador.
     */
    async login(account, password, { remember = false } = {}) {
      await this.get('/api/health');
      return this.post('/api/auth/login', { account, password, remember });
    },
  };
}