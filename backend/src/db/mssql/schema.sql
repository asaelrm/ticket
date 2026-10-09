-- SIFHA MSSQL target schema (M2).
-- Base schema for an empty database. It is intentionally not idempotent and is
-- not executed by the application. Future migration tooling owns deployment and
-- controlled IDENTITY_INSERT during the SQLite -> MSSQL data migration.
-- No CREATE/DROP DATABASE, credentials, seed data, or tenant-specific values.

-- 0. Global organization and RBAC catalog.
CREATE TABLE dbo.organizations (
  id INT IDENTITY(1,1) NOT NULL,
  code NVARCHAR(50) NOT NULL,
  name NVARCHAR(200) NOT NULL,
  description NVARCHAR(MAX) NULL,
  active BIT NOT NULL CONSTRAINT DF_organizations_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_organizations_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_organizations PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_organizations_code UNIQUE (code)
);

CREATE TABLE dbo.roles (
  id INT IDENTITY(1,1) NOT NULL,
  code NVARCHAR(100) NOT NULL,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(MAX) NULL,
  active BIT NOT NULL CONSTRAINT DF_roles_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_roles_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_roles PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_roles_code UNIQUE (code)
);

CREATE TABLE dbo.permissions (
  id INT IDENTITY(1,1) NOT NULL,
  code NVARCHAR(100) NOT NULL,
  description NVARCHAR(MAX) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_permissions_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_permissions PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_permissions_code UNIQUE (code)
);

CREATE TABLE dbo.role_permissions (
  role_id INT NOT NULL,
  permission_id INT NOT NULL,
  CONSTRAINT PK_role_permissions PRIMARY KEY CLUSTERED (role_id, permission_id),
  CONSTRAINT FK_role_permissions_role FOREIGN KEY (role_id) REFERENCES dbo.roles(id) ON DELETE CASCADE,
  CONSTRAINT FK_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES dbo.permissions(id) ON DELETE CASCADE
);

-- Tenant catalogs. New MSSQL data is always organization-scoped; SQLite's
-- nullable legacy columns are migration compatibility only.
CREATE TABLE dbo.departments (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(MAX) NULL,
  active BIT NOT NULL CONSTRAINT DF_departments_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_departments_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_departments PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_departments_organization_name UNIQUE (organization_id, name),
  CONSTRAINT UQ_departments_organization_id UNIQUE (organization_id, id),
  CONSTRAINT FK_departments_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
);

CREATE TABLE dbo.categories (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(MAX) NULL,
  color NVARCHAR(7) NOT NULL CONSTRAINT DF_categories_color DEFAULT (N'#64748b'),
  active BIT NOT NULL CONSTRAINT DF_categories_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_categories_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_categories PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_categories_organization_name UNIQUE (organization_id, name),
  CONSTRAINT UQ_categories_organization_id UNIQUE (organization_id, id),
  CONSTRAINT CK_categories_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  CONSTRAINT FK_categories_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
);

CREATE TABLE dbo.users (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NULL,
  department_id INT NULL,
  role_id INT NOT NULL,
  name NVARCHAR(150) NOT NULL,
  last_name NVARCHAR(150) NOT NULL,
  username NVARCHAR(150) NOT NULL,
  email NVARCHAR(320) NOT NULL,
  password_hash NVARCHAR(500) NOT NULL,
  position NVARCHAR(200) NULL,
  active BIT NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
  last_login_at DATETIME2(3) NULL,
  last_password_change_at DATETIME2(3) NULL,
  password_reset_token NVARCHAR(500) NULL,
  password_reset_expires DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_users_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_users PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_users_username UNIQUE (username),
  CONSTRAINT UQ_users_email UNIQUE (email),
  CONSTRAINT UQ_users_organization_id UNIQUE (organization_id, id),
  CONSTRAINT FK_users_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
  CONSTRAINT FK_users_department_same_org FOREIGN KEY (organization_id, department_id)
    REFERENCES dbo.departments(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_users_role FOREIGN KEY (role_id) REFERENCES dbo.roles(id) ON DELETE NO ACTION
);

CREATE TABLE dbo.teams (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(MAX) NULL,
  active BIT NOT NULL CONSTRAINT DF_teams_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_teams_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_teams PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_teams_organization_name UNIQUE (organization_id, name),
  CONSTRAINT UQ_teams_organization_id UNIQUE (organization_id, id),
  CONSTRAINT FK_teams_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
);

-- organization_id on the membership is deliberate: it lets both composite FKs
-- prove that a user cannot be a member of a team from another organization.
CREATE TABLE dbo.team_members (
  organization_id INT NOT NULL,
  team_id INT NOT NULL,
  user_id INT NOT NULL,
  CONSTRAINT PK_team_members PRIMARY KEY CLUSTERED (team_id, user_id),
  CONSTRAINT FK_team_members_team_same_org FOREIGN KEY (organization_id, team_id)
    REFERENCES dbo.teams(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT FK_team_members_user_same_org FOREIGN KEY (organization_id, user_id)
    REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

-- 4. Tenant tickets. Composite FKs are the DB backstop for server-side scope.
CREATE TABLE dbo.tickets (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  ticket_number NVARCHAR(32) NOT NULL,
  title NVARCHAR(300) NOT NULL,
  description NVARCHAR(MAX) NOT NULL,
  reporter_id INT NOT NULL,
  assigned_to_id INT NULL,
  assigned_team_id INT NULL,
  category_id INT NULL,
  department_id INT NULL,
  priority NVARCHAR(16) NOT NULL CONSTRAINT DF_tickets_priority DEFAULT (N'MEDIUM'),
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_tickets_status DEFAULT (N'OPEN'),
  sla_due_at DATETIME2(3) NULL,
  resolution NVARCHAR(MAX) NULL,
  resolution_category NVARCHAR(200) NULL,
  root_cause NVARCHAR(500) NULL,
  time_spent_minutes INT NULL,
  resolved_by INT NULL,
  resolved_at DATETIME2(3) NULL,
  closed_by INT NULL,
  closed_at DATETIME2(3) NULL,
  reopened_at DATETIME2(3) NULL,
  reopened_by INT NULL,
  reopen_reason NVARCHAR(MAX) NULL,
  pending_reason NVARCHAR(500) NULL,
  resolution_notified BIT NOT NULL CONSTRAINT DF_tickets_resolution_notified DEFAULT (0),
  cancel_reason NVARCHAR(MAX) NULL,
  cancelled_by INT NULL,
  cancelled_at DATETIME2(3) NULL,
  csat_rating TINYINT NULL,
  csat_comment NVARCHAR(MAX) NULL,
  csat_answered_at DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_tickets_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_tickets PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_tickets_organization_ticket_number UNIQUE (organization_id, ticket_number),
  CONSTRAINT UQ_tickets_organization_id UNIQUE (organization_id, id),
  CONSTRAINT CK_tickets_priority CHECK (priority IN (N'LOW', N'MEDIUM', N'HIGH', N'CRITICAL')),
  CONSTRAINT CK_tickets_status CHECK (status IN (N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING', N'RESOLVED', N'CLOSED', N'CANCELLED')),
  CONSTRAINT CK_tickets_time_spent CHECK (time_spent_minutes IS NULL OR time_spent_minutes >= 0),
  CONSTRAINT CK_tickets_csat_rating CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5),
  CONSTRAINT FK_tickets_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_reporter_same_org FOREIGN KEY (organization_id, reporter_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_assigned_user_same_org FOREIGN KEY (organization_id, assigned_to_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_team_same_org FOREIGN KEY (organization_id, assigned_team_id) REFERENCES dbo.teams(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_category_same_org FOREIGN KEY (organization_id, category_id) REFERENCES dbo.categories(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_department_same_org FOREIGN KEY (organization_id, department_id) REFERENCES dbo.departments(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_resolved_by_same_org FOREIGN KEY (organization_id, resolved_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_closed_by_same_org FOREIGN KEY (organization_id, closed_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_reopened_by_same_org FOREIGN KEY (organization_id, reopened_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_tickets_cancelled_by_same_org FOREIGN KEY (organization_id, cancelled_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.canned_responses (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  title NVARCHAR(100) NOT NULL,
  body NVARCHAR(2000) NOT NULL,
  scope NVARCHAR(10) NOT NULL,
  owner_id INT NULL,
  team_id INT NULL,
  is_active BIT NOT NULL CONSTRAINT DF_canned_responses_active DEFAULT (1),
  use_count INT NOT NULL CONSTRAINT DF_canned_responses_use_count DEFAULT (0),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_canned_responses_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_canned_responses PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_canned_responses_organization_id UNIQUE (organization_id, id),
  CONSTRAINT CK_canned_responses_scope CHECK (scope IN (N'GLOBAL', N'PERSONAL', N'TEAM')),
  CONSTRAINT CK_canned_responses_title CHECK (LEN(LTRIM(RTRIM(title))) BETWEEN 1 AND 100),
  CONSTRAINT CK_canned_responses_body CHECK (LEN(LTRIM(RTRIM(body))) BETWEEN 1 AND 2000),
  CONSTRAINT CK_canned_responses_use_count CHECK (use_count >= 0),
  CONSTRAINT CK_canned_responses_scope_links CHECK (
    (scope = N'GLOBAL' AND owner_id IS NULL AND team_id IS NULL) OR
    (scope = N'PERSONAL' AND owner_id IS NOT NULL AND team_id IS NULL) OR
    (scope = N'TEAM' AND owner_id IS NULL AND team_id IS NOT NULL)
  ),
  CONSTRAINT FK_canned_responses_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
  CONSTRAINT FK_canned_responses_owner_same_org FOREIGN KEY (organization_id, owner_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_canned_responses_team_same_org FOREIGN KEY (organization_id, team_id) REFERENCES dbo.teams(organization_id, id) ON DELETE NO ACTION
);

-- Child tables retain organization_id to make their tenant scope indexable and
-- enforceable. ticket_id remains the authoritative parent relationship.
CREATE TABLE dbo.ticket_comments (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  ticket_id INT NOT NULL,
  user_id INT NULL,
  message NVARCHAR(MAX) NOT NULL,
  is_internal BIT NOT NULL CONSTRAINT DF_ticket_comments_internal DEFAULT (0),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_comments_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_ticket_comments PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_ticket_comments_organization_id UNIQUE (organization_id, id),
  CONSTRAINT FK_ticket_comments_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT FK_ticket_comments_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.ticket_attachments (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  ticket_id INT NOT NULL,
  comment_id INT NULL,
  original_name NVARCHAR(500) NOT NULL,
  stored_name NVARCHAR(500) NOT NULL,
  mime_type NVARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploader_id INT NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_attachments_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_ticket_attachments PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_ticket_attachments_stored_name UNIQUE (stored_name),
  CONSTRAINT CK_ticket_attachments_size CHECK (size_bytes >= 0),
  CONSTRAINT FK_ticket_attachments_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
  -- NO ACTION prevents SQL Server's multiple cascade path ticket -> comments -> attachments.
  CONSTRAINT FK_ticket_attachments_comment_same_org FOREIGN KEY (organization_id, comment_id) REFERENCES dbo.ticket_comments(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_ticket_attachments_uploader_same_org FOREIGN KEY (organization_id, uploader_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.ticket_history (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  ticket_id INT NOT NULL,
  user_id INT NULL,
  action NVARCHAR(100) NOT NULL,
  description NVARCHAR(MAX) NULL,
  old_value NVARCHAR(MAX) NULL,
  new_value NVARCHAR(MAX) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_history_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_ticket_history PRIMARY KEY CLUSTERED (id),
  CONSTRAINT FK_ticket_history_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT FK_ticket_history_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

-- System/session tables are global infrastructure.
CREATE TABLE dbo.sessions (
  sid NVARCHAR(255) NOT NULL,
  sess NVARCHAR(MAX) NOT NULL,
  expire BIGINT NOT NULL,
  CONSTRAINT PK_sessions PRIMARY KEY CLUSTERED (sid)
);

CREATE TABLE dbo.sequences (
  name NVARCHAR(150) NOT NULL,
  value BIGINT NOT NULL,
  CONSTRAINT PK_sequences PRIMARY KEY CLUSTERED (name),
  CONSTRAINT CK_sequences_value CHECK (value >= 0)
);

CREATE TABLE dbo.settings (
  [key] NVARCHAR(100) NOT NULL,
  value NVARCHAR(MAX) NULL,
  updated_by INT NULL,
  updated_at DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_settings_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_settings PRIMARY KEY CLUSTERED ([key]),
  CONSTRAINT FK_settings_updated_by FOREIGN KEY (updated_by) REFERENCES dbo.users(id) ON DELETE SET NULL
);

CREATE TABLE dbo.org_settings (
  organization_id INT NOT NULL,
  [key] NVARCHAR(100) NOT NULL,
  value NVARCHAR(MAX) NOT NULL,
  updated_by INT NULL,
  updated_at DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_org_settings_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_org_settings PRIMARY KEY CLUSTERED (organization_id, [key]),
  -- This is the only organization cascade; other tenant history uses NO ACTION.
  CONSTRAINT FK_org_settings_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE CASCADE,
  CONSTRAINT FK_org_settings_updated_by FOREIGN KEY (updated_by) REFERENCES dbo.users(id) ON DELETE SET NULL
);

CREATE TABLE dbo.email_logs (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NULL,
  kind NVARCHAR(100) NOT NULL,
  to_email NVARCHAR(320) NOT NULL,
  subject NVARCHAR(500) NOT NULL,
  ticket_id INT NULL,
  status NVARCHAR(20) NOT NULL,
  error NVARCHAR(MAX) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_email_logs_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_email_logs PRIMARY KEY CLUSTERED (id),
  CONSTRAINT CK_email_logs_status CHECK (status IN (N'smtp', N'dev', N'error')),
  CONSTRAINT FK_email_logs_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.notifications (
  id INT IDENTITY(1,1) NOT NULL,
  -- organization_id es NULL solo para avisos globales legítimos dirigidos a una
  -- cuenta SUPERADMIN sin organización. Una notificación ligada a un ticket
  -- SIEMPRE pertenece a la organización del ticket (lo exige el CHECK y la FK).
  organization_id INT NULL,
  user_id INT NOT NULL,
  ticket_id INT NULL,
  type NVARCHAR(100) NOT NULL,
  title NVARCHAR(500) NOT NULL,
  body NVARCHAR(500) NULL,
  link NVARCHAR(500) NULL,
  read_at DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_notifications_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_notifications PRIMARY KEY CLUSTERED (id),
  CONSTRAINT CK_notifications_ticket_requires_org CHECK (organization_id IS NOT NULL OR ticket_id IS NULL),
  CONSTRAINT FK_notifications_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_notifications_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE
);

-- 9. Tenant knowledge base.
CREATE TABLE dbo.kb_categories (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  name NVARCHAR(150) NOT NULL,
  description NVARCHAR(MAX) NULL,
  color NVARCHAR(7) NOT NULL CONSTRAINT DF_kb_categories_color DEFAULT (N'#64748b'),
  active BIT NOT NULL CONSTRAINT DF_kb_categories_active DEFAULT (1),
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_categories_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_kb_categories PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_kb_categories_organization_name UNIQUE (organization_id, name),
  CONSTRAINT UQ_kb_categories_organization_id UNIQUE (organization_id, id),
  CONSTRAINT CK_kb_categories_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  CONSTRAINT FK_kb_categories_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
);

CREATE TABLE dbo.kb_articles (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  category_id INT NULL,
  author_id INT NULL,
  title NVARCHAR(200) NOT NULL,
  summary NVARCHAR(500) NOT NULL,
  description NVARCHAR(MAX) NOT NULL,
  solution NVARCHAR(MAX) NOT NULL,
  keywords NVARCHAR(MAX) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_kb_articles_status DEFAULT (N'DRAFT'),
  is_featured BIT NOT NULL CONSTRAINT DF_kb_articles_featured DEFAULT (0),
  view_count INT NOT NULL CONSTRAINT DF_kb_articles_view_count DEFAULT (0),
  published_at DATETIME2(3) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_articles_created_at DEFAULT (SYSUTCDATETIME()),
  updated_at DATETIME2(3) NULL,
  CONSTRAINT PK_kb_articles PRIMARY KEY CLUSTERED (id),
  CONSTRAINT UQ_kb_articles_organization_id UNIQUE (organization_id, id),
  CONSTRAINT CK_kb_articles_status CHECK (status IN (N'DRAFT', N'PUBLISHED', N'ARCHIVED')),
  CONSTRAINT CK_kb_articles_view_count CHECK (view_count >= 0),
  CONSTRAINT CK_kb_articles_title CHECK (LEN(LTRIM(RTRIM(title))) BETWEEN 1 AND 200),
  CONSTRAINT CK_kb_articles_summary CHECK (LEN(LTRIM(RTRIM(summary))) BETWEEN 1 AND 500),
  CONSTRAINT FK_kb_articles_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
  CONSTRAINT FK_kb_articles_category_same_org FOREIGN KEY (organization_id, category_id) REFERENCES dbo.kb_categories(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_kb_articles_author_same_org FOREIGN KEY (organization_id, author_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.kb_ticket_articles (
  organization_id INT NOT NULL,
  article_id INT NOT NULL,
  ticket_id INT NOT NULL,
  created_by INT NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_ticket_articles_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_kb_ticket_articles PRIMARY KEY CLUSTERED (article_id, ticket_id),
  CONSTRAINT FK_kb_ticket_articles_article_same_org FOREIGN KEY (organization_id, article_id) REFERENCES dbo.kb_articles(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT FK_kb_ticket_articles_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE NO ACTION,
  CONSTRAINT FK_kb_ticket_articles_creator_same_org FOREIGN KEY (organization_id, created_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

CREATE TABLE dbo.kb_article_history (
  id INT IDENTITY(1,1) NOT NULL,
  organization_id INT NOT NULL,
  article_id INT NOT NULL,
  user_id INT NULL,
  action NVARCHAR(100) NOT NULL,
  field NVARCHAR(100) NULL,
  old_value NVARCHAR(MAX) NULL,
  new_value NVARCHAR(MAX) NULL,
  created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_article_history_created_at DEFAULT (SYSUTCDATETIME()),
  CONSTRAINT PK_kb_article_history PRIMARY KEY CLUSTERED (id),
  CONSTRAINT FK_kb_article_history_article_same_org FOREIGN KEY (organization_id, article_id) REFERENCES dbo.kb_articles(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT FK_kb_article_history_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
);

-- Query indexes; integrity constraints above remain separate from performance.
CREATE INDEX IX_organizations_active ON dbo.organizations(active);
CREATE INDEX IX_users_organization_active ON dbo.users(organization_id, active);
CREATE INDEX IX_users_department ON dbo.users(department_id);
CREATE INDEX IX_tickets_org_status_priority ON dbo.tickets(organization_id, status, priority);
CREATE INDEX IX_tickets_org_assigned ON dbo.tickets(organization_id, assigned_to_id);
CREATE INDEX IX_tickets_org_created ON dbo.tickets(organization_id, created_at DESC);
CREATE INDEX IX_tickets_org_sla_due ON dbo.tickets(organization_id, sla_due_at);
CREATE INDEX IX_tickets_org_category ON dbo.tickets(organization_id, category_id);
CREATE INDEX IX_tickets_org_department ON dbo.tickets(organization_id, department_id);
CREATE INDEX IX_team_members_user ON dbo.team_members(organization_id, user_id);
CREATE INDEX IX_canned_responses_org_scope_active ON dbo.canned_responses(organization_id, scope, is_active);
CREATE INDEX IX_ticket_comments_org_ticket_internal ON dbo.ticket_comments(organization_id, ticket_id, is_internal);
CREATE INDEX IX_ticket_attachments_org_ticket ON dbo.ticket_attachments(organization_id, ticket_id);
CREATE INDEX IX_ticket_attachments_comment ON dbo.ticket_attachments(comment_id);
CREATE INDEX IX_ticket_history_org_ticket_created ON dbo.ticket_history(organization_id, ticket_id, created_at DESC);
CREATE INDEX IX_sessions_expire ON dbo.sessions(expire);
CREATE INDEX IX_email_logs_org_created ON dbo.email_logs(organization_id, created_at DESC);
CREATE INDEX IX_notifications_org_user_read ON dbo.notifications(organization_id, user_id, read_at);
CREATE INDEX IX_notifications_org_ticket ON dbo.notifications(organization_id, ticket_id);
CREATE INDEX IX_kb_articles_org_status_published ON dbo.kb_articles(organization_id, status, published_at DESC);
CREATE INDEX IX_kb_articles_org_category ON dbo.kb_articles(organization_id, category_id);
CREATE INDEX IX_kb_ticket_articles_ticket ON dbo.kb_ticket_articles(organization_id, ticket_id);
CREATE INDEX IX_kb_article_history_article ON dbo.kb_article_history(organization_id, article_id, created_at DESC);
