-- SIFHA Tickets: esquema SQL Server DEV (B2).
-- Este archivo crea SOLAMENTE dbo.departments y no crea la base de datos.
-- Ejecútelo conectado expresamente a SIFHA_Tickets_DEV.

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;
GO

IF OBJECT_ID(N'dbo.departments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.departments (
    id          INT IDENTITY(1,1) NOT NULL,
    name        NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX) NULL,
    active      BIT NOT NULL CONSTRAINT DF_departments_active DEFAULT (1),
    created_at  DATETIME2(3) NOT NULL CONSTRAINT DF_departments_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_departments PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_departments_name UNIQUE (name)
  );
END;
GO
