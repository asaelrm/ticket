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

export function ensureColumn(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec('BEGIN');
  try {
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

    db.exec(schema);

    // Índices de columnas aditivas (idempotentes).
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team ON tickets(assigned_team_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets(sla_due_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_resolved_by ON tickets(resolved_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets(closed_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_by ON tickets(cancelled_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_at ON tickets(cancelled_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_comments_internal ON ticket_comments(ticket_id, is_internal)');

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