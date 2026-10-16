// Orquestación del arranque sobre SQL Server (único motor).
//
// La base ya contiene los datos migrados. NO se aplican migraciones, NO se
// ejecuta el seed, NO se restaura ninguna instantánea del directorio y NO se
// aplica DDL. Solo se valida de forma NO destructiva (SELECT sobre catálogo del
// sistema) que el esquema requerido existe y es compatible. Si la validación
// falla, se lanza un error claro y el servidor HTTP nunca llega a iniciarse.
//
// SQLite se ha eliminado del runtime: los archivos históricos del migrador se
// conservan aparte, como referencia.

import config from './config.js';
import { createApp } from './app.js';
import { startJobs } from './utils/jobs.js';
import { getRuntime } from './db/runtime.js';
import { validateMssqlSchema, describeSchemaFailures } from './db/mssql/schemaValidator.js';

/**
 * Prepara la base de datos: valida el esquema de SQL Server (solo lectura).
 *
 * @param {object} [options]
 * @param {object} [options.runtime] Fachada de runtime (inyectable en pruebas).
 * @param {object} [options.logger] Consola (inyectable en pruebas).
 * @returns {Promise<{ engine: 'mssql', migrated: false, seeded: false, snapshot: false, schema: object }>}
 */
export async function prepareDatabase({
  runtime = getRuntime(),
  logger = console,
} = {}) {
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

/**
 * Arranca la aplicación: primero valida la base y solo después crea la app,
 * lanza las tareas de mantenimiento y abre el puerto. Un fallo en la validación
 * impide cualquier inicio del servidor HTTP.
 *
 * @param {object} [options] Dependencias inyectables para pruebas.
 * @returns {Promise<{ app: object, server: object, database: object }>}
 */
export async function startServer({
  runtime = getRuntime(),
  logger = console,
  createAppFn = createApp,
  startJobsFn = startJobs,
  listenFn,
} = {}) {
  const database = await prepareDatabase({ runtime, logger });

  const app = createAppFn();
  startJobsFn();

  const listen = listenFn || ((application, port, callback) => application.listen(port, callback));
  const server = await listen(app, config.port, () => {
    logger.log(`[ticket] API escuchando en http://localhost:${config.port} (${config.env})`);
    logger.log(`[ticket] Motor: SQL Server`);
    logger.log(`[ticket] Base de datos: ${process.env.DB_DATABASE}`);
    logger.log(`[ticket] Uploads: ${config.uploadDir}`);
  });

  return { app, server, database };
}
