// Verificación SOLO LECTURA del destino M5 de validación antes de un ensayo de
// migración. No emite INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE/RESeed: todo el
// acceso es SELECT. Reutiliza las guardas y la configuración de conexión del
// migrador (sqlite-to-mssql.js) y añade una comprobación estricta del destino.
//
// Códigos de salida:
//   0  verificación superada (destino correcto, 24 tablas, 0 filas)
//   1  discrepancia de destino, tablas o filas (no se modifica nada)
//   2  configuración/destino rechazado antes de conectar
//   3  error de ejecución o de conexión
import {
  IDENTITY_TABLES,
  TABLES,
  VALIDATION_DATABASE_WITH_TRUSTED_SELF_SIGNED_CERT,
  assertTargetGuard,
  mssqlConnectionConfig,
} from './sqlite-to-mssql.js';

const AUTHORIZED_SERVER = '100.100.4.60';
// Nombre de instancia registrado en el dominio SQL Server. La barra invertida
// se escapa en el literal de JavaScript (TI-DESK-01\\SIFHADEV -> TI-DESK-01\SIFHADEV).
const AUTHORIZED_SQL_SERVER_NAME = 'TI-DESK-01\\SIFHADEV';
const AUTHORIZED_INSTANCE = 'SIFHADEV';
const AUTHORIZED_DATABASE = VALIDATION_DATABASE_WITH_TRUSTED_SELF_SIGNED_CERT;

const report = { status: 'fail', exit_code: 1, destination: null };
const failures = [];
const warnings = [];

function fail(label, detail) {
  failures.push({ label, detail });
}

async function main() {
  // ---- 1. Rechazo del destino antes de tocar la red -------------------------
  const env = process.env;
  let target;
  try {
    target = assertTargetGuard(env);
  } catch (error) {
    report.exit_code = 2;
    report.status = 'rejected';
    report.errors = [`Destino rechazado por assertTargetGuard: ${error.message}`];
    return report;
  }
  const strict = [
    [`servidor ${target.server} !== ${AUTHORIZED_SERVER}`, () => target.server !== AUTHORIZED_SERVER],
    [`instancia ${target.instance || '(vacía)'} !== ${AUTHORIZED_INSTANCE}`, () => target.instance.toUpperCase() !== AUTHORIZED_INSTANCE],
    [`base ${target.database} !== ${AUTHORIZED_DATABASE}`, () => target.database.toUpperCase() !== AUTHORIZED_DATABASE.toUpperCase()],
    ['MIGRATION_TARGET_DATABASE no coincide', () => env.MIGRATION_TARGET_DATABASE !== target.database],
    ['DB_ENCRYPT debe ser true para M5', () => String(env.DB_ENCRYPT || '').trim().toLowerCase() !== 'true'],
    ['DB_TRUST_SERVER_CERTIFICATE debe ser true para la excepción TLS M5', () => String(env.DB_TRUST_SERVER_CERTIFICATE || '').trim().toLowerCase() !== 'true'],
    ['faltan credenciales DB_USER o DB_PASSWORD', () => !env.DB_USER || !env.DB_PASSWORD],
  ];
  const rejected = strict.find(([, guard]) => guard());
  if (rejected) {
    report.exit_code = 2;
    report.status = 'rejected';
    report.errors = [`Destino rechazado: ${rejected[0]}`];
    return report;
  }
  report.destination = { server: target.server, instance: target.instance, database: target.database };

  // ---- 2. Conexión solo tras validar el destino -----------------------------
  const { default: sql } = await import('mssql');
  const config = mssqlConnectionConfig(target, env);
  const pool = await sql.connect(config);
  try {
    // Identidad exacta del servidor, instancia y base.
    const identityResult = await pool.request().query(`
      SELECT @@SERVERNAME AS registered_server_name,
             CONVERT(nvarchar(256), SERVERPROPERTY('ServerName')) AS server_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machine_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instance_name,
             CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS product_version,
             CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition,
             DB_NAME() AS current_database
    `);
    const row = identityResult.recordset[0];
    const registered = String(row.registered_server_name || '').trim();
    const serverName = String(row.server_name || '').trim();
    const currentDatabase = String(row.current_database || '').trim();
    report.identity = {
      registered_server_name: registered,
      server_name: serverName,
      machine_name: String(row.machine_name || '').trim(),
      instance_name: String(row.instance_name || '').trim(),
      product_version: String(row.product_version || '').trim(),
      edition: String(row.edition || '').trim(),
      current_database: currentDatabase,
    };
    const nameMatches = [registered, serverName].some((name) => name.toUpperCase() === AUTHORIZED_SQL_SERVER_NAME.toUpperCase());
    if (!nameMatches) fail('identidad', `se esperaba ${AUTHORIZED_SQL_SERVER_NAME} y el servidor reporta "${registered}"`);
    if (currentDatabase.toUpperCase() !== AUTHORIZED_DATABASE.toUpperCase()) {
      fail('identidad', `DB_NAME()="${currentDatabase}" pero el destino autorizado es ${AUTHORIZED_DATABASE}`);
    }
    const instanceProperty = String(row.instance_name || '').trim();
    if (instanceProperty && instanceProperty.toUpperCase() !== AUTHORIZED_INSTANCE) {
      fail('identidad', `SERVERPROPERTY('InstanceName')="${instanceProperty}" no coincide con ${AUTHORIZED_INSTANCE}`);
    }

    // Existencia exacta de las 24 tablas (ni una más, ni una menos).
    const tablesResult = await pool.request().query(`
      SELECT name FROM sys.tables
      WHERE schema_id = SCHEMA_ID(N'dbo')
        AND is_ms_shipped = 0
        AND OBJECTPROPERTY(object_id, 'IsUserTable') = 1
      ORDER BY name
    `);
    const actualTables = tablesResult.recordset.map((t) => t.name).sort();
    const expectedTables = [...TABLES].sort();
    report.tables = actualTables;
    if (actualTables.length !== expectedTables.length) {
      fail('tablas', `${actualTables.length} tablas; se esperaban ${expectedTables.length}`);
    }
    const missing = expectedTables.filter((t) => !actualTables.includes(t));
    const extra = actualTables.filter((t) => !expectedTables.includes(t));
    if (missing.length) fail('tablas', `faltan: ${missing.join(', ')}`);
    if (extra.length) fail('tablas', `no esperadas: ${extra.join(', ')}`);

    // 0 filas en cada una de las 24 tablas.
    const countColumns = TABLES.map((t) => `(SELECT COUNT(*) FROM dbo.[${t}]) AS [${t}]`);
    const countsResult = await pool.request().query(`SELECT ${countColumns.join(', ')}`);
    const counts = countsResult.recordset[0];
    const nonEmpty = TABLES.filter((t) => Number(counts[t]) > 0);
    report.row_counts = Object.fromEntries(TABLES.map((t) => [t, Number(counts[t])]));
    if (nonEmpty.length) fail('filas', `tablas con filas: ${nonEmpty.map((t) => `${t}=${counts[t]}`).join(', ')}`);

    // Columnas IDENTITY: exactamente la columna id de las 17 tablas IDENTITY.
    const identityCols = await pool.request().query(`
      SELECT t.name AS table_name,
             c.name AS column_name,
             CAST(ic.seed_value AS bigint) AS seed_value,
             CAST(ic.increment_value AS bigint) AS increment_value
      FROM sys.identity_columns AS ic
      INNER JOIN sys.columns AS c
        ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      INNER JOIN sys.tables AS t
        ON t.object_id = ic.object_id
      WHERE t.schema_id = SCHEMA_ID(N'dbo')
        AND t.is_ms_shipped = 0
      ORDER BY t.name
    `);
    const identityMap = Object.fromEntries(identityCols.recordset.map((c) => [c.table_name, { column: c.column_name, seed: Number(c.seed_value), increment: Number(c.increment_value) }]));
    const expectedIdentity = [...IDENTITY_TABLES].sort();
    const actualIdentity = Object.keys(identityMap).sort();
    report.identity_columns = identityMap;
    if (actualIdentity.join('|') !== expectedIdentity.join('|')) {
      fail('identidad', `columnas IDENTITY distintas a las esperadas: ${actualIdentity.join(', ') || '(ninguna)'}`);
    }
    for (const table of Object.keys(identityMap)) {
      if (identityMap[table].column !== 'id') fail('identidad', `${table}: la columna IDENTITY es "${identityMap[table].column}", se esperaba id`);
      if (identityMap[table].seed !== 1 || identityMap[table].increment !== 1) {
        fail('identidad', `${table}: IDENTITY(seed=${identityMap[table].seed}, increment=${identityMap[table].increment})`);
      }
      if (!expectedIdentity.includes(table)) fail('identidad', `${table}: columna IDENTITY no declarada`);
    }
    for (const table of expectedIdentity) {
      if (!identityMap[table]) fail('identidad', `${table}: sin columna IDENTITY`);
    }

    // Residuos de intentos anteriores: el contador IDENTITY puede avanzar aun
    // con 0 filas (IDENTITY_INSERT/rollback queman valores). NO es un fallo por
    // sí mismo: el requisito es que no haya filas. Se informa sin tocar nada.
    const residueExpr = expectedIdentity.map((t) => `IDENT_CURRENT(N'dbo.${t}') AS [${t}]`);
    const residueResult = await pool.request().query(`SELECT ${residueExpr.join(', ')}`);
    const residue = residueResult.recordset[0];
    report.identity_residues = Object.fromEntries(expectedIdentity.map((t) => [t, residue[t] == null ? null : Number(residue[t])]));
    for (const table of expectedIdentity) {
      if (residue[table] != null && Number(residue[table]) > 0) {
        warnings.push(`${table}: 0 filas pero contador IDENTITY en ${Number(residue[table])} (residuo de un intento previo; no impide el ensayo porque APPLY preserva IDs con IDENTITY_INSERT y usa el ID real de la organización legacy)`);
      }
    }
  } finally {
    try { await pool.close(); } catch { /* el error principal manda */ }
  }

  if (failures.length) {
    report.status = 'fail';
    report.exit_code = 1;
    report.errors = failures.map((f) => `${f.label}: ${f.detail}`);
    if (warnings.length) report.warnings = warnings;
    return report;
  }
  report.status = 'pass';
  report.exit_code = 0;
  report.warnings = warnings;
  return report;
}

let result;
try {
  result = await main();
} catch (error) {
  result = { status: 'error', exit_code: 3, destination: null, errors: [String(error && error.message ? error.message : error)] };
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.exit_code;
