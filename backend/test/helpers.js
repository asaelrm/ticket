import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { runMigrations } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');

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

  async function get(url) {
    const res = await request(app).get(url).set('Cookie', cookieStr());
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

  return { get, post, patch, postForm, postMultipart, login };
}