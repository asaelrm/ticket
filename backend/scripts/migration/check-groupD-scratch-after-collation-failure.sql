/* Solo lectura despues del fallo de validacion por collation. */
SET NOCOUNT ON;
IF DB_NAME() <> N'SIFHA_GroupD_ScratchTest'
    THROW 51220, N'ABORTADO: conecte exclusivamente a SIFHA_GroupD_ScratchTest.', 1;

SELECT DB_NAME() AS database_name, ORIGINAL_LOGIN() AS original_login,
       c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type, c.is_nullable
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

SELECT kc.name AS constraint_name, i.name AS index_name, i.type_desc,
       i.is_unique, i.is_unique_constraint, i.is_padded, i.fill_factor,
       i.ignore_dup_key, i.allow_row_locks, i.allow_page_locks,
       i.optimize_for_sequential_key
FROM sys.key_constraints AS kc
JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
WHERE kc.parent_object_id = OBJECT_ID(N'dbo.departments')
ORDER BY kc.name;

SELECT fk.name, fk.is_disabled, fk.is_not_trusted,
       fk.delete_referential_action_desc, fk.update_referential_action_desc
FROM sys.foreign_keys AS fk
WHERE fk.name IN (N'FK_users_department_same_org', N'FK_tickets_department_same_org');

SELECT COUNT_BIG(*) AS department_count,
       SUM(CASE WHEN organization_id IS NULL THEN 1 ELSE 0 END) AS null_organization_count
FROM dbo.departments;
