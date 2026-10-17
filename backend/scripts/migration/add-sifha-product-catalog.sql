/* Catálogo central SIFHA. Ejecutar únicamente por un administrador SQL. */
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  IF OBJECT_ID(N'dbo.sifha_systems', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.sifha_systems (
      id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_sifha_systems PRIMARY KEY,
      code NVARCHAR(80) NOT NULL,
      name NVARCHAR(200) NOT NULL,
      description NVARCHAR(MAX) NULL,
      active BIT NOT NULL CONSTRAINT DF_sifha_systems_active DEFAULT (1),
      created_at DATETIME2(3) NOT NULL CONSTRAINT DF_sifha_systems_created_at DEFAULT (SYSUTCDATETIME()),
      updated_at DATETIME2(3) NULL,
      CONSTRAINT UQ_sifha_systems_code UNIQUE (code)
    );
  END;
  IF OBJECT_ID(N'dbo.organization_sifha_systems', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.organization_sifha_systems (
      id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_organization_sifha_systems PRIMARY KEY,
      organization_id INT NOT NULL,
      sifha_system_id INT NOT NULL,
      active BIT NOT NULL CONSTRAINT DF_organization_sifha_systems_active DEFAULT (1),
      assigned_by INT NULL,
      created_at DATETIME2(3) NOT NULL CONSTRAINT DF_organization_sifha_systems_created_at DEFAULT (SYSUTCDATETIME()),
      updated_at DATETIME2(3) NULL,
      CONSTRAINT UQ_organization_sifha_systems_pair UNIQUE (organization_id, sifha_system_id),
      CONSTRAINT FK_organization_sifha_systems_org FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
      CONSTRAINT FK_organization_sifha_systems_system FOREIGN KEY (sifha_system_id) REFERENCES dbo.sifha_systems(id),
      CONSTRAINT FK_organization_sifha_systems_assigned_by FOREIGN KEY (assigned_by) REFERENCES dbo.users(id)
    );
  END;
  IF COL_LENGTH(N'dbo.tickets', N'sifha_system_id') IS NULL
    ALTER TABLE dbo.tickets ADD sifha_system_id INT NULL;
  IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_tickets_sifha_system')
    ALTER TABLE dbo.tickets ADD CONSTRAINT FK_tickets_sifha_system FOREIGN KEY (sifha_system_id) REFERENCES dbo.sifha_systems(id);
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_organization_sifha_systems_active')
    CREATE INDEX IX_organization_sifha_systems_active ON dbo.organization_sifha_systems(organization_id, active, sifha_system_id);
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_sifha_system')
    CREATE INDEX IX_tickets_sifha_system ON dbo.tickets(sifha_system_id);
  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
