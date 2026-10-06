-- C1: permisos temporales minimos para sifha_migration_dev.
-- Ejecutar manualmente solo en SIFHA_Tickets_DEV por un administrador autorizado.

USE [SIFHA_Tickets_DEV];
GO

SET NOCOUNT ON;

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;

IF USER_ID(N'sifha_migration_dev') IS NULL
  THROW 50001, 'No existe el usuario de base sifha_migration_dev.', 1;

DECLARE @requiredTables TABLE (name sysname NOT NULL PRIMARY KEY);
INSERT INTO @requiredTables (name)
VALUES (N'users'), (N'roles'), (N'permissions'), (N'role_permissions'), (N'departments'), (N'sessions');

IF EXISTS (
  SELECT 1
  FROM @requiredTables AS required
  WHERE OBJECT_ID(N'dbo.' + required.name, N'U') IS NULL
)
  THROW 50002, 'Falta una tabla protegida requerida en dbo; no se concedieron permisos.', 1;

IF DATABASE_PRINCIPAL_ID(N'c1_deploy_temp') IS NULL
BEGIN
  PRINT N'[C1-GRANT] Creando rol c1_deploy_temp.';
  CREATE ROLE [c1_deploy_temp] AUTHORIZATION [dbo];
END
ELSE
  PRINT N'[C1-GRANT] El rol c1_deploy_temp ya existe; se reutiliza.';

PRINT N'[C1-GRANT] Concediendo permisos temporales C1.';
GRANT CREATE TABLE TO [c1_deploy_temp];
GRANT ALTER ON SCHEMA::[dbo] TO [c1_deploy_temp];

-- REFERENCES es un permiso distinto de ALTER y no lo implica: SQL Server lo
-- exige sobre la TABLA REFERENCIADA al declarar una FK (error 229). Las tablas
-- nuevas de C1 (teams, categories, tickets, ticket_comments) todavia no existen
-- en este punto, asi que el alcance sobre el esquema dbo es el unico que cubre
-- tambien las referencias entre tablas creadas por el propio C1. No concede
-- SELECT/INSERT/UPDATE/ALTER sobre nada.
GRANT REFERENCES ON SCHEMA::[dbo] TO [c1_deploy_temp];

GRANT SELECT ON OBJECT::dbo.[users] TO [c1_deploy_temp];
GRANT SELECT ON OBJECT::dbo.[roles] TO [c1_deploy_temp];
GRANT SELECT ON OBJECT::dbo.[permissions] TO [c1_deploy_temp];
GRANT SELECT ON OBJECT::dbo.[role_permissions] TO [c1_deploy_temp];
GRANT SELECT ON OBJECT::dbo.[departments] TO [c1_deploy_temp];
GRANT SELECT ON OBJECT::dbo.[sessions] TO [c1_deploy_temp];

GRANT REFERENCES ON OBJECT::dbo.[users] TO [c1_deploy_temp];
GRANT REFERENCES ON OBJECT::dbo.[departments] TO [c1_deploy_temp];

IF NOT EXISTS (
  SELECT 1
  FROM sys.database_role_members AS drm
  JOIN sys.database_principals AS role_principal ON role_principal.principal_id = drm.role_principal_id
  JOIN sys.database_principals AS member_principal ON member_principal.principal_id = drm.member_principal_id
  WHERE role_principal.name = N'c1_deploy_temp'
    AND member_principal.name = N'sifha_migration_dev'
)
BEGIN
  ALTER ROLE [c1_deploy_temp] ADD MEMBER [sifha_migration_dev];
  PRINT N'[C1-GRANT] sifha_migration_dev agregado al rol temporal.';
END
ELSE
  PRINT N'[C1-GRANT] sifha_migration_dev ya era miembro del rol temporal.';

PRINT N'[C1-GRANT] Completado. No se otorgaron permisos a sifha_ticket_dev.';
