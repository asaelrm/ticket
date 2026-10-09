// Diagnóstico SOLO LECTURA de compatibilidad entre el esquema MSSQL esperado
// (src/db/mssql/schema.sql, el que usa el runtime) y la base autorizada de
// validación SIFHA_Tickets_M5_Validation.
//
// Este script NO escribe nunca: todo el acceso es SELECT sobre catálogo del
// sistema y consultas de comprobación. No ejecuta INSERT/UPDATE/DELETE/MERGE/
// ALTER/CREATE/DROP, ni migraciones, seeds o restauraciones.
//
// Antes de tocar la red exige, de forma estricta, que el destino sea el M5
// autorizado (servidor/instancia/base). Si el destino configurado no coincide,
// aborta sin conectarse (código 2). Después de conectar vuelve a verificar la
// identidad real del servidor y de la base.
//
// Uso (PowerShell), sin modificar .env ni mostrar secretos: los valores de
// destino se pasan por entorno para ESTE proceso y las credenciales se leen del
// .env con --env-file (las variables ya presentes en el entorno tienen
// prioridad, así que el destino ejecutado es el M5, nunca el del .env):
//
//   $env:DB_CLIENT='mssql'
//   $env:DB_INSTANCE='SIFHADEV'
//   $env:DB_DATABASE='SIFHA_Tickets_M5_Validation'
//   $env:MIGRATION_TARGET_DATABASE='SIFHA_Tickets_M5_Validation'
//   $env:DB_ENCRYPT='true'
//   $env:DB_TRUST_SERVER_CERTIFICATE='true'
//   node --env-file-if-exists=.env scripts/migration/diagnose-m5-validation.js
//
// Códigos de salida:
//   0  sin diferencias bloqueantes
//   1  hay diferencias bloqueantes (no se modifica nada)
//   2  destino rechazado antes de conectar
//   3  error de ejecución o de conexión
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLUMNS,
  TABLES,
  IDENTITY_TABLES,
  TENANT_FKS,
  GLOBAL_TABLES,
  assertTargetGuard,
  mssqlConnectionConfig,
} from './sqlite-to-mssql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(__dirname, '..', '..', 'src', 'db', 'mssql', 'schema.sql');

const AUTHORIZED = Object.freeze({
  serverIp: '100.100.4.60',
  serverHost: 'TI-DESK-01',
  sqlServerName: 'TI-DESK-01\\SIFHADEV',
  instance: 'SIFHADEV',
  database: 'SIFHA_Tickets_M5_Validation',
});

const report = {
  status: 'fail',
  exit_code: 1,
  authorized: {
    server: AUTHORIZED.sqlServerName,
    instance: AUTHORIZED.instance,
    database: AUTHORIZED.database,
  },
  destination_configured: null,
  identity: null,
  schema_differences: { blocking: [], non_blocking: [] },
  notifications: null,
  data_integrity: null,
  row_counts: null,
  summary: null,
  errors: [],
};

function blocking(detail) {
  report.schema_differences.blocking.push(detail);
}
function nonBlocking(detail) {
  report.schema_differences.non_blocking.push(detail);
}

// Enmascara cualquier rastro de credenciales en un texto, por si el driver de
// SQL Server las incluyera en un mensaje de error. El informe NUNCA imprime
// DB_USER ni DB_PASSWORD, ni una cadena de conexión.
function redact(text) {
  let out = String(text);
  for (const secret of [process.env.DB_PASSWORD, process.env.DB_USER]) {
    if (secret && String(secret).length >= 3) out = out.split(String(secret)).join('***');
  }
  return out
    .replace(/password\s*=\s*[^;,\s]+/gi, 'password=***')
    .replace(/Login failed for user '[^']*'/gi, "Login failed for user '***'");
}

// ---------------------------------------------------------------------------
// 1. Guardas de destino ANTES de cualquier conexión.
// ---------------------------------------------------------------------------
function reviewDestination(env) {
  const configured = {
    client: String(env.DB_CLIENT || ''),
    server: String(env.DB_SERVER || ''),
    instance: String(env.DB_INSTANCE || ''),
    database: String(env.DB_DATABASE || ''),
    migrationTarget: String(env.MIGRATION_TARGET_DATABASE || ''),
    encrypt: String(env.DB_ENCRYPT || '').trim().toLowerCase(),
    trustCert: String(env.DB_TRUST_SERVER_CERTIFICATE || '').trim().toLowerCase(),
    hasUser: Boolean(env.DB_USER),
    hasPassword: Boolean(env.DB_PASSWORD),
  };
  report.destination_configured = {
    client: configured.client,
    server: configured.server,
    instance: configured.instance,
    database: configured.database,
    migration_target_database: configured.migrationTarget,
    encrypt: configured.encrypt,
    trust_server_certificate: configured.trustCert,
    credentials_present: configured.hasUser && configured.hasPassword,
  };

  const problems = [];
  // assertTargetGuard reutiliza las prohibiciones (DEV, master, ZZZSQL, HPWJA...).
  try {
    assertTargetGuard(env);
  } catch (error) {
    problems.push(`assertTargetGuard: ${error.message}`);
  }
  if (configured.client.toLowerCase() !== 'mssql') problems.push('DB_CLIENT debe ser mssql.');
  if (configured.instance.toUpperCase() !== AUTHORIZED.instance) {
    problems.push(`DB_INSTANCE debe ser ${AUTHORIZED.instance}.`);
  }
  if (configured.database.toUpperCase() !== AUTHORIZED.database.toUpperCase()) {
    problems.push(`DB_DATABASE debe ser ${AUTHORIZED.database} (configurado: ${configured.database || '(vacío)'}).`);
  }
  if (configured.migrationTarget.toUpperCase() !== AUTHORIZED.database.toUpperCase()) {
    problems.push(`MIGRATION_TARGET_DATABASE debe ser ${AUTHORIZED.database}.`);
  }
  const serverOk = [AUTHORIZED.serverIp, AUTHORIZED.serverHost].some(
    (value) => configured.server.toUpperCase() === value.toUpperCase(),
  ) || configured.server.toUpperCase() === AUTHORIZED.sqlServerName.toUpperCase();
  if (!serverOk) {
    problems.push(`DB_SERVER debe ser ${AUTHORIZED.serverIp} o ${AUTHORIZED.serverHost}.`);
  }
  if (configured.encrypt !== 'true') problems.push('DB_ENCRYPT debe ser true.');
  if (configured.trustCert !== 'true') problems.push('DB_TRUST_SERVER_CERTIFICATE debe ser true (excepción TLS solo para M5).');
  if (!configured.hasUser || !configured.hasPassword) problems.push('faltan DB_USER o DB_PASSWORD.');
  return problems;
}

// ---------------------------------------------------------------------------
// 2. Esquema esperado derivado de schema.sql (mismo DDL que valida el runtime).
// ---------------------------------------------------------------------------
const TYPE_SYSTEM = {
  INT: 'int', BIGINT: 'bigint', SMALLINT: 'smallint', TINYINT: 'tinyint',
  NVARCHAR: 'nvarchar', VARCHAR: 'varchar', NCHAR: 'nchar', CHAR: 'char',
  BIT: 'bit', DATETIME2: 'datetime2', DATETIME: 'datetime', DATE: 'date', TIME: 'time',
  DECIMAL: 'decimal', NUMERIC: 'numeric', FLOAT: 'float', REAL: 'real',
  UNIQUEIDENTIFIER: 'uniqueidentifier', VARBINARY: 'varbinary', TEXT: 'text', NTEXT: 'ntext',
};

function parseExpected(ddl) {
  const tables = new Map();
  const tableBlock = /CREATE TABLE dbo\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let match;
  while ((match = tableBlock.exec(ddl))) {
    const name = match[1];
    const columns = new Map();
    const constraints = new Map();
    for (const raw of match[2].split('\n')) {
      const line = raw.trim().replace(/,\s*$/, '');
      if (!line || line.startsWith('--')) continue;

      const constraint = /^CONSTRAINT\s+(\w+)\s+(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK)/i.exec(line);
      if (constraint) {
        constraints.set(constraint[1], { kind: constraint[2].toUpperCase() });
        continue;
      }
      // Continuaciones de una restricción multilínea (p. ej. la línea
      // "REFERENCES dbo.departments(...)" de una FK compuesta): no son columnas.
      if (/^(REFERENCES|CHECK|PRIMARY|UNIQUE|FOREIGN|ON|KEY)\b/i.test(line)) continue;
      const column = /^(\[[A-Za-z_]\w*\]|[A-Za-z_]\w*)\s+([A-Za-z][A-Za-z0-9]*)(?:\(([^)]*)\))?\s+([\s\S]*)$/.exec(line);
      if (!column) continue;
      const columnName = column[1].replace(/[[\]]/g, '');
      const rest = column[4] || '';
      const defaultName = /CONSTRAINT\s+(\w+)\s+DEFAULT/i.exec(rest);
      if (defaultName) constraints.set(defaultName[1], { kind: 'DEFAULT' });
      columns.set(columnName, {
        type: TYPE_SYSTEM[column[2].toUpperCase()] || column[2].toLowerCase(),
        size: column[3] === undefined ? null : column[3].toUpperCase(),
        notNull: /\bNOT NULL\b/i.test(rest),
        identity: /\bIDENTITY\b/i.test(rest),
      });
    }
    tables.set(name, { columns, constraints });
  }

  const indexes = new Map();
  const indexRe = /CREATE INDEX (\w+)\s+ON dbo\.(\w+)\s*\(([^)]*)\)/g;
  while ((match = indexRe.exec(ddl))) {
    indexes.set(match[1], {
      table: match[2],
      columns: match[3].split(',').map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, '')),
    });
  }
  return { tables, indexes };
}

function expectedCharLength(size) {
  if (size == null) return null;
  if (size === 'MAX') return -1;
  const n = Number(size);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 3. Catálogo real.
// ---------------------------------------------------------------------------
async function readCatalog(pool) {
  const tables = await pool.request().query(`
    SELECT t.name AS table_name
    FROM sys.tables t
    WHERE t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
  `);
  const columns = await pool.request().query(`
    SELECT t.name AS table_name, c.name AS column_name, ty.name AS type_name,
           c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    WHERE t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
  `);
  const constraints = await pool.request().query(`
    SELECT t.name AS table_name, o.name AS constraint_name, o.type AS constraint_type
    FROM sys.objects o
    JOIN sys.tables t ON t.object_id = o.parent_object_id
    WHERE o.type IN ('PK','UQ','F','C','D')
      AND t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
  `);
  const indexes = await pool.request().query(`
    SELECT t.name AS table_name, i.name AS index_name
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    WHERE t.schema_id = SCHEMA_ID('dbo') AND t.is_ms_shipped = 0
      AND i.name IS NOT NULL AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
  `);
  return {
    tables: tables.recordset.map((r) => r.table_name),
    columns: columns.recordset,
    constraints: constraints.recordset,
    indexes: indexes.recordset.map((r) => r.index_name),
  };
}

function compareSchema(expected, catalog) {
  const lower = (v) => String(v).toLowerCase();

  const actualTables = new Map(catalog.tables.map((name) => [lower(name), name]));
  const actualColumns = new Map();
  for (const row of catalog.columns) {
    const key = lower(row.table_name);
    if (!actualColumns.has(key)) actualColumns.set(key, new Map());
    actualColumns.get(key).set(lower(row.column_name), row);
  }
  const actualConstraints = new Map();
  for (const row of catalog.constraints) {
    const key = lower(row.table_name);
    if (!actualConstraints.has(key)) actualConstraints.set(key, new Map());
    actualConstraints.get(key).set(lower(row.constraint_name), row.constraint_name);
  }
  const actualIndexes = new Map(catalog.indexes.map((name) => [lower(name), name]));

  for (const [table, definition] of expected.tables) {
    const key = lower(table);
    if (!actualTables.has(key)) {
      blocking(`falta la tabla dbo.${table}`);
      continue;
    }
    const columns = actualColumns.get(key) || new Map();
    for (const [column, spec] of definition.columns) {
      const actual = columns.get(lower(column));
      if (!actual) {
        blocking(`falta la columna dbo.${table}.${column}`);
        continue;
      }
      const actualType = lower(actual.type_name);
      if (actualType !== spec.type) {
        blocking(`dbo.${table}.${column}: tipo ${actual.type_name}, esperado ${spec.type}`);
      } else if (spec.type === 'nvarchar' || spec.type === 'varchar') {
        const actualChars = Number(actual.max_length) === -1
          ? -1
          : Number(actual.max_length) / (spec.type === 'nvarchar' ? 2 : 1);
        const expected = expectedCharLength(spec.size);
        if (expected != null && actualChars !== expected) {
          if (actualChars === -1 || actualChars > expected) {
            nonBlocking(`dbo.${table}.${column}: longitud ${actualChars === -1 ? 'MAX' : actualChars}, esperada ${expected === -1 ? 'MAX' : expected} (más ancha en el destino; no bloquea)`);
          } else {
            blocking(`dbo.${table}.${column}: longitud ${actualChars}, esperada ${expected === -1 ? 'MAX' : expected} (el destino es MÁS ESTRECHO; puede truncar/fallar)`)
          }
        }
      } else if (spec.type === 'decimal' || spec.type === 'numeric') {
        const size = String(spec.size || '').split(',').map((v) => Number(v.trim()));
        if (size[0] !== Number(actual.precision) || (size[1] ?? 0) !== Number(actual.scale)) {
          blocking(`dbo.${table}.${column}: precisión/escala ${actual.precision},${actual.scale}, esperada ${size[0]},${size[1] ?? 0}`);
        }
      }
      const actualNotNull = Number(actual.is_nullable) === 0;
      if (actualNotNull !== spec.notNull) {
        if (spec.notNull && !actualNotNull) {
          nonBlocking(`dbo.${table}.${column}: admite NULL en el destino, el esquema lo declara NOT NULL (más laxo; no bloquea)`);
        } else {
          blocking(`dbo.${table}.${column}: NOT NULL en el destino, el esquema lo declara NULL (la app podría insertar NULL)`);
        }
      }
      const actualIdentity = Number(actual.is_identity) === 1;
      if (actualIdentity !== spec.identity) {
        blocking(`dbo.${table}.${column}: ${actualIdentity ? 'es IDENTITY' : 'NO es IDENTITY'}, el esquema ${spec.identity ? 'lo exige' : 'no lo declara'}`);
      }
      if (Number(actual.is_computed) === 1) {
        nonBlocking(`dbo.${table}.${column}: es una columna calculada en el destino`);
      }
    }
    for (const actual of columns.values()) {
      if (![...definition.columns.keys()].some((c) => lower(c) === lower(actual.column_name))) {
        nonBlocking(`columna adicional en dbo.${table}: ${actual.column_name}`);
      }
    }

    const constraints = actualConstraints.get(key) || new Map();
    for (const [constraint] of definition.constraints) {
      if (!constraints.has(lower(constraint))) blocking(`falta la restricción ${constraint} en dbo.${table}`);
    }
    for (const [key2, original] of constraints) {
      if (![...definition.constraints.keys()].some((c) => lower(c) === key2)) {
        nonBlocking(`restricción adicional en dbo.${table}: ${original}`);
      }
    }
  }

  const expectedTableKeys = new Set([...expected.tables.keys()].map(lower));
  for (const name of catalog.tables) {
    if (!expectedTableKeys.has(lower(name))) nonBlocking(`tabla adicional en el destino: dbo.${name}`);
  }

  for (const [name, spec] of expected.indexes) {
    if (!actualIndexes.has(lower(name))) nonBlocking(`falta el índice ${name} en dbo.${spec.table} (rendimiento; no bloquea)`);
  }
  for (const name of catalog.indexes) {
    if (![...expected.indexes.keys()].some((n) => lower(n) === lower(name))) {
      nonBlocking(`índice adicional en el destino: ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Comprobaciones de datos (solo lectura).
// ---------------------------------------------------------------------------
async function readDataChecks(pool) {
  const countColumns = TABLES.map((t) => `(SELECT COUNT_BIG(*) FROM dbo.[${t}]) AS [${t}]`).join(', ');
  const counts = (await pool.request().query(`SELECT ${countColumns}`)).recordset[0] || {};

  const fkOrphans = [];
  for (const [table, column, parent] of TENANT_FKS) {
    const result = await pool.request().query(
      `SELECT COUNT_BIG(*) AS n FROM dbo.[${table}] c ` +
        `WHERE c.[${column}] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.[${parent}] p WHERE p.id = c.[${column}])`,
    );
    const n = Number(result.recordset[0].n);
    if (n > 0) fkOrphans.push({ table, column, parent, rows: n });
  }

  const isolation = [];
  for (const [table, column, parent, sameOrg] of TENANT_FKS) {
    if (!sameOrg || GLOBAL_TABLES.has(parent) || parent === 'organizations') continue;
    const result = await pool.request().query(
      `SELECT COUNT_BIG(*) AS n FROM dbo.[${table}] c JOIN dbo.[${parent}] p ON p.id = c.[${column}] ` +
        `WHERE c.organization_id IS NOT NULL AND p.organization_id IS NOT NULL AND c.organization_id <> p.organization_id`,
    );
    const n = Number(result.recordset[0].n);
    if (n > 0) isolation.push({ table, column, parent, rows: n });
  }

  const orphanOrganizations = [];
  for (const table of TABLES) {
    if (GLOBAL_TABLES.has(table) || table === 'organizations' || !COLUMNS[table].includes('organization_id')) continue;
    const result = await pool.request().query(
      `SELECT COUNT_BIG(*) AS n FROM dbo.[${table}] c ` +
        `WHERE c.organization_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.organizations o WHERE o.id = c.organization_id)`,
    );
    const n = Number(result.recordset[0].n);
    if (n > 0) orphanOrganizations.push({ table, rows: n });
  }

  const globalUsers = (await pool.request().query(`
    SELECT u.id, r.code AS role_code,
           (SELECT COUNT(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = u.role_id AND p.code = 'organization.manage') AS has_global_permission
    FROM dbo.users u LEFT JOIN dbo.roles r ON r.id = u.role_id
    WHERE u.organization_id IS NULL
  `)).recordset;

  const notificationsSummary = (await pool.request().query(`
    SELECT COUNT_BIG(*) AS total,
           SUM(CASE WHEN organization_id IS NULL THEN 1 ELSE 0 END) AS null_org,
           SUM(CASE WHEN organization_id IS NULL AND ticket_id IS NOT NULL THEN 1 ELSE 0 END) AS null_org_with_ticket,
           MAX(LEN(body)) AS max_body_len,
           MAX(LEN(link)) AS max_link_len
    FROM dbo.notifications
  `)).recordset[0];
  const nullOrgNotifications = (await pool.request().query(
    `SELECT id, user_id FROM dbo.notifications WHERE organization_id IS NULL`,
  )).recordset;

  return {
    row_counts: Object.fromEntries(TABLES.map((t) => [t, Number(counts[t] ?? 0)])),
    fk_orphans: fkOrphans,
    tenant_isolation_mismatches: isolation,
    organizations_not_found: orphanOrganizations,
    global_users: globalUsers,
    notifications_summary: notificationsSummary
      ? {
          total: Number(notificationsSummary.total),
          null_organization_id: Number(notificationsSummary.null_org),
          null_organization_id_with_ticket: Number(notificationsSummary.null_org_with_ticket),
          max_body_length: notificationsSummary.max_body_len == null ? null : Number(notificationsSummary.max_body_len),
          max_link_length: notificationsSummary.max_link_len == null ? null : Number(notificationsSummary.max_link_len),
        }
      : null,
    null_org_notifications: nullOrgNotifications,
  };
}

function reviewDataIntegrity(data) {
  const issues = { blocking: [], non_blocking: [] };
  if (data.fk_orphans.length) {
    for (const row of data.fk_orphans) {
      issues.blocking.push(`FK huérfana: ${row.table}.${row.column} → ${row.parent} (${row.rows} fila(s))`);
    }
  }
  for (const row of data.tenant_isolation_mismatches) {
    issues.blocking.push(`Aislamiento: ${row.table}.organization_id difiere de ${row.parent} vía ${row.column} (${row.rows} fila(s))`);
  }
  for (const row of data.organizations_not_found) {
    issues.blocking.push(`organization_id inexistente en ${row.table} (${row.rows} fila(s))`);
  }
  for (const user of data.global_users) {
    const role = String(user.role_code || '');
    if (role.toUpperCase() !== 'SUPERADMIN' || Number(user.has_global_permission) === 0) {
      issues.blocking.push(`usuario global users#${user.id}: rol ${role || '(sin rol)'} sin permiso organization.manage`);
    }
  }
  const summary = data.notifications_summary;
  if (summary) {
    if (summary.null_organization_id_with_ticket > 0) {
      issues.blocking.push(`notifications: ${summary.null_organization_id_with_ticket} aviso(s) con organization_id NULL y ticket_id presente (viola el CHECK)`);
    }
    for (const row of data.null_org_notifications) {
      const recipient = data.global_users.find((u) => Number(u.id) === Number(row.user_id));
      if (!recipient) {
        issues.blocking.push(`notifications#${row.id}: organization_id NULL y destinatario users#${row.user_id} no es una cuenta global`);
      }
    }
  }
  return issues;
}

function humanSummary() {
  const blockingList = report.schema_differences.blocking;
  const nonBlockingList = report.schema_differences.non_blocking;
  const dataIntegrity = report.data_integrity || { blocking: [], non_blocking: [] };
  return {
    blocking_total: blockingList.length + dataIntegrity.blocking.length,
    non_blocking_total: nonBlockingList.length + dataIntegrity.non_blocking.length,
    can_start_mssql: blockingList.length === 0 && dataIntegrity.blocking.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Ejecución.
// ---------------------------------------------------------------------------
async function main() {
  // Modo de auto-comprobación del parser, sin red: verifica que el DDL esperado
  // se descompone en las mismas tablas/columnas que el allowlist del migrador.
  if (String(process.env.DIAGNOSE_SELFCHECK || '') === '1') {
    const expected = parseExpected(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    const mismatches = [];
    for (const table of TABLES) {
      const parsed = expected.tables.get(table);
      if (!parsed) { mismatches.push(`tabla ${table} ausente en el parser`); continue; }
      const parsedColumns = [...parsed.columns.keys()].sort().join(',');
      const declaredColumns = [...COLUMNS[table]].sort().join(',');
      if (parsedColumns !== declaredColumns) {
        mismatches.push(`${table}: parser=[${parsedColumns}] COLUMNS=[${declaredColumns}]`);
      }
    }
    for (const table of expected.tables.keys()) {
      if (!TABLES.includes(table)) mismatches.push(`tabla extra en el parser: ${table}`);
    }
    report.status = mismatches.length ? 'fail' : 'pass';
    report.exit_code = mismatches.length ? 1 : 0;
    report.self_check = { tables: expected.tables.size, indexes: expected.indexes.size, mismatches };
    return report;
  }

  const problems = reviewDestination(process.env);
  if (problems.length) {
    report.status = 'rejected';
    report.exit_code = 2;
    report.errors = problems;
    return report;
  }

  const { default: sql } = await import('mssql');
  const target = assertTargetGuard(process.env);
  const pool = await sql.connect(mssqlConnectionConfig(target, process.env));
  try {
    const identityResult = await pool.request().query(`
      SELECT @@SERVERNAME AS registered_server_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS server_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machine_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instance_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS product_version,
             CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition,
             DB_NAME() AS current_database
    `);
    const row = identityResult.recordset[0];
    report.identity = {
      registered_server_name: String(row.registered_server_name || '').trim(),
      server_name: String(row.server_name || '').trim(),
      machine_name: String(row.machine_name || '').trim(),
      instance_name: String(row.instance_name || '').trim(),
      product_version: String(row.product_version || '').trim(),
      edition: String(row.edition || '').trim(),
      current_database: String(row.current_database || '').trim(),
    };
    const nameOk = [report.identity.registered_server_name, report.identity.server_name]
      .some((n) => n.toUpperCase() === AUTHORIZED.sqlServerName.toUpperCase());
    if (!nameOk || report.identity.current_database.toUpperCase() !== AUTHORIZED.database.toUpperCase()) {
      report.status = 'rejected';
      report.exit_code = 2;
      report.errors = ['La conexión no corresponde a la base autorizada; se aborta sin leer datos.'];
      return report;
    }

    const expected = parseExpected(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    const catalog = await readCatalog(pool);
    compareSchema(expected, catalog);
    const data = await readDataChecks(pool);
    report.row_counts = data.row_counts;
    report.notifications = data.notifications_summary;
    report.data_integrity = reviewDataIntegrity(data);
    report.summary = humanSummary();
    report.status = report.summary.can_start_mssql ? 'pass' : 'fail';
    report.exit_code = report.summary.can_start_mssql ? 0 : 1;
    return report;
  } finally {
    try { await pool.close(); } catch { /* el error principal manda */ }
  }
}

let result;
try {
  result = await main();
} catch (error) {
  result = { ...report, status: 'error', exit_code: 3, errors: [redact(error && error.message ? error.message : error)] };
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.exit_code;
