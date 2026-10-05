import sql from 'mssql';

// Las integraciones automáticas solo pueden escribir en una base que se
// identifique de forma inequívoca como no productiva. Un guion bajo forma parte
// de una palabra para `\b`, por eso se comprueban expresamente los separadores.
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
    if (value === undefined) {
      throw new TypeError(`Parámetro "${name}" es undefined. Usa null para un valor NULL.`);
    }
    request.input(name, value);
  }
  return request;
}

function affected(result) {
  return (result.rowsAffected || []).reduce((total, count) => total + Number(count || 0), 0);
}

/**
 * Contrato async para SQL Server. El SQL se entrega intacto: usa placeholders
 * nativos `@nombre`; no existe conversión de `:nombre` porque hacerlo bien
 * requeriría un parser SQL y una sustitución textual sería insegura.
 *
 * @param {object} config Configuración compatible con `mssql.ConnectionPool`.
 * @param {{ connect?: Function }} dependencies Inyección para pruebas unitarias.
 */
export function createMssqlContract(config, { connect = (options) => sql.connect(options) } = {}) {
  let poolPromise;

  async function pool() {
    if (!poolPromise) {
      poolPromise = Promise.resolve(connect(config)).catch((error) => {
        poolPromise = undefined;
        throw error;
      });
    }
    return poolPromise;
  }

  async function request(params) {
    return bind((await pool()).request(), params);
  }

  return {
    async queryOne(statement, params) {
      const result = await (await request(params)).query(statement);
      return result.recordset?.[0] ?? null;
    },

    async queryMany(statement, params) {
      const result = await (await request(params)).query(statement);
      return result.recordset ?? [];
    },

    async execute(statement, params) {
      const result = await (await request(params)).query(statement);
      return { rowsAffected: affected(result) };
    },

    async insertAndGetId(statement, params) {
      const result = await (await request(params)).query(statement);
      const id = result.recordset?.[0]?.id;
      if (!Number.isSafeInteger(Number(id))) {
        throw new Error('insertAndGetId requiere `OUTPUT INSERTED.id AS id` y un id numérico seguro.');
      }
      return { id: Number(id), rowsAffected: affected(result) };
    },
  };
}

// B3: `transactionAsync(async (tx) => ...)` creará un `sql.Transaction` sobre
// el pool y cada operación de `tx` construirá `new sql.Request(transaction)`.
// Así queryOne/queryMany/execute/insertAndGetId quedan atadas a la misma
// conexión reservada hasta commit o rollback. SQLite no puede ofrecer esa misma
// forma sobre su DatabaseSync compartido: requerirá serializar la sección
// completa y prohibir awaits externos antes de exponer una API equivalente.
