-- VERSIÓN SEGURA - SOLO PARA SIFHA_Tickets_M5_Integration_Test
-- NO MODIFICAR EL SCRIPT ORIGINAL
-- Revisado para ejecución controlada

SET NOCOUNT ON;
IF DB_NAME() <> 'SIFHA_Tickets_M5_Integration_Test'
BEGIN
  RAISERROR('DB_NAME() = %s - DEBE SER SIFHA_Tickets_M5_Integration_Test. ABORTANDO.', 16, 1, DB_NAME());
  RETURN;
END

SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'dbo.users', N'U') IS NULL OR OBJECT_ID(N'dbo.organizations', N'U') IS NULL OR OBJECT_ID(N'dbo.roles', N'U') IS NULL
    THROW 51000, N'Faltan tablas base requeridas para las asignaciones de empresa.', 1;

  IF OBJECT_ID(N'dbo.user_organizations', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.user_organizations (
      user_id INT NOT NULL, organization_id INT NOT NULL, role_id INT NOT NULL,
      active BIT NOT NULL CONSTRAINT DF_user_organizations_active DEFAULT (1),
      assigned_by INT NULL,
      assigned_at DATETIME2(3) NOT NULL CONSTRAINT DF_user_organizations_assigned_at DEFAULT (SYSUTCDATETIME()),
      revoked_at DATETIME2(3) NULL,
      CONSTRAINT PK_user_organizations PRIMARY KEY (user_id, organization_id),
      CONSTRAINT FK_user_organizations_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
      CONSTRAINT FK_user_organizations_org FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
      CONSTRAINT FK_user_organizations_role FOREIGN KEY (role_id) REFERENCES dbo.roles(id),
      CONSTRAINT FK_user_organizations_assigned_by FOREIGN KEY (assigned_by) REFERENCES dbo.users(id)
    );
  END;

  IF OBJECT_ID(N'dbo.user_organization_history', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.user_organization_history (
      id INT IDENTITY(1,1) NOT NULL, user_id INT NOT NULL, organization_id INT NOT NULL,
      role_id INT NULL, action NVARCHAR(30) NOT NULL, changed_by INT NOT NULL,
      changed_at DATETIME2(3) NOT NULL CONSTRAINT DF_user_organization_history_changed_at DEFAULT (SYSUTCDATETIME()),
      CONSTRAINT PK_user_organization_history PRIMARY KEY (id),
      CONSTRAINT FK_user_organization_history_user FOREIGN KEY (user_id) REFERENCES dbo.users(id),
      CONSTRAINT FK_user_organization_history_org FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
      CONSTRAINT FK_user_organization_history_role FOREIGN KEY (role_id) REFERENCES dbo.roles(id),
      CONSTRAINT FK_user_organization_history_changed_by FOREIGN KEY (changed_by) REFERENCES dbo.users(id)
    );
  END;

  INSERT dbo.user_organizations (user_id, organization_id, role_id, assigned_by)
  SELECT u.id, u.organization_id, u.role_id, NULL FROM dbo.users u
  WHERE u.organization_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dbo.user_organizations x WHERE x.user_id = u.id AND x.organization_id = u.organization_id);

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;

