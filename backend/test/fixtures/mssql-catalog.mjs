// Utilidades compartidas por las pruebas de arranque MSSQL: construyen un
// catálogo falso de SQL Server a partir del esquema requerido y un contrato
// falso que NUNCA se conecta. Se pueden aplicar mutaciones para simular un
// destino incompatible (sin tocar ninguna base real).

/**
 * Convierte el esquema requerido (Map) en filas equivalentes a las que
 * devolverían sys.tables / sys.columns / sys.objects.
 *
 * @param {Map} schema Esquema requerido (parseMssqlSchema/requiredSchema).
 * @param {object} [mutation] Mutación para simular incompatibilidades:
 *   dropTable, addTable, dropColumn ('tabla.columna'), addColumn,
 *   dropConstraint ('tabla.NOMBRE'), addConstraint,
 *   forceNullable / forceNotNull ('tabla.columna'), dropIdentity (tabla), empty.
 */
export function catalogFromSchema(schema, mutation = {}) {
  const tables = [];
  const columns = [];
  const constraints = [];
  if (mutation.empty) return { tables, columns, constraints };

  for (const [table, definition] of schema) {
    if (mutation.dropTable === table) continue;
    tables.push({ table_name: table });

    for (const [column, spec] of definition.columns) {
      if (mutation.dropColumn === `${table}.${column}`) continue;
      let notNull = spec.notNull;
      if (mutation.forceNullable === `${table}.${column}`) notNull = false;
      if (mutation.forceNotNull === `${table}.${column}`) notNull = true;
      let identity = spec.identity;
      if (mutation.dropIdentity === table) identity = false;
      columns.push({
        table_name: table,
        column_name: column,
        is_nullable: notNull ? 0 : 1,
        is_identity: identity ? 1 : 0,
      });
    }

    for (const constraint of definition.constraints) {
      if (mutation.dropConstraint === `${table}.${constraint}`) continue;
      constraints.push({ table_name: table, constraint_name: constraint });
    }

    if (mutation.addColumn && mutation.addColumn.startsWith(`${table}.`)) {
      columns.push({
        table_name: table,
        column_name: mutation.addColumn.slice(table.length + 1),
        is_nullable: 1,
        is_identity: 0,
      });
    }
    if (mutation.addConstraint && mutation.addConstraint.startsWith(`${table}.`)) {
      constraints.push({
        table_name: table,
        constraint_name: mutation.addConstraint.slice(table.length + 1),
      });
    }
  }

  if (mutation.addTable) tables.push({ table_name: mutation.addTable });

  return { tables, columns, constraints };
}

/**
 * Contrato MSSQL falso que responde al catálogo y contabiliza cualquier intento
 * de escritura (execute/insertAndGetId/transactionAsync). Ninguna apertura de
 * conexión real: es un objeto en memoria.
 */
export function fakeContract(catalog, stats = { writes: 0 }) {
  const contract = {
    async queryOne() {
      return null;
    },
    async queryMany(statement) {
      if (/sys\.columns/i.test(statement)) return catalog.columns;
      if (/sys\.objects/i.test(statement)) return catalog.constraints;
      return catalog.tables;
    },
    async execute() {
      stats.writes += 1;
      return { rowsAffected: 0 };
    },
    async insertAndGetId() {
      stats.writes += 1;
      return { id: 0, rowsAffected: 0 };
    },
    async transactionAsync(callback) {
      stats.writes += 1;
      return callback(contract);
    },
    async close() {},
  };
  return contract;
}
