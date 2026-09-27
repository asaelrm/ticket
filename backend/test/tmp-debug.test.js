import { it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';

it('debug hsts', async () => {
  const server = createApp({ trustProxy: 'loopback', publicHosts: 'tickets.example.com' }).listen(0, '0.0.0.0');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const lines = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Host: 'tickets.example.com', 'X-Forwarded-Proto': 'https' },
    });
    lines.push(`status ${res.status}`);
    for (const [k, v] of res.headers.entries()) if (/transport/i.test(k)) lines.push(`hdr ${k} = ${v}`);
    const v = res.headers.get('strict-transport-security');
    lines.push(`typeof ${typeof v} value ${JSON.stringify(v)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  fs.writeFileSync('C:/Users/asael/AppData/Local/Temp/opencode/hsts-debug.txt', lines.join('\n'));
});
