-- VERIFICACION INTEGRACION SIFHA MSSQL
-- SCRIPT DE SOLO LECTURA
-- DB AUTORIZADA: SIFHA_Tickets_M5_Integration_Test
-- NO MODIFICA DATOS, NO CREA NI ELIMINA OBJETOS

SET NOCOUNT ON;
DECLARE @ok BIT = 1;
DECLARE @db sysname = DB_NAME();

IF @db <> 'SIFHA_Tickets_M5_Integration_Test'
BEGIN
  RAISERROR('DB_NAME()=%s - DEBE SER SIFHA_Tickets_M5_Integration_Test. ABORTAR.', 16, 1, @db);
  RETURN;
END

PRINT '1) DB CORRECTA: ' + @db;

-- 2) Tablas SIFHA presentes
SELECT 'sifha_systems' AS tabla, COUNT(*) AS filas FROM dbo.sifha_systems
UNION ALL SELECT 'organization_sifha_systems', COUNT(*) FROM dbo.organization_sifha_systems
UNION ALL SELECT 'user_sifha_organizations', COUNT(*) FROM dbo.user_sifha_organizations
UNION ALL SELECT 'user_organizations', COUNT(*) FROM dbo.user_organizations
UNION ALL SELECT 'user_organization_history', COUNT(*) FROM dbo.user_organization_history
UNION ALL SELECT 'user_support_permissions', COUNT(*) FROM dbo.user_support_permissions;

-- 3) Tickets con soporte scope
SELECT support_scope, COUNT(*) AS c FROM dbo.tickets GROUP BY support_scope;

-- 4) CK_tickets_support_scope
SELECT name FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID('dbo.tickets') AND name = 'CK_tickets_support_scope';

-- 5) FKs hacia sifha_systems
SELECT fk.name AS fk, tp.name AS tabla_padre
FROM sys.foreign_keys fk
JOIN sys.tables tp ON tp.object_id = fk.parent_object_id
JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id
WHERE tr.name='sifha_systems' AND tp.schema_id=SCHEMA_ID('dbo') AND tr.schema_id=SCHEMA_ID('dbo');

-- 6) Columnas tickets
SELECT c.name, t.name AS type
FROM sys.columns c
JOIN sys.types t ON t.user_type_id=c.user_type_id
WHERE c.object_id=OBJECT_ID('dbo.tickets') AND c.name IN ('support_scope','sifha_system_id');

-- 7) organization_sifha_systems
SELECT c.name FROM sys.columns c WHERE c.object_id=OBJECT_ID('dbo.organization_sifha_systems') ORDER BY c.column_id;

-- 8) Identidades y reglas (solo lectura)
SELECT OBJECT_NAME(c.object_id) AS tabla, c.name AS col, c.is_identity
FROM sys.columns c
WHERE c.object_id IN (OBJECT_ID('dbo.sifha_systems'), OBJECT_ID('dbo.organization_sifha_systems'), OBJECT_ID('dbo.user_organization_history'))
  AND c.is_identity=1;

-- 9) Permisos de conexión (informativo)
SELECT DB_NAME() AS db, SUSER_NAME() AS login, USER_NAME() AS usuario;

PRINT 'FIN VERIFICACION (SOLO LECTURA)';
GO
