/* Inventario previo de solo lectura para SIFHA_GroupD_ScratchTest. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF DB_NAME() <> N'SIFHA_GroupD_ScratchTest'
    THROW 51200, N'ABORTADO: conecte exclusivamente a SIFHA_GroupD_ScratchTest.', 1;
IF CONVERT(sysname, SERVERPROPERTY('InstanceName')) <> N'SIFHADEV'
    THROW 51201, N'ABORTADO: instancia no autorizada.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = DB_NAME() AND state_desc = N'ONLINE')
    THROW 51202, N'ABORTADO: la base no esta ONLINE.', 1;

SELECT ORIGINAL_LOGIN() AS original_login, SUSER_SNAME() AS current_login,
       DB_NAME() AS database_name, @@SERVERNAME AS server_name,
       CONVERT(sysname, SERVERPROPERTY('InstanceName')) AS instance_name;

SELECT t.name AS table_name, SUM(p.rows) AS row_count
FROM sys.tables AS t
JOIN sys.partitions AS p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY t.name
ORDER BY t.name;

SELECT c.object_id, OBJECT_SCHEMA_NAME(c.object_id) AS schema_name,
       OBJECT_NAME(c.object_id) AS table_name, c.name AS column_name,
       TYPE_NAME(c.user_type_id) AS data_type, c.is_nullable
FROM sys.columns AS c
WHERE (c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id')
   OR (c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id');

SELECT i.name AS index_name, i.type_desc, i.is_unique, i.is_unique_constraint,
       i.is_padded, i.fill_factor, i.ignore_dup_key, i.allow_row_locks,
       i.allow_page_locks, i.optimize_for_sequential_key, ds.name AS data_space_name,
       ic.key_ordinal, COL_NAME(ic.object_id, ic.column_id) AS column_name,
       ic.is_descending_key, ic.is_included_column
FROM sys.indexes AS i
JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
WHERE i.object_id = OBJECT_ID(N'dbo.departments')
  AND i.is_unique = 1
ORDER BY i.name, ic.key_ordinal;

SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) AS parent_schema,
       OBJECT_NAME(fk.parent_object_id) AS parent_table,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS referenced_schema,
       OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
       fk.delete_referential_action_desc, fk.update_referential_action_desc,
       fk.is_not_for_replication, fk.is_disabled, fk.is_not_trusted,
       fkc.constraint_column_id,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS parent_column,
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
ORDER BY fk.name, fkc.constraint_column_id;
