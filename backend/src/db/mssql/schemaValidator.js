// Validación NO destructiva del esquema SQL Server antes de arrancar.
//
// En modo MSSQL el proceso NUNCA aplica el DDL: la base destino ya contiene los
// datos migrados, así que arrancar significa solo comprobar que el esquema
// instalado ES el que la aplicación espera. Este módulo:
//
//   - deriva el esquema requerido de src/db/mssql/schema.sql (la misma fuente
//     canónica que usa el migrador; test/migrate-schema-parity.test.js pinza esa
//     paridad);
//   - consulta SOLO catálogo del sistema (sys.tables, sys.columns, sys.objects)
//     a través de la fachada de runtime, es decir, únicamente SELECT;
//   - devuelve un resultado con errores/avisos en lugar de lanzar, para que el
//     arranque decida el mensaje y el código de salida.
//
// No abre ninguna conexión al importarse: solo lo hace cuando se le pasa una
// función de consulta y se ejecuta validateMssqlSchema().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// Un bloque de tabla llega hasta el primer "\n);" (todas las tablas del esquema
// cierran así). El cuerpo se analiza línea a línea.
const TABLE_BLOCK = /CREATE TABLE dbo\.(\w+)\s*\(([\s\S]*?)\n\);/g;
// Línea de columna: identificador (con o sin corchetes) seguido de un tipo
// conocido. Las continuaciones de restricción (REFERENCES ..., cláusulas CHECK
// multilínea, etc.) empiezan por otra cosa y se descartan.
const COLUMN_LINE = /^(\[[A-Za-z_]\w*\]|[A-Za-z_]\w*)\s+(?:INT|BIGINT|SMALLINT|TINYINT|NVARCHAR|VARCHAR|BIT|DATETIME2|DATE|TIME|DECIMAL|NUMERIC|FLOAT|REAL|UNIQUEIDENTIFIER|VARBINARY|TEXT|NTEXT)\b/i;
const CONSTRAINT_LINE = /^CONSTRAINT\s+(\w+)\b/i;

// Catálogo del sistema. Todas las sentencias empiezan por SELECT, de modo que
// pasan por el traductor de dialecto sin cambios y NUNCA escriben.
export const TABLES_QUERY = `
  SELECT t.name AS table_name
  FROM sys.tables t
  WHERE t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
`;

export const COLUMNS_QUERY = `
  SELECT t.name AS table_name, c.name AS column_name,
         c.is_nullable AS is_nullable, c.is_identity AS is_identity
  FROM sys.columns c
  JOIN sys.tables t ON t.object_id = c.object_id
  WHERE t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
`;

// PK, UNIQUE, CHECK y DEFAULT son subobjetos con nombre; las FK también. Los
// índices sueltos (CREATE INDEX) NO se piden: no son restricciones y el esquema
// los crea sin nombre de restricción.
export const CONSTRAINTS_QUERY = `
  SELECT t.name AS table_name, o.name AS constraint_name
  FROM sys.objects o
  JOIN sys.tables t ON t.object_id = o.parent_object_id
  WHERE o.type IN ('PK', 'UQ', 'F', 'C', 'D')
    AND t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
`;

/**
 * Deriva el esquema requerido de un texto DDL.
 * @returns {Map<string, { columns: Map<string, { notNull: boolean, identity: boolean }>, constraints: Set<string> }>}
 */
export function parseMssqlSchema(ddl) {
  const tables = new Map();
  let match;
  TABLE_BLOCK.lastIndex = 0;
  while ((match = TABLE_BLOCK.exec(ddl))) {
    const [, name, body] = match;
    const columns = new Map();
    const constraints = new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      const constraint = CONSTRAINT_LINE.exec(line);
      if (constraint) {
        constraints.add(constraint[1]);
        continue;
      }
      const column = COLUMN_LINE.exec(line);
      if (!column) continue;
      columns.set(column[1].replace(/[[\]]/g, ''), {
        notNull: /\bNOT NULL\b/i.test(line),
        identity: /\bIDENTITY\s*\(/i.test(line),
      });
    }
    tables.set(name, { columns, constraints });
  }
  return tables;
}

let cachedSchema;

/** Esquema requerido, cacheado tras la primera lectura de schema.sql. */
export function requiredSchema() {
  if (!cachedSchema) {
    cachedSchema = parseMssqlSchema(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  }
  return cachedSchema;
}

function lowerKey(value) {
  return String(value).toLowerCase();
}

/**
 * Compara el catálogo leído con el esquema requerido.
 *
 * @param {{ queryMany: Function } | Function} query Fachada de runtime o función
 *   `queryMany(statement)`.
 * @param {{ schema?: Map }} [options] Esquema requerido (por defecto schema.sql).
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], counts: object }>}
 */
export async function validateMssqlSchema(query, { schema = requiredSchema() } = {}) {
  const queryMany = typeof query === 'function'
    ? query
    : (statement) => query.queryMany(statement);

  const [tableRows, columnRows, constraintRows] = await Promise.all([
    queryMany(TABLES_QUERY),
    queryMany(COLUMNS_QUERY),
    queryMany(CONSTRAINTS_QUERY),
  ]);

  // Se indexa en minúsculas para no depender de la collation del servidor al
  // comparar identificadores, pero los mensajes conservan el nombre canónico.
  const actualTables = new Map();
  for (const row of tableRows || []) {
    actualTables.set(lowerKey(row.table_name), String(row.table_name));
  }

  const actualColumns = new Map();
  for (const row of columnRows || []) {
    const table = lowerKey(row.table_name);
    if (!actualColumns.has(table)) actualColumns.set(table, new Map());
    actualColumns.get(table).set(lowerKey(row.column_name), {
      name: String(row.column_name),
      notNull: Number(row.is_nullable) === 0,
      identity: Number(row.is_identity) === 1,
    });
  }

  const actualConstraints = new Map();
  for (const row of constraintRows || []) {
    const table = lowerKey(row.table_name);
    if (!actualConstraints.has(table)) actualConstraints.set(table, new Map());
    actualConstraints.get(table).set(lowerKey(row.constraint_name), String(row.constraint_name));
  }

  const errors = [];
  const warnings = [];

  const requiredTables = new Set([...schema.keys()].map(lowerKey));

  for (const [table, definition] of schema) {
    const key = lowerKey(table);
    if (!actualTables.has(key)) {
      errors.push(`falta la tabla dbo.${table}`);
      continue;
    }

    const columns = actualColumns.get(key) || new Map();
    for (const [column, spec] of definition.columns) {
      const actual = columns.get(lowerKey(column));
      if (!actual) {
        errors.push(`falta la columna dbo.${table}.${column}`);
        continue;
      }
      if (actual.notNull !== spec.notNull) {
        errors.push(
          actual.notNull
            ? `dbo.${table}.${column} es NOT NULL y el esquema lo declara NULL`
            : `dbo.${table}.${column} admite NULL y el esquema exige NOT NULL`,
        );
      }
      if (actual.identity !== spec.identity) {
        errors.push(
          actual.identity
            ? `dbo.${table}.${column} es IDENTITY y el esquema NO lo declara`
            : `dbo.${table}.${column} NO es IDENTITY y el esquema SÍ lo declara`,
        );
      }
    }

    const requiredColumns = new Set([...definition.columns.keys()].map(lowerKey));
    const requiredConstraints = new Set([...definition.constraints].map(lowerKey));

    const constraints = actualConstraints.get(key) || new Map();
    for (const constraint of definition.constraints) {
      if (!constraints.has(lowerKey(constraint))) {
        errors.push(`falta la restricción ${constraint} en dbo.${table}`);
      }
    }
    for (const [constraint, original] of constraints) {
      if (!requiredConstraints.has(constraint)) {
        warnings.push(`restricción adicional en dbo.${table}: ${original}`);
      }
    }
    for (const [column, actual] of columns) {
      if (!requiredColumns.has(column)) {
        warnings.push(`columna adicional en dbo.${table}: ${actual.name}`);
      }
    }
  }

  for (const [key, table] of actualTables) {
    if (!requiredTables.has(key)) {
      warnings.push(`tabla adicional en el destino: dbo.${table}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      tables: schema.size,
      requiredColumns: [...schema.values()].reduce((total, t) => total + t.columns.size, 0),
    },
  };
}

/** Mensaje claro y accionable para el arranque. */
export function describeSchemaFailures(result, { limit = 25 } = {}) {
  const lines = ['Esquema SQL Server incompatible: el servidor no puede arrancar.'];
  for (const error of result.errors.slice(0, limit)) lines.push(`  - ${error}`);
  if (result.errors.length > limit) {
    lines.push(`  - ... y ${result.errors.length - limit} problema(s) más`);
  }
  lines.push(
    'Aplique el DDL/migración de cutover fuera de línea y vuelva a arrancar. '
      + 'Este arranque no ejecutó migraciones, seed ni restauró instantáneas.',
  );
  return lines.join('\n');
}
