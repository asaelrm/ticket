/*
 SIFHA Ticket - Diagnostico seguro para SSMS
 Solo lectura. NO aplica permisos ni crea usuarios.
 Ejecutar en una consulta conectada a TI-DESK-01\SIFHADEV.
 Para aplicar permisos usar los scripts oficiales del repositorio, previa revision y autorizacion.
*/
SET NOCOUNT ON;

/* Selecciona SIFHA_Tickets_DEV en el desplegable de bases antes de ejecutar. */
IF UPPER(CONVERT(nvarchar(128), SERVERPROPERTY('ServerName'))) <> N'TI-DESK-01\SIFHADEV'
   OR UPPER(DB_NAME()) <> N'SIFHA_TICKETS_DEV'
BEGIN
    RAISERROR(N'SERVIDOR O BASE INCORRECTOS. Selecciona SIFHA_Tickets_DEV en TI-DESK-01\SIFHADEV.', 16, 1);
    RETURN;
END;

PRINT N'=== SIFHA: DIAGNOSTICO SEGURO (SIN CAMBIOS) ===';
SELECT @@SERVERNAME AS servidor,
       DB_NAME() AS base_actual,
       ORIGINAL_LOGIN() AS login_actual,
       SUSER_SNAME() AS usuario_servidor,
       IS_SRVROLEMEMBER(N'sysadmin') AS es_sysadmin,
       IS_SRVROLEMEMBER(N'dbcreator') AS es_dbcreator;

SELECT COUNT(*) AS total_tablas FROM sys.tables WHERE is_ms_shipped = 0;

SELECT name AS usuario_bd, type_desc, authentication_type_desc
FROM sys.database_principals
WHERE name IN (N'sifha_ticket_dev', N'sifha_group_e');

SELECT p.name AS principal,
       r.name AS rol,
       CASE WHEN rm.member_principal_id IS NULL THEN 0 ELSE 1 END AS es_miembro
FROM sys.database_principals AS p
CROSS JOIN sys.database_principals AS r
LEFT JOIN sys.database_role_members AS rm
    ON rm.member_principal_id = p.principal_id
   AND rm.role_principal_id = r.principal_id
WHERE p.name IN (N'sifha_ticket_dev', N'sifha_group_e')
  AND r.name IN (N'db_owner', N'db_securityadmin', N'db_ddladmin', N'db_datareader', N'db_datawriter')
ORDER BY p.name, r.name;

SELECT pr.name AS principal,
       pe.state_desc AS estado,
       pe.permission_name AS permiso,
       pe.class_desc AS alcance,
       CASE WHEN pe.class = 1 THEN OBJECT_SCHEMA_NAME(pe.major_id) + N'.' + OBJECT_NAME(pe.major_id)
            WHEN pe.class = 0 THEN DB_NAME()
            ELSE CONVERT(nvarchar(128), pe.major_id) END AS objeto
FROM sys.database_permissions AS pe
JOIN sys.database_principals AS pr ON pe.grantee_principal_id = pr.principal_id
WHERE pr.name IN (N'sifha_ticket_dev', N'sifha_group_e')
ORDER BY pr.name, pe.class_desc, objeto, pe.permission_name;

PRINT N'FIN DEL DIAGNOSTICO: no se ejecutaron GRANT, REVOKE, CREATE LOGIN, CREATE USER ni RESTORE.';
PRINT N'NOTA: permisos heredados de roles u otros mecanismos requieren revision adicional.';
