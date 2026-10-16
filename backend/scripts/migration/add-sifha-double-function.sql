/* Migración incremental: permiso acumulativo de soporte central SIFHA.
   Aplicar únicamente sobre una base previamente verificada y autorizada. */

IF COL_LENGTH(N'dbo.tickets', N'support_scope') IS NULL
BEGIN
  ALTER TABLE dbo.tickets ADD support_scope NVARCHAR(16) NOT NULL
    CONSTRAINT DF_tickets_support_scope DEFAULT (N'INTERNAL');
  ALTER TABLE dbo.tickets ADD CONSTRAINT CK_tickets_support_scope
    CHECK (support_scope IN (N'INTERNAL', N'SIFHA'));
END;

IF OBJECT_ID(N'dbo.user_support_permissions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.user_support_permissions (
    user_id INT NOT NULL,
    permission_code NVARCHAR(100) NOT NULL,
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
    user_id INT NOT NULL,
    organization_id INT NOT NULL,
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
