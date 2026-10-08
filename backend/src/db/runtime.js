// Fachada única de ejecución SQL de la aplicación. El resto del código no
// habla con node:sqlite ni con mssql directamente, sino con este módulo, que:
//
//   - elige el motor según config.dbClient (DB_CLIENT=sqlite|mssql);
//   - traduce cada sentencia al dialecto del motor (src/db/dialect.js para SQL
//     Server; sin traducción para SQLite);
//   - normaliza parámetros y filas para que ambos motores se comporten igual
//     (booleano → 0/1, fechas → ISO sin sufijo Z en SQL Server, bigint → number);
//   - encamina dentro de db.transaction() las consultas hechas por el callback
//     a la conexión o a la transacción activas mediante AsyncLocalStorage.
//
// Todas las operaciones devuelven promesas: nunca se finge sincronía. La
// fachada por defecto se construye perezosamente en la primera consulta, así
// que importar este módulo no abre ninguna conexión de SQL Server.

import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config.js';
import legacyDb from '../db.js';
import { createSqliteDatabase } from './sqlite.js';
import { createMssqlContract } from './mssql.js';
import { placeholderCount, toTsql } from './dialect.js';

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

function assertPositional(values) {
  if (values.length !== 1) return;
  const [value] = values;
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  throw new TypeError(
    'Los parámetros van posicionales: queryOne(sql, a, b). No se admite un objeto con nombres.',
  );
}

function assertPlaceholderCount(statement, values) {
  const expected = placeholderCount(statement);
  if (expected !== values.length) {
    throw new TypeError(
      `La sentencia tiene ${expected} parámetro(s) "?" pero se enviaron ${values.length}: ${statement.slice(0, 80).replace(/\s+/g, ' ')}`,
    );
  }
}

function sqliteValue(value, index) {
  if (value === undefined) {
    throw new TypeError(`El parámetro #${index + 1} es undefined. Usa null para NULL.`);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// SQL Server rechaza el sufijo Z en DATETIME2: la fecha canónica aquí es ISO
// de hasta milisegundos sin zona.
function stripZone(iso) {
  const withoutZone = iso.endsWith('Z') ? iso.slice(0, -1) : iso;
  return withoutZone.length > 23 ? withoutZone.slice(0, 23) : withoutZone;
}

function mssqlValue(value, index) {
  if (value === undefined) {
    throw new TypeError(`El parámetro #${index + 1} es undefined. Usa null para NULL.`);
  }
  if (value instanceof Date) return stripZone(value.toISOString());
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && ISO_PREFIX.test(value) && value.endsWith('Z')) {
    return stripZone(value);
  }
  return value;
}

// SQLite devuelve enteros y SQL Server devuelve booleanos para BIT: aquí ambas
// bases terminan devolviendo 0/1, que es lo que el código de la aplicación
// espera desde siempre.
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'boolean') normalized[key] = value ? 1 : 0;
    else if (typeof value === 'bigint') {
      normalized[key] = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    } else normalized[key] = value;
  }
  return normalized;
}

function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

export function createRuntime({
  engine,
  connection,
  openConnection,
  contract,
  translate = toTsql,
} = {}) {
  if (engine !== 'sqlite' && engine !== 'mssql') {
    throw new Error(`Motor de ejecución no soportado: "${engine}". Use "sqlite" o "mssql".`);
  }
  if (engine === 'sqlite') {
    if (!connection || typeof connection.prepare !== 'function') {
      throw new TypeError('createRuntime(sqlite) necesita la conexión de node:sqlite.');
    }
    if (typeof openConnection !== 'function') {
      throw new TypeError('createRuntime(sqlite) necesita openConnection() para transacciones.');
    }
  }
  if (engine === 'mssql') {
    for (const method of ['queryOne', 'queryMany', 'execute', 'insertAndGetId', 'transactionAsync']) {
      if (!contract || typeof contract[method] !== 'function') {
        throw new TypeError(`createRuntime(mssql) necesita el contrato con ${method}().`);
      }
    }
  }

  const txContext = new AsyncLocalStorage();

  function activeTarget() {
    const store = txContext.getStore();
    if (engine === 'sqlite') return store?.connection ?? connection;
    return store?.contract ?? contract;
  }

  function sqliteParams(statement, values) {
    assertPositional(values);
    assertPlaceholderCount(statement, values);
    return values.map((value, index) => sqliteValue(value, index));
  }

  function mssqlParams(statement, values) {
    assertPositional(values);
    assertPlaceholderCount(statement, values);
    const params = {};
    values.forEach((value, index) => {
      params[`p${index}`] = mssqlValue(value, index);
    });
    return params;
  }

  async function queryOne(statement, ...values) {
    if (engine === 'sqlite') {
      const target = activeTarget();
      const params = sqliteParams(statement, values);
      return normalizeRow(target.prepare(statement).get(...params) ?? null);
    }
    const target = activeTarget();
    return normalizeRow(await target.queryOne(translate(statement), mssqlParams(statement, values)));
  }

  async function queryMany(statement, ...values) {
    if (engine === 'sqlite') {
      const target = activeTarget();
      const params = sqliteParams(statement, values);
      return normalizeRows(target.prepare(statement).all(...params) ?? []);
    }
    const target = activeTarget();
    return normalizeRows(await target.queryMany(translate(statement), mssqlParams(statement, values)));
  }

  async function execute(statement, ...values) {
    if (engine === 'sqlite') {
      const target = activeTarget();
      const params = sqliteParams(statement, values);
      const result = target.prepare(statement).run(...params);
      return { rowsAffected: Number(result.changes) };
    }
    const target = activeTarget();
    return target.execute(translate(statement), mssqlParams(statement, values));
  }

  async function insertAndGetId(statement, ...values) {
    if (engine === 'sqlite') {
      const target = activeTarget();
      const params = sqliteParams(statement, values);
      const result = target.prepare(statement).run(...params);
      return { id: Number(result.lastInsertRowid), rowsAffected: Number(result.changes) };
    }
    const target = activeTarget();
    return target.insertAndGetId(translate(statement, { insertId: true }), mssqlParams(statement, values));
  }

  // SQLite usa una segunda conexión (BEGIN IMMEDIATE) para que las consultas
  // concurrentes de otras peticiones no se mezclen dentro de la transacción
  // mientras el callback espera. SQL Server delega en el contrato del pool.
  async function transaction(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('transaction necesita un callback.');
    }
    if (txContext.getStore()) {
      throw new Error('No se permiten transacciones anidadas; reutilice el tx recibido.');
    }
    if (engine === 'sqlite') {
      const txConnection = openConnection();
      let began = false;
      let committed = false;
      try {
        txConnection.exec('BEGIN IMMEDIATE');
        began = true;
        const value = await txContext.run({ connection: txConnection }, () => callback(api));
        txConnection.exec('COMMIT');
        committed = true;
        return value;
      } catch (error) {
        if (began && !committed) {
          try {
            txConnection.exec('ROLLBACK');
          } catch {
            // La conexión se cierra a continuación; el error original manda.
          }
        }
        throw error;
      } finally {
        txConnection.close();
      }
    }
    return contract.transactionAsync((txContract) =>
      txContext.run({ contract: txContract }, () => callback(api)),
    );
  }

  async function close() {
    if (engine === 'mssql' && typeof contract.close === 'function') await contract.close();
  }

  const api = { engine, queryOne, queryMany, execute, insertAndGetId, transaction, close };
  return api;
}

let defaultRuntime;

function createDefaultRuntime() {
  if (config.dbClient === 'mssql') {
    return createRuntime({ engine: 'mssql', contract: createMssqlContract(config.mssql) });
  }
  return createRuntime({
    engine: 'sqlite',
    connection: legacyDb,
    openConnection: () => createSqliteDatabase(config.dbFile),
  });
}

export function getRuntime() {
  if (!defaultRuntime) defaultRuntime = createDefaultRuntime();
  return defaultRuntime;
}

export function currentEngine() {
  return getRuntime().engine;
}

// Interfaz que usan las rutas: import db from '../db/runtime.js' y las mismas
// queryOne/queryMany/execute/insertAndGetId/transaction de siempre.
const facade = {
  queryOne: (...args) => getRuntime().queryOne(...args),
  queryMany: (...args) => getRuntime().queryMany(...args),
  execute: (...args) => getRuntime().execute(...args),
  insertAndGetId: (...args) => getRuntime().insertAndGetId(...args),
  transaction: (callback) => getRuntime().transaction(callback),
  async close() {
    if (defaultRuntime) await defaultRuntime.close();
  },
};

export default facade;
