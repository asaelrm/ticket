import { DatabaseSync } from 'node:sqlite';

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
// `transactionAsync` NO existe todavía en A2, y es deliberado. Ver el bloque
// `TRANSACCIONES` más abajo.
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
export function createSqliteContract(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createSqliteContract necesita una conexión SQLite (DatabaseSync).');
  }

  return {
    /**
     * Una fila o null.
     *
     * node:sqlite devuelve `undefined` cuando no hay resultado; el contrato
     * normaliza a `null` porque es lo que devuelve `mssql` y lo que se puede
     * comprobar con `=== null` sin conocer el driver.
     */
    async queryOne(sql, params) {
      const fila = db.prepare(sql).get(normalizeParams(params)) ?? null;
      return fila;
    },

    /**
     * Todas las filas; array vacío si no hay ninguna (nunca null ni undefined).
     */
    async queryMany(sql, params) {
      return db.prepare(sql).all(normalizeParams(params)) ?? [];
    },

    /**
     * INSERT / UPDATE / DELETE. Devuelve solo el número de filas afectadas:
     * `lastInsertRowid` no sale de aquí porque es un detalle de SQLite y no
     * existe en otros motores.
     */
    async execute(sql, params) {
      const info = db.prepare(sql).run(normalizeParams(params));
      return { rowsAffected: Number(info.changes) };
    },

    /**
     * INSERT que devuelve el id generado, normalizado.
     */
    async insertAndGetId(sql, params) {
      const info = db.prepare(sql).run(normalizeParams(params));
      return {
        id: Number(info.lastInsertRowid),
        rowsAffected: Number(info.changes),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// TRANSACCIONES (decisión de A2: NO implementar)
//
// La interfaz prevista para A3 es:
//
//   const client = await db.transactionAsync();
//   try {
//     await client.queryOne(sql, params);
//     await client.execute(sql, params);
//     await client.commit();
//   } catch (err) {
//     await client.rollback();
//     throw err;
//   }
//
// O, si se prefiere una forma con callback, el mismo objeto `client` se pasa al
// callback. Lo que NO se hará es `transactionAsync(fn)` que abre y cierra la
// transacción alrededor de un `await fn()`, por dos razones concretas:
//
// 1. `DatabaseSync` es UNA conexión síncrona. Si el callback hace `await`, el
//    control vuelve al bucle de eventos y cualquier otra operación que se cuele
//    entremedias se ejecutaría DENTRO de esa transacción. SQLite no tiene
//    transacciones anidadas (`cannot start a transaction within a transaction`),
//    así que la segunda parte secome a la primera y el resultado no es el que
//    el llamador cree. Con `mssql` esto no pasa porque la transacción va atada a
//    una conexión reservada, no a un singleton.
//
// 2. En `mssql` la transacción no se abre con `BEGIN`: se crea un objeto
//    `Transaction` sobre una conexión del pool y TODAS las consultas de esa
//    transacción tienen que pasar por esa conexión. Un `transactionAsync(fn)`
//    que esconde la conexión por dentro obligaría en A4 a cambiar la firma.
//
// Implementar ahora una versión con `BEGIN/COMMIT` sobre la conexión compartida
// daría una falsa seguridad: los tests en verde sobre un único flujo, y un
// `SQLITE_BUSY` o una escritura ajena colándose en la transacción en producción.
// Se prefiere no tener esa abstracción antes que tenerla rota.
//
// En A2 el contrato verificable son las cuatro operaciones. La transacción async
// se define en A3, con una implementación real de pool detrás.
// ---------------------------------------------------------------------------

/**
 * Mantiene la configuración SQLite actual aislada de la fachada pública de
 * db.js. En A1 SQLite es el único proveedor real y esta función devuelve la
 * misma API DatabaseSync que ya consumen las rutas.
 */
export function createSqliteDatabase(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
