import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers.js';

let server;
let base;

function makeClient() {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  function store(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const [kv] = raw.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  async function req(method, path, body) {
    const headers = {};
    if (Object.keys(jar).length) headers.Cookie = cookieHeader();
    if (method !== 'GET') headers['x-csrf-token'] = jar.tf_csrf || '';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    store(res);
    let parsed = null;
    if (res.headers.get('content-type')?.includes('application/json')) {
      parsed = await res.json();
    }
    return { status: res.status, headers: res.headers, body: parsed, raw: res };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    cookie: cookieHeader,
  };
}

function parseChunk(chunk) {
  let type = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (type === 'message' && !dataLines.length) return null;
  let data = {};
  if (dataLines.length) {
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      data = {};
    }
  }
  return { type, data };
}

function openStream(path, cookie) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  let buffer = '';
  let connected = false;

  const done = fetch(base + path, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: ac.signal,
  }).then(async (res) => {
    connected = true;
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = parseChunk(chunk);
            if (ev) {
              events.push(ev);
              for (const w of [...waiters]) w(ev);
            }
          }
        }
      } catch {
        // conexión abortada
      }
    })();
  });

  function waitFor(type, timeout = 4000) {
    const existing = events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout esperando evento "${type}"`)), timeout);
      const waiter = (ev) => {
        if (ev.type === type) {
          clearTimeout(timer);
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(ev);
        }
      };
      waiters.push(waiter);
    });
  }

  return { done, waitFor, events, close: () => ac.abort(), isConnected: () => connected };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

describe('Conversación en vivo por SSE', () => {
  it('entrega comentarios y "escribiendo…" y oculta notas internas', async () => {
    const empleado = makeClient();
    await empleado.post('/api/auth/login', { account: 'empleado', password: 'Empleado1234!', remember: false });
    const created = await empleado.post('/api/tickets', {
      title: 'Chat en vivo e2e',
      description: 'Prueba de conversación en tiempo real',
      category_id: 1,
      priority: 'MEDIUM',
    });
    const ticketId = created.body.ticket.id;
    assert.ok(ticketId);

    const stream = openStream(`/api/tickets/${ticketId}/stream`, empleado.cookie());
    await stream.done;
    await stream.waitFor('ready');

    const admin = makeClient();
    await admin.post('/api/auth/login', { account: 'admin', password: 'Admin1234!', remember: false });

    const publicMsg = await admin.post(`/api/tickets/${ticketId}/comments`, { message: 'Hola, estamos revisando.' });
    assert.equal(publicMsg.status, 201);
    const commentEvent = await stream.waitFor('comment');
    assert.equal(commentEvent.data.comment.message, 'Hola, estamos revisando.');
    assert.equal(commentEvent.data.comment.is_internal, false);
    assert.equal(commentEvent.data.comment.user_name, 'Administrador Sistema');

    await admin.post(`/api/tickets/${ticketId}/typing`, {});
    const typingEvent = await stream.waitFor('typing');
    assert.equal(typingEvent.data.user_name, 'Administrador Sistema');

    const note = await admin.post(`/api/tickets/${ticketId}/comments`, {
      message: 'Nota interna que el empleado no debe ver',
      is_internal: '1',
    });
    assert.equal(note.status, 201);

    // Cambio de estado -> evento de refresco
    await admin.patch(`/api/tickets/${ticketId}`, { priority: 'HIGH' });
    await stream.waitFor('refresh');

    // El empleado no recibe la nota interna ni un evento de comentario interno.
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !stream.events.some((e) => e.type === 'comment' && e.data.comment?.is_internal),
      'no debe llegar la nota interna al reportante'
    );

    stream.close();
  });

  it('rechaza el stream en tickets ajenos sin permiso', async () => {
    const admin = makeClient();
    await admin.post('/api/auth/login', { account: 'admin', password: 'Admin1234!', remember: false });
    const created = await admin.post('/api/tickets', {
      title: 'Ticket privado e2e',
      description: 'x',
      category_id: 1,
      priority: 'LOW',
    });

    const empleado = makeClient();
    await empleado.post('/api/auth/login', { account: 'empleado', password: 'Empleado1234!', remember: false });
    const res = await fetch(`${base}/api/tickets/${created.body.ticket.id}/stream`, {
      headers: { Cookie: empleado.cookie(), Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 404);
    await res.body?.cancel?.();
  });
});
