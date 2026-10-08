import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.DATA_DIR = tmp;
// Mismo criterio que test/setup.js: la suite es SQLite; DB_CLIENT no debe
// arrancar el pool de SQL Server al importar config.js.
process.env.DB_CLIENT = 'sqlite';
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
// El seed exige pedir cada cuenta. Estas son las credenciales de fixture que
// usa la suite; no hay ninguna contraseña por defecto en el código de producción.
process.env.SEED_ADMIN_PASSWORD = '123456';
process.env.SEED_DEMO_ACCOUNTS = 'true';
process.env.SEED_DEMO_PASSWORD = 'Empleado1234!';
process.env.SEED_TECH_PASSWORD = 'Tecnico1234!';

const { default: db, runMigrations, nowIso } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/utils/password.js');

runMigrations();
seed();

export const app = createApp();

export function createClient() {
  const cookies = {};
  let csrf = '';

  function store(res) {
    for (const raw of res.headers['set-cookie'] || []) {
      const [kv] = raw.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    if (cookies.tf_csrf) csrf = cookies.tf_csrf;
  }

  function cookieStr() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async function get(url, { timeout, headers } = {}) {
    let req = request(app).get(url).set('Cookie', cookieStr());
    // Cabeceras extra (p. ej. probar que x-organization-id se IGNORA): nunca
    // deben cambiar el contexto de sesión, que es la única fuente de org.
    for (const [k, v] of Object.entries(headers || {})) req = req.set(k, v);
    // Timeout opcional: hay rutas cuyo defecto es justamente no responder
    // nunca, y sin esto la suite se quedaría colgada en lugar de fallar.
    if (timeout) req.timeout({ response: timeout, deadline: timeout });
    const res = await req;
    store(res);
    return res;
  }

  async function post(url, body) {
    const res = await request(app)
      .post(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf)
      .send(body);
    store(res);
    return res;
  }

  async function patch(url, body) {
    const res = await request(app)
      .patch(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf)
      .send(body);
    store(res);
    return res;
  }

  async function put(url, body) {
    const res = await request(app)
      .put(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf)
      .send(body);
    store(res);
    return res;
  }

  async function del(url) {
    const res = await request(app)
      .delete(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf);
    store(res);
    return res;
  }

  async function postForm(url, fd) {
    const res = await request(app)
      .post(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf)
      .send(fd);
    store(res);
    return res;
  }

  async function postMultipart(url, fields, files = []) {
    let req = request(app)
      .post(url)
      .set('Cookie', cookieStr())
      .set('x-csrf-token', csrf);
    for (const [k, v] of Object.entries(fields || {})) req = req.field(k, v);
    for (const f of files) req = req.attach('files', f.buffer, { filename: f.name, contentType: f.mime });
    const res = await req;
    store(res);
    return res;
  }

  async function login(account, password) {
    await get('/api/health');
    return post('/api/auth/login', { account, password, remember: false });
  }

  return { get, post, patch, put, del, postForm, postMultipart, login };
}

// Crea (si hace falta) una cuenta SUPERADMIN global de prueba y devuelve un
// cliente YA autenticado con ella. Los canales reservados al SUPERADMIN no
// deben depender de que otra suite haya creado la cuenta: cada archivo de
// pruebas corre en su propio proceso con su propia base, y el seed no crea
// ninguna cuenta SUPERADMIN.
const SUPERADMIN_TEST_PASSWORD = 'SuperClave123!';
export async function createSuperadminClient(username = 'super_roles_test') {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!existing) {
    const role = db.prepare("SELECT id FROM roles WHERE code = 'SUPERADMIN'").get();
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`
    ).run(
      'Super',
      'Global',
      username,
      `${username}@organizacion.test`,
      hashPassword(SUPERADMIN_TEST_PASSWORD),
      role.id,
      nowIso()
    );
  }
  const client = createClient();
  const login = await client.login(username, SUPERADMIN_TEST_PASSWORD);
  if (login.status !== 200) {
    throw new Error(`No se pudo iniciar sesión como SUPERADMIN de prueba (${login.status})`);
  }
  return client;
}