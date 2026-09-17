import { createApp } from './app.js';
import config from './config.js';
import { runMigrations } from './db.js';
import { seed } from './seed.js';

runMigrations();
seed();

const app = createApp();

app.listen(config.port, () => {
  console.log(`[ticket-flow] API escuchando en http://localhost:${config.port} (${config.env})`);
  console.log(`[ticket-flow] Base de datos: ${config.dbFile}`);
  console.log(`[ticket-flow] Uploads: ${config.uploadDir}`);
});