#!/usr/bin/env node
// Preflight M5 estrictamente de lectura. No importa el runtime ni ejecuta APPLY.
import sql from 'mssql';
import process from 'node:process';
import {
  IDENTITY_TABLES,
  TABLES,
  assertTargetGuard,
  mssqlConnectionConfig,
} from './sqlite-to-mssql.js';

const EXPECTED = {
  server: '100.100.4.60',
  instance: 'SIFHADEV',
  database: 'SIFHA_Tickets_M5_Validation',
  sqlServerName: 'TI-DESK-01\\SIFHADEV',
};

function requireExactEnvironment(env) {
  const values = {
    DB_CLIENT: 'mssql',
    DB_SERVER: EXPECTED.server,
    DB_INSTANCE: EXPECTED.instance,
    DB_DATABASE: EXPECTED.database,
    MIGRATION_TARGET_DATABASE: EXPECTED.database,
    DB_ENCRYPT: 'true',
    DB_TRUST_SERVER_CERTIFICATE: 'true',
  };
  for (const [key, expected] of Object.entries(values)) {
    if (String(env[key] || '').trim() !== expected) {
      throw new Error(`Preflight rechazado: ${key} no coincide con M5 autorizado.`);
    }
  }
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

requireExactEnvironment(process.env);
const target = assertTargetGuard(process.env);
const pool = await sql.connect(mssqlConnectionConfig(target, process.env));

try {
  const connection = await pool.request().query(
    'SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, @@SERVICENAME AS service_name',
  );
  const current = connection.recordset?.[0] || {};
  const serverName = String(current.server_name || '');
  const databaseName = String(current.database_name || '');
  const serviceName = String(current.service_name || '');
  if (
    serverName.toUpperCase() !== EXPECTED.sqlServerName.toUpperCase()
    || databaseName !== EXPECTED.database
    || serviceName.toUpperCase() !== EXPECTED.instance
  ) {
    throw new Error('Preflight rechazado: la conexión no corresponde exactamente a M5.');
  }

  const tablesResult = await pool.request().query(
    "SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID(N'dbo') ORDER BY name",
  );
  const actualTables = tablesResult.recordset.map((row) => row.name).sort();
  const expectedTables = [...TABLES].sort();
  if (!exactArray(actualTables, expectedTables)) {
    throw new Error('Preflight rechazado: las tablas dbo no coinciden exactamente con las 24 esperadas.');
  }

  const countsSql = TABLES.map((table) => (
    `SELECT N'${table}' AS table_name, COUNT_BIG(1) AS row_count FROM dbo.${table}`
  )).join(' UNION ALL ');
  const counts = await pool.request().query(countsSql);
  const nonEmpty = counts.recordset.filter((row) => Number(row.row_count) !== 0);
  if (nonEmpty.length) {
    throw new Error(`Preflight rechazado: hay filas en ${nonEmpty.map((row) => row.table_name).join(', ')}.`);
  }

  const identities = await pool.request().query(
    "SELECT t.name AS table_name, ic.last_value FROM sys.identity_columns AS ic JOIN sys.tables AS t ON t.object_id = ic.object_id WHERE t.schema_id = SCHEMA_ID(N'dbo') ORDER BY t.name",
  );
  const actualIdentity = identities.recordset.map((row) => row.table_name).sort();
  const expectedIdentity = [...IDENTITY_TABLES].sort();
  const unexpectedIdentity = identities.recordset.filter((row) => !IDENTITY_TABLES.has(row.table_name));
  const missingIdentity = expectedIdentity.filter((table) => !actualIdentity.includes(table));
  const identityResidues = identities.recordset.filter((row) => (
    IDENTITY_TABLES.has(row.table_name) && row.last_value !== null
  ));
  if (unexpectedIdentity.length || missingIdentity.length) {
    const details = [
      unexpectedIdentity.length ? `IDENTITY inesperada: ${unexpectedIdentity.map((row) => row.table_name).join(', ')}` : null,
      missingIdentity.length ? `IDENTITY ausente: ${missingIdentity.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    throw new Error(`Preflight rechazado: ${details}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    server: serverName,
    database: databaseName,
    service: serviceName,
    dbo_tables: actualTables.length,
    total_rows: 0,
    identity_residues: identityResidues.map((row) => row.table_name),
    warnings: identityResidues.length
      ? ['Contadores IDENTITY avanzados con 0 filas: advertencia no bloqueante; APPLY conserva IDs y no asume el siguiente ID.']
      : [],
  }));
} finally {
  await pool.close();
}
