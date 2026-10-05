-- SIFHA Tickets: esquema SQL Server DEV para roles y permisos (B8).
-- No crea la base ni debe ejecutarse automáticamente desde la aplicación.
-- Ejecútelo únicamente conectado a SIFHA_Tickets_DEV con una identidad administrativa.

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;
GO

IF OBJECT_ID(N'dbo.roles', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.roles (
    id          INT IDENTITY(1,1) NOT NULL,
    code        NVARCHAR(100) NOT NULL,
    name        NVARCHAR(200) NOT NULL,
    description NVARCHAR(MAX) NULL,
    active      BIT NOT NULL CONSTRAINT DF_roles_active DEFAULT (1),
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_roles_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_roles PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_roles_code UNIQUE (code)
  );
END;
GO

IF OBJECT_ID(N'dbo.permissions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.permissions (
    id          INT IDENTITY(1,1) NOT NULL,
    code        NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX) NULL,
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_permissions_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_permissions PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_permissions_code UNIQUE (code)
  );
END;
GO

IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.role_permissions (
    role_id       INT NOT NULL,
    permission_id INT NOT NULL,
    CONSTRAINT PK_role_permissions PRIMARY KEY CLUSTERED (role_id, permission_id),
    CONSTRAINT FK_role_permissions_role
      FOREIGN KEY (role_id) REFERENCES dbo.roles(id) ON DELETE CASCADE,
    CONSTRAINT FK_role_permissions_permission
      FOREIGN KEY (permission_id) REFERENCES dbo.permissions(id) ON DELETE CASCADE
  );

END;
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.role_permissions')
    AND name = N'IX_role_permissions_permission_id'
)
BEGIN
  CREATE INDEX IX_role_permissions_permission_id
    ON dbo.role_permissions(permission_id);
END;
GO
