import crypto from 'node:crypto';

export const FORBIDDEN_INSTANCE_TOKENS = ['HPWJA', 'ZZZSQL'];
export const FORBIDDEN_DATABASES = ['master', 'tempdb', 'model', 'msdb', 'SIFHA_Tickets_DEV'];
export const SESSION_POLICY = 'REQUIRES_DECISION';
export const LEGACY_ORG_CODE = /^[A-Z][A-Z0-9_-]{1,63}$/;

export function resolveSourcePath(runtimeDbFile, explicitSource = undefined) {
  if (explicitSource !== undefined) {
    if (!explicitSource || typeof explicitSource !== 'string') throw new Error('--source requiere una ruta de archivo SQLite.');
    return explicitSource;
  }
  if (!runtimeDbFile || typeof runtimeDbFile !== 'string') throw new Error('No se pudo determinar config.dbFile del runtime SQLite.');
  return runtimeDbFile;
}

export function legacyOrganizationPlan(source, { code, name } = {}) {
  const hasLegacyTenantRows = ['departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'kb_categories', 'kb_articles']
    .some((table) => (source[table] || []).length > 0 && !(source[table] || []).some((row) => row.organization_id != null));
  if (!hasLegacyTenantRows) return null;
  if (!code) throw new Error('Legacy tenant requiere --legacy-org-code explícito.');
  if (!LEGACY_ORG_CODE.test(code)) throw new Error('legacy_org_code inválido; use A-Z, 0-9, _ o -, comenzando por letra.');
  if (!name || !String(name).trim() || String(name).trim().length > 200) throw new Error('Legacy tenant requiere --legacy-org-name válido (1-200 caracteres).');
  const affectedTables = Object.fromEntries(
    ['departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'ticket_comments', 'ticket_attachments', 'ticket_history', 'notifications', 'kb_categories', 'kb_articles', 'kb_article_history']
      .map((table) => [table, (source[table] || []).length]).filter(([, count]) => count > 0),
  );
  const emailLogs = (source.email_logs || []).filter((row) => row.ticket_id != null).length;
  if (emailLogs) affectedTables.email_logs = emailLogs;
  return { code, name: String(name).trim(), marker: `legacy-org:${code}`, affectedTables, sequence: legacySequencePlan(source.tickets || [], code, source.sequences || []) };
}

export function legacySequencePlan(tickets, organizationCode, sequences = []) {
  const values = (tickets || []).map((ticket) => {
    const match = /-([0-9]+)$/.exec(String(ticket.ticket_number || ''));
    return match ? Number(match[1]) : null;
  }).filter(Number.isSafeInteger);
  const max = values.length ? Math.max(...values) : 0;
  const legacy = (sequences || []).find((row) => row.name === 'ticket_number');
  return { organization_code: organizationCode, target_sequence: `ticket_number:<id resuelto por code ${organizationCode}>`, max_ticket_number: max, next_ticket_number: max + 1, legacy_sequence_value: legacy ? Number(legacy.value) : null, reconciled_value: max };
}

// Ordered from the actual FK graph in src/db/mssql/schema.sql.  Tables with
// tenant children carry organization_id in MSSQL even when legacy SQLite did
// not; it is derived only from an already validated parent row.
export const TABLES = [
  'organizations', 'roles', 'permissions', 'role_permissions', 'departments',
  'categories', 'users', 'teams', 'team_members', 'tickets', 'canned_responses',
  'ticket_comments', 'ticket_attachments', 'ticket_history', 'settings',
  'org_settings', 'email_logs', 'notifications', 'kb_categories', 'kb_articles',
  'kb_ticket_articles', 'kb_article_history', 'sequences', 'sessions',
];

export const GLOBAL_TABLES = new Set(['roles', 'permissions', 'role_permissions', 'settings', 'sequences', 'sessions']);
export const SKIPPED_TABLES = new Set(['sessions']);
export const IDENTITY_TABLES = new Set(['organizations', 'roles', 'permissions', 'departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'ticket_comments', 'ticket_attachments', 'ticket_history', 'email_logs', 'notifications', 'kb_categories', 'kb_articles', 'kb_article_history']);
export const BOOLEAN_COLUMNS = new Set([
  'organizations.active', 'roles.active', 'departments.active', 'categories.active', 'users.active',
  'teams.active', 'canned_responses.is_active', 'ticket_comments.is_internal',
  'tickets.resolution_notified', 'kb_categories.active', 'kb_articles.is_featured',
]);
export const DATETIME_COLUMNS = new Set([
  'organizations.created_at', 'organizations.updated_at', 'roles.created_at', 'permissions.created_at',
  'departments.created_at', 'categories.created_at', 'categories.updated_at', 'users.last_login_at',
  'users.last_password_change_at', 'users.password_reset_expires', 'users.created_at', 'users.updated_at',
  'teams.created_at', 'teams.updated_at', 'tickets.sla_due_at', 'tickets.resolved_at', 'tickets.closed_at',
  'tickets.reopened_at', 'tickets.cancelled_at', 'tickets.csat_answered_at', 'tickets.created_at', 'tickets.updated_at',
  'canned_responses.created_at', 'canned_responses.updated_at', 'ticket_comments.created_at', 'ticket_comments.updated_at',
  'ticket_attachments.created_at', 'ticket_history.created_at', 'settings.updated_at', 'settings.created_at',
  'org_settings.updated_at', 'org_settings.created_at', 'email_logs.created_at', 'notifications.read_at',
  'notifications.created_at', 'kb_categories.created_at', 'kb_categories.updated_at', 'kb_articles.published_at',
  'kb_articles.created_at', 'kb_articles.updated_at', 'kb_ticket_articles.created_at', 'kb_article_history.created_at',
]);

const PARENT = {
  departments: null, categories: null, users: null, teams: null, tickets: null, canned_responses: null,
  ticket_comments: 'tickets', ticket_attachments: 'tickets', ticket_history: 'tickets',
  notifications: 'users', kb_categories: null, kb_articles: null, kb_ticket_articles: 'tickets', kb_article_history: 'kb_articles',
};

export function assertTargetGuard(env) {
  const client = String(env.DB_CLIENT || '').toLowerCase();
  const instance = String(env.DB_INSTANCE || '');
  const server = String(env.DB_SERVER || '');
  const database = String(env.DB_DATABASE || '');
  const haystack = `${instance} ${server} ${database}`.toUpperCase();
  if (FORBIDDEN_INSTANCE_TOKENS.some((x) => haystack.includes(x))) throw new Error('Destino rechazado: instancia prohibida.');
  if (client !== 'mssql') throw new Error('APPLY requiere DB_CLIENT=mssql.');
  if (!server) throw new Error('APPLY requiere DB_SERVER explícito.');
  if (instance.toUpperCase() !== 'SIFHADEV') throw new Error('APPLY requiere DB_INSTANCE=SIFHADEV.');
  if (!database || FORBIDDEN_DATABASES.map((x) => x.toUpperCase()).includes(database.toUpperCase())) throw new Error('Destino rechazado: base no permitida.');
  if (!env.MIGRATION_TARGET_DATABASE || env.MIGRATION_TARGET_DATABASE !== database) throw new Error('Defina MIGRATION_TARGET_DATABASE exactamente igual a DB_DATABASE.');
  return { server, instance, database };
}

export function toBit(value, label) {
  if (value === null || value === undefined) return value;
  if ([0, false, '0', 'false', 'FALSE'].includes(value)) return false;
  if ([1, true, '1', 'true', 'TRUE'].includes(value)) return true;
  throw new Error(`${label}: booleano legacy inválido`);
}

export function toDate(value, label) {
  if (value === null || value === undefined || value === '') return value ?? null;
  const text = String(value);
  // ISO timezone-less values are deliberately rejected: treating local time as
  // UTC would invent a timestamp. Offset-bearing ISO strings are normalized.
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(text)) throw new Error(`${label}: timestamp sin timezone`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}: timestamp inválido`);
  return new Date(Math.round(date.getTime())).toISOString();
}

// Narrow compatibility rule for the SQLite backfill in src/db.js. SQLite's
// datetime(ISO-with-Z, '+N hours') evaluates in UTC and emits a 19-character
// UTC value without a suffix. We accept it only when the stored value exactly
// equals that documented calculation from the ticket's UTC created_at.
export function normalizeLegacySlaBackfill(row) {
  const value = row?.sla_due_at;
  const hours = { CRITICAL: 4, HIGH: 24, MEDIUM: 48, LOW: 72 }[row?.priority];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) || hours === undefined) return null;
  const created = toDate(row.created_at, 'tickets.created_at');
  const expected = new Date(new Date(created).getTime() + hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  return value === expected ? `${value.replace(' ', 'T')}.000Z` : null;
}

export function sourceFingerprint(rowsByTable) {
  const counts = Object.fromEntries(TABLES.map((table) => [table, (rowsByTable[table] || []).length]));
  return crypto.createHash('sha256').update(JSON.stringify(counts)).digest('hex');
}

export function organizationFor(table, row, source, legacyOrganization = null) {
  if (GLOBAL_TABLES.has(table) || table === 'organizations') return row.organization_id ?? null;
  if (table === 'email_logs') {
    if (row.organization_id != null) return row.organization_id;
    const ticket = (source.tickets || []).find((r) => r.id === row.ticket_id);
    return ticket ? organizationFor('tickets', ticket, source, legacyOrganization) : null;
  }
  if (row.organization_id != null) return row.organization_id;
  const parent = PARENT[table];
  if (parent && row[`${parent.slice(0, -1)}_id`] != null) {
    const parentRow = (source[parent] || []).find((r) => r.id === row[`${parent.slice(0, -1)}_id`]);
    return parentRow?.organization_id ?? legacyOrganization?.marker ?? null;
  }
  return legacyOrganization?.marker ?? null;
}

export function transformRow(table, row, source, legacyOrganization = null) {
  if (SKIPPED_TABLES.has(table)) return null;
  const output = { ...row };
  for (const [column, value] of Object.entries(output)) {
    const key = `${table}.${column}`;
    if (BOOLEAN_COLUMNS.has(key)) output[column] = toBit(value, key);
    if (DATETIME_COLUMNS.has(key)) {
      const normalizedLegacySla = key === 'tickets.sla_due_at' ? normalizeLegacySlaBackfill(row) : null;
      output[column] = normalizedLegacySla ?? toDate(value, key);
    }
  }
  if (!GLOBAL_TABLES.has(table) && table !== 'organizations') {
    output.organization_id = organizationFor(table, row, source, legacyOrganization);
    if (output.organization_id == null) throw new Error(`${table}#${row.id ?? '?'}: organization_id requiere decisión explícita`);
  }
  return output;
}

export function validateSource(source, legacyOrganization = null) {
  const errors = [];
  const ids = Object.fromEntries(Object.entries(source).map(([table, rows]) => [table, new Set(rows.map((r) => r.id))]));
  for (const table of TABLES) for (const row of source[table] || []) {
    try { transformRow(table, row, source, legacyOrganization); } catch (error) { errors.push({ table, id: row.id ?? null, error: error.message }); }
  }
  const refs = [['users', 'department_id', 'departments'], ['users', 'role_id', 'roles'], ['tickets', 'reporter_id', 'users'], ['tickets', 'category_id', 'categories'], ['tickets', 'department_id', 'departments'], ['ticket_comments', 'ticket_id', 'tickets'], ['ticket_attachments', 'ticket_id', 'tickets'], ['ticket_history', 'ticket_id', 'tickets'], ['notifications', 'user_id', 'users'], ['kb_articles', 'category_id', 'kb_categories'], ['kb_ticket_articles', 'ticket_id', 'tickets'], ['kb_ticket_articles', 'article_id', 'kb_articles'], ['email_logs', 'ticket_id', 'tickets']];
  for (const [table, column, parent] of refs) for (const row of source[table] || []) {
    if (row[column] != null && !ids[parent]?.has(row[column])) errors.push({ table, id: row.id ?? null, error: `${column} referencia ${parent} inexistente` });
  }
  const duplicate = (table, columns) => {
    const seen = new Set(); for (const row of source[table] || []) { const key = columns.map((c) => row[c]).join('\u0000'); if (seen.has(key)) errors.push({ table, id: row.id ?? null, error: `duplicado ${columns.join('+')}` }); seen.add(key); }
  };
  duplicate('tickets', ['organization_id', 'ticket_number']);
  duplicate('org_settings', ['organization_id', 'key']);
  for (const table of ['departments', 'categories', 'teams', 'kb_categories']) duplicate(table, ['organization_id', 'name']);
  return errors;
}

export function sanitizeManifest(manifest) {
  const text = JSON.stringify(manifest);
  if (/password_hash|password_reset_token|token/i.test(text)) throw new Error('El manifest contiene un campo sensible.');
  return manifest;
}

export function summarizeValidationErrors(errors) {
  const summary = {};
  for (const { table, error } of errors) {
    const kind = String(error).replace(/#\d+/g, '#?');
    const key = `${table}: ${kind}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

export function buildManifest(source, target, legacyOrganization = null) {
  const manifest = { source_fingerprint: sourceFingerprint(source), target, started_at: new Date().toISOString(), tables: Object.fromEntries(TABLES.map((t) => [t, { source_count: (source[t] || []).length, planned_insert_count: SKIPPED_TABLES.has(t) ? 0 : (source[t] || []).length, inserted_count: 0, skipped_count: SKIPPED_TABLES.has(t) ? (source[t] || []).length : 0, error_count: 0 }])) };
  if (legacyOrganization) { manifest.legacy_organization = { legacy_org_code: legacyOrganization.code, planned_creation: true, associated_records: legacyOrganization.affectedTables, sequence_reconciliation: legacyOrganization.sequence }; manifest.tables.organizations.planned_insert_count = 1; }
  return sanitizeManifest(manifest);
}

export function reconciliationPlan() { return { compareCounts: TABLES.filter((t) => !SKIPPED_TABLES.has(t)), verify: ['FK integrity', 'duplicates', 'NULL violations', 'ticket sequence', 'organization isolation', 'settings parity'], checksums: ['organizations', 'roles', 'permissions', 'departments', 'categories', 'teams', 'tickets metadata', 'kb categories'] }; }

// The source sequence can lag behind old rows.  The cutover executor must use
// this maximum, never trust the legacy counter alone, and upsert it only after
// ticket rows are inserted inside the same transaction.
export function sequenceReconciliation(tickets, prefix = 'TCK') {
  const maximum = new Map();
  const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`, 'i');
  for (const ticket of tickets || []) {
    const match = pattern.exec(String(ticket.ticket_number || ''));
    if (!match || ticket.organization_id == null) continue;
    const value = Number(match[1]);
    maximum.set(ticket.organization_id, Math.max(maximum.get(ticket.organization_id) || 0, value));
  }
  return [...maximum].map(([organization_id, value]) => ({ name: `ticket_number:${organization_id}`, value }));
}
