import { createApp } from './app.js';
import config from './config.js';
import { runMigrations } from './db.js';
import { seed } from './seed.js';
import { startJobs } from './utils/jobs.js';

runMigrations();
seed();

const app = createApp();
startJobs();

app.listen(config.port, () => {
  console.log(`[ticket] API escuchando en http://localhost:${config.port} (${config.env})`);
  console.log(`[ticket] Base de datos: ${config.dbFile}`);
  console.log(`[ticket] Uploads: ${config.uploadDir}`);
});