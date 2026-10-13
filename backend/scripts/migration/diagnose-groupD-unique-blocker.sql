/* Solo lectura: diagnostico exacto del bloqueo preventivo de UNIQUE. */
SET NOCOUNT ON;
IF DB_NAME() <> N'SIFHA_GroupD_ScratchTest'
    THROW 51230, N'ABORTADO: conecte exclusivamente a SIFHA_GroupD_ScratchTest.', 1;

SELECT i.name AS index_name,
       i.type_desc,
       i.is_unique_constraint,
       i.has_filter,
       i.filter_definition,
       ds.name AS data_space_name,
       ds.type_desc AS data_space_type_desc,
       ps.name AS partition_scheme_name,
       COUNT(DISTINCT p.partition_number) AS partition_count,
       STRING_AGG(CONVERT(nvarchar(60), p.data_compression_desc), N', ')
           WITHIN GROUP (ORDER BY p.partition_number) AS compression_by_partition,
       CASE WHEN ds.type_desc <> N'ROWS_FILEGROUP' THEN 1 ELSE 0 END AS triggers_data_space_guard,
       CASE WHEN i.has_filter = 1 THEN 1 ELSE 0 END AS triggers_filter_guard,
       CASE WHEN EXISTS (SELECT 1 FROM sys.partitions AS px
                         WHERE px.object_id = i.object_id AND px.index_id = i.index_id
                           AND px.data_compression_desc <> N'NONE') THEN 1 ELSE 0 END AS triggers_compression_guard
FROM sys.indexes AS i
JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id
LEFT JOIN sys.partition_schemes AS ps ON ps.data_space_id = i.data_space_id
JOIN sys.partitions AS p ON p.object_id = i.object_id AND p.index_id = i.index_id
WHERE i.object_id = OBJECT_ID(N'dbo.departments')
  AND i.name IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name')
GROUP BY i.name, i.type_desc, i.is_unique_constraint, i.has_filter, i.filter_definition,
         ds.name, ds.type_desc, ps.name, i.object_id, i.index_id;

SELECT i.name AS index_name, p.partition_number, p.rows, p.data_compression_desc,
       ds.name AS data_space_name, ds.type_desc AS data_space_type_desc
FROM sys.indexes AS i
JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id
JOIN sys.partitions AS p ON p.object_id = i.object_id AND p.index_id = i.index_id
WHERE i.object_id = OBJECT_ID(N'dbo.departments')
  AND i.name IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name')
ORDER BY i.name, p.partition_number;
