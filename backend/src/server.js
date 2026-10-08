import { createApp } from './app.js';
import config from './config.js';
import { runMigrations } from './db.js';
import { seed } from './seed.js';
import { restoreDirectorySnapshot } from './directorySync.js';
import { startJobs } from './utils/jobs.js';

runMigrations();
seed();
restoreDirectorySnapshot();

const app = createApp();
startJobs();

// Deja constancia cuando se pidió SQL Server pero el runtime no está activado:
// sin este aviso, un `DB_CLIENT=mssql` sin `MSSQL_RUNTIME=true` parecería estar
// ejecutándose sobre SQL Server cuando en realidad usa SQLite.
if (config.requestedDbClient === 'mssql' && config.dbClient !== 'mssql') {
  console.warn(
    '[db] DB_CLIENT=mssql solicitado, pero el runtime MSSQL no está activado ' +
      '(defina MSSQL_RUNTIME=true para habilitarlo). Este proceso usa SQLite.',
  );
}

app.listen(config.port, () => {
  console.log(`[ticket] API escuchando en http://localhost:${config.port} (${config.env})`);
  console.log(`[ticket] Base de datos: ${config.dbFile}`);
  console.log(`[ticket] Uploads: ${config.uploadDir}`);
});
