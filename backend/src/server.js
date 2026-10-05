import { createApp } from './app.js';
import config from './config.js';
import { runMigrations } from './db.js';
import { seed } from './seed.js';
import { restoreDirectorySnapshot } from './directorySync.js';
import { startJobs } from './utils/jobs.js';
import { runDatabaseBootstrap, startBackgroundJobs, usesSqliteBootstrap } from './startup.js';

// Las migraciones, el seed y el directorio son SQLite puro. Con DB_CLIENT=mssql
// se omiten en lugar de dejar que la API legacy de `db.js` abortara el proceso
// antes de levantar el servidor. Ver src/startup.js.
runDatabaseBootstrap({
  dbClient: config.dbClient,
  runMigrations,
  seed,
  restoreDirectorySnapshot,
});

const app = createApp();

startBackgroundJobs({ dbClient: config.dbClient, startJobs });

app.listen(config.port, () => {
  console.log(`[ticket] API escuchando en http://localhost:${config.port} (${config.env})`);
  // Se anuncia el motor, no la configuración de conexión: aquí no se imprime
  // servidor, usuario, contraseña ni dirección de red. La decisión sale de
  // `usesSqliteBootstrap`, la misma función que gobierna el bootstrap de arriba,
  // para que las dos cosas no puedan divergir.
  if (usesSqliteBootstrap(config.dbClient)) {
    console.log(`[ticket] Base de datos: SQLite (${config.dbFile})`);
  } else {
    console.log('[ticket] Base de datos: SQL Server (soporte en migración progresiva)');
  }
  console.log(`[ticket] Uploads: ${config.uploadDir}`);
});
