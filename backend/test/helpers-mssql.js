// Helpers para pruebas MSSQL: cliente HTTP contra la API real con base MSSQL
// Requiere que setup-mssql.js ya haya validado la conexión

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Credenciales de prueba desde variables de entorno (definidas en .env.mssql-test)
const TEST_ADMIN_USER = process.env.MSSQL_TEST_ADMIN_USER || 'admin';
const TEST_ADMIN_PASS = process.env.MSSQL_TEST_ADMIN_PASS || 'TestAdmin123!';
const TEST_EMPLEADO_USER = process.env.MSSQL_TEST_EMPLEADO_USER || 'empleado';
const TEST_EMPLEADO_PASS = process.env.MSSQL_TEST_EMPLEADO_PASS || 'Empleado1234!';
const TEST_TECNICO_USER = process.env.MSSQL_TEST_TECNICO_USER || 'tecnico';
const TEST_TECNICO_PASS = process.env.MSSQL_TEST_TECNICO_PASS || 'Tecnico1234!';

// Directorio temporal para uploads (solo archivos locales, no BD)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mssql-test-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.DIRECTORY_SNAPSHOT_FILE = path.join(tmp, 'directory.json');

// Importar app después de que setup-mssql.js configure las variables de entorno MSSQL
const { createApp } = await import('../src/app.js');

export const app = createApp();

// Generador de sufijos únicos para aislar datos de prueba
export function uniqueSuffix() {
  return `mssql_${crypto.randomBytes(6).toString('hex')}`;
}

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
    for (const [k, v] of Object.entries(headers || {})) req = req.set(k, v);
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

// Clientes preconfigurados para roles comunes
export async function createAdminClient(suffix = '') {
  const c = createClient();
  await c.login(TEST_ADMIN_USER, TEST_ADMIN_PASS);
  return c;
}

export async function createEmpleadoClient(suffix = '') {
  const c = createClient();
  await c.login(TEST_EMPLEADO_USER, TEST_EMPLEADO_PASS);
  return c;
}

export async function createTecnicoClient(suffix = '') {
  const c = createClient();
  await c.login(TEST_TECNICO_USER, TEST_TECNICO_PASS);
  return c;
}

// Limpieza de archivos temporales al salir (no toca la BD)
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignorar
  }
});