import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

const transactionContext = new AsyncLocalStorage();

function configureDatabase(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// ---------------------------------------------------------------------------
// Adaptador SQLite.
//
// `createSqliteDatabase` es la fachada LEGACY: devuelve el `DatabaseSync` tal cual
// y es lo que consumen hoy `db.js`, las rutas, `seed.js` y las migraciones. A2 no
// la toca: sigue siendo síncrona y sigue siendo la que usan `db.prepare()`.
//
// `createSqliteContract` es el CONTRATO NUEVO (A2). Es un wrapper fino sobre el
// mismo `DatabaseSync`, sin cambiar una sola ruta, pensado para que las rutas
// migren a él más adelante sin reescribirse.
//
// Contrato (async a propósito):
//
//   queryOne(sql, params)       -> Promise<row | null>
//   queryMany(sql, params)      -> Promise<Array>
//   execute(sql, params)        -> Promise<{ rowsAffected }>
//   insertAndGetId(sql, params) -> Promise<{ id, rowsAffected }>
//
// Las cuatro son `async` aunque por debajo sean síncronas. No es un capricho:
// `mssql` es asíncrono de verdad, y una API síncrona obligaría a reescribir cada
// consumidor cuando llegue ese driver. Exponerlas como Promise ahora mantiene el
// contrato idéntico entre los dos motores.
//
// `transactionAsync(callback)` usa una conexión dedicada: las operaciones de
// `tx` nunca comparten la conexión legacy global.
// ---------------------------------------------------------------------------

// Valores que SQLite no acepta tal cual pero que el resto del código produce de
// forma natural. Se convierten aquí, en el borde del driver, y no en cada
// consulta.
//
// `boolean` -> 1 / 0: SQLite no tiene tipo booleano (guarda INTEGER) y `mssql`
// tampoco acepta un `true` pelado, así que normalizar en este punto hace que el
// mismo código funcione en los dos motores.
//
// `undefined` se RECHAZA en vez de convertirse: no es lo mismo "sin valor" que
// "NULL", y convertirlo en silencio escribiría un NULL donde el llamador creía
// que no estaba pasando nada. El error de node (`Provided value cannot be
// bound`) no dice qué parámetro es, así que aquí se dice.
function normalizeValue(value, clave) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value;
  if (value === undefined) {
    throw new TypeError(
      `Parámetro ":${clave}" es undefined. Usa null para un valor NULL.`,
    );
  }
  return value;
}

// node:sqlite acepta las claves con o sin los dos puntos (`{id:1}` y `{':id':1}`
// funcionan), pero mssql acepta únicamente la forma sin prefijo. Normalizar aquí es
// la única manipulación que se hace sobre las claves, y no toca el SQL.
//
// IMPORTANTE: esto NO es un parser de SQL. El texto de la consulta llega intacto
// a `db.prepare()` y los valores viajan por el binding nativo del prepared
// statement, que escapa correctamente comillas, comentarios, JSON y lo que
// contenga el valor. No hay ninguna forma de que un valor de usuario termine
// concatenado en la consulta.
function normalizeParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Los parámetros deben ser un objeto con pares nombre → valor.');
  }
  const salida = {};
  for (const [clave, valor] of Object.entries(params)) {
    const nombre = clave.startsWith(':') ? clave.slice(1) : clave;
    salida[nombre] = normalizeValue(valor, nombre);
  }
  return salida;
}

/**
 * Envoltorio fino de un `DatabaseSync` que expone el contrato de datos.
 *
 * @param {DatabaseSync} db - Conexión SQLite ya configurada (WAL, FK, busy_timeout).
 * @returns {{queryOne: Function, queryMany: Function, execute: Function, insertAndGetId: Function}}
 */
export function createSqliteContract(db, {
  databasePath,
  openDatabase = (file) => new DatabaseSync(file),
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createSqliteContract necesita una conexión SQLite (DatabaseSync).');
  }

  function operations(connection) {
    return {
    /**
     * Una fila o null.
     *
     * node:sqlite devuelve `undefined` cuando no hay resultado; el contrato
     * normaliza a `null` porque es lo que devuelve `mssql` y lo que se puede
     * comprobar con `=== null` sin conocer el driver.
     */
    async queryOne(sql, params) {
      const fila = connection.prepare(sql).get(normalizeParams(params)) ?? null;
      return fila;
    },

    /**
     * Todas las filas; array vacío si no hay ninguna (nunca null ni undefined).
     */
    async queryMany(sql, params) {
      return connection.prepare(sql).all(normalizeParams(params)) ?? [];
    },

    /**
     * INSERT / UPDATE / DELETE. Devuelve solo el número de filas afectadas:
     * `lastInsertRowid` no sale de aquí porque es un detalle de SQLite y no
     * existe en otros motores.
     */
    async execute(sql, params) {
      const info = connection.prepare(sql).run(normalizeParams(params));
      return { rowsAffected: Number(info.changes) };
    },

    /**
     * INSERT que devuelve el id generado, normalizado.
     */
    async insertAndGetId(sql, params) {
      const info = connection.prepare(sql).run(normalizeParams(params));
      return {
        id: Number(info.lastInsertRowid),
        rowsAffected: Number(info.changes),
      };
    },
    };
  }

  async function transactionAsync(callback) {
    if (typeof callback !== 'function') throw new TypeError('transactionAsync necesita un callback.');
    if (transactionContext.getStore()) {
      throw new Error('No se permiten transacciones anidadas; reutilice el tx recibido.');
    }
    if (!databasePath) {
      throw new Error('transactionAsync SQLite necesita la ruta del archivo de base de datos.');
    }

    const transactionDb = openDatabase(databasePath);
    let began = false;
    let commitAttempted = false;
    let failure;
    let value;
    try {
      configureDatabase(transactionDb);
      transactionDb.exec('BEGIN IMMEDIATE');
      began = true;
      value = await transactionContext.run({ engine: 'sqlite' }, () => callback(operations(transactionDb)));
      commitAttempted = true;
      transactionDb.exec('COMMIT');
    } catch (error) {
      failure = error;
      if (began && !commitAttempted) {
        try {
          transactionDb.exec('ROLLBACK');
        } catch (rollbackError) {
          if (failure && typeof failure === 'object') failure.rollbackError = rollbackError;
        }
      }
    }

    try {
      transactionDb.close();
    } catch (closeError) {
      if (failure && typeof failure === 'object') {
        failure.closeError = closeError;
      } else {
        throw closeError;
      }
    }
    if (failure) throw failure;
    return value;
  }

  return { ...operations(db), transactionAsync };
}

// ---------------------------------------------------------------------------
// transactionAsync abre una conexión dedicada al mismo archivo, inicia
// `BEGIN IMMEDIATE` y la cierra tras COMMIT o ROLLBACK. Mantener el callback
// corto evita retener el bloqueo de escritura durante I/O externo.
// ---------------------------------------------------------------------------

/**
 * Mantiene la configuración SQLite actual aislada de la fachada pública de
 * db.js. En A1 SQLite es el único proveedor real y esta función devuelve la
 * misma API DatabaseSync que ya consumen las rutas.
 */
export function createSqliteDatabase(dbFile) {
  return configureDatabase(new DatabaseSync(dbFile));
}
