import { it } from 'vitest';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { resolveTrustProxy } from '../src/transportSecurity.js';

it('debug trust', async () => {
  const lines = [];
  lines.push(`resolveTrustProxy('loopback') = ${JSON.stringify(resolveTrustProxy('loopback'))}`);
  const app = createApp({ trustProxy: 'loopback', publicHosts: 'tickets.example.com' });
  app.get('/probe', (req, res) => {
    res.json({
      secure: req.secure,
      protocol: req.protocol,
      hostname: req.hostname,
      host: req.headers.host,
      xfp: req.headers['x-forwarded-proto'] ?? null,
      remote: req.socket.remoteAddress,
      trustSetting: app.get('trust proxy fn') ? 'fn' : String(app.get('trust proxy')),
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
    lines.push(`hsts=${res.headers.get('strict-transport-security')}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  fs.writeFileSync('C:/Users/asael/AppData/Local/Temp/opencode/hsts-debug.txt', lines.join('\n'));
});
