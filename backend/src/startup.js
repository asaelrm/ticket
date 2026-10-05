// B12 · Arranque consciente del motor de base de datos.
//
// `runMigrations`, `seed` y `restoreDirectorySnapshot` son SQLite puro: usan la
// API legacy (`db.prepare`/`db.exec`), `PRAGMA`, `sqlite_master` y DDL de
// SQLite. Con DB_CLIENT=mssql esa API lanza a propósito, así que el proceso
// moría en la primera línea de `server.js` y no llegaba a levantar el servidor:
// no había ni listener ni health.
//
// Aquí se decide, y solo aquí, qué inicialización es propia de SQLite. Lo que
// este módulo NO hace es suavizar el Proxy legacy de `db.js`: una ruta sin
// migrar sigue fallando ruidosamente en vez de degradarse por sorpresa a otro
// motor. Que el servidor arranque no significa que el soporte de SQL Server esté
// completo; significa únicamente que la inicialización exclusiva de SQLite ya no
// se ejecuta cuando el motor es otro.

// Pasos de arranque que dependen de la API legacy de SQLite, en orden.
export const SQLITE_BOOTSTRAP_STEPS = ['migraciones', 'seed', 'directorio'];

/**
 * `config.dbClient` ya está validado a 'sqlite' | 'mssql' al importar config.js
 * (ver `dbClient()`). Se normaliza igual para que esta función se pueda probar
 * sin cargar la configuración real.
 */
export function usesSqliteBootstrap(dbClient) {
  return String(dbClient || 'sqlite').trim().toLowerCase() === 'sqlite';
}

/**
 * Ejecuta la inicialización de la base de datos si el motor es SQLite.
 *
 * Las dependencias se inyectan para que la prueba pueda observar qué pasos se
 * ejecutan sin levantar nada. Devuelve los pasos omitidos: vacío con SQLite.
 */
export function runDatabaseBootstrap({
  dbClient,
  runMigrations,
  seed,
  restoreDirectorySnapshot,
  log = console.log,
}) {
  if (!usesSqliteBootstrap(dbClient)) {
    log(
      '[ticket] DB_CLIENT=mssql: se omite la inicialización exclusiva de SQLite '
      + `(migraciones, seed y directorio).`,
    );
    log(
      '[ticket] AVISO: el soporte de SQL Server está en MIGRACIÓN PROGRESIVA. Arranca y responde, '
      + 'pero las rutas, el seed, el directorio y el mantenimiento que aún usen la API legacy de '
      + 'SQLite fallarán de forma explícita al ejecutarse.',
    );
    return SQLITE_BOOTSTRAP_STEPS.slice();
  }

  runMigrations();
  seed();
  restoreDirectorySnapshot();
  return [];
}

/**
 * El mantenimiento programado sigue siendo SQLite puro (`tickets`,
 * `notifications`, `settings`), y `startJobs()` ejecuta una pasada inmediata al
 * arrancar. Con otro motor esa pasada consultaría `db.prepare` en el arranque y
 * además repetiría el error cada 10 minutos. Se desactiva aquí; migrarlo es
 * trabajo posterior.
 */
export function startBackgroundJobs({ dbClient, startJobs, log = console.log }) {
  if (!usesSqliteBootstrap(dbClient)) {
    log(
      '[ticket] DB_CLIENT=mssql: mantenimiento programado desactivado porque todavía consulta '
      + 'tickets/notifications/settings con la API legacy de SQLite.',
    );
    return false;
  }

  startJobs();
  return true;
}
