// Proceso hijo para test/migration-orgs-legacy.test.js (ETAPA 3): construye una
// base PRE-multiempresa con tickets y dominios asociados (categorías, equipos,
// respuestas rápidas, conocimiento) SIN organization_id y con la secuencia
// legacy de tickets ya avanzada (ticket_number = 3), aplica las migraciones y el
// seed actuales sobre ella y devuelve por stdout un JSON con el resultado de la
// verificación. No importa app.js ni toca la base de las demás pruebas: usa su
// propio DB_FILE, que llega por entorno.

import { DatabaseSync } from 'node:sqlite';

const dbFile = process.env.DB_FILE;

// 1) Base legacy: mismas tablas que una instalación anterior a ETAPA 1A/3, SIN
//    organization_id. Se incluyen los índices que db.js/schema.sql vuelven a
//    crear (IF NOT EXISTS = no-op) y todas las columnas que los índices
//    aditivos de db.js referencian.
const legacy = new DatabaseSync(dbFile);

// La base puede venir de un arranque anterior (migrada y sembrada): en ese caso
// NO se reconstruye el esquema legacy, solo se vuelve a migrar y sembrar sobre
// el MISMO archivo (doble arranque). Esto permite al test reejecutar este mismo
// fixture sobre la misma base y comprobar idempotencia sin perder datos.
const legacyDdl = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    position TEXT,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    last_password_change_at TEXT,
    password_reset_token TEXT,
    password_reset_expires TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#64748b',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT
  );
  CREATE TABLE teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT
  );
  CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE TABLE canned_responses (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    scope     TEXT NOT NULL CHECK (scope IN ('GLOBAL','PERSONAL','TEAM')),
    owner_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    team_id   INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT
  );
  CREATE TABLE tickets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number     TEXT NOT NULL UNIQUE,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    reporter_id       INTEGER NOT NULL REFERENCES users(id),
    assigned_to_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    priority          TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','PENDING','RESOLVED','CLOSED','CANCELLED')),
    sla_due_at        TEXT,
    resolution        TEXT,
    resolution_category TEXT,
    root_cause        TEXT,
    time_spent_minutes INTEGER,
    resolution_notified INTEGER NOT NULL DEFAULT 0,
    pending_reason    TEXT,
    cancel_reason     TEXT,
    cancelled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at      TEXT,
    resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at       TEXT,
    closed_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_at         TEXT,
    reopened_at       TEXT,
    reopened_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reopen_reason     TEXT,
    csat_rating       INTEGER,
    csat_comment      TEXT,
    csat_answered_at  TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT
  );
  CREATE TABLE ticket_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT
  );
  CREATE TABLE ticket_attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    comment_id    INTEGER REFERENCES ticket_comments(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL UNIQUE,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    uploader_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE ticket_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    description TEXT,
    old_value   TEXT,
    new_value   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE kb_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    color       TEXT NOT NULL DEFAULT '#64748b',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT
  );
  CREATE TABLE kb_articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL,
    description  TEXT NOT NULL,
    solution     TEXT NOT NULL,
    keywords     TEXT,
    category_id  INTEGER REFERENCES kb_categories(id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
    author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_featured  INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
    view_count   INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    published_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT
  );
  CREATE TABLE kb_ticket_articles (
    article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (article_id, ticket_id)
  );
  CREATE TABLE kb_article_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    field      TEXT,
    old_value  TEXT,
    new_value  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE sequences (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  INSERT INTO roles (code, name, description, active) VALUES ('ADMIN', 'Administrador', 'legacy', 1);
  INSERT INTO departments (name, description, active) VALUES ('IRH Legacy', 'historico', 1);
  INSERT INTO users (name, last_name, username, email, password_hash, department_id, role_id, active)
  VALUES ('Admin', 'Legacy', 'admin', 'admin@empresa.com', 'hash-de-prueba', 1, 1, 1);
  INSERT INTO categories (name, description, color, active) VALUES
    ('Incidencias Legacy', 'historico', '#2563eb', 1),
    ('Solicitudes Legacy', 'historico', '#059669', 1);
  INSERT INTO teams (name, description, active) VALUES ('Mesa Legacy', 'historico', 1);
  INSERT INTO team_members (team_id, user_id) VALUES (1, 1);
  INSERT INTO canned_responses (title, body, scope, is_active, use_count) VALUES
    ('Plantilla Global Legacy', 'Atencion inicial', 'GLOBAL', 1, 5);
  INSERT INTO canned_responses (title, body, scope, owner_id, is_active, use_count) VALUES
    ('Plantilla Personal Legacy', 'Mia', 'PERSONAL', 1, 1, 1);
  INSERT INTO tickets (ticket_number, title, description, reporter_id, category_id, priority, status)
  VALUES ('OLD-000001', 'Ticket legacy 1', 'reportado antes de la multiempresa', 1, 1, 'MEDIUM', 'OPEN');
  INSERT INTO tickets (ticket_number, title, description, reporter_id, assigned_team_id, category_id, priority, status)
  VALUES ('OLD-000002', 'Ticket legacy 2', 'asignado a equipo legacy', 1, 1, 2, 'HIGH', 'ASSIGNED');
  INSERT INTO ticket_comments (ticket_id, user_id, message) VALUES (1, 1, 'Comentario legacy');
  INSERT INTO ticket_history (ticket_id, user_id, action, description) VALUES (1, 1, 'CREATED', 'legacy');
  INSERT INTO ticket_attachments (ticket_id, original_name, stored_name, mime_type, size_bytes)
  VALUES (1, 'captura.png', 'legacy-captura.png', 'image/png', 2048);
  INSERT INTO kb_categories (name, description, color, active) VALUES ('Temas Legacy', 'historico', '#64748b', 1);
  INSERT INTO kb_articles (title, summary, description, solution, category_id, status, author_id)
  VALUES ('Articulo Legacy', 'resumen', 'descripcion', 'solucion', 1, 'PUBLISHED', 1);
  INSERT INTO kb_ticket_articles (article_id, ticket_id, created_by) VALUES (1, 1, 1);
  INSERT INTO sequences (name, value) VALUES ('ticket_number', 3);

  -- Los índices que db.js/schema.sql van a pedir de nuevo ya existen en base
  -- legacy; INSERT IF NOT EXISTS es no-op y no debe romper nada.
  CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team ON tickets(assigned_team_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets(sla_due_at);
  CREATE INDEX IF NOT EXISTS idx_tickets_resolved_by ON tickets(resolved_by);
  CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets(closed_by);
  CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_by ON tickets(cancelled_by);
  CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_at ON tickets(cancelled_at);
  CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);
  -- Índice y trigger PERSONALIZADOS (no forman parte de los estándar que
  -- schema.sql/db.js recrean): el rebuild de tickets debe preservarlos.
  CREATE INDEX idx_tickets_title ON tickets(title);
  CREATE TRIGGER trg_tickets_auto_updated
  AFTER UPDATE ON tickets
  WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
  END;
`;

// El esquema legacy solo se construye sobre una base sin migrar. Si la base ya
// tiene tickets.organization_id (primer arranque completado), se omite y se
// pasa directamente a migración + seed: el MISMO fixture es idempotente y
// admite el doble arranque sobre el mismo archivo.
const alreadyOrg = legacy
  .prepare('PRAGMA table_info(tickets)')
  .all()
  .some((c) => c.name === 'organization_id');
if (!alreadyOrg) legacy.exec(legacyDdl);
legacy.close();

// 2) Migraciones y seed reales sobre esa base (DB_FILE ya está fijado).
const { runMigrations } = await import('../../src/db.js');
const { seed } = await import('../../src/seed.js');
runMigrations();
seed();
seed(); // idempotencia

const db = (await import('../../src/db.js')).default;

const uce = db.prepare('SELECT id FROM organizations WHERE code = ?').get('UCE');
const uceId = uce?.id ?? null;

const colOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function orphans(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id IS NULL`).get().n;
}
function inUce(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`).get(uceId).n;
}

const legacyTickets = orphans('tickets');
const legacyCats = orphans('categories');
const legacyTeams = orphans('teams');
const legacyCanned = orphans('canned_responses');
const legacyKbCats = orphans('kb_categories');
const legacyKbArts = orphans('kb_articles');

// La columna es una FK real: una categoría con organización inexistente debe
// violar la constraint (PRAGMA foreign_keys = ON que activa db.js).
let fkOk = false;
try {
  db.prepare('INSERT INTO categories (name, description, color, organization_id) VALUES (?, ?, ?, ?)')
    .run('FK invalida', '', '#ffffff', 999999);
  db.prepare('DELETE FROM categories WHERE name = ?').run('FK invalida');
} catch {
  fkOk = true;
}

// Unicidad compuesta (ETAPA 3): la numeración es por organización, así que el
// UNIQUE de COLUMNA de la era legacy debe haber desaparecido y quedar solo el
// índice compuesto (organization_id, ticket_number). Un número repetido dentro
// de la misma organización sigue violando la unicidad; el mismo número en otra
// organización es legítimo.
const autoIndex = db
  .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name LIKE 'sqlite_autoindex_tickets%'")
  .get();
const numberOrgIndex = db
  .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_tickets_number_org'")
  .get();

// Rebuild de tickets (ETAPA 3): la reconstrucción debe 1) conservar los ids y
// las filas hijas (adjuntos han de seguir intactos), 2) recrear los objetos
// personalizados (índice/trigger no estándar), 3) dejar foreign_key_check
// limpio y 4) restaurar sqlite_sequence al max(id). Se mide ANTES que las
// pruebas de unicidad, que insertan y borran tickets y ensuciarían las cuentas.
const idsKept = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE id IN (1, 2)').get().n;
const attachmentsTotal = db.prepare('SELECT COUNT(*) AS n FROM ticket_attachments').get().n;
const customIndexKept = Boolean(
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_tickets_title'").get()
);
const customTriggerKept = Boolean(
  db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='trigger' AND name='trg_tickets_auto_updated'").get()
);
const fkCheckOk = db.prepare('PRAGMA foreign_key_check').all().length === 0;
const seqOk = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get('tickets')?.seq
  === db.prepare('SELECT MAX(id) AS m FROM tickets').get().m;

// El trigger reconstruido sigue vivo: un UPDATE sin updated_at lo fija
// (el WHEN NEW.updated_at IS NULL evita recursión).
let triggerWorks = false;
try {
  db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run('Ticket legacy 1 (tocado)', 1);
  const row = db.prepare('SELECT updated_at FROM tickets WHERE id = 1').get();
  triggerWorks = Boolean(row?.updated_at);
} catch {
  triggerWorks = false;
}

function tryInsertTicket(ticketNumber, organizationId) {
  try {
    db.prepare(
      'INSERT INTO tickets (ticket_number, title, description, reporter_id, organization_id) VALUES (?, ?, ?, ?, ?)'
    ).run(ticketNumber, `Duplicado ${organizationId}`, 'prueba de unicidad', 1, organizationId);
    return true;
  } catch {
    return false;
  }
}
const dupSameOrgThrows = !tryInsertTicket('OLD-000001', uceId);
const newOrgId = db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1) RETURNING id')
  .get('PRUEBA_ORG', 'Organización para unicidad', 'prueba').id;
const dupOtherOrgAllowed = tryInsertTicket('OLD-000001', newOrgId);
db.prepare('DELETE FROM tickets WHERE title LIKE ?').run('Duplicado %');
db.exec("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM tickets) WHERE name = 'tickets'");
db.prepare('DELETE FROM organizations WHERE id = ?').run(newOrgId);

// Continuidad de numeración: la secuencia legacy (3) se hereda a la clave por
// organización de UCE; el siguiente ticket debe ser 4. La comprobación es de
// LECTURA pura: nextTicketNumber() CONSUME la secuencia (persiste el +1) y
// rompería la idempotencia del doble arranque sobre el mismo archivo.
const legacySeq = db.prepare("SELECT value FROM sequences WHERE name = 'ticket_number'").get()?.value ?? null;
const uceSeq = db.prepare('SELECT value FROM sequences WHERE name = ?').get(`ticket_number:${uceId}`)?.value ?? null;
const prefix = (db.prepare("SELECT value FROM settings WHERE key = 'ticket_prefix'").get()?.value ?? 'TCK').toUpperCase();
const nextNumber = `${prefix}-${String((uceSeq ?? 0) + 1).padStart(6, '0')}`;

const counts = {
  ticketsTotal: db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
  ticketsUce: inUce('tickets'),
  categoriesUce: inUce('categories'),
  teamsUce: inUce('teams'),
  cannedUce: inUce('canned_responses'),
  kbCategoriesUce: inUce('kb_categories'),
  kbArticlesUce: inUce('kb_articles'),
  usersTotal: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
};

console.log(JSON.stringify({
  hasColumn: {
    tickets: colOf('tickets').includes('organization_id'),
    categories: colOf('categories').includes('organization_id'),
    teams: colOf('teams').includes('organization_id'),
    canned_responses: colOf('canned_responses').includes('organization_id'),
    kb_categories: colOf('kb_categories').includes('organization_id'),
    kb_articles: colOf('kb_articles').includes('organization_id'),
  },
  uceId,
  orphanBackfill: {
    tickets: legacyTickets,
    categories: legacyCats,
    teams: legacyTeams,
    canned_responses: legacyCanned,
    kb_categories: legacyKbCats,
    kb_articles: legacyKbArts,
  },
  counts,
  fkOk,
  numbering: { legacySeq, uceSeq, nextNumber },
  numberUnique: {
    constraintColumnRemoved: !autoIndex,
    compositeIndex: Boolean(numberOrgIndex),
    dupSameOrgThrows,
    dupOtherOrgAllowed,
  },
  rebuild: {
    idsKept,
    attachmentsTotal,
    customIndexKept,
    customTriggerKept,
    triggerWorks,
    fkCheckOk,
    seqOk,
  },
}));