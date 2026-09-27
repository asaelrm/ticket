import { it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import { resolveTrustProxy } from '../src/transportSecurity.js';

it('debug trust', async () => {
  const lines = [];
  const t = resolveTrustProxy('loopback');
  lines.push(`resolveTrustProxy('loopback') = ${JSON.stringify(t)}`);
  const app = express();
  if (t.value) app.set('trust proxy', t.value);
  app.get('/probe', (req, res) => {
    res.json({
      secure: req.secure,
      protocol: req.protocol,
      hostname: req.hostname,
      host: req.headers.host,
      xfp: req.headers['x-forwarded-proto'] ?? null,
      remote: req.socket.remoteAddress,
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { Host: 'tickets.example.com', 'X-Forwarded-Proto': 'https' },
    });
    lines.push(JSON.stringify(await res.json(), null, 1));
  } finally {
    await new Promise((r) => server.close(r));
  }
  fs.writeFileSync('C:/Users/asael/AppData/Local/Temp/opencode/trust-debug.txt', lines.join('\n'));
});
