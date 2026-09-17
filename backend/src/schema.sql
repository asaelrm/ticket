-- ============================================================================
-- Ticket Flow - Esquema de base de datos (SQLite)
-- Migraciones aplicadas de forma incremental (user_version).
-- ============================================================================

-- 1. Roles y permisos (RBAC)
CREATE TABLE IF NOT EXISTS roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  description TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- 2. Departamentos y categorías
CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  description TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#64748b',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT
);

-- 3. Usuarios
CREATE TABLE IF NOT EXISTS users (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  last_name               TEXT NOT NULL,
  username                TEXT NOT NULL UNIQUE,
  email                   TEXT NOT NULL UNIQUE,
  password_hash           TEXT NOT NULL,
  department_id           INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  position                TEXT,
  role_id                 INTEGER NOT NULL REFERENCES roles(id),
  active                  INTEGER NOT NULL DEFAULT 1,
  last_login_at           TEXT,
  last_password_change_at TEXT,
  password_reset_token    TEXT,
  password_reset_expires  TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);

-- 4. Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number  TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  reporter_id    INTEGER NOT NULL REFERENCES users(id),
  assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  priority       TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','PENDING','RESOLVED','CLOSED','CANCELLED')),
  resolved_at    TEXT,
  closed_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_tickets_reporter ON tickets(reporter_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(department_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

-- 5. Adjuntos, comentarios e historial
CREATE TABLE IF NOT EXISTS ticket_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON ticket_comments(created_at);

CREATE TABLE IF NOT EXISTS ticket_attachments (
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
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  description TEXT,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_history(ticket_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON ticket_history(created_at);

-- 6. Sesiones y secuencias
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expire INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Configuración interna (para futura tabla de settings)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);