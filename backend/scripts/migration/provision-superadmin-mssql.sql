/*
 * SIFHA Ticket - Aprovisionamiento SUPERADMIN para MSSQL
 * 
 * Este script crea de forma idempotente:
 *   1. Permiso organization.manage (si no existe)
 *   2. Rol SUPERADMIN (si no existe)
 * 3. Asignación de TODOS los permisos al rol SUPERADMIN
 * 
 * NO modifica usuarios existentes, NO ejecuta migraciones, NO toca datos de tickets/organizaciones.
 * Seguro para ejecutar en SIFHA_Tickets_DEV con datos existentes.
 * 
 * Uso:
 *   sqlcmd -S 100.100.4.60,1433 -d SIFHA_Tickets_DEV -U sifha_ticket_dev -P "@asael231123@" -C -b -i provision-superadmin-mssql.sql
 * 
 * Requiere: conexión con permisos DDL/DML sobre SIFHA_Tickets_DEV
 */

SET NOCOUNT ON;
SET XACT_ABORT ON;

-- Verificación de identidad del servidor y base
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_DEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_instance NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));

IF UPPER(@current_database) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: base de datos incorrecta. Se esperaba %s y se estÃ¡ en %s.', 16, 1, @expected_database, @current_database);
    RETURN;
END;

IF UPPER(@current_instance) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: instancia incorrecta. Se esperaba %s y se estÃ¡ en %s.', 16, 1, @expected_instance, @current_instance);
    RETURN;
END;

PRINT N'=== APROVISIONAMIENTO SUPERADMIN MSSQL ===';
PRINT N'Base de datos: ' + @current_database;
PRINT N'Instancia: ' + @current_instance;

BEGIN TRANSACTION;

--------------------------------------------------------------------
-- 1. Permiso organization.manage
--------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = N'organization.manage')
BEGIN
    INSERT INTO permissions (code, description, created_at)
    VALUES (N'organization.manage', N'Gestionar organizaciones', SYSUTCDATETIME());
    PRINT N'CREADO: permiso organization.manage';
END
ELSE
BEGIN
    PRINT N'EXISTE: permiso organization.manage';
END

--------------------------------------------------------------------
-- 2. Rol SUPERADMIN
--------------------------------------------------------------------
DECLARE @superadmin_role_id INT;

IF NOT EXISTS (SELECT 1 FROM roles WHERE code = N'SUPERADMIN')
BEGIN
    INSERT INTO roles (code, name, description, active, created_at)
    VALUES (N'SUPERADMIN', N'Superadministrador', N'Cuenta global sin organizaciÃ³n: administra todo el sistema', 1, SYSUTCDATETIME());
    
    SET @superadmin_role_id = SCOPE_IDENTITY();
    PRINT N'CREADO: rol SUPERADMIN (id=' + CAST(@superadmin_role_id AS NVARCHAR(10)) + N')';
END
ELSE
BEGIN
    SELECT @superadmin_role_id = id FROM roles WHERE code = N'SUPERADMIN';
    PRINT N'EXISTE: rol SUPERADMIN (id=' + CAST(@superadmin_role_id AS NVARCHAR(10)) + N')';
END

--------------------------------------------------------------------
-- 3. Asignar TODOS los permisos al rol SUPERADMIN
--------------------------------------------------------------------
DECLARE @assigned_count INT = 0;

INSERT INTO role_permissions (role_id, permission_id)
SELECT @superadmin_role_id, p.id
FROM permissions p
WHERE NOT EXISTS (
    SELECT 1 FROM role_permissions rp 
    WHERE rp.role_id = @superadmin_role_id 
      AND rp.permission_id = p.id
);

SET @assigned_count = @@ROWCOUNT;

IF @assigned_count > 0
    PRINT N'ASIGNADOS: ' + CAST(@assigned_count AS NVARCHAR(10)) + N' permisos al rol SUPERADMIN';
ELSE
    PRINT N'SIN CAMBIOS: todos los permisos ya asignados al rol SUPERADMIN';

--------------------------------------------------------------------
-- Verificación final
--------------------------------------------------------------------
DECLARE @total_perms INT;
DECLARE @super_perms INT;
DECLARE @has_org_manage BIT;
DECLARE @has_superadmin_role BIT;

SELECT @total_perms = COUNT(*) FROM permissions;

SELECT @super_perms = COUNT(*) 
FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE rp.role_id = @superadmin_role_id;

SET @has_org_manage = CASE WHEN EXISTS (SELECT 1 FROM permissions WHERE code = N'organization.manage') THEN 1 ELSE 0 END;
SET @has_superadmin_role = CASE WHEN EXISTS (SELECT 1 FROM roles WHERE code = N'SUPERADMIN') THEN 1 ELSE 0 END;

PRINT N'';
PRINT N'=== RESUMEN ===';
PRINT N'Rol SUPERADMIN ID: ' + CAST(@superadmin_role_id AS NVARCHAR(10));
PRINT N'Permisos asignados: ' + CAST(@super_perms AS NVARCHAR(10)) + N' / ' + CAST(@total_perms AS NVARCHAR(10));
PRINT N'Permiso organization.manage: ' + CASE WHEN @has_org_manage = 1 THEN N'EXISTE' ELSE N'FALTA' END;
PRINT N'Rol SUPERADMIN: ' + CASE WHEN @has_superadmin_role = 1 THEN N'EXISTE' ELSE N'FALTA' END;

COMMIT TRANSACTION;

PRINT N'=== APROVISIONAMIENTO COMPLETADO ===';