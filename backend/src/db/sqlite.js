import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeDateParameter } from './datetime.js';

const transactionContext = new AsyncLocalStorage();

function configureDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function normalizeParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Los parámetros deben ser un objeto con pares nombre → valor.');
  }
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    const name = key.replace(/^:/, '');
    if (value === undefined) throw new TypeError(`Parámetro ":${name}" es undefined. Usa null para NULL.`);
    result[name] = typeof value === 'boolean' ? Number(value) : normalizeDateParameter(value, `:${name}`);
  }
  return result;
}

function operations(db) {
  return {
    async queryOne(statement, params) {
      return db.prepare(statement).get(normalizeParams(params)) ?? null;
    },
    async queryMany(statement, params) {
      return db.prepare(statement).all(normalizeParams(params)) ?? [];
    },
    async execute(statement, params) {
      const result = db.prepare(statement).run(normalizeParams(params));
      return { rowsAffected: Number(result.changes) };
    },
    async insertAndGetId(statement, params) {
      const result = db.prepare(statement).run(normalizeParams(params));
      return { id: Number(result.lastInsertRowid), rowsAffected: Number(result.changes) };
    },
  };
}

// This is not wired into db.js in M1. It is a compatibility contract for a
// future incremental route migration while legacy DatabaseSync stays active.
export function createSqliteContract(db, { databasePath, openDatabase = (file) => new DatabaseSync(file) } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createSqliteContract necesita DatabaseSync.');

  async function transactionAsync(callback) {
    if (typeof callback !== 'function') throw new TypeError('transactionAsync necesita un callback.');
    if (transactionContext.getStore()) throw new Error('No se permiten transacciones anidadas; reutilice el tx recibido.');
    if (!databasePath) throw new Error('transactionAsync SQLite necesita la ruta del archivo de base de datos.');
    const txDb = configureDatabase(openDatabase(databasePath));
    let began = false;
    let committed = false;
    try {
      txDb.exec('BEGIN IMMEDIATE');
      began = true;
      const value = await transactionContext.run({ engine: 'sqlite' }, () => callback(operations(txDb)));
      await txDb.exec('COMMIT');
      committed = true;
      return value;
    } catch (error) {
      if (began && !committed) txDb.exec('ROLLBACK');
      throw error;
    } finally {
      txDb.close();
    }
  }

  return { ...operations(db), transactionAsync };
}

export function createSqliteDatabase(dbFile) {
  return configureDatabase(new DatabaseSync(dbFile));
}
