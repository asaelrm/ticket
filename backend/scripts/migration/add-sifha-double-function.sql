/* Migración incremental de soporte central SIFHA.
   Ejecutar solo en la base de integración autorizada y con una cuenta DDL. */
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'dbo.tickets', N'U') IS NULL OR OBJECT_ID(N'dbo.users', N'U') IS NULL OR OBJECT_ID(N'dbo.organizations', N'U') IS NULL
    THROW 51000, N'Faltan tablas base requeridas para la migración SIFHA.', 1;

  IF COL_LENGTH(N'dbo.tickets', N'support_scope') IS NULL
    ALTER TABLE dbo.tickets ADD support_scope NVARCHAR(16) NOT NULL
      CONSTRAINT DF_tickets_support_scope DEFAULT (N'INTERNAL');

  IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.tickets') AND name = N'CK_tickets_support_scope')
    ALTER TABLE dbo.tickets ADD CONSTRAINT CK_tickets_support_scope
      CHECK (support_scope IN (N'INTERNAL', N'SIFHA'));

  IF OBJECT_ID(N'dbo.user_support_permissions', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.user_support_permissions (
      user_id INT NOT NULL, permission_code NVARCHAR(100) NOT NULL,
      active BIT NOT NULL CONSTRAINT DF_user_support_permissions_active DEFAULT (1),
      granted_by INT NOT NULL,
      granted_at DATETIME2(3) NOT NULL CONSTRAINT DF_user_support_permissions_granted_at DEFAULT (SYSUTCDATETIME()),
      revoked_at DATETIME2(3) NULL,
      CONSTRAINT PK_user_support_permissions PRIMARY KEY (user_id, permission_code),
      CONSTRAINT FK_user_support_permissions_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
      CONSTRAINT FK_user_support_permissions_granted_by FOREIGN KEY (granted_by) REFERENCES dbo.users(id)
    );
  END;

  IF OBJECT_ID(N'dbo.user_sifha_organizations', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.user_sifha_organizations (
      user_id INT NOT NULL, organization_id INT NOT NULL,
      active BIT NOT NULL CONSTRAINT DF_user_sifha_organizations_active DEFAULT (1),
      granted_by INT NOT NULL,
      granted_at DATETIME2(3) NOT NULL CONSTRAINT DF_user_sifha_organizations_granted_at DEFAULT (SYSUTCDATETIME()),
      revoked_at DATETIME2(3) NULL,
      CONSTRAINT PK_user_sifha_organizations PRIMARY KEY (user_id, organization_id),
      CONSTRAINT FK_user_sifha_organizations_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
      CONSTRAINT FK_user_sifha_organizations_org FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
      CONSTRAINT FK_user_sifha_organizations_granted_by FOREIGN KEY (granted_by) REFERENCES dbo.users(id)
    );
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
