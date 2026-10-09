// Fixture de arranque por motor. Se ejecuta como proceso hijo
// (`node startup-mssql.mjs`) con DB_CLIENT/MSSQL_RUNTIME ya fijados.
//
// - En modo MSSQL construye un CONTRATO FALSO en memoria (sin conexión real) a
//   partir del esquema requerido, con la mutación indicada en
//   STARTUP_TEST_MUTATION, y ejecuta el MISMO startServer() que usa server.js
//   con ese runtime inyectado.
// - En modo SQLite usa el arranque real (migra, siembra y restaura la
//   instantánea del directorio).
//
// El listen se sustituye por un espía para no abrir un puerto. Se reporta si el
// archivo SQLite apareció, si hubo escrituras en el contrato falso, si la
// instantánea del directorio se aplicó y, si algo falló, el mensaje de error.
import fs from 'node:fs';
import config from '../../src/config.js';
import { createRuntime } from '../../src/db/runtime.js';
import { requiredSchema } from '../../src/db/mssql/schemaValidator.js';
import { catalogFromSchema, fakeContract } from './mssql-catalog.mjs';
import { startServer } from '../../src/startup.js';

const engine = config.dbClient;
const mutation = process.env.STARTUP_TEST_MUTATION
  ? JSON.parse(process.env.STARTUP_TEST_MUTATION)
  : {};

const stats = { writes: 0 };
const listenCalls = [];
let error = null;
let snapshotApplied = null;

try {
  let runtime;
  if (engine === 'mssql') {
    const catalog = catalogFromSchema(requiredSchema(), mutation);
    runtime = createRuntime({ engine: 'mssql', contract: fakeContract(catalog, stats) });
  } else {
    runtime = (await import('../../src/db/runtime.js')).default;
  }

  const result = await startServer({
    runtime,
    logger: { log() {}, warn() {}, error() {} },
    listenFn: async (app, port) => {
      listenCalls.push(port);
      return { close() {} };
    },
  });
  snapshotApplied = result.database.snapshot;
} catch (err) {
  error = String(err && err.message ? err.message : err);
}

console.log(JSON.stringify({
  engine,
  dbFile: config.dbFile,
  dbFileExists: fs.existsSync(config.dbFile),
  listenCalls,
  writes: stats.writes,
  snapshotApplied,
  error,
}));
