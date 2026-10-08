import crypto from 'node:crypto';

export const FORBIDDEN_INSTANCE_TOKENS = ['HPWJA', 'ZZZSQL'];
export const FORBIDDEN_DATABASES = ['master', 'tempdb', 'model', 'msdb', 'SIFHA_Tickets_DEV'];
export const SESSION_POLICY = 'REQUIRES_DECISION';
export const LEGACY_ORG_CODE = /^[A-Z][A-Z0-9_-]{1,63}$/;
// Clave global de numeración usada por el SQLite legacy. La numeración
// multiempresa vive en `ticket_number:<organization_id>` (src/utils/ticketNumber.js).
export const LEGACY_SEQUENCE_NAME = 'ticket_number';
// Mensaje único del control de vacuidad: el driver real y el doble de pruebas
// lo comparten, y APPLY se niega a escribir si cualquier tabla tiene filas.
export const EMPTY_TARGET_ERROR = 'Destino no está vacío; APPLY se niega a continuar.';

// Política de cuentas globales, en paridad con src/orgPolicy.js. MSSQL permite
// users.organization_id NULL, pero esa apertura NO convierte a `users` en tabla
// global (no está en GLOBAL_TABLES): solo una cuenta SUPERADMIN puede ocupar el
// NULL y el precheck lo exige antes de aceptarla.
export const SUPERADMIN_ROLE_CODE = 'SUPERADMIN';
// Permiso que src/seed.js asigna a todos los roles y excluye expresamente de
// ADMIN: identifica al rol global sin depender de su id ni de su nombre.
export const SUPERADMIN_GLOBAL_PERMISSION = 'organization.manage';

export function roleFor(source, roleId) {
  if (roleId == null) return null;
  return (source.roles || []).find((role) => role.id === roleId) || null;
}

export function roleHasPermission(source, roleId, permissionCode) {
  if (roleId == null) return false;
  const granted = new Set((source.role_permissions || [])
    .filter((link) => link.role_id === roleId).map((link) => link.permission_id));
  return (source.permissions || []).some((permission) => permission.code === permissionCode && granted.has(permission.id));
}

export function isSuperadminRole(source, row) {
  const role = roleFor(source, row?.role_id);
  return !!role && role.code === SUPERADMIN_ROLE_CODE;
}

// Regla única de organización para una fila de `users`. Devuelve el mensaje de
// rechazo (sin datos personales) o null si el estado es válido:
//   - SUPERADMIN global: organization_id NULL + permiso global + sin departamento.
//   - Cualquier otro usuario: organization_id obligatorio.
export function userOrganizationError(row, source, organizationId) {
  const label = `users#${row?.id ?? '?'}`;
  const role = roleFor(source, row?.role_id);
  const isSuperadmin = !!role && role.code === SUPERADMIN_ROLE_CODE;
  if (!isSuperadmin) {
    if (organizationId == null) return `${label}: un usuario normal debe pertenecer a una organización`;
    return null;
  }
  if (organizationId != null) return `${label}: un SUPERADMIN es global; organization_id debe ser NULL`;
  if (!roleHasPermission(source, role.id, SUPERADMIN_GLOBAL_PERMISSION)) {
    return `${label}: el rol SUPERADMIN no tiene el permiso global ${SUPERADMIN_GLOBAL_PERMISSION}`;
  }
  if (row?.department_id != null) return `${label}: una cuenta global no puede pertenecer a un departamento`;
  return null;
}

export function resolveSourcePath(runtimeDbFile, explicitSource = undefined) {
  if (explicitSource !== undefined) {
    if (!explicitSource || typeof explicitSource !== 'string') throw new Error('--source requiere una ruta de archivo SQLite.');
    return explicitSource;
  }
  if (!runtimeDbFile || typeof runtimeDbFile !== 'string') throw new Error('No se pudo determinar config.dbFile del runtime SQLite.');
  return runtimeDbFile;
}

export function legacyOrganizationPlan(source, { code, name } = {}) {
  // Una cuenta SUPERADMIN global (organization_id NULL) no es un dato legacy:
  // no dispara la creación del tenant ni se asocia a él. El resto de tablas se
  // evalúan igual que siempre (ninguna fila con organización propia).
  const legacyRows = (table) => (source[table] || [])
    .filter((row) => !(table === 'users' && isSuperadminRole(source, row)));
  const hasLegacyTenantRows = ['departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'kb_categories', 'kb_articles']
    .some((table) => { const rows = legacyRows(table); return rows.length > 0 && !rows.some((row) => row.organization_id != null); });
  if (!hasLegacyTenantRows) return null;
  if (!code) throw new Error('Legacy tenant requiere --legacy-org-code explícito.');
  if (!LEGACY_ORG_CODE.test(code)) throw new Error('legacy_org_code inválido; use A-Z, 0-9, _ o -, comenzando por letra.');
  const affectedTables = Object.fromEntries(
    ['departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'ticket_comments', 'ticket_attachments', 'ticket_history', 'notifications', 'kb_categories', 'kb_articles', 'kb_article_history']
      .map((table) => [table, legacyRows(table).length]).filter(([, count]) => count > 0),
  );
  const emailLogs = (source.email_logs || []).filter((row) => row.ticket_id != null).length;
  if (emailLogs) affectedTables.email_logs = emailLogs;
  const sequence = legacySequencePlan(source.tickets || [], code, source.sequences || []);
  // Snapshot mixto: si el origen YA trae una organización con ese código, sus
  // filas sin etiquetar se resuelven contra ese ID (se conservan los IDs
  // existentes) y no se crea una segunda organización con el mismo código.
  const existing = (source.organizations || []).find((row) => row.code === code);
  if (existing) {
    const id = Number(existing.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`organizations#? : id ${existing.id} inválido para la organización ${code} existente en el origen.`);
    return { mode: 'reuse', code, name: existing.name ?? '', existingId: id, marker: `legacy-org:${code}`, affectedTables, sequence };
  }
  if (!name || !String(name).trim() || String(name).trim().length > 200) throw new Error('Legacy tenant requiere --legacy-org-name válido (1-200 caracteres).');
  return { mode: 'create', code, name: String(name).trim(), marker: `legacy-org:${code}`, affectedTables, sequence };
}

export function legacySequencePlan(tickets, organizationCode, sequences = []) {
  // Solo los tickets SIN organización propia pertenecen al tenant legacy: los que
  // ya traen organization_id numeran en su secuencia y no deben contaminarla.
  const values = (tickets || []).filter((ticket) => ticket.organization_id == null).map((ticket) => {
    const match = /-([0-9]+)$/.exec(String(ticket.ticket_number || ''));
    return match ? Number(match[1]) : null;
  }).filter(Number.isSafeInteger);
  const max = values.length ? Math.max(...values) : 0;
  const legacy = (sequences || []).find((row) => row.name === LEGACY_SEQUENCE_NAME);
  // Nunca se escribe un valor por debajo del que ya existe: el contador global
  // legacy pertenece al tenant que se está migrando, por eso se absorbe aquí.
  const counter = legacy && Number.isSafeInteger(Number(legacy.value)) && Number(legacy.value) > 0 ? Number(legacy.value) : 0;
  const reconciled = Math.max(max, counter);
  return { organization_code: organizationCode, target_sequence: `${LEGACY_SEQUENCE_NAME}:<id resuelto por code ${organizationCode}>`, max_ticket_number: max, next_ticket_number: reconciled + 1, legacy_sequence_value: legacy ? Number(legacy.value) : null, reconciled_value: reconciled };
}

// ---------------------------------------------------------------------------
// Organización legacy: creación en el destino y resolución del ID real.
//
// El destino multiempresa exige un ID numérico en cada fila tenant. El origen
// legacy no lo tiene, así que el transformador usa un marcador (`legacy-org:<code>`)
// SOLO como valor intermedio: el apply crea la organización con el código que se
// pase por línea de comandos, toma el ID que el servidor devuelve de verdad y
// vuelve a transformar con ese ID. Nunca se asume un valor (ni 1) y el código
// no está escrito en el código: lo aporta quien ejecuta la migración.
// ---------------------------------------------------------------------------
export function legacyOrganizationInsertRow(legacyOrganization, now = new Date().toISOString()) {
  if (!legacyOrganization || !legacyOrganization.code || !legacyOrganization.name) {
    throw new Error('legacyOrganizationInsertRow requiere el plan de la organización legacy.');
  }
  // toDate exige un instante con offset: no se inventa una marca de tiempo local.
  return { code: legacyOrganization.code, name: legacyOrganization.name, active: true, created_at: toDate(now, 'organizations.created_at') };
}

export function resolveLegacyOrganization(legacyOrganization, organizationId) {
  if (!legacyOrganization) throw new Error('resolveLegacyOrganization requiere el plan de la organización legacy.');
  const id = Number(organizationId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('organization_id resuelto inválido: se requiere el ID real devuelto por el destino.');
  }
  return { ...legacyOrganization, resolvedId: id };
}

// Fila de secuencia por organización con el máximo real de la organización
// (no el contador legacy, que puede ir por detrás). El valor guardado es el
// ÚLTIMO número emitido: nextTicketNumber lo incrementa antes de usarlo.
export function legacySequenceRow(legacyOrganization, organizationId) {
  const resolved = resolveLegacyOrganization(legacyOrganization, organizationId);
  const value = Number(resolved.sequence?.reconciled_value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('reconciled_value inválido para la secuencia de la organización legacy.');
  }
  return { name: `${LEGACY_SEQUENCE_NAME}:${resolved.resolvedId}`, value };
}

// Secuencias que se insertan en el destino:
// - La clave global `ticket_number` no existe en el runtime multiempresa, así
//   que nunca viaja; su valor lo absorbe la organización legacy (si la hay).
// - Por organización se guarda el MÁXIMO entre el valor ya presente en el
//   origen y el máximo REAL de los tickets que quedarán en esa organización
//   (etiquetados o heredados del tenant legacy). Nunca un valor por debajo del
//   existente ni de los números ya emitidos.
export function sequenceRowsForMigration(source, legacyOrganization = null, organizationId = null) {
  const rows = (source.sequences || []).map((row) => ({ ...row }));
  const kept = rows.filter((row) => row.name !== LEGACY_SEQUENCE_NAME);
  const maximum = new Map();
  for (const ticket of source.tickets || []) {
    const organization = organizationFor('tickets', ticket, source, legacyOrganization);
    if (!Number.isSafeInteger(organization) || organization <= 0) continue;
    const match = /-([0-9]+)$/.exec(String(ticket.ticket_number || ''));
    if (!match) continue;
    const value = Number(match[1]);
    if (value > (maximum.get(organization) || 0)) maximum.set(organization, value);
  }
  const output = kept.map((row) => {
    const match = /^ticket_number:([0-9]+)$/.exec(String(row.name));
    if (!match) return row;
    const stored = Number(row.value);
    const emitted = maximum.get(Number(match[1])) || 0;
    return { ...row, value: Math.max(Number.isSafeInteger(stored) && stored >= 0 ? stored : 0, emitted) };
  });
  if (!legacyOrganization || organizationId == null) return output;
  const legacyRow = legacySequenceRow(legacyOrganization, organizationId);
  const emitted = maximum.get(Number(organizationId)) || 0;
  const index = output.findIndex((row) => row.name === legacyRow.name);
  if (index === -1) { output.push({ ...legacyRow, value: Math.max(legacyRow.value, emitted) }); return output; }
  const stored = Number(output[index].value);
  output[index] = { ...output[index], value: Math.max(legacyRow.value, emitted, Number.isSafeInteger(stored) && stored >= 0 ? stored : 0) };
  return output;
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

// Allowlist de columnas por tabla, idéntica a src/db/mssql/schema.sql (test de
// paridad: test/migrate-schema-parity.test.js). El INSERT jamás construye un
// identificador que no esté aquí: un dato del origen no se convierte en SQL.
export const COLUMNS = {
  organizations: ['id', 'code', 'name', 'description', 'active', 'created_at', 'updated_at'],
  roles: ['id', 'code', 'name', 'description', 'active', 'created_at'],
  permissions: ['id', 'code', 'description', 'created_at'],
  role_permissions: ['role_id', 'permission_id'],
  departments: ['id', 'organization_id', 'name', 'description', 'active', 'created_at'],
  categories: ['id', 'organization_id', 'name', 'description', 'color', 'active', 'created_at', 'updated_at'],
  users: ['id', 'organization_id', 'department_id', 'role_id', 'name', 'last_name', 'username', 'email', 'password_hash', 'position', 'active', 'last_login_at', 'last_password_change_at', 'password_reset_token', 'password_reset_expires', 'created_at', 'updated_at'],
  teams: ['id', 'organization_id', 'name', 'description', 'active', 'created_at', 'updated_at'],
  team_members: ['organization_id', 'team_id', 'user_id'],
  tickets: ['id', 'organization_id', 'ticket_number', 'title', 'description', 'reporter_id', 'assigned_to_id', 'assigned_team_id', 'category_id', 'department_id', 'priority', 'status', 'sla_due_at', 'resolution', 'resolution_category', 'root_cause', 'time_spent_minutes', 'resolved_by', 'resolved_at', 'closed_by', 'closed_at', 'reopened_at', 'reopened_by', 'reopen_reason', 'pending_reason', 'resolution_notified', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'csat_rating', 'csat_comment', 'csat_answered_at', 'created_at', 'updated_at'],
  canned_responses: ['id', 'organization_id', 'title', 'body', 'scope', 'owner_id', 'team_id', 'is_active', 'use_count', 'created_at', 'updated_at'],
  ticket_comments: ['id', 'organization_id', 'ticket_id', 'user_id', 'message', 'is_internal', 'created_at', 'updated_at'],
  ticket_attachments: ['id', 'organization_id', 'ticket_id', 'comment_id', 'original_name', 'stored_name', 'mime_type', 'size_bytes', 'uploader_id', 'created_at'],
  ticket_history: ['id', 'organization_id', 'ticket_id', 'user_id', 'action', 'description', 'old_value', 'new_value', 'created_at'],
  sessions: ['sid', 'sess', 'expire'],
  sequences: ['name', 'value'],
  settings: ['key', 'value', 'updated_by', 'updated_at', 'created_at'],
  org_settings: ['organization_id', 'key', 'value', 'updated_by', 'updated_at', 'created_at'],
  email_logs: ['id', 'organization_id', 'kind', 'to_email', 'subject', 'ticket_id', 'status', 'error', 'created_at'],
  notifications: ['id', 'organization_id', 'user_id', 'ticket_id', 'type', 'title', 'body', 'link', 'read_at', 'created_at'],
  kb_categories: ['id', 'organization_id', 'name', 'description', 'color', 'active', 'created_at', 'updated_at'],
  kb_articles: ['id', 'organization_id', 'category_id', 'author_id', 'title', 'summary', 'description', 'solution', 'keywords', 'status', 'is_featured', 'view_count', 'published_at', 'created_at', 'updated_at'],
  kb_ticket_articles: ['organization_id', 'article_id', 'ticket_id', 'created_by', 'created_at'],
  kb_article_history: ['id', 'organization_id', 'article_id', 'user_id', 'action', 'field', 'old_value', 'new_value', 'created_at'],
};

export function assertAllowedColumns(table, columns) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(table)) || !COLUMNS[table]) throw new Error(`tabla ${table} no existe en el esquema destino`);
  for (const column of columns) {
    if (!/^[a-z][a-z0-9_]*$/.test(String(column)) || !COLUMNS[table].includes(column)) {
      throw new Error(`${table}: columna ${column} no existe en el esquema destino`);
    }
  }
  return columns;
}

const PARENT = {
  departments: null, categories: null, users: null, teams: null, tickets: null, canned_responses: null,
  ticket_comments: 'tickets', ticket_attachments: 'tickets', ticket_history: 'tickets',
  notifications: 'users', kb_categories: null, kb_articles: null, kb_ticket_articles: 'tickets', kb_article_history: 'kb_articles',
};

// FKs derivadas de src/db/mssql/schema.sql (test de paridad). Excluye las que
// solo apuntan a organizations: esa existencia la cubre el chequeo dedicado con
// su propio mensaje. `sameOrg` marca las FK compuestas con organization_id, las
// únicas que el esquema exige en la misma organización; las simples (role_id,
// permission_id, updated_by) solo exigen existencia porque no llevan organization_id.
export const TENANT_FKS = [
  ['role_permissions', 'role_id', 'roles', false],
  ['role_permissions', 'permission_id', 'permissions', false],
  ['users', 'department_id', 'departments', true],
  ['users', 'role_id', 'roles', false],
  ['team_members', 'team_id', 'teams', true],
  ['team_members', 'user_id', 'users', true],
  ['tickets', 'reporter_id', 'users', true],
  ['tickets', 'assigned_to_id', 'users', true],
  ['tickets', 'assigned_team_id', 'teams', true],
  ['tickets', 'category_id', 'categories', true],
  ['tickets', 'department_id', 'departments', true],
  ['tickets', 'resolved_by', 'users', true],
  ['tickets', 'closed_by', 'users', true],
  ['tickets', 'reopened_by', 'users', true],
  ['tickets', 'cancelled_by', 'users', true],
  ['canned_responses', 'owner_id', 'users', true],
  ['canned_responses', 'team_id', 'teams', true],
  ['ticket_comments', 'ticket_id', 'tickets', true],
  ['ticket_comments', 'user_id', 'users', true],
  ['ticket_attachments', 'ticket_id', 'tickets', true],
  ['ticket_attachments', 'comment_id', 'ticket_comments', true],
  ['ticket_attachments', 'uploader_id', 'users', true],
  ['ticket_history', 'ticket_id', 'tickets', true],
  ['ticket_history', 'user_id', 'users', true],
  ['settings', 'updated_by', 'users', false],
  ['org_settings', 'updated_by', 'users', false],
  ['email_logs', 'ticket_id', 'tickets', true],
  ['notifications', 'user_id', 'users', true],
  ['notifications', 'ticket_id', 'tickets', true],
  ['kb_articles', 'category_id', 'kb_categories', true],
  ['kb_articles', 'author_id', 'users', true],
  ['kb_ticket_articles', 'article_id', 'kb_articles', true],
  ['kb_ticket_articles', 'ticket_id', 'tickets', true],
  ['kb_ticket_articles', 'created_by', 'users', true],
  ['kb_article_history', 'article_id', 'kb_articles', true],
  ['kb_article_history', 'user_id', 'users', true],
];

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
  // Una cuenta SUPERADMIN global no hereda nunca la organización legacy:
  // organization_id NULL es su estado válido y lo decide el rol, no el dato.
  if (table === 'users' && row.organization_id == null) {
    return isSuperadminRole(source, row) ? null : (legacyOrganization?.resolvedId ?? legacyOrganization?.marker ?? null);
  }
  if (table === 'email_logs') {
    // El ticket es la fuente de verdad: el log notifica sobre un ticket, así que
    // su organización es la de ese ticket (etiquetada o legacy).
    const ticket = row.ticket_id == null ? null : (source.tickets || []).find((r) => r.id === row.ticket_id);
    if (ticket) return organizationFor('tickets', ticket, source, legacyOrganization);
    // Sin ticket solo vale una organización explícita del propio registro; la
    // legacy NUNCA se asigna aquí, porque sería decidir a qué tenant pertenece
    // un correo huérfano.
    return row.organization_id ?? null;
  }
  if (row.organization_id != null) return row.organization_id;
  const parent = PARENT[table];
  if (parent && row[`${parent.slice(0, -1)}_id`] != null) {
    const parentRow = (source[parent] || []).find((r) => r.id === row[`${parent.slice(0, -1)}_id`]);
    if (parentRow) return organizationFor(parent, parentRow, source, legacyOrganization);
  }
  // Resuelto (apply) → ID numérico real; sin resolver (dry-run) → marcador.
  return legacyOrganization?.resolvedId ?? legacyOrganization?.marker ?? null;
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
    // `users` es la única tabla que puede quedar con organization_id NULL y
    // solo si el rol y los permisos demuestran que es una cuenta global.
    if (table === 'users') {
      const error = userOrganizationError(row, source, output.organization_id);
      if (error) throw new Error(error);
      return output;
    }
    if (output.organization_id == null) {
      if (table === 'email_logs') {
        // Mensaje sanitizado: identifica la fila sin volcar destinatario,
        // asunto ni cuerpo del correo.
        const detail = row.ticket_id != null
          ? 'el ticket referenciado no existe en el origen, no se puede derivar organization_id'
          : 'sin ticket_id ni organization_id explícito; se requiere decisión explícita';
        throw new Error(`email_logs#${row.id ?? '?'}: ${detail}`);
      }
      throw new Error(`${table}#${row.id ?? '?'}: organization_id requiere decisión explícita`);
    }
  }
  return output;
}

// Restricciones PRIMARY KEY y UNIQUE de src/db/mssql/schema.sql, con la forma en
// que el precheck las cubre. `exempt` documenta las que NO generan chequeo y por
// qué; test/migrate-schema-parity.test.js exige paridad exacta con el DDL, de
// modo que una restricción nueva en el esquema obliga a declararla aquí.
//   - Las claves que llevan organization_id se comparan contra la organización
//     DERIVADA (marcador legacy o ID real), nunca contra la columna cruda.
//   - UQ_(organization_id, id) queda exenta: su duplicado implicaría dos filas
//     con el mismo id, ya cubierto por la PK global de la tabla.
export const UNIQUE_KEYS = {
  organizations: [{ columns: ['id'] }, { columns: ['code'] }],
  roles: [{ columns: ['id'] }, { columns: ['code'] }],
  permissions: [{ columns: ['id'] }, { columns: ['code'] }],
  role_permissions: [{ columns: ['role_id', 'permission_id'] }],
  departments: [{ columns: ['id'] }, { columns: ['organization_id', 'name'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  categories: [{ columns: ['id'] }, { columns: ['organization_id', 'name'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  users: [{ columns: ['id'] }, { columns: ['username'] }, { columns: ['email'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  teams: [{ columns: ['id'] }, { columns: ['organization_id', 'name'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  team_members: [{ columns: ['team_id', 'user_id'] }],
  tickets: [{ columns: ['id'] }, { columns: ['organization_id', 'ticket_number'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  canned_responses: [{ columns: ['id'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  ticket_comments: [{ columns: ['id'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  ticket_attachments: [{ columns: ['id'] }, { columns: ['stored_name'] }],
  ticket_history: [{ columns: ['id'] }],
  sessions: [{ columns: ['sid'], exempt: 'tabla no migrada (SKIPPED_TABLES)' }],
  sequences: [{ columns: ['name'] }],
  settings: [{ columns: ['key'] }],
  org_settings: [{ columns: ['organization_id', 'key'] }],
  email_logs: [{ columns: ['id'] }],
  notifications: [{ columns: ['id'] }],
  kb_categories: [{ columns: ['id'] }, { columns: ['organization_id', 'name'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  kb_articles: [{ columns: ['id'] }, { columns: ['organization_id', 'id'], exempt: 'implicada por la PK id' }],
  kb_ticket_articles: [{ columns: ['article_id', 'ticket_id'] }],
  kb_article_history: [{ columns: ['id'] }],
};

export function validateSource(source, legacyOrganization = null) {
  const errors = [];
  const ids = Object.fromEntries(Object.entries(source).map(([table, rows]) => [table, new Set(rows.map((r) => r.id))]));
  for (const table of TABLES) for (const row of source[table] || []) {
    try { transformRow(table, row, source, legacyOrganization); } catch (error) { errors.push({ table, id: row.id ?? null, error: error.message }); }
    // Precheck de allowlist: una columna del origen que no exista en el destino
    // nunca se inserta en silencio (perdería datos) y tampoco llega al SQL.
    const unknown = Object.keys(row).filter((column) => !COLUMNS[table]?.includes(column));
    if (unknown.length) errors.push({ table, id: row.id ?? null, error: `columna no permitida en el destino: ${unknown.join(', ')}` });
  }
  const isolationReported = new Set();
  for (const [table, column, parent, sameOrg] of TENANT_FKS) for (const row of source[table] || []) {
    if (row[column] == null) continue;
    if (!ids[parent]?.has(row[column])) { errors.push({ table, id: row.id ?? null, error: `${column} referencia ${parent} inexistente` }); continue; }
    if (!sameOrg || GLOBAL_TABLES.has(parent) || parent === 'organizations') continue;
    const parentRow = (source[parent] || []).find((r) => r.id === row[column]);
    if (!parentRow) continue;
    // Aislamiento: un hijo nunca puede quedar en una organización distinta de la
    // de su padre, ni por columna propia ni por el marcador/ID resuelto.
    const childOrganization = organizationFor(table, row, source, legacyOrganization);
    const parentOrganization = organizationFor(parent, parentRow, source, legacyOrganization);
    // Un hijo etiquetado no puede apuntar a un padre SIN organización (una
    // cuenta global): la FK compuesta (organization_id, id) del destino no
    // encontraría la clave y APPLY fallaría a mitad de escritura.
    const key = `${table}#${row.id ?? '?'}`;
    if (childOrganization != null && parentOrganization == null) {
      if (!isolationReported.has(key)) {
        isolationReported.add(key);
        errors.push({ table, id: row.id ?? null, error: `aislamiento: ${table}#${row.id ?? '?'} referencia ${parent}#${parentRow.id} sin organización` });
      }
      continue;
    }
    if (childOrganization == null || childOrganization === parentOrganization) continue;
    if (isolationReported.has(key)) continue;
    isolationReported.add(key);
    errors.push({ table, id: row.id ?? null, error: `aislamiento: organization_id ${childOrganization} difiere de ${parent}#${parentRow.id} (${parentOrganization})` });
  }
  // Un organization_id explícito debe existir en el origen: si no, la fila apunta
  // a una organización que el destino nunca recibirá (y que la FK rechazaría).
  const organizationIds = ids.organizations || new Set();
  for (const table of TABLES) {
    if (GLOBAL_TABLES.has(table) || table === 'organizations') continue;
    for (const row of source[table] || []) {
      if (row.organization_id != null && !organizationIds.has(row.organization_id)) {
        errors.push({ table, id: row.id ?? null, error: `organization_id ${row.organization_id} no existe en organizations del origen` });
      }
    }
  }
  // email_logs: la organización derivada del ticket manda. Si el registro trae
  // además una organization_id explícita, debe coincidir con la del ticket;
  // si no, el dato es ambiguo y se rechaza (nunca se reasila en silencio).
  for (const row of source.email_logs || []) {
    if (row.ticket_id == null || row.organization_id == null) continue;
    const ticket = (source.tickets || []).find((r) => r.id === row.ticket_id);
    if (!ticket) continue; // ya reportado como FK inexistente
    const ticketOrganization = organizationFor('tickets', ticket, source, legacyOrganization);
    if (ticketOrganization != null && ticketOrganization !== row.organization_id) {
      errors.push({ table: 'email_logs', id: row.id ?? null, error: `organization_id ${row.organization_id} difiere de la organización del ticket ${row.ticket_id} (${ticketOrganization})` });
    }
  }
  const duplicate = (table, columns) => {
    const seen = new Set(); for (const row of source[table] || []) {
      // La unicidad es POR ORGANIZACIÓN: se compara la organización derivada
      // (marcador legacy o ID real), no la columna cruda, vacía en el legacy.
      const values = columns.map((c) => (c === 'organization_id'
        ? (organizationFor(table, row, source, legacyOrganization) ?? row.organization_id ?? null)
        : row[c]));
      // Una clave incompleta no demuestra nada: la fila ya se rechaza por su
      // propio error de transformación, no por un duplicado inventado.
      if (values.some((value) => value == null)) continue;
      // SQL Server aplica una colación case-insensitive por defecto: dos claves
      // que solo difieren en mayúsculas también chocan en el destino.
      const key = values.map((value) => (typeof value === 'string' ? value.toLowerCase() : value)).join('\u0000');
      if (seen.has(key)) errors.push({ table, id: row.id ?? null, error: `duplicado ${columns.join('+')}` }); seen.add(key); }
  };
  // Cada restricción UNIQUE/PK de src/db/mssql/schema.sql, declarada en
  // UNIQUE_KEYS y verificada contra el DDL por test/migrate-schema-parity.test.js.
  for (const [table, keys] of Object.entries(UNIQUE_KEYS)) {
    if (SKIPPED_TABLES.has(table)) continue;
    for (const key of keys) if (!key.exempt) duplicate(table, key.columns);
  }
  return errors;
}

// Allowlist de campos del manifest: solo salen contadores y decisiones
// planificadas. Ninguna fila, ningún valor del origen, ningún secreto.
export const MANIFEST_FIELDS = {
  root: ['source_fingerprint', 'target', 'started_at', 'finished_at', 'tables', 'legacy_organization', 'precheck_errors'],
  target: ['instance', 'database'],
  table: ['source_count', 'planned_insert_count', 'inserted_count', 'skipped_count', 'error_count'],
  legacy: ['legacy_org_code', 'organization_action', 'planned_creation', 'reused_organization_id', 'resolved_organization_id', 'planned_organization_row', 'associated_records', 'sequence_reconciliation'],
  sequence: ['organization_code', 'target_sequence', 'max_ticket_number', 'next_ticket_number', 'legacy_sequence_value', 'reconciled_value', 'planned_sequence_name', 'legacy_global_sequence_rows'],
  organization_row: ['code', 'name', 'active'],
};

const pickFields = (value, fields) => {
  const output = {};
  if (!value || typeof value !== 'object') return output;
  for (const field of fields) if (Object.hasOwn(value, field)) output[field] = value[field];
  return output;
};

export function sanitizeManifest(manifest) {
  const safe = pickFields(manifest, MANIFEST_FIELDS.root);
  safe.target = pickFields(manifest.target, MANIFEST_FIELDS.target);
  safe.tables = Object.fromEntries(Object.entries(manifest.tables || {}).map(([table, counts]) => [table, pickFields(counts, MANIFEST_FIELDS.table)]));
  if (manifest.legacy_organization) {
    const legacy = pickFields(manifest.legacy_organization, MANIFEST_FIELDS.legacy);
    if (legacy.planned_organization_row) legacy.planned_organization_row = pickFields(legacy.planned_organization_row, MANIFEST_FIELDS.organization_row);
    legacy.sequence_reconciliation = pickFields(legacy.sequence_reconciliation, MANIFEST_FIELDS.sequence);
    safe.legacy_organization = legacy;
  }
  const text = JSON.stringify(safe);
  if (/password_hash|password_reset_token|token/i.test(text)) throw new Error('El manifest contiene un campo sensible.');
  return safe;
}

export function summarizeValidationErrors(errors) {
  const summary = {};
  for (const { table, error } of errors) {
    // El resumen es un identificador de error: cualquier rastro de nombre
    // sensible se enmascara para que el manifest pueda imprimirlo.
    const kind = String(error).replace(/#\d+/g, '#?').replace(/password_hash|password_reset_token|token/gi, '***');
    const key = `${table}: ${kind}`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

export function buildManifest(source, target, legacyOrganization = null) {
  const manifest = { source_fingerprint: sourceFingerprint(source), target, started_at: new Date().toISOString(), tables: Object.fromEntries(TABLES.map((t) => [t, { source_count: (source[t] || []).length, planned_insert_count: SKIPPED_TABLES.has(t) ? 0 : (source[t] || []).length, inserted_count: 0, skipped_count: SKIPPED_TABLES.has(t) ? (source[t] || []).length : 0, error_count: 0 }])) };
  const globalSequenceRows = (source.sequences || []).filter((row) => row.name === LEGACY_SEQUENCE_NAME).length;
  const organizationRows = (source.organizations || []).length;
  if (legacyOrganization) {
    const reuse = legacyOrganization.mode === 'reuse';
    // Si la organización destino ya existe en el origen, su fila de secuencia
    // también: en ese caso no se planifica una fila nueva.
    const legacySequencePresent = reuse && (source.sequences || []).some((row) => row.name === `${LEGACY_SEQUENCE_NAME}:${legacyOrganization.existingId}`);
    manifest.legacy_organization = {
      legacy_org_code: legacyOrganization.code,
      organization_action: legacyOrganization.mode,
      planned_creation: !reuse,
      reused_organization_id: reuse ? legacyOrganization.existingId : null,
      planned_organization_row: reuse ? null : { code: legacyOrganization.code, name: legacyOrganization.name, active: true },
      associated_records: legacyOrganization.affectedTables,
      sequence_reconciliation: {
        ...legacyOrganization.sequence,
        planned_sequence_name: `${LEGACY_SEQUENCE_NAME}:<organization_id>`,
        legacy_global_sequence_rows: globalSequenceRows,
      },
    };
    manifest.tables.organizations.planned_insert_count = organizationRows + (reuse ? 0 : 1);
    // La fila global legacy no viaja: se sustituye por la de la organización.
    manifest.tables.sequences.planned_insert_count = (source.sequences || []).length - globalSequenceRows + (legacySequencePresent ? 0 : 1);
  } else {
    manifest.tables.organizations.planned_insert_count = organizationRows;
    manifest.tables.sequences.planned_insert_count = (source.sequences || []).length - globalSequenceRows;
  }
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
