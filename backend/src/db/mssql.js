import sql from 'mssql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeDateParameter, normalizeDateRow } from './datetime.js';

const transactionContext = new AsyncLocalStorage();

export function isDevelopmentDatabase(database) {
  return /(^|[_-])(dev|test)([_-]|$)/i.test(String(database || '').trim());
}

function parameterName(key) {
  const name = String(key).replace(/^[:@]/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`Nombre de parámetro SQL Server no válido: "${key}".`);
  }
  return name;
}

function bind(request, params) {
  if (params === undefined || params === null) return request;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Los parámetros deben ser un objeto con pares nombre → valor.');
  }
  for (const [key, value] of Object.entries(params)) {
    const name = parameterName(key);
    if (value === undefined) throw new TypeError(`Parámetro "${name}" es undefined. Usa null para NULL.`);
    request.input(name, normalizeDateParameter(value, `@${name}`));
  }
  return request;
}

function affected(result) {
  return (result.rowsAffected || []).reduce((total, count) => total + Number(count || 0), 0);
}

function requireInsertedId(result) {
  const id = result.recordset?.[0]?.id;
  if (!Number.isSafeInteger(Number(id))) {
    throw new Error('insertAndGetId requiere `OUTPUT INSERTED.id AS id` y un id numérico seguro.');
  }
  return Number(id);
}

// Creating this contract never opens a network connection. The first query or
// transaction opens the configured pool, making imports safe in M1 tests.
export function createMssqlContract(config, {
  connect = (options) => sql.connect(options),
  Transaction = sql.Transaction,
  Request = sql.Request,
} = {}) {
  let poolPromise;
  let closingPromise;
  let activeOperations = 0;
  let idleWaiters = [];

  function notifyIdle() {
    if (activeOperations !== 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitForIdle() {
    if (activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  async function withActiveOperation(callback) {
    if (closingPromise) {
      throw new Error('El pool MSSQL se está cerrando; no se pueden iniciar operaciones.');
    }
    activeOperations += 1;
    try {
      return await callback();
    } finally {
      activeOperations -= 1;
      notifyIdle();
    }
  }

  async function pool() {
    if (!poolPromise) {
      poolPromise = Promise.resolve(connect(config)).catch((error) => {
        poolPromise = undefined;
        throw error;
      });
    }
    return poolPromise;
  }

  function operations(makeRequest, { trackOperation = false } = {}) {
    const run = (callback) => (trackOperation ? withActiveOperation(callback) : callback());
    return {
      async queryOne(statement, params) {
        return run(async () => {
          const result = await bind(await makeRequest(), params).query(statement);
          return normalizeDateRow(result.recordset?.[0] ?? null);
        });
      },
      async queryMany(statement, params) {
        return run(async () => {
          const result = await bind(await makeRequest(), params).query(statement);
          return (result.recordset ?? []).map(normalizeDateRow);
        });
      },
      async execute(statement, params) {
        return run(async () => {
          const result = await bind(await makeRequest(), params).query(statement);
          return { rowsAffected: affected(result) };
        });
      },
      async insertAndGetId(statement, params) {
        return run(async () => {
          const result = await bind(await makeRequest(), params).query(statement);
          return { id: requireInsertedId(result), rowsAffected: affected(result) };
        });
      },
    };
  }

  async function transactionAsync(callback) {
    if (typeof callback !== 'function') throw new TypeError('transactionAsync necesita un callback.');
    if (transactionContext.getStore()) throw new Error('No se permiten transacciones anidadas; reutilice el tx recibido.');
    return withActiveOperation(async () => {
      let transaction;
      let began = false;
      let commitAttempted = false;
      let failure;
      let value;
      try {
        transaction = new Transaction(await pool());
        await transaction.begin();
        began = true;
        value = await transactionContext.run({ engine: 'mssql' }, () => callback(operations(() => new Request(transaction))));
        commitAttempted = true;
        await transaction.commit();
      } catch (error) {
        failure = error;
        if (began && !commitAttempted) {
          try { await transaction.rollback(); } catch (rollbackError) {
            if (failure && typeof failure === 'object') failure.rollbackError = rollbackError;
          }
        }
      } finally {
      }
      if (failure) throw failure;
      return value;
    });
  }

  async function close() {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      await waitForIdle();
      const activePoolPromise = poolPromise;
      if (!activePoolPromise) return;
      poolPromise = undefined;
      await (await activePoolPromise).close();
    })();
    try {
      return await closingPromise;
    } finally {
      closingPromise = undefined;
    }
  }

  const shared = operations(async () => (await pool()).request(), { trackOperation: true });
  return { ...shared, transactionAsync, close };
}
