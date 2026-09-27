import { it } from 'vitest';
import os from 'node:os';
import { createApp } from '../src/app.js';

it('debug hsts', async () => {
  const server = createApp({ trustProxy: 'loopback', publicHosts: 'tickets.example.com' }).listen(0, '0.0.0.0');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Host: 'tickets.example.com', 'X-Forwarded-Proto': 'https' },
    });
    console.log('status', res.status);
    console.log('entries', JSON.stringify([...res.headers.entries()].filter(([k]) => /transport|strict/i.test(k))));
    const v = res.headers.get('strict-transport-security');
    console.log('typeof', typeof v, 'value', JSON.stringify(v));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
