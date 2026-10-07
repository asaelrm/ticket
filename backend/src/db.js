import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// Migraciones aditivas idempotentes (SQLite no soporta ADD COLUMN IF NOT EXISTS).
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function tableExists(table) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
  );
}

/**
 * Ensures a column exists in a SQLite table. If not, it runs the ALTER TABLE statement.
 * @param {string} table - The name of the table.
 * @param {string} column - The name of the column.
 * @param {string} ddl - The column definition (e.g. 'column_name TEXT').
 */
export function ensureColumn(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// ETAPA 3: lista de índices UNIQUE de `table` cuya lista EXACTA de columnas es
// únicamente [`column`]. Se mira `PRAGMA index_info` (nunca el nombre del
// índice) para distinguir el UNIQUE global de ticket_number de
// UNIQUE(organization_id, ticket_number), que es legítimo y debe conservarse.
// Devuelve [{ name, origin }]:
//   - origin 'u' → constraint UNIQUE (de columna o de tabla) materializada
//     como autoindex: SQLite no puede quitarla in situ y exige REBUILD.
//   - origin 'c' → CREATE UNIQUE INDEX explícito: se elimina con DROP INDEX,
//     sin reconstruir la tabla.
//   - origin 'pk' → clave principal; no se toca (imposible en esta tabla).
function uniqueIndexesOn(table, column) {
  if (!tableExists(table)) return [];
  const found = [];
  for (const idx of db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all()) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all();
    if (cols.length === 1 && cols[0].name === column) {
      found.push({ name: idx.name, origin: idx.origin });
    }
  }
  return found;
}

// Índices estándar que schema.sql/db.js recrean con IF NOT EXISTS al migrar:
// no se restauran manualmente (sería redundante y rompería la idempotencia).
const STANDARD_TICKET_INDEXES = new Set([
  'idx_tickets_number_org',
  'idx_tickets_number',
  'idx_tickets_reporter',
  'idx_tickets_assigned',
  'idx_tickets_assigned_team',
  'idx_tickets_category',
  'idx_tickets_department',
  'idx_tickets_priority',
  'idx_tickets_status',
  'idx_tickets_created',
  'idx_tickets_updated',
  'idx_tickets_resolved',
  'idx_tickets_closed',
  'idx_tickets_sla_due',
  'idx_tickets_resolved_by',
  'idx_tickets_closed_by',
  'idx_tickets_cancelled_by',
  'idx_tickets_cancelled_at',
  'idx_tickets_organization',
]);

// Extrae del schema.sql el CREATE TABLE de `tickets` (la definición canónica:
// sin UNIQUE de columna sobre ticket_number y con organization_id) y lo
// reescribe como `CREATE TABLE tickets_rebuild`.
function ticketsRebuildDdl(schema) {
  const marker = 'CREATE TABLE IF NOT EXISTS tickets (';
  const start = schema.indexOf(marker);
  if (start < 0) {
    throw new Error('Migración de tickets: no se encontró la definición de tickets en schema.sql');
  }
  const open = start + marker.length - 1;
  let depth = 0;
  let end = open;
  for (let i = open; i < schema.length; i++) {
    if (schema[i] === '(') depth++;
    else if (schema[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === open) {
    throw new Error('Migración de tickets: CREATE TABLE tickets mal formado en schema.sql');
  }
  const semicolon = schema.indexOf(';', end);
  if (semicolon < 0) {
    throw new Error('Migración de tickets: CREATE TABLE tickets sin terminador en schema.sql');
  }
  return schema.slice(start, semicolon + 1).replace(marker, 'CREATE TABLE tickets_rebuild (');
}

/**
 * ETAPA 3: sustituye la tabla `tickets` legacy (UNIQUE de columna sobre
 * ticket_number) por la definición canónica. El procedimiento preserva los ids
 * y TODA la referencia de las tablas hijas (ticket_comments, ticket_history,
 * ...) porque sus constraints apuntan al NOMBRE `tickets`:
 *
 *   1. Se crea `tickets_rebuild` con el esquema nuevo.
 *   2. Se copian las filas conservando los ids (organization_id y las columnas
 *      nuevas quedan NULL y los rellena el backfill del seed, igual que con el
 *      resto de dominios).
 *   3. Se DROPEA la tabla vieja con foreign_keys OFF (no toca las filas hijas)
 *      y se renombra `tickets_rebuild` a `tickets`: las FKs hijas, que por
 *      nombre referencian `tickets`, vuelven a apuntar a la tabla reconstruida
 *      sin mover ni perder ningún dato.
 *   4. Se restauran los índices explícitos y triggers personalizados (no los
 *      estándar que schema.sql/db.js ya recrean, ni el UNIQUE global sobre
 *      ticket_number, que es el bloqueo que se elimina). Si algo no se puede
 *      restaurar, se aborta la migración con un error claro.
 *   5. foreign_key_check debe quedar limpio; si no, rollback (el DDL es
 *      transaccional, la tabla vieja se restaura intacta).
 */
function rebuildTicketsTable(schema) {
  // El UNIQUE global explícito sobre ticket_number (CREATE UNIQUE INDEX
  // legado) muere con el DROP TABLE y NO se restaura: sería exactamente el
  // bloqueo que esta migración viene a eliminar.
  const globalUniqueNames = new Set(
    uniqueIndexesOn('tickets', 'ticket_number').map((i) => i.name)
  );
  const customIndexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='tickets' AND sql IS NOT NULL")
    .all()
    .filter((r) => !STANDARD_TICKET_INDEXES.has(r.name) && !globalUniqueNames.has(r.name));
  const customTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='tickets' AND sql IS NOT NULL")
    .all();

  db.exec(ticketsRebuildDdl(schema));

  const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  const list = cols.map((c) => JSON.stringify(c)).join(', ');
  db.exec(`INSERT INTO tickets_rebuild (${list}) SELECT ${list} FROM tickets`);

  db.exec('DROP TABLE tickets');
  db.exec('ALTER TABLE tickets_rebuild RENAME TO tickets');

  // AUTOINCREMENT: DROP borra la entrada de sqlite_sequence de `tickets`; se
  // restaura explícitamente al último id para que los tickets nuevos nunca
  // reutilicen un id.
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'tickets'");
  db.exec("INSERT INTO sqlite_sequence (name, seq) SELECT 'tickets', MAX(id) FROM tickets");

  for (const idx of customIndexes) {
    if (!idx.sql) {
      throw new Error(`Migración de tickets: el índice "${idx.name}" no tiene definición restaurable`);
    }
    db.exec(idx.sql);
  }
  for (const trg of customTriggers) {
    if (!trg.sql) {
      throw new Error(`Migración de tickets: el trigger "${trg.name}" no tiene definición restaurable`);
    }
    db.exec(trg.sql);
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    throw new Error(
      `Migración de tickets: foreign_key_check detectó ${violations.length} violación(es) tras el rebuild`
    );
  }
}

export function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // ETAPA 3: bases anteriores declaraban `ticket_number TEXT NOT NULL UNIQUE`
  // como constraint de COLUMNA, o bien sobrevivía un CREATE UNIQUE INDEX
  // explícito sobre ticket_number. Con la numeración por organización (cada org
  // arranca en 000001) dos organizaciones producen legítimamente el mismo
  // número, así que la unicidad debe ser COMPUESTA
  // (organization_id, ticket_number).
  //   - Constraint de columna (origin 'u'): SQLite no puede quitarla in situ,
  //     así que la tabla se RECONSTRUYE (rebuildTicketsTable).
  //   - Índice explícito (origin 'c'): basta con DROP INDEX; no se reconstruye
  //     la tabla entera para algo que es un simple índice.
  // `PRAGMA foreign_keys` debe cambiarse FUERA de la transacción: dentro de
  // una transacción el cambio se difiere hasta el COMMIT y no afecta al DDL.
  const globalTicketUnique = uniqueIndexesOn('tickets', 'ticket_number');
  const rebuildTickets = globalTicketUnique.some((i) => i.origin === 'u');
  const dropOnlyUnique = rebuildTickets ? [] : globalTicketUnique.filter((i) => i.origin === 'c');
  if (rebuildTickets) db.exec('PRAGMA foreign_keys = OFF');

  db.exec('BEGIN');
  try {
    if (rebuildTickets) {
      rebuildTicketsTable(schema);
    } else if (dropOnlyUnique.length) {
      for (const idx of dropOnlyUnique) {
        db.exec(`DROP INDEX IF EXISTS ${JSON.stringify(idx.name)}`);
      }
    }

    // En bases existentes con esquema antiguo, las columnas aditivas deben crearse
    // ANTES de schema.sql, cuyos CREATE INDEX ya las referencian (idempotente).
    if (tableExists('tickets')) {
      ensureColumn('tickets', 'assigned_team_id', 'assigned_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
      ensureColumn('tickets', 'sla_due_at', 'sla_due_at TEXT');

      // Datos de resolución / cierre / reapertura / pendiente (flujo de trabajo).
      ensureColumn('tickets', 'resolution', 'resolution TEXT');
      ensureColumn('tickets', 'resolution_category', 'resolution_category TEXT');
      ensureColumn('tickets', 'root_cause', 'root_cause TEXT');
      ensureColumn('tickets', 'time_spent_minutes', 'time_spent_minutes INTEGER');
      ensureColumn('tickets', 'resolved_by', 'resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
      ensureColumn('tickets', 'resolved_at', 'resolved_at TEXT');
      ensureColumn('tickets', 'closed_by', 'closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
      ensureColumn('tickets', 'closed_at', 'closed_at TEXT');
      ensureColumn('tickets', 'reopened_at', 'reopened_at TEXT');
      ensureColumn('tickets', 'reopened_by', 'reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
      ensureColumn('tickets', 'reopen_reason', 'reopen_reason TEXT');
      ensureColumn('tickets', 'pending_reason', 'pending_reason TEXT');
      ensureColumn('tickets', 'resolution_notified', 'resolution_notified INTEGER NOT NULL DEFAULT 0');

      // Cancelación con motivo (flujo de cancelación).
      ensureColumn('tickets', 'cancel_reason', 'cancel_reason TEXT');
      ensureColumn('tickets', 'cancelled_by', 'cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
      ensureColumn('tickets', 'cancelled_at', 'cancelled_at TEXT');

      // Encuesta de satisfacción (CSAT).
      ensureColumn('tickets', 'csat_rating', 'csat_rating INTEGER');
      ensureColumn('tickets', 'csat_comment', 'csat_comment TEXT');
      ensureColumn('tickets', 'csat_answered_at', 'csat_answered_at TEXT');
    }

    // Nota interna vs. comentario público.
    if (tableExists('ticket_comments')) {
      ensureColumn('ticket_comments', 'is_internal', 'is_internal INTEGER NOT NULL DEFAULT 0');
    }

    // ETAPA 1A (multiempresa): organización del usuario. La columna se agrega
    // ANTES de schema.sql, cuyos CREATE INDEX y CREATE TABLE IF NOT EXISTS ya la
    // referencian (idempotente). SQLite valida la FK al hacer DML, no al añadir
    // la columna, por lo que es seguro referenciar `organizations` aunque la
    // tabla se cree justo después en schema.sql.
    if (tableExists('users')) {
      ensureColumn('users', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }

    // ETAPA 2 (aislamiento por organización): departamento organizado. Mismo
    // patrón aditivo e idempotente que users.organization_id.
    if (tableExists('departments')) {
      ensureColumn('departments', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }

    // ETAPA 3 (aislamiento completo por organización): tickets y dominios que
    // cuelgan de la organización. Las tablas hijas (ticket_comments,
    // ticket_attachments, ticket_history, kb_article_history, team_members,
    // kb_ticket_articles) NO llevan columna propia: se aíslan a través de su
    // padre (tickets, kb_articles, teams), igual que schema.sql las referencia.
    if (tableExists('tickets')) {
      ensureColumn('tickets', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }
    if (tableExists('categories')) {
      ensureColumn('categories', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }
    if (tableExists('teams')) {
      ensureColumn('teams', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }
    if (tableExists('canned_responses')) {
      ensureColumn('canned_responses', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }
    if (tableExists('kb_categories')) {
      ensureColumn('kb_categories', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }
    if (tableExists('kb_articles')) {
      ensureColumn('kb_articles', 'organization_id', 'organization_id INTEGER REFERENCES organizations(id)');
    }

    db.exec(schema);

    // Índices de columnas aditivas (idempotentes).
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team ON tickets(assigned_team_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets(sla_due_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_resolved_by ON tickets(resolved_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets(closed_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_by ON tickets(cancelled_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_at ON tickets(cancelled_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_internal ON ticket_comments(ticket_id, is_internal)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_organization ON tickets(organization_id)');
    // La unicidad de ticket_number es POR ORGANIZACIÓN. Se garantiza aquí de
    // forma explícita (idempotente) además de en schema.sql: es el índice que
    // sustituye al UNIQUE global eliminado por esta migración.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number_org ON tickets(organization_id, ticket_number)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_categories_organization ON categories(organization_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_organization ON teams(organization_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_canned_organization ON canned_responses(organization_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_categories_organization ON kb_categories(organization_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_articles_organization ON kb_articles(organization_id)');

    // Notificaciones in-app.
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        link       TEXT,
        read_at    TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)');

    // Índices de apoyo para auditoría, historial y adjuntos (evitan full scans).
    db.exec('CREATE INDEX IF NOT EXISTS idx_history_user ON ticket_history(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_user ON ticket_comments(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON ticket_attachments(uploader_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_ticket_type ON notifications(ticket_id, type)');

    // Backfill: fecha límite SLA para tickets abiertos históricos (reglas por defecto).
    db.exec(`
      UPDATE tickets SET sla_due_at =
        datetime(created_at, '+' || (
          CASE priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 24 WHEN 'MEDIUM' THEN 48 ELSE 72 END
        ) || ' hours')
      WHERE sla_due_at IS NULL
        AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')
    `);

    // Reactivar foreign_keys DESPUÉS del COMMIT: es la única posición segura.
    // Dentro de una transacción la pragma es un no-op diferido y, si se fija
    // OFF desde fuera, SQLite deja la conexión en OFF al cerrar la transacción.
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    // Tanto en éxito como en error la conexión vuelve a FK ON antes de seguir
    // (el seed posterior y las rutas dependen de la integridad referencial).
    if (rebuildTickets) db.exec('PRAGMA foreign_keys = ON');
  }
  const { user_version } = db.prepare('PRAGMA user_version').get();
  return user_version;
}

/**
 * Executes a function within a SQLite transaction.
 * @param {Function} fn - The callback to execute.
 * @returns {*} The result of the callback.
 */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export default db;

