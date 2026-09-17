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

export function ensureColumn(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(schema);

    // Columnas nuevas en tickets (aditivas, solo si faltan).
    ensureColumn('tickets', 'assigned_team_id', 'assigned_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
    ensureColumn('tickets', 'sla_due_at', 'sla_due_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team ON tickets(assigned_team_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets(sla_due_at)');

    // Datos de resolución / cierre / reapertura / pendiente (flujo de trabajo).
    ensureColumn('tickets', 'resolution', 'resolution TEXT');
    ensureColumn('tickets', 'resolution_category', 'resolution_category TEXT');
    ensureColumn('tickets', 'root_cause', 'root_cause TEXT');
    ensureColumn('tickets', 'time_spent_minutes', 'time_spent_minutes INTEGER');
    ensureColumn('tickets', 'resolved_by', 'resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    ensureColumn('tickets', 'closed_by', 'closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    ensureColumn('tickets', 'reopened_at', 'reopened_at TEXT');
    ensureColumn('tickets', 'reopened_by', 'reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
    ensureColumn('tickets', 'reopen_reason', 'reopen_reason TEXT');
    ensureColumn('tickets', 'pending_reason', 'pending_reason TEXT');
    ensureColumn('tickets', 'resolution_notified', 'resolution_notified INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_resolved_by ON tickets(resolved_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets(closed_by)');

    // Nota interna vs. comentario público.
    ensureColumn('ticket_comments', 'is_internal', 'is_internal INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_internal ON ticket_comments(ticket_id, is_internal)');

    // Backfill: fecha límite SLA para tickets abiertos históricos (reglas por defecto).
    db.exec(`
      UPDATE tickets SET sla_due_at =
        datetime(created_at, '+' || (
          CASE priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 24 WHEN 'MEDIUM' THEN 48 ELSE 72 END
        ) || ' hours')
      WHERE sla_due_at IS NULL
        AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')
    `);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const { user_version } = db.prepare('PRAGMA user_version').get();
  return user_version;
}

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