#!/usr/bin/env node
// M4: deliberately standalone. Importing it never changes the runtime backend.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import process from 'node:process';
import config from '../src/config.js';
import {
  TABLES, SKIPPED_TABLES, IDENTITY_TABLES, assertTargetGuard, buildManifest, legacyOrganizationPlan, resolveSourcePath, summarizeValidationErrors, transformRow, validateSource,
} from './migration/sqlite-to-mssql.js';

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--dry-run') ? 'dry-run' : null;
if (!mode) throw new Error('Uso: node scripts/migrate-sqlite-to-mssql.js --dry-run|--apply');
const sourceFlag = process.argv.indexOf('--source');
if (sourceFlag !== -1 && (sourceFlag === process.argv.length - 1 || process.argv.indexOf('--source', sourceFlag + 1) !== -1)) {
  throw new Error('Use --source exactamente una vez seguido por una ruta SQLite.');
}
const sourcePath = resolveSourcePath(config.dbFile, sourceFlag === -1 ? undefined : process.argv[sourceFlag + 1]);
if (!fs.existsSync(sourcePath)) throw new Error(`El source SQLite no existe: ${sourcePath}`);
if (!fs.statSync(sourcePath).isFile()) throw new Error(`El source SQLite no es un archivo: ${sourcePath}`);
const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
const existing = new Set(sourceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
const source = Object.fromEntries(TABLES.map((table) => [table, existing.has(table) ? sourceDb.prepare(`SELECT * FROM "${table}"`).all() : []]));
sourceDb.close();
const option = (flag) => { const index = process.argv.indexOf(flag); if (index === -1) return undefined; if (index === process.argv.length - 1 || process.argv.indexOf(flag, index + 1) !== -1) throw new Error(`${flag} requiere exactamente un valor.`); return process.argv[index + 1]; };
const legacyOrganization = legacyOrganizationPlan(source, { code: option('--legacy-org-code'), name: option('--legacy-org-name') });
const errors = validateSource(source, legacyOrganization);
const manifest = buildManifest(source, { instance: process.env.DB_INSTANCE || null, database: process.env.DB_DATABASE || null }, legacyOrganization);
for (const error of errors) manifest.tables[error.table].error_count += 1;
if (errors.length) manifest.precheck_errors = summarizeValidationErrors(errors);
if (mode === 'dry-run') {
  manifest.finished_at = new Date().toISOString();
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(errors.length ? 2 : 0);
}
if (errors.length) throw new Error(`Precheck falló con ${errors.length} error(es); no se escribió ningún destino.`);

const target = assertTargetGuard(process.env);
const { default: sql } = await import('mssql');
const pool = await sql.connect({ server: target.server, database: target.database, options: { instanceName: target.instance, trustServerCertificate: false }, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
try {
  const count = await pool.request().query(`SELECT SUM(rows) AS count FROM sys.partitions WHERE index_id IN (0,1) AND object_id IN (${TABLES.filter((x) => !SKIPPED_TABLES.has(x)).map((x) => `OBJECT_ID('dbo.${x}')`).join(',')})`);
  if (Number(count.recordset[0].count || 0) !== 0) throw new Error('Destino no está vacío; APPLY se niega a continuar.');
  const tx = new sql.Transaction(pool); await tx.begin();
  try {
    for (const table of TABLES) {
      if (SKIPPED_TABLES.has(table)) continue;
      const rows = source[table] || []; if (!rows.length) continue;
      const usesIdentity = IDENTITY_TABLES.has(table);
      if (usesIdentity) await new sql.Request(tx).query(`SET IDENTITY_INSERT dbo.${table} ON`);
      try {
        for (const row of rows) { const data = transformRow(table, row, source, legacyOrganization); const request = new sql.Request(tx); const columns = Object.keys(data); columns.forEach((key) => request.input(key, data[key])); await request.query(`INSERT dbo.${table} (${columns.map((c) => `[${c}]`).join(',')}) VALUES (${columns.map((c) => `@${c}`).join(',')})`); manifest.tables[table].inserted_count += 1; }
      } finally {
        // IDENTITY_INSERT is session-scoped; turn it off even when a row fails.
        if (usesIdentity) await new sql.Request(tx).query(`SET IDENTITY_INSERT dbo.${table} OFF`);
      }
    }
    await tx.commit();
  } catch (error) { try { await tx.rollback(); } finally { throw error; } }
} finally { await pool.close(); }
manifest.finished_at = new Date().toISOString(); console.log(JSON.stringify(manifest, null, 2));
