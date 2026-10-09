// Orquestación del arranque, separada por motor para que los dos caminos no se
// pisen:
//
//   - SQLite: comportamiento de siempre. Se importan db.js y seed.js (solo en
//     esta rama, para no abrir/crear el archivo SQLite en modo MSSQL), se
//     aplican las migraciones, se ejecuta el seed y se restaura la instantánea
//     del directorio.
//   - MSSQL: la base ya contiene los datos migrados. NO se importa db.js ni
//     seed.js, NO se aplican migraciones, NO se ejecuta el seed, NO se restaura
//     ninguna instantánea y NO se aplica schema.sql. Solo se valida de forma no
//     destructiva (SELECT sobre catálogo del sistema) que el esquema requerido
//     existe y es compatible. Si la validación falla, se lanza un error claro y
//     el servidor HTTP nunca llega a iniciarse.
//
// Los imports de las dependencias SQLite son DINÁMICOS y viven dentro de la
// rama SQLite: así, en modo MSSQL, el import de este módulo no evalúa db.js (que
// abre el archivo SQLite al cargarse).

import config from './config.js';
import { createApp } from './app.js';
import { startJobs } from './utils/jobs.js';
import { getRuntime } from './db/runtime.js';
import { validateMssqlSchema, describeSchemaFailures } from './db/mssql/schemaValidator.js';

/**
 * Prepara la base de datos según el motor efectivo.
 *
 * @param {object} [options]
 * @param {'sqlite'|'mssql'} [options.dbClient] Motor efectivo (config.dbClient).
 * @param {object} [options.runtime] Fachada de runtime (inyectable en pruebas).
 * @param {object} [options.logger] Consola (inyectable en pruebas).
 * @returns {Promise<{ engine: string, migrated: boolean, seeded: boolean, snapshot: boolean, schema?: object }>}
 */
export async function prepareDatabase({
  dbClient = config.dbClient,
  runtime = getRuntime(),
  logger = console,
} = {}) {
  if (dbClient === 'mssql') {
    const schema = await validateMssqlSchema(runtime);
    if (!schema.ok) {
      throw new Error(describeSchemaFailures(schema));
    }
    logger.log(
      '[db] Esquema SQL Server verificado (solo lectura): '
        + `${schema.counts.tables} tablas y ${schema.counts.requiredColumns} columnas. `
        + 'No se ejecutan migraciones ni seed.',
    );
    return { engine: 'mssql', migrated: false, seeded: false, snapshot: false, schema };
  }

  const { runMigrations } = await import('./db.js');
  const { seed } = await import('./seed.js');
  const { restoreDirectorySnapshot } = await import('./directorySync.js');

  runMigrations();
  seed();
  const snapshot = await restoreDirectorySnapshot();

  return { engine: 'sqlite', migrated: true, seeded: true, snapshot: snapshot.applied === true };
}

/**
 * Arranca la aplicación: primero prepara/valida la base y solo después crea la
 * app, lanza las tareas de mantenimiento y abre el puerto. Un fallo en la
 * validación (MSSQL) impide cualquier inicio del servidor HTTP.
 *
 * @param {object} [options] Dependencias inyectables para pruebas.
 * @returns {Promise<{ app: object, server: object, database: object }>}
 */
export async function startServer({
  dbClient = config.dbClient,
  runtime = getRuntime(),
  logger = console,
  createAppFn = createApp,
  startJobsFn = startJobs,
  listenFn,
} = {}) {
  const database = await prepareDatabase({ dbClient, runtime, logger });

  const app = createAppFn();
  startJobsFn();

  const listen = listenFn || ((application, port, callback) => application.listen(port, callback));
  const server = await listen(app, config.port, () => {
    logger.log(`[ticket] API escuchando en http://localhost:${config.port} (${config.env})`);
    logger.log(`[ticket] Base de datos: ${config.dbFile}`);
    logger.log(`[ticket] Uploads: ${config.uploadDir}`);
  });

  return { app, server, database };
}
