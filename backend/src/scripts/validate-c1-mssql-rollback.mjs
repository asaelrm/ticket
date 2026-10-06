/**
 * Valida que el DDL C1 compile en SQL Server DEV y revierte siempre.
 * No carga dotenv: la configuración procede exclusivamente de process.env.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

export const EXPECTED_DATABASE = 'SIFHA_Tickets_DEV';
export const C1_TABLES = ['categories', 'sequences', 'settings', 'teams', 'team_members', 'tickets', 'ticket_comments', 'ticket_history', 'ticket_attachments', 'notifications'];
export const PROTECTED_TABLES = ['users', 'roles', 'permissions', 'role_permissions', 'departments', 'sessions'];

const here = path.dirname(fileURLToPath(import.meta.url));
const ddlPath = path.join(here, '..', 'schema.mssql.tickets-dev.sql');
const c1TableList = C1_TABLES.map((name) => `N'${name}'`).join(', ');

export const EXPECTED_FKS = new Map([
  ['FK_settings_updated_by', 'SET_NULL'], ['FK_team_members_team', 'CASCADE'], ['FK_team_members_user', 'CASCADE'],
  ['FK_tickets_reporter', 'NO_ACTION'], ['FK_tickets_assigned_to', 'NO_ACTION'], ['FK_tickets_assigned_team', 'SET_NULL'],
  ['FK_tickets_category', 'SET_NULL'], ['FK_tickets_department', 'SET_NULL'], ['FK_tickets_resolved_by', 'NO_ACTION'],
  ['FK_tickets_closed_by', 'NO_ACTION'], ['FK_tickets_reopened_by', 'NO_ACTION'], ['FK_tickets_cancelled_by', 'NO_ACTION'],
  ['FK_ticket_comments_ticket', 'CASCADE'], ['FK_ticket_comments_user', 'SET_NULL'], ['FK_ticket_history_ticket', 'CASCADE'],
  ['FK_ticket_history_user', 'SET_NULL'], ['FK_ticket_attachments_ticket', 'CASCADE'],
  ['FK_ticket_attachments_comment', 'NO_ACTION'], ['FK_ticket_attachments_uploader', 'SET_NULL'],
  ['FK_notifications_user', 'CASCADE'], ['FK_notifications_ticket', 'CASCADE'],
]);
export const EXPECTED_KEYS = ['PK_categories', 'UQ_categories_name', 'PK_sequences', 'PK_settings', 'PK_teams', 'UQ_teams_name', 'PK_team_members', 'PK_tickets', 'UQ_tickets_ticket_number', 'PK_ticket_comments', 'PK_ticket_history', 'PK_ticket_attachments', 'UQ_ticket_attachments_stored_name', 'PK_notifications'];
export const EXPECTED_CHECKS = ['CK_sequences_value_nonnegative', 'CK_tickets_priority', 'CK_tickets_status', 'CK_tickets_time_spent_minutes', 'CK_tickets_csat_rating'];
export const EXPECTED_INDEXES = ['IX_team_members_user', 'IX_tickets_reporter', 'IX_tickets_assigned', 'IX_tickets_assigned_team', 'IX_tickets_category', 'IX_tickets_department', 'IX_tickets_priority', 'IX_tickets_status', 'IX_tickets_created', 'IX_tickets_updated', 'IX_tickets_resolved', 'IX_tickets_closed', 'IX_tickets_sla_due', 'IX_tickets_resolved_by', 'IX_tickets_closed_by', 'IX_tickets_cancelled_by', 'IX_tickets_cancelled_at', 'IX_ticket_comments_ticket', 'IX_ticket_comments_ticket_internal', 'IX_ticket_comments_created', 'IX_ticket_history_ticket', 'IX_ticket_history_created', 'IX_ticket_attachments_ticket', 'IX_ticket_attachments_comment', 'IX_notifications_user_read', 'IX_notifications_created'];

function fail(message) { throw new Error(message); }
function bool(value) { return String(value || '').trim().toLowerCase() === 'true' || String(value || '').trim() === '1'; }
function safeError() { return new Error('La validación C1 falló; no se confirmó ningún cambio.'); }
function row(result) { return result.recordset?.[0] || {}; }
function names(result) { return new Set((result.recordset || []).map((r) => r.name)); }

export function sanitizeMessage(message, env = process.env) {
  let value = String(message || 'Error sin mensaje técnico.');
  const password = String(env.DB_PASSWORD || '');
  if (password) value = value.split(password).join('[REDACTED]');
  // Defensa adicional para errores que incluyan fragmentos de connection string.
  value = value.replace(/\b(password|pwd)\s*=\s*[^;\s]*/gi, '$1=[REDACTED]');
  return value.replace(/\$2[aby]\$[^\s;,]*/g, '[REDACTED]');
}

export function logDiagnostic({ stage, error, env = process.env, log = console.error }) {
  log(`[C1-VALIDATE] etapa: ${stage}`);
  for (const field of ['name', 'code', 'number', 'state', 'class', 'lineNumber', 'procName']) {
    if (error?.[field] !== undefined && error[field] !== null && error[field] !== '') {
      log(`[C1-VALIDATE] error.${field}: ${sanitizeMessage(error[field], env)}`);
    }
  }
  log(`[C1-VALIDATE] mensaje: ${sanitizeMessage(error?.message, env)}`);
}

export function configurationFromEnv(env = process.env) {
  if (String(env.DB_CLIENT || '').trim().toLowerCase() !== 'mssql') fail('DB_CLIENT debe ser mssql.');
  if (env.DB_DATABASE !== EXPECTED_DATABASE) fail(`DB_DATABASE debe ser ${EXPECTED_DATABASE}.`);
  for (const key of ['DB_SERVER', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']) if (!String(env[key] || '').trim()) fail(`Falta ${key}.`);
  return {
    server: env.DB_SERVER,
    port: Number(env.DB_PORT),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    options: { encrypt: bool(env.DB_ENCRYPT), trustServerCertificate: bool(env.DB_TRUST_SERVER_CERTIFICATE) },
    pool: { max: 1, min: 0 },
  };
}

async function tablePresence(request, tag) {
  return request.query(`/* C1V:${tag} */ SELECT t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=N'dbo' AND t.name IN (${c1TableList});`);
}

async function protectedState(request, tag, { log, report = false } = {}) {
  const found = await request.query(`/* C1V:${tag}:objects */ SELECT t.name, t.object_id FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=N'dbo' AND t.name IN (${PROTECTED_TABLES.map((n) => `N'${n}'`).join(', ')});`);
  const byName = new Map((found.recordset || []).map((r) => [r.name, r.object_id]));
  const detected = PROTECTED_TABLES.filter((name) => byName.has(name));
  const missing = PROTECTED_TABLES.filter((name) => !byName.has(name));
  if (report) log(`[C1-VALIDATE] tablas protegidas encontradas: ${detected.join(', ') || '(ninguna)'}`);
  if (missing.length) {
    if (report) log(`[C1-VALIDATE] tablas protegidas faltantes: ${missing.join(', ')} (ausente o no visible para el login actual)`);
    fail(`Tablas protegidas faltantes o no visibles para el login actual: ${missing.join(', ')}.`);
  }
  const state = new Map();
  for (const name of PROTECTED_TABLES) {
    const result = await request.query(`/* C1V:${tag}:count:${name} */ SELECT COUNT_BIG(*) AS row_count FROM dbo.${name};`);
    state.set(name, { object_id: byName.get(name), row_count: String(row(result).row_count) });
  }
  return state;
}

function assertSameProtected(before, after) {
  for (const name of PROTECTED_TABLES) {
    const a = before.get(name); const b = after.get(name);
    if (!b || a.object_id !== b.object_id || a.row_count !== b.row_count) fail(`La tabla protegida ${name} cambió.`);
  }
}

function assertExpected(actual, expected, label) {
  for (const name of expected) if (!actual.has(name)) fail(`Falta ${label}: ${name}.`);
}

async function verifyCatalog(request) {
  const tables = names(await tablePresence(request, 'inside-tables'));
  assertExpected(tables, C1_TABLES, 'tabla C1');
  const fks = await request.query(`/* C1V:inside-fks */ SELECT name, delete_referential_action_desc FROM sys.foreign_keys WHERE parent_object_id IN (SELECT object_id FROM sys.tables WHERE name IN (${c1TableList}));`);
  const byFk = new Map((fks.recordset || []).map((r) => [r.name, r.delete_referential_action_desc]));
  for (const [name, action] of EXPECTED_FKS) if (byFk.get(name) !== action) fail(`FK C1 inválida: ${name}.`);
  const keys = names(await request.query(`/* C1V:inside-keys */ SELECT kc.name FROM sys.key_constraints kc WHERE kc.parent_object_id IN (SELECT object_id FROM sys.tables WHERE name IN (${c1TableList}));`));
  assertExpected(keys, EXPECTED_KEYS, 'PK/UNIQUE');
  const checks = names(await request.query(`/* C1V:inside-checks */ SELECT cc.name FROM sys.check_constraints cc WHERE cc.parent_object_id IN (SELECT object_id FROM sys.tables WHERE name IN (${c1TableList}));`));
  assertExpected(checks, EXPECTED_CHECKS, 'CHECK');
  const indexes = names(await request.query(`/* C1V:inside-indexes */ SELECT i.name FROM sys.indexes i WHERE i.object_id IN (SELECT object_id FROM sys.tables WHERE name IN (${c1TableList})) AND i.name IS NOT NULL;`));
  assertExpected(indexes, EXPECTED_INDEXES, 'índice');
}

async function transactionCount(request, tag) {
  return Number(row(await request.query(`/* C1V:${tag} */ SELECT @@TRANCOUNT AS tran_count;`)).tran_count);
}

async function rollbackIfActive(transaction) {
  try {
    const count = await transactionCount(transaction.request(), 'error-trancount');
    if (count > 0) await transaction.rollback();
  } catch {
    // C1 pudo haber hecho ROLLBACK de toda la transacción externa. Nunca se hace COMMIT.
  }
}

export async function validateC1Rollback({ env = process.env, sqlModule = sql, readFile = fs.readFile, log = console.log } = {}) {
  let pool;
  let transaction;
  let protectedBefore;
  let stage = 'validacion-base';
  try {
    const config = configurationFromEnv(env);
    stage = 'conexion';
    pool = await sqlModule.connect(config);
    stage = 'validacion-base';
    const identity = row(await pool.request().query("/* C1V:identity */ SELECT DB_NAME() AS [database], ORIGINAL_LOGIN() AS original_login, SUSER_SNAME() AS suser;"));
    if (identity.database !== EXPECTED_DATABASE) fail('DB_NAME() no es la base DEV permitida.');
    stage = 'validacion-login';
    if (String(identity.original_login || '').toLowerCase() === 'sa' || String(identity.suser || '').toLowerCase() === 'sa') fail('La identidad sa no está permitida.');
    log('[C1-VALIDATE] base correcta');

    stage = 'preflight-c1';
    if (names(await tablePresence(pool.request(), 'preflight-tables')).size) fail('Ya existe una tabla C1; se aborta sin DDL.');
    stage = 'preflight-protegidas';
    protectedBefore = await protectedState(pool.request(), 'preflight-protected', { log, report: true });
    log('[C1-VALIDATE] preflight OK');

    const ddl = await readFile(ddlPath, 'utf8');
    transaction = new sqlModule.Transaction(pool);
    stage = 'begin-transaction';
    await transaction.begin();
    if (await transactionCount(transaction.request(), 'before-ddl') !== 1) fail('@@TRANCOUNT antes de C1 no es 1.');
    log('[C1-VALIDATE] transaccion externa iniciada');

    stage = 'ddl-c1';
    await transaction.request().batch(ddl);
    if (await transactionCount(transaction.request(), 'after-ddl') !== 1) fail('@@TRANCOUNT después de C1 no es 1.');
    log('[C1-VALIDATE] DDL C1 compilado');
    stage = 'validacion-catalogo';
    await verifyCatalog(transaction.request());
    const protectedInside = await protectedState(transaction.request(), 'inside-protected');
    assertSameProtected(protectedBefore, protectedInside);
    log('[C1-VALIDATE] catalogo C1 OK');

    stage = 'rollback';
    await transaction.rollback();
    transaction = null;
    log('[C1-VALIDATE] ROLLBACK ejecutado');

    stage = 'post-rollback-c1';
    if (names(await tablePresence(pool.request(), 'after-tables')).size) fail('Persistió una tabla C1 después del rollback.');
    log('[C1-VALIDATE] tablas C1 ausentes despues del rollback');
    stage = 'post-rollback-protegidas';
    assertSameProtected(protectedBefore, await protectedState(pool.request(), 'after-protected'));
    log('[C1-VALIDATE] tablas protegidas intactas');
    log('[C1-VALIDATE] RESULTADO: OK');
    return { ok: true };
  } catch (error) {
    if (transaction) await rollbackIfActive(transaction);
    // Si C1 falló, su propio CATCH puede haber revertido la transacción externa.
    // Aun así, comprobamos el estado global cuando el preflight ya se completó.
    if (pool && protectedBefore) {
      try {
        if (names(await tablePresence(pool.request(), 'error-after-tables')).size) fail('Persistió una tabla C1 después de un rollback por error.');
        assertSameProtected(protectedBefore, await protectedState(pool.request(), 'error-after-protected'));
      } catch {
        // El resultado seguirá siendo error seguro y nunca habrá COMMIT.
      }
    }
    logDiagnostic({ stage, error, env, log });
    throw safeError();
  } finally {
    if (pool) await pool.close();
  }
}

export function usage() {
  return 'Uso: DB_CLIENT=mssql DB_SERVER=... DB_PORT=... DB_DATABASE=SIFHA_Tickets_DEV DB_USER=... DB_PASSWORD=... node src/scripts/validate-c1-mssql-rollback.mjs';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) console.log(usage());
  else validateC1Rollback().catch((error) => { console.error(`[C1-VALIDATE] ERROR: ${error.message}`); process.exitCode = 1; });
}
