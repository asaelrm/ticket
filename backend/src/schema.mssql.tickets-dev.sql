-- SIFHA Tickets: esquema SQL Server DEV para infraestructura de tickets (C1).
--
-- Este archivo no crea la base ni debe ejecutarse automáticamente desde la
-- aplicación. Es DDL idempotente para SIFHA_Tickets_DEV; no siembra datos.

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;

-- CREATE TABLE/INDEX es transaccional en SQL Server. Mantener todo C1 en una
-- transacción evita dejar un esquema parcialmente creado si una dependencia
-- existente o una constraint impide completar el despliegue.
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

-- Catálogos requeridos antes de crear tickets.
IF OBJECT_ID(N'dbo.categories', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.categories (
    id          INT IDENTITY(1,1) NOT NULL,
    name        NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX) NULL,
    color       NVARCHAR(7) NOT NULL CONSTRAINT DF_categories_color DEFAULT (N'#64748b'),
    active      BIT NOT NULL CONSTRAINT DF_categories_active DEFAULT (1),
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_categories_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at  DATETIME2(3) NULL,
    CONSTRAINT PK_categories PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_categories_name UNIQUE (name)
  );
END;

-- Secuencia funcional para ticket_number. C2 sembrará ticket_number = 0.
IF OBJECT_ID(N'dbo.sequences', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sequences (
    name  NVARCHAR(100) NOT NULL,
    value BIGINT NOT NULL,
    CONSTRAINT PK_sequences PRIMARY KEY CLUSTERED (name),
    CONSTRAINT CK_sequences_value_nonnegative CHECK (value >= 0)
  );
END;

IF OBJECT_ID(N'dbo.settings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.settings (
    [key]      NVARCHAR(100) NOT NULL,
    value      NVARCHAR(MAX) NULL,
    updated_by INT NULL,
    updated_at DATETIME2(3) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_settings_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_settings PRIMARY KEY CLUSTERED ([key]),
    CONSTRAINT FK_settings_updated_by
      FOREIGN KEY (updated_by) REFERENCES dbo.users(id) ON DELETE SET NULL
  );
END;

IF OBJECT_ID(N'dbo.teams', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.teams (
    id          INT IDENTITY(1,1) NOT NULL,
    name        NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX) NULL,
    active      BIT NOT NULL CONSTRAINT DF_teams_active DEFAULT (1),
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_teams_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at  DATETIME2(3) NULL,
    CONSTRAINT PK_teams PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_teams_name UNIQUE (name)
  );
END;

IF OBJECT_ID(N'dbo.team_members', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.team_members (
    team_id INT NOT NULL,
    user_id INT NOT NULL,
    CONSTRAINT PK_team_members PRIMARY KEY CLUSTERED (team_id, user_id),
    CONSTRAINT FK_team_members_team
      FOREIGN KEY (team_id) REFERENCES dbo.teams(id) ON DELETE CASCADE,
    CONSTRAINT FK_team_members_user
      FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
  );
END;

IF OBJECT_ID(N'dbo.tickets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.tickets (
    id                    INT IDENTITY(1,1) NOT NULL,
    ticket_number         NVARCHAR(32) NOT NULL,
    title                 NVARCHAR(200) NOT NULL,
    description           NVARCHAR(MAX) NOT NULL,
    reporter_id           INT NOT NULL,
    assigned_to_id        INT NULL,
    assigned_team_id      INT NULL,
    category_id           INT NULL,
    department_id         INT NULL,
    priority              NVARCHAR(10) NOT NULL CONSTRAINT DF_tickets_priority DEFAULT (N'MEDIUM'),
    status                NVARCHAR(16) NOT NULL CONSTRAINT DF_tickets_status DEFAULT (N'OPEN'),
    sla_due_at            DATETIME2(3) NULL,
    resolution            NVARCHAR(MAX) NULL,
    resolution_category   NVARCHAR(120) NULL,
    root_cause            NVARCHAR(120) NULL,
    time_spent_minutes    INT NULL,
    resolved_by           INT NULL,
    resolved_at           DATETIME2(3) NULL,
    closed_by             INT NULL,
    closed_at             DATETIME2(3) NULL,
    reopened_at           DATETIME2(3) NULL,
    reopened_by           INT NULL,
    reopen_reason         NVARCHAR(2000) NULL,
    pending_reason        NVARCHAR(2000) NULL,
    resolution_notified   BIT NOT NULL CONSTRAINT DF_tickets_resolution_notified DEFAULT (0),
    cancel_reason         NVARCHAR(2000) NULL,
    cancelled_by          INT NULL,
    cancelled_at          DATETIME2(3) NULL,
    csat_rating           INT NULL,
    csat_comment          NVARCHAR(2000) NULL,
    csat_answered_at      DATETIME2(3) NULL,
    created_at            DATETIME2(3) NOT NULL CONSTRAINT DF_tickets_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at            DATETIME2(3) NULL,
    CONSTRAINT PK_tickets PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_tickets_ticket_number UNIQUE (ticket_number),
    -- Los usuarios no se desvinculan automáticamente: SQL Server no permite
    -- múltiples acciones cascada/SET NULL hacia esta tabla.
    CONSTRAINT FK_tickets_reporter FOREIGN KEY (reporter_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT FK_tickets_assigned_to FOREIGN KEY (assigned_to_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT FK_tickets_assigned_team FOREIGN KEY (assigned_team_id) REFERENCES dbo.teams(id) ON DELETE SET NULL,
    CONSTRAINT FK_tickets_category FOREIGN KEY (category_id) REFERENCES dbo.categories(id) ON DELETE SET NULL,
    CONSTRAINT FK_tickets_department FOREIGN KEY (department_id) REFERENCES dbo.departments(id) ON DELETE SET NULL,
    CONSTRAINT FK_tickets_resolved_by FOREIGN KEY (resolved_by) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT FK_tickets_closed_by FOREIGN KEY (closed_by) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT FK_tickets_reopened_by FOREIGN KEY (reopened_by) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT FK_tickets_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT CK_tickets_priority CHECK (priority IN (N'LOW', N'MEDIUM', N'HIGH', N'CRITICAL')),
    CONSTRAINT CK_tickets_status CHECK (status IN (N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING', N'RESOLVED', N'CLOSED', N'CANCELLED')),
    CONSTRAINT CK_tickets_time_spent_minutes CHECK (time_spent_minutes IS NULL OR time_spent_minutes BETWEEN 0 AND 100000),
    CONSTRAINT CK_tickets_csat_rating CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5)
  );
END;

IF OBJECT_ID(N'dbo.ticket_comments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ticket_comments (
    id          INT IDENTITY(1,1) NOT NULL,
    ticket_id   INT NOT NULL,
    user_id     INT NULL,
    message     NVARCHAR(4000) NOT NULL,
    is_internal BIT NOT NULL CONSTRAINT DF_ticket_comments_is_internal DEFAULT (0),
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_comments_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at  DATETIME2(3) NULL,
    CONSTRAINT PK_ticket_comments PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_ticket_comments_ticket FOREIGN KEY (ticket_id) REFERENCES dbo.tickets(id) ON DELETE CASCADE,
    CONSTRAINT FK_ticket_comments_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE SET NULL
  );
END;

IF OBJECT_ID(N'dbo.ticket_history', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ticket_history (
    id          INT IDENTITY(1,1) NOT NULL,
    ticket_id   INT NOT NULL,
    user_id     INT NULL,
    action      NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX) NULL,
    old_value   NVARCHAR(MAX) NULL,
    new_value   NVARCHAR(MAX) NULL,
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_history_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ticket_history PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_ticket_history_ticket FOREIGN KEY (ticket_id) REFERENCES dbo.tickets(id) ON DELETE CASCADE,
    CONSTRAINT FK_ticket_history_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE SET NULL
  );
END;

IF OBJECT_ID(N'dbo.ticket_attachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ticket_attachments (
    id            INT IDENTITY(1,1) NOT NULL,
    ticket_id     INT NOT NULL,
    comment_id    INT NULL,
    original_name NVARCHAR(255) NOT NULL,
    stored_name   NVARCHAR(255) NOT NULL,
    mime_type     NVARCHAR(100) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    uploader_id   INT NULL,
    created_at    DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_attachments_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ticket_attachments PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_ticket_attachments_stored_name UNIQUE (stored_name),
    CONSTRAINT FK_ticket_attachments_ticket FOREIGN KEY (ticket_id) REFERENCES dbo.tickets(id) ON DELETE CASCADE,
    -- Un ticket sigue eliminando adjuntos directamente. Un comentario con
    -- adjuntos debe limpiarlos explícitamente antes de poder eliminarse.
    CONSTRAINT FK_ticket_attachments_comment FOREIGN KEY (comment_id) REFERENCES dbo.ticket_comments(id) ON DELETE NO ACTION,
    CONSTRAINT FK_ticket_attachments_uploader FOREIGN KEY (uploader_id) REFERENCES dbo.users(id) ON DELETE SET NULL
  );
END;

IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.notifications (
    id         INT IDENTITY(1,1) NOT NULL,
    user_id    INT NOT NULL,
    ticket_id  INT NULL,
    type       NVARCHAR(100) NOT NULL,
    title      NVARCHAR(200) NOT NULL,
    body       NVARCHAR(500) NULL,
    link       NVARCHAR(2048) NULL,
    read_at    DATETIME2(3) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_notifications_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_notifications PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_notifications_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
    CONSTRAINT FK_notifications_ticket FOREIGN KEY (ticket_id) REFERENCES dbo.tickets(id) ON DELETE CASCADE
  );
END;

-- Índices de lectura y FK. Los PK/UQ ya cubren id, ticket_number y stored_name.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.team_members') AND name = N'IX_team_members_user')
  CREATE INDEX IX_team_members_user ON dbo.team_members(user_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_reporter') CREATE INDEX IX_tickets_reporter ON dbo.tickets(reporter_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_assigned') CREATE INDEX IX_tickets_assigned ON dbo.tickets(assigned_to_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_assigned_team') CREATE INDEX IX_tickets_assigned_team ON dbo.tickets(assigned_team_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_category') CREATE INDEX IX_tickets_category ON dbo.tickets(category_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_department') CREATE INDEX IX_tickets_department ON dbo.tickets(department_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_priority') CREATE INDEX IX_tickets_priority ON dbo.tickets(priority);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_status') CREATE INDEX IX_tickets_status ON dbo.tickets(status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_created') CREATE INDEX IX_tickets_created ON dbo.tickets(created_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_updated') CREATE INDEX IX_tickets_updated ON dbo.tickets(updated_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_resolved') CREATE INDEX IX_tickets_resolved ON dbo.tickets(resolved_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_closed') CREATE INDEX IX_tickets_closed ON dbo.tickets(closed_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_sla_due') CREATE INDEX IX_tickets_sla_due ON dbo.tickets(sla_due_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_resolved_by') CREATE INDEX IX_tickets_resolved_by ON dbo.tickets(resolved_by);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_closed_by') CREATE INDEX IX_tickets_closed_by ON dbo.tickets(closed_by);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_cancelled_by') CREATE INDEX IX_tickets_cancelled_by ON dbo.tickets(cancelled_by);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.tickets') AND name = N'IX_tickets_cancelled_at') CREATE INDEX IX_tickets_cancelled_at ON dbo.tickets(cancelled_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_comments') AND name = N'IX_ticket_comments_ticket') CREATE INDEX IX_ticket_comments_ticket ON dbo.ticket_comments(ticket_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_comments') AND name = N'IX_ticket_comments_ticket_internal') CREATE INDEX IX_ticket_comments_ticket_internal ON dbo.ticket_comments(ticket_id, is_internal);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_comments') AND name = N'IX_ticket_comments_created') CREATE INDEX IX_ticket_comments_created ON dbo.ticket_comments(created_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_history') AND name = N'IX_ticket_history_ticket') CREATE INDEX IX_ticket_history_ticket ON dbo.ticket_history(ticket_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_history') AND name = N'IX_ticket_history_created') CREATE INDEX IX_ticket_history_created ON dbo.ticket_history(created_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_attachments') AND name = N'IX_ticket_attachments_ticket') CREATE INDEX IX_ticket_attachments_ticket ON dbo.ticket_attachments(ticket_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.ticket_attachments') AND name = N'IX_ticket_attachments_comment') CREATE INDEX IX_ticket_attachments_comment ON dbo.ticket_attachments(comment_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.notifications') AND name = N'IX_notifications_user_read') CREATE INDEX IX_notifications_user_read ON dbo.notifications(user_id, read_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.notifications') AND name = N'IX_notifications_created') CREATE INDEX IX_notifications_created ON dbo.notifications(created_at);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
