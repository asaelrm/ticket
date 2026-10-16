// Fachada única de ejecución SQL de la aplicación sobre SQL Server. El resto
// del código no habla con `mssql` directamente, sino con este módulo, que:
//
//   - traduce cada sentencia al dialecto T-SQL (src/db/dialect.js). Las
//     consultas se siguen escribiendo en dialecto SQLite y el traductor se
//     conserva temporalmente para no reescribir todo el repositorio;
//   - normaliza parámetros y filas (booleano → 0/1, fechas → ISO sin sufijo Z
//     en SQL Server, bigint → number) para que la aplicación reciba siempre la
//     misma forma;
//   - encamina dentro de db.transaction() las consultas hechas por el callback
//     a la transacción activa mediante AsyncLocalStorage.
//
// Todas las operaciones devuelven promesas. La fachada por defecto se construye
// perezosamente en la primera consulta, así que importar este módulo no abre
// ninguna conexión de SQL Server.
//
// SQLite se ha eliminado del runtime: SQL Server es el único motor. Los archivos
// históricos del migrador SQLite → MSSQL se conservan aparte, como referencia.

import { AsyncLocalStorage } from 'node:async_hooks';
import config from '../config.js';
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

// SQL Server devuelve booleanos para BIT: aquí terminan como 0/1, que es lo que
// el código de la aplicación espera.
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
  engine = 'mssql',
  contract,
  translate = toTsql,
} = {}) {
  if (engine !== 'mssql') {
    throw new Error(`Motor de ejecución no soportado: "${engine}". SQL Server es el único motor.`);
  }
  for (const method of ['queryOne', 'queryMany', 'execute', 'insertAndGetId', 'transactionAsync']) {
    if (!contract || typeof contract[method] !== 'function') {
      throw new TypeError(`createRuntime(mssql) necesita el contrato con ${method}().`);
    }
  }

  const txContext = new AsyncLocalStorage();

  function activeTarget() {
    return txContext.getStore()?.contract ?? contract;
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
    const target = activeTarget();
    return normalizeRow(await target.queryOne(translate(statement), mssqlParams(statement, values)));
  }

  async function queryMany(statement, ...values) {
    const target = activeTarget();
    return normalizeRows(await target.queryMany(translate(statement), mssqlParams(statement, values)));
  }

  async function execute(statement, ...values) {
    const target = activeTarget();
    return target.execute(translate(statement), mssqlParams(statement, values));
  }

  async function insertAndGetId(statement, ...values) {
    const target = activeTarget();
    return target.insertAndGetId(translate(statement, { insertId: true }), mssqlParams(statement, values));
  }

  // SQL Server delega en el contrato del pool.
  async function transaction(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('transaction necesita un callback.');
    }
    if (txContext.getStore()) {
      throw new Error('No se permiten transacciones anidadas; reutilice el tx recibido.');
    }
    return contract.transactionAsync((txContract) =>
      txContext.run({ contract: txContract }, () => callback(api)),
    );
  }

  async function close() {
    if (typeof contract.close === 'function') await contract.close();
  }

  const api = { engine, queryOne, queryMany, execute, insertAndGetId, transaction, close };
  return api;
}

let defaultRuntime;

function createDefaultRuntime() {
  return createRuntime({ engine: 'mssql', contract: createMssqlContract(config.mssql) });
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
