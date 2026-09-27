-- ============================================================================
-- Ticket - Esquema de base de datos (SQLite)
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
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number           TEXT NOT NULL UNIQUE,
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL,
  reporter_id             INTEGER NOT NULL REFERENCES users(id),
  assigned_to_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_team_id        INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  category_id             INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  department_id           INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  priority                TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                  TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','PENDING','RESOLVED','CLOSED','CANCELLED')),
  sla_due_at              TEXT,
  resolution              TEXT,
  resolution_category     TEXT,
  root_cause              TEXT,
  time_spent_minutes      INTEGER,
  resolved_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at             TEXT,
  closed_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at               TEXT,
  reopened_at             TEXT,
  reopened_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reopen_reason           TEXT,
  pending_reason          TEXT,
  resolution_notified     INTEGER NOT NULL DEFAULT 0,
  cancel_reason           TEXT,
  cancelled_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at            TEXT,
  csat_rating             INTEGER,
  csat_comment            TEXT,
  csat_answered_at        TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_tickets_reporter ON tickets(reporter_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team ON tickets(assigned_team_id);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(department_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at);
CREATE INDEX IF NOT EXISTS idx_tickets_resolved ON tickets(resolved_at);
CREATE INDEX IF NOT EXISTS idx_tickets_closed ON tickets(closed_at);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets(sla_due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_resolved_by ON tickets(resolved_by);
CREATE INDEX IF NOT EXISTS idx_tickets_closed_by ON tickets(closed_by);
CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_by ON tickets(cancelled_by);
CREATE INDEX IF NOT EXISTS idx_tickets_cancelled_at ON tickets(cancelled_at);

-- 4b. Equipos de trabajo
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- 4c. Respuestas rápidas (plantillas de respuesta reutilizables)
-- Tres ámbitos: GLOBAL (compartida por la organización), PERSONAL (del dueño) y
-- TEAM (visible para los miembros actuales del equipo). El CHECK de consistencia
-- impide combinaciones inválidas (p. ej. GLOBAL con owner_id, TEAM sin team_id).
-- No hay borrado físico: la baja es lógica con is_active para conservar use_count.
CREATE TABLE IF NOT EXISTS canned_responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('GLOBAL','PERSONAL','TEAM')),
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  use_count  INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT,
  CHECK (length(trim(title)) > 0 AND length(title) <= 100),
  CHECK (length(trim(body)) > 0 AND length(body) <= 2000),
  CHECK (
    (scope = 'GLOBAL'   AND owner_id IS NULL     AND team_id IS NULL) OR
    (scope = 'PERSONAL' AND owner_id IS NOT NULL AND team_id IS NULL) OR
    (scope = 'TEAM'     AND owner_id IS NULL     AND team_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_canned_scope_active ON canned_responses(scope, is_active);
CREATE INDEX IF NOT EXISTS idx_canned_owner ON canned_responses(owner_id);
CREATE INDEX IF NOT EXISTS idx_canned_team ON canned_responses(team_id);
CREATE INDEX IF NOT EXISTS idx_canned_usage ON canned_responses(use_count DESC);

-- 5. Adjuntos, comentarios e historial
CREATE TABLE IF NOT EXISTS ticket_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON ticket_comments(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_internal ON ticket_comments(ticket_id, is_internal);

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
-- El recuento de adjuntos por comentario es una subconsulta correlacionada que
-- se ejecuta una vez por cada comentario del ticket, y el borrado de los
-- adjuntos de un comentario filtra por esta columna.
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON ticket_attachments(comment_id);

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

-- 7. Bitácora de correos enviados (notificaciones)
CREATE TABLE IF NOT EXISTS email_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  status     TEXT NOT NULL,           -- smtp | dev | error
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_ticket ON email_logs(ticket_id);

-- 8. Notificaciones in-app
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
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- 9. Base de conocimiento
-- A diferencia de canned_responses, aquí NO hay una columna de ámbito (scope):
-- el ciclo de vida del artículo ya aporta la visibilidad. Un DRAFT es privado
-- por definición (solo su autor), un PUBLISHED es público para quien tenga
-- kb.view y un ARCHIVED sale de los listados públicos sin desaparecer de la
-- gestión. Así se evita la dimensión ortogonal scope/team_id y todo lo que
-- arrastra (filtros, selectores, comprobaciones de consistencia).
--
-- El autor se borra con SET NULL y no con CASCADE (a diferencia de
-- canned_responses.owner_id): el conocimiento de la organización no debe
-- destruirse al dar de baja a un empleado. La UI muestra "Autor eliminado".
--
-- El contenido se guarda VERBATIM: el escapado ocurre al renderizar, nunca al
-- almacenar. Coherente con canned_responses.body y con su prueba de regresión.
CREATE TABLE IF NOT EXISTS kb_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#64748b',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  description  TEXT NOT NULL,
  solution     TEXT NOT NULL,
  keywords     TEXT,
  category_id  INTEGER REFERENCES kb_categories(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_featured  INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
  view_count   INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT,
  CHECK (length(trim(title)) > 0       AND length(title)       <= 200),
  CHECK (length(trim(summary)) > 0     AND length(summary)     <= 500),
  CHECK (length(trim(description)) > 0 AND length(description) <= 20000),
  CHECK (length(trim(solution)) > 0    AND length(solution)    <= 20000)
);
CREATE INDEX IF NOT EXISTS idx_kb_articles_status      ON kb_articles(status);
CREATE INDEX IF NOT EXISTS idx_kb_articles_category    ON kb_articles(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_articles_author      ON kb_articles(author_id);
CREATE INDEX IF NOT EXISTS idx_kb_articles_popular     ON kb_articles(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_kb_articles_published   ON kb_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_articles_status_date ON kb_articles(status, published_at DESC);

-- Relación muchos-a-muchos artículo <-> ticket. CASCADE en ambos lados porque
-- un enlace no significa nada sin las dos filas. Sustituye a una columna
-- source_ticket_id redundante y aporta navegación bidireccional.
-- No hay ninguna sincronización automática: el enlace es solo una relación.
CREATE TABLE IF NOT EXISTS kb_ticket_articles (
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_ticket_articles_ticket ON kb_ticket_articles(ticket_id);

-- Auditoría ligera: quién cambió qué campo y cuándo. old_value/new_value
-- guardan un RECORTE legible, nunca el cuerpo completo del artículo, para no
-- inflar la tabla. Las instantáneas de contenido quedan fuera de esta versión.
CREATE TABLE IF NOT EXISTS kb_article_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_history_article ON kb_article_history(article_id);
CREATE INDEX IF NOT EXISTS idx_kb_history_created ON kb_article_history(created_at);