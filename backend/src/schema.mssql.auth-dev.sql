-- SIFHA Tickets: esquema SQL Server DEV para autenticación (B10).
-- No crea la base ni debe ejecutarse automáticamente desde la aplicación.

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id                      INT IDENTITY(1,1) NOT NULL,
    name                    NVARCHAR(100) NOT NULL,
    last_name               NVARCHAR(100) NOT NULL,
    username                NVARCHAR(100) NOT NULL,
    email                   NVARCHAR(254) NOT NULL,
    password_hash           NVARCHAR(255) NOT NULL,
    department_id           INT NULL,
    position                NVARCHAR(255) NULL,
    role_id                 INT NOT NULL,
    active                  BIT NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
    last_login_at           DATETIME2(3) NULL,
    last_password_change_at DATETIME2(3) NULL,
    password_reset_token    NVARCHAR(64) NULL,
    password_reset_expires  DATETIME2(3) NULL,
    created_at              DATETIME2(3) NOT NULL CONSTRAINT DF_users_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at              DATETIME2(3) NULL,
    CONSTRAINT PK_users PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_users_username UNIQUE (username),
    CONSTRAINT UQ_users_email UNIQUE (email),
    CONSTRAINT FK_users_department
      FOREIGN KEY (department_id) REFERENCES dbo.departments(id) ON DELETE SET NULL,
    CONSTRAINT FK_users_role
      FOREIGN KEY (role_id) REFERENCES dbo.roles(id)
  );
END;
GO

IF OBJECT_ID(N'dbo.sessions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.sessions (
    sid    NVARCHAR(255) NOT NULL,
    sess   NVARCHAR(MAX) NOT NULL,
    expire BIGINT NOT NULL,
    CONSTRAINT PK_sessions PRIMARY KEY CLUSTERED (sid)
  );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'IX_users_department')
  CREATE INDEX IX_users_department ON dbo.users(department_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'IX_users_role')
  CREATE INDEX IX_users_role ON dbo.users(role_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.users') AND name = N'IX_users_active')
  CREATE INDEX IX_users_active ON dbo.users(active);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.sessions') AND name = N'IX_sessions_expire')
  CREATE INDEX IX_sessions_expire ON dbo.sessions(expire);
GO
