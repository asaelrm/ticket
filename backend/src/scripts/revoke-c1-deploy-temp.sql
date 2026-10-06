-- C1: retiro de permisos temporales concedidos por grant-c1-deploy-temp.sql.
-- Ejecutar manualmente solo en SIFHA_Tickets_DEV por un administrador autorizado.

USE [SIFHA_Tickets_DEV];
GO

SET NOCOUNT ON;

IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;

IF DATABASE_PRINCIPAL_ID(N'c1_deploy_temp') IS NULL
BEGIN
  PRINT N'[C1-REVOKE] El rol c1_deploy_temp no existe; no hay nada que retirar.';
  RETURN;
END;

IF USER_ID(N'sifha_migration_dev') IS NOT NULL
AND EXISTS (
  SELECT 1
  FROM sys.database_role_members AS drm
  JOIN sys.database_principals AS role_principal ON role_principal.principal_id = drm.role_principal_id
  JOIN sys.database_principals AS member_principal ON member_principal.principal_id = drm.member_principal_id
  WHERE role_principal.name = N'c1_deploy_temp'
    AND member_principal.name = N'sifha_migration_dev'
)
BEGIN
  ALTER ROLE [c1_deploy_temp] DROP MEMBER [sifha_migration_dev];
  PRINT N'[C1-REVOKE] sifha_migration_dev retirado del rol temporal.';
END
ELSE
  PRINT N'[C1-REVOKE] sifha_migration_dev no era miembro del rol temporal.';

PRINT N'[C1-REVOKE] Revocando permisos temporales C1 del rol.';
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
BEGIN
  REVOKE REFERENCES ON OBJECT::dbo.[users] FROM [c1_deploy_temp];
  REVOKE SELECT ON OBJECT::dbo.[users] FROM [c1_deploy_temp];
END;
IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
  REVOKE SELECT ON OBJECT::dbo.[roles] FROM [c1_deploy_temp];
IF OBJECT_ID(N'dbo.permissions', N'U') IS NOT NULL
  REVOKE SELECT ON OBJECT::dbo.[permissions] FROM [c1_deploy_temp];
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL
  REVOKE SELECT ON OBJECT::dbo.[role_permissions] FROM [c1_deploy_temp];
IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
BEGIN
  REVOKE REFERENCES ON OBJECT::dbo.[departments] FROM [c1_deploy_temp];
  REVOKE SELECT ON OBJECT::dbo.[departments] FROM [c1_deploy_temp];
END;
IF OBJECT_ID(N'dbo.sessions', N'U') IS NOT NULL
  REVOKE SELECT ON OBJECT::dbo.[sessions] FROM [c1_deploy_temp];

REVOKE REFERENCES ON SCHEMA::[dbo] FROM [c1_deploy_temp];
REVOKE ALTER ON SCHEMA::[dbo] FROM [c1_deploy_temp];
REVOKE CREATE TABLE FROM [c1_deploy_temp];

DECLARE @roleId int = DATABASE_PRINCIPAL_ID(N'c1_deploy_temp');

IF EXISTS (SELECT 1 FROM sys.database_role_members WHERE role_principal_id = @roleId)
BEGIN
  PRINT N'[C1-REVOKE] El rol conserva otros miembros; no se elimina.';
  RETURN;
END;

IF EXISTS (SELECT 1 FROM sys.database_permissions WHERE grantee_principal_id = @roleId)
BEGIN
  PRINT N'[C1-REVOKE] El rol conserva otros permisos; no se elimina.';
  RETURN;
END;

IF EXISTS (SELECT 1 FROM sys.schemas WHERE principal_id = @roleId)
   OR EXISTS (SELECT 1 FROM sys.objects WHERE principal_id = @roleId)
BEGIN
  PRINT N'[C1-REVOKE] El rol posee un esquema u objeto; no se elimina.';
  RETURN;
END;

DROP ROLE [c1_deploy_temp];
PRINT N'[C1-REVOKE] Rol temporal eliminado. Retiro C1 completado.';
