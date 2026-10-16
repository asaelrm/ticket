/* ============================================================================
 * SIFHA - GRUPO D (INDEPENDIENTE): departments.organization_id -> NOT NULL
 *         Exclusivo de la instancia TI-DESK-01\SIFHADEV / base SIFHA_GroupD_ScratchTest
 * ============================================================================
 *
 * OBJETIVO
 *   Convertir dbo.departments.organization_id a NOT NULL (paridad con el
 *   esquema canonico backend/src/db/mssql/schema.sql, donde ya es NOT NULL).
 *   Depende de que el grupo C haya dejado 0 filas NULL. NO repite B ni C y NO
 *   toca dbo.users.organization_id (sigue NULL-able, como el canonico).
 *
 * PRECONDICIONES (el script las comprueba y aborta si no se cumplen)
 *   1. Grupo C ya ejecutado y verificado: verify-after-groupC.sql -> GO.
 *   2. Existen las 24 tablas del esquema reconciliado.
 *   3. Existen exactamente 97 registros (1 organizacion CMUCE + 96 heredados).
 *   4. CMUCE existe UNA sola vez y los 25 departamentos pertenecen a ella.
 *   5. departments.organization_id no tiene ninguna fila NULL.
 *   6. El tipo real de departments.organization_id es INT (igual que el canonico).
 *   7. Existen los UNIQUE y las FK que dependen de departments(organization_id):
 *        - UQ_departments_organization_id      UNIQUE (organization_id, id)
 *        - UQ_departments_organization_name    UNIQUE (organization_id, name)
 *        - FK_departments_organization          (departments -> organizations)
 *        - FK_users_department_same_org        (users -> departments(org, id))
 *        - FK_tickets_department_same_org      (tickets -> departments(org, id))
 *      habilitadas y confiables.
 *   8. Backend detenido; ventana de mantenimiento; respaldo verificado.
 *
 * POR QUE ESTE SCRIPT GESTIONA DEPENDENCIAS (hallazgo verificado)
 *   En SQL Server 2022, ALTER TABLE ... ALTER COLUMN falla con
 *   "one or more objects access this column" cuando la columna pertenece a un
 *   indice/UNIQUE (confirmado empiricamente sobre una copia aislada). Las FK no
 *   bloquean por si mismas, pero las FK compuestas que usan
 *   UQ_departments_organization_id (organization_id, id) obligan a disponer de
 *   ese indice unico; por tanto el orden correcto es:
 *       (a) soltar las FK dependientes (users/tickets),
 *       (b) soltar los UNIQUE que incluyen organization_id,
 *       (c) ALTER COLUMN,
 *       (d) recrear los UNIQUE con la MISMA definicion,
 *       (e) recrear las FK con WITH CHECK (quedan confiables),
 *   todo dentro de UNA SOLA TRANSACCION.
 *
 * GARANTIAS DE SEGURIDAD
 *   - Descubre TODAS las dependencias (indices/UNIQUE y FK) que incluyen
 *     organization_id y ABORTA si aparecen objetos distintos de los esperados,
 *     para no perder silenciosamente ninguna restriccion.
 *   - UNA SOLA TRANSACCION atomica: si algo falla, ROLLBACK deja la nulabilidad,
 *     las restricciones y las FK como estaban.
 *   - El ALTER se re-valida DENTRO de la transaccion, con bloqueos
 *     (UPDLOCK/HOLDLOCK), justo antes de ejecutarse.
 *   - Solo cambia la NULABILIDAD de departments.organization_id. NO cambia el
 *     tipo, no borra datos, no elimina permanentemente restricciones/FK/indices
 *     (los suelta y los recrea identicos).
 *   - Idempotente: si la columna ya es NOT NULL, no se ejecuta ningun DDL y se
 *     informa; el resumen sigue siendo GO si el resto del estado es correcto.
 *   - NO usa DROP TABLE/TRUNCATE/DELETE, NO usa NOCHECK, NO altera otras columnas.
 *   - Verificacion post-D: comprueba que las restricciones UNIQUE, las FK y los
 *     datos siguen intactos antes del COMMIT y de nuevo al final.
 *
 * ATOMICIDAD
 *   - ALTER TABLE ... ALTER COLUMN y el DROP/ADD de restricciones son
 *     transaccionales en SQL Server. El bloque usa BEGIN TRAN + TRY/CATCH +
 *     XACT_ABORT ON y ROLLBACK si algo falla.
 *
 * NO REVERSION AUTOMATICA POST-COMMIT
 *   - Antes del COMMIT: TRY/CATCH + XACT_ABORT revierte.
 *   - Despues del COMMIT: la transaccion quedo confirmada. NO se recomienda
 *     restaurar automaticamente el respaldo. Ante un resultado inesperado:
 *     DETENER, documentar y escalar al auditor.
 *
 * AUTORIZACION EXPLICITA
 *   El script NO hace nada salvo que @AuthorizeDdl = 1 Y @BackupVerified = 1.
 *
 * NO EJECUTAR hasta la ventana autorizada.
 * ============================================================================ */

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_WARNINGS ON;

/* ---------------------------------------------------------------------------
 * PARAMETROS E INTERRUPTORES
 * ------------------------------------------------------------------------- */
DECLARE @AuthorizeDdl   BIT = 0;   /* PONER EN 1 para autorizar el ALTER. */
DECLARE @BackupVerified BIT = 0;   /* PONER EN 1 tras crear y VERIFICAR el respaldo. */

DECLARE @ExpectedTables      INT = 24;
DECLARE @ExpectedRows        BIGINT = 97;
DECLARE @ExpectedDepartments INT = 25;
DECLARE @ExpectedUsers       INT = 1;
DECLARE @ExpectedOrgCode     NVARCHAR(50) = N'CMUCE';
DECLARE @ExpectedColumnType  NVARCHAR(60) = N'int';

/* ---------------------------------------------------------------------------
 * 0. Guarda de identidad (servidor / instancia / base)
 * ------------------------------------------------------------------------- */
DECLARE @expected_database SYSNAME = N'SIFHA_GroupD_ScratchTest';
DECLARE @expected_server   NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server   NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
DECLARE @current_legacy_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), @@SERVERNAME)));
DECLARE @current_instance NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));

IF UPPER(ISNULL(@current_database, N'')) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: la base actual "%s" no es la autorizada "%s". No se aplica nada.', 16, 1, @current_database, @expected_database);
    RETURN;
END;

IF UPPER(ISNULL(@current_instance, N'')) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: la instancia "%s" no es la autorizada "%s". No se aplica nada.', 16, 1, @current_instance, @expected_instance);
    RETURN;
END;

IF NOT (
    UPPER(ISNULL(@current_server, N'')) = UPPER(@expected_server)
    OR UPPER(ISNULL(@current_legacy_server, N'')) = UPPER(@expected_server)
)
BEGIN
    RAISERROR(N'ABORTADO: el servidor "%s"/"%s" no es el autorizado "%s". No se aplica nada.', 16, 1, @current_server, @current_legacy_server, @expected_server);
    RETURN;
END;

PRINT N'Identidad verificada: TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_GroupD_ScratchTest';

/* ---------------------------------------------------------------------------
 * 1. Autorizacion explicita
 * ------------------------------------------------------------------------- */
IF @AuthorizeDdl = 0 OR @BackupVerified = 0
BEGIN
    PRINT N'';
    PRINT N'*** NO AUTORIZADO: el grupo D no se ejecuta. ***';
    PRINT N'*** Para autorizar: @AuthorizeDdl = 1 Y @BackupVerified = 1 (respaldo creado y VERIFICADO). ***';
    PRINT N'';
    RETURN;
END;

PRINT N'Autorizacion explicita recibida: @AuthorizeDdl=1, @BackupVerified=1.';

DECLARE @sql NVARCHAR(MAX);
DECLARE @n BIGINT;
DECLARE @cmuce_id INT = NULL;
DECLARE @cmuce_count INT = -1;
DECLARE @dept_total BIGINT = -1;
DECLARE @dept_null BIGINT = -1;
DECLARE @dept_foreign BIGINT = -1;
DECLARE @dept_nullable BIGINT = -1;   -- 1 = aun NULL-able; 0 = ya NOT NULL
DECLARE @dept_type_ok BIT = 0;
DECLARE @users_nullable BIGINT = -1;  -- 0 = NULL-able (canonico); 1 = NOT NULL
DECLARE @u_null BIGINT = -1;
DECLARE @tables_present INT = 0;
DECLARE @total_rows BIGINT = 0;

/* ---------------------------------------------------------------------------
 * 2. Prechequeos estructurales (SIN escribir): 24 tablas y dependencias
 * ------------------------------------------------------------------------- */
DECLARE @tablas TABLE (name SYSNAME);
INSERT INTO @tablas (name) VALUES
    (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
    (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
    (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
    (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
    (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
    (N'kb_ticket_articles'), (N'kb_article_history');

SELECT @tables_present = COUNT(*) FROM @tablas AS t WHERE OBJECT_ID(N'dbo.' + t.name, N'U') IS NOT NULL;
IF @tables_present <> @ExpectedTables
BEGIN
    RAISERROR(N'ABORTADO: solo %d/%d tablas presentes. Ejecute y verifique B antes.', 16, 1, @tables_present, @ExpectedTables);
    RETURN;
END;
PRINT N'[2] OK: 24/24 tablas presentes.';

/* Columna diana e integridad de dependencias: UQ + FK que referencian
   departments(organization_id, ...). */
IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: falta dbo.departments.organization_id. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_departments_organization_id')
BEGIN
    RAISERROR(N'ABORTADO: falta UQ_departments_organization_id (la exigen las FK compuestas). Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_departments_organization_name')
BEGIN
    RAISERROR(N'ABORTADO: falta UQ_departments_organization_name. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = N'FK_departments_organization' AND is_disabled = 0 AND is_not_trusted = 0
)
BEGIN
    RAISERROR(N'ABORTADO: FK_departments_organization ausente/deshabilitada/no confiable. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = N'FK_users_department_same_org' AND is_disabled = 0 AND is_not_trusted = 0
)
BEGIN
    RAISERROR(N'ABORTADO: FK_users_department_same_org ausente/deshabilitada/no confiable. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = N'FK_tickets_department_same_org' AND is_disabled = 0 AND is_not_trusted = 0
)
BEGIN
    RAISERROR(N'ABORTADO: FK_tickets_department_same_org ausente/deshabilitada/no confiable. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

/* Objetos que impedirian el ALTER COLUMN: estadisticas no automaticas y
   cualquier objeto de esquema (columna calculada/vista/funcion) que lea la
   columna. */
IF EXISTS (
    SELECT 1
    FROM sys.stats AS s
    JOIN sys.stats_columns AS sc ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id
    JOIN sys.columns AS c ON c.object_id = sc.object_id AND c.column_id = sc.column_id
    WHERE s.object_id = OBJECT_ID(N'dbo.departments')
      AND c.name = N'organization_id'
      AND s.auto_created = 0
      AND s.user_created = 1
)
BEGIN
    RAISERROR(N'ABORTADO: hay estadisticas manuales sobre departments.organization_id que bloquean ALTER COLUMN. Revise antes.', 16, 1);
    RETURN;
END;

IF EXISTS (
    SELECT 1
    FROM sys.sql_expression_dependencies AS sed
    JOIN sys.columns AS c
         ON c.object_id = sed.referenced_id AND c.column_id = sed.referenced_minor_id
    WHERE sed.referenced_id = OBJECT_ID(N'dbo.departments')
      AND c.name = N'organization_id'
)
BEGIN
    RAISERROR(N'ABORTADO: hay objetos de esquema que leen departments.organization_id (vista/columna calculada) y pueden bloquear ALTER COLUMN. Revise antes.', 16, 1);
    RETURN;
END;

/* Descubrimiento OBLIGATORIO de TODAS las dependencias que incluyen
   organization_id. Si aparece algo distinto de lo esperado, se ABORTA para no
   perder restricciones silenciosamente. */
DECLARE @blocking_uq TABLE (name SYSNAME, type_desc NVARCHAR(60), key_cols NVARCHAR(MAX),
    data_space_name SYSNAME, data_space_type_desc NVARCHAR(60), is_padded BIT,
    fill_factor TINYINT, ignore_dup_key BIT, allow_row_locks BIT, allow_page_locks BIT,
    has_filter BIT, filter_definition NVARCHAR(MAX), optimize_for_sequential_key BIT);
DECLARE @blocking_fk TABLE (
    name SYSNAME, parent_schema SYSNAME, parent_table SYSNAME,
    ref_schema SYSNAME, ref_table SYSNAME,
    parent_cols NVARCHAR(MAX), ref_cols NVARCHAR(MAX),
    on_delete NVARCHAR(60), on_update NVARCHAR(60), not_for_repl BIT,
    is_disabled BIT, is_not_trusted BIT);

INSERT INTO @blocking_uq (name, type_desc, key_cols, data_space_name, data_space_type_desc,
                          is_padded, fill_factor, ignore_dup_key, allow_row_locks, allow_page_locks,
                          has_filter, filter_definition, optimize_for_sequential_key)
SELECT i.name, i.type_desc,
       STUFF((SELECT N', ' + QUOTENAME(c2.name) + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END
              FROM sys.index_columns AS ic2
              JOIN sys.columns AS c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
              WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
       ORDER BY ic2.key_ordinal FOR XML PATH(N'')), 1, 2, N''),
       ds.name, ds.type_desc, i.is_padded, i.fill_factor, i.ignore_dup_key,
       i.allow_row_locks, i.allow_page_locks, i.has_filter, i.filter_definition,
       i.optimize_for_sequential_key
FROM sys.indexes AS i
JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id
WHERE i.object_id = OBJECT_ID(N'dbo.departments')
  AND i.is_primary_key = 0
  AND i.is_hypothetical = 0
  AND EXISTS (
      SELECT 1
      FROM sys.index_columns AS ic
      JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND c.name = N'organization_id');

INSERT INTO @blocking_fk (name, parent_schema, parent_table, ref_schema, ref_table, parent_cols, ref_cols, on_delete, on_update, not_for_repl, is_disabled, is_not_trusted)
SELECT fk.name,
       SCHEMA_NAME(pt.schema_id), pt.name,
       SCHEMA_NAME(rt.schema_id), rt.name,
       STUFF((SELECT N', ' + COL_NAME(fkc2.parent_object_id, fkc2.parent_column_id)
              FROM sys.foreign_key_columns AS fkc2
              WHERE fkc2.constraint_object_id = fk.object_id
              ORDER BY fkc2.constraint_column_id FOR XML PATH(N'')), 1, 2, N''),
       STUFF((SELECT N', ' + COL_NAME(fkc2.referenced_object_id, fkc2.referenced_column_id)
              FROM sys.foreign_key_columns AS fkc2
              WHERE fkc2.constraint_object_id = fk.object_id
              ORDER BY fkc2.constraint_column_id FOR XML PATH(N'')), 1, 2, N''),
       REPLACE(fk.delete_referential_action_desc, N'_', N' '),
       REPLACE(fk.update_referential_action_desc, N'_', N' '),
       fk.is_not_for_replication, fk.is_disabled, fk.is_not_trusted
FROM sys.foreign_keys AS fk
JOIN sys.tables AS pt ON pt.object_id = fk.parent_object_id
JOIN sys.tables AS rt ON rt.object_id = fk.referenced_object_id
WHERE fk.referenced_object_id = OBJECT_ID(N'dbo.departments')
  AND EXISTS (
      SELECT 1
      FROM sys.foreign_key_columns AS fkc
      JOIN sys.columns AS c ON c.object_id = fkc.referenced_object_id AND c.column_id = fkc.referenced_column_id
      WHERE fkc.constraint_object_id = fk.object_id AND c.name = N'organization_id');

IF (SELECT COUNT(*) FROM @blocking_uq) <> 2
   OR EXISTS (SELECT 1 FROM @blocking_uq WHERE name NOT IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name'))
BEGIN
    RAISERROR(N'ABORTADO: el conjunto de indices/UNIQUE que incluyen organization_id no es el esperado (UQ_departments_organization_id, UQ_departments_organization_name). Revise antes de aplicar D.', 16, 1);
    RETURN;
END;

IF (SELECT COUNT(*) FROM @blocking_fk) <> 2
   OR EXISTS (SELECT 1 FROM @blocking_fk WHERE name NOT IN (N'FK_users_department_same_org', N'FK_tickets_department_same_org'))
BEGIN
    RAISERROR(N'ABORTADO: el conjunto de FK que referencian departments(organization_id, ...) no es el esperado (FK_users_department_same_org, FK_tickets_department_same_org). Revise antes de aplicar D.', 16, 1);
    RETURN;
END;

IF EXISTS (SELECT 1 FROM @blocking_uq WHERE data_space_type_desc <> N'ROWS_FILEGROUP')
   OR EXISTS (SELECT 1 FROM @blocking_uq WHERE has_filter = 1)
   OR EXISTS (
        SELECT 1
        FROM sys.partitions AS p
        JOIN sys.indexes AS i ON i.object_id = p.object_id AND i.index_id = p.index_id
        WHERE i.object_id = OBJECT_ID(N'dbo.departments')
          AND i.name IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name')
          AND p.data_compression_desc <> N'NONE')
BEGIN
    RAISERROR(N'ABORTADO: una UNIQUE dependiente usa particionamiento, filtro o compresion y no puede reconstruirse fielmente con ALTER TABLE. No se modifico la base.', 16, 1);
    RETURN;
END;

PRINT N'[2] OK: UNIQUE + FK dependientes descubiertos y son exactamente los esperados (se soltaran y recrearan identicos).';

/* ---------------------------------------------------------------------------
 * 3. Prechequeo de datos (SIN escribir; se repite en la transaccion)
 * ------------------------------------------------------------------------- */
/* 3a. Total de registros de las 24 tablas (esperado 97). */
DECLARE @tabla_cur SYSNAME;
DECLARE @actual BIGINT;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @tablas ORDER BY name;
OPEN cur;
FETCH NEXT FROM cur INTO @tabla_cur;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.' + QUOTENAME(@tabla_cur) + N';';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @actual OUTPUT;
    SET @total_rows = @total_rows + @actual;
    FETCH NEXT FROM cur INTO @tabla_cur;
END;
CLOSE cur;
DEALLOCATE cur;

IF @total_rows <> @ExpectedRows
BEGIN
    RAISERROR(N'ABORTADO: total de registros = %I64d; se esperaban %I64d (estado post-C). Ejecute y verifique C antes.', 16, 1, @total_rows, @ExpectedRows);
    RETURN;
END;
PRINT N'[3] OK: total de registros = ' + CAST(@total_rows AS NVARCHAR(20)) + N' (esperado 97).';

/* 3b. CMUCE exactamente una vez. */
SELECT @cmuce_count = ISNULL(SUM(CASE WHEN code = @ExpectedOrgCode THEN 1 ELSE 0 END), 0),
       @cmuce_id = MAX(CASE WHEN code = @ExpectedOrgCode THEN id END)
FROM dbo.organizations;

IF @cmuce_count <> 1 OR @cmuce_id IS NULL
BEGIN
    RAISERROR(N'ABORTADO: CMUCE debe existir exactamente una vez (encontradas %d). Ejecute y verifique C antes.', 16, 1, @cmuce_count);
    RETURN;
END;
PRINT N'[3] OK: CMUCE id = ' + CAST(@cmuce_id AS NVARCHAR(10)) + N'.';

/* 3c. 25 departamentos, todos en CMUCE, 0 NULL. */
SELECT @dept_total = COUNT_BIG(*) FROM dbo.departments;
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @dept_null OUTPUT;
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NOT NULL AND organization_id <> @oid;';
EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @dept_foreign OUTPUT;

IF @dept_total <> @ExpectedDepartments
BEGIN
    RAISERROR(N'ABORTADO: departamentos = %I64d; se esperaban %d.', 16, 1, @dept_total, @ExpectedDepartments);
    RETURN;
END;

IF @dept_null <> 0 OR @dept_foreign <> 0
BEGIN
    RAISERROR(N'ABORTADO: %I64d departamentos con NULL y %I64d fuera de CMUCE; no se puede pasar a NOT NULL. Ejecute y verifique C antes.', 16, 1, @dept_null, @dept_foreign);
    RETURN;
END;
PRINT N'[3] OK: 25 departamentos, 0 NULL y todos en CMUCE.';

/* 3d. users: organization_id sigue NULL-able y sin filas NULL (no se altera). */
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_null OUTPUT;
SELECT @users_nullable = ISNULL(CONVERT(BIGINT, CASE WHEN c.is_nullable = 1 THEN 0 ELSE 1 END), -1)
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id';

IF @u_null <> 0
BEGIN
    RAISERROR(N'ABORTADO: hay %I64d usuarios con organization_id NULL. Revise antes del grupo D.', 16, 1, @u_null);
    RETURN;
END;
IF @users_nullable <> 0
BEGIN
    RAISERROR(N'ABORTADO: users.organization_id ya no es NULL-able; la paridad canonica lo exige NULL-able. Revise antes.', 16, 1);
    RETURN;
END;
PRINT N'[3] OK: users.organization_id sigue NULL-able y sin filas NULL (no se altera).';

/* 3e. Tipo real de departments.organization_id (esperado INT). */
SELECT @dept_type_ok = CASE WHEN TYPE_NAME(c.user_type_id) = @ExpectedColumnType THEN 1 ELSE 0 END
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

IF @dept_type_ok <> 1
BEGIN
    RAISERROR(N'ABORTADO: departments.organization_id no es %s; el grupo D solo cambia la NULABILIDAD, nunca el tipo.', 16, 1, @ExpectedColumnType);
    RETURN;
END;

SELECT @dept_nullable = CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

PRINT N'[3] OK: departments.organization_id es INT; nulabilidad actual = '
    + CASE WHEN @dept_nullable = 1 THEN N'NULL-able (pendiente de D)' ELSE N'NOT NULL (D ya aplicado)' END + N'.';

/* ---------------------------------------------------------------------------
 * 4. TRANSACCION UNICA: re-validacion + (drop dependencias + ALTER + recrear) + verificacion
 * ------------------------------------------------------------------------- */
DECLARE @cmuce_count_tx INT = -1;
DECLARE @dept_null_tx BIGINT = -1;
DECLARE @dept_total_tx BIGINT = -1;
DECLARE @dept_foreign_tx BIGINT = -1;
DECLARE @dept_total_mid BIGINT = -1;
DECLARE @dept_nullable_tx BIGINT = -1;
DECLARE @dept_nullable_after BIGINT = -1;
DECLARE @cur_uq INT = -1;
DECLARE @cur_fk INT = -1;
DECLARE @uq_after INT = -1;
DECLARE @fk_after INT = -1;
DECLARE @fk_untrusted INT = -1;

/* Variables de trabajo para los cursores de drop/recreate. */
DECLARE @d_name SYSNAME, @d_schema SYSNAME, @d_table SYSNAME, @d_type NVARCHAR(60);
DECLARE @d_pcols NVARCHAR(MAX), @d_rcols NVARCHAR(MAX), @d_del NVARCHAR(60), @d_upd NVARCHAR(60);
DECLARE @d_kcols NVARCHAR(MAX), @d_nfr BIT, @d_ref_schema SYSNAME, @d_ref_table SYSNAME;
DECLARE @d_is_disabled BIT, @d_is_not_trusted BIT;
DECLARE @d_space SYSNAME, @d_space_type NVARCHAR(60), @d_padded BIT, @d_fill TINYINT;
DECLARE @d_ignore BIT, @d_rowlocks BIT, @d_pagelocks BIT, @d_seq BIT;

BEGIN TRY
    BEGIN TRANSACTION;

    /* 4.1 Revalidacion autoritativa con bloqueos, antes del DDL. */
    SELECT @cmuce_count_tx = ISNULL(SUM(CASE WHEN code = @ExpectedOrgCode THEN 1 ELSE 0 END), 0)
    FROM dbo.organizations WITH (UPDLOCK, HOLDLOCK);

    SELECT @dept_total_tx = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK);
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @dept_null_tx OUTPUT;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NOT NULL AND organization_id <> @oid;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @dept_foreign_tx OUTPUT;

    SELECT @dept_nullable_tx = CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END
    FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

    IF @cmuce_count_tx <> 1
        RAISERROR(N'ABORTADO (grupo D): CMUCE ya no es unica (%d). Se revierte.', 16, 1, @cmuce_count_tx);
    IF @dept_total_tx <> @ExpectedDepartments
        RAISERROR(N'ABORTADO (grupo D): departamentos = %I64d (esperado %d). Se revierte.', 16, 1, @dept_total_tx, @ExpectedDepartments);
    IF @dept_null_tx <> 0 OR @dept_foreign_tx <> 0
        RAISERROR(N'ABORTADO (grupo D): %I64d NULL y %I64d fuera de CMUCE. Se revierte.', 16, 1, @dept_null_tx, @dept_foreign_tx);

    /* Revalidar que el conjunto de dependencias no cambio desde el prechequeo. */
    SELECT @cur_uq = COUNT(*)
    FROM sys.indexes AS i
    WHERE i.object_id = OBJECT_ID(N'dbo.departments') AND i.is_primary_key = 0 AND i.is_hypothetical = 0
      AND EXISTS (SELECT 1 FROM sys.index_columns AS ic
                  JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                  WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND c.name = N'organization_id');
    SELECT @cur_fk = COUNT(*)
    FROM sys.foreign_keys AS fk
    WHERE fk.referenced_object_id = OBJECT_ID(N'dbo.departments')
      AND EXISTS (SELECT 1 FROM sys.foreign_key_columns AS fkc
                  JOIN sys.columns AS c ON c.object_id = fkc.referenced_object_id AND c.column_id = fkc.referenced_column_id
                  WHERE fkc.constraint_object_id = fk.object_id AND c.name = N'organization_id');

    IF @cur_uq <> (SELECT COUNT(*) FROM @blocking_uq) OR @cur_fk <> (SELECT COUNT(*) FROM @blocking_fk)
        RAISERROR(N'ABORTADO (grupo D): las dependencias cambiaron desde el prechequeo (UNIQUE=%d FK=%d). Se revierte.', 16, 1, @cur_uq, @cur_fk);

    /* 4.2 DDL (solo si aun no es NOT NULL: idempotencia). */
    IF @dept_nullable_tx = 0
        PRINT N'[4] departments.organization_id ya es NOT NULL: DDL omitido (idempotente).';
    ELSE
    BEGIN
        /* (a) Soltar las FK dependientes del UNIQUE(organization_id, id). */
        DECLARE cfk CURSOR LOCAL FAST_FORWARD FOR
            SELECT name, parent_schema, parent_table, ref_schema, ref_table, parent_cols, ref_cols, on_delete, on_update, not_for_repl, is_disabled, is_not_trusted
            FROM @blocking_fk;
        OPEN cfk;
        FETCH NEXT FROM cfk INTO @d_name, @d_schema, @d_table, @d_ref_schema, @d_ref_table, @d_pcols, @d_rcols, @d_del, @d_upd, @d_nfr, @d_is_disabled, @d_is_not_trusted;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @sql = N'ALTER TABLE ' + QUOTENAME(@d_schema) + N'.' + QUOTENAME(@d_table)
                     + N' DROP CONSTRAINT ' + QUOTENAME(@d_name) + N';';
            EXEC sys.sp_executesql @sql;
            PRINT N'[4] FK soltada temporalmente: ' + @d_name;
            FETCH NEXT FROM cfk INTO @d_name, @d_schema, @d_table, @d_ref_schema, @d_ref_table, @d_pcols, @d_rcols, @d_del, @d_upd, @d_nfr, @d_is_disabled, @d_is_not_trusted;
        END;
        CLOSE cfk;
        DEALLOCATE cfk;

        /* (b) Soltar los UNIQUE que incluyen organization_id. */
        DECLARE cuq CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @blocking_uq;
        OPEN cuq;
        FETCH NEXT FROM cuq INTO @d_name;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @sql = N'ALTER TABLE dbo.departments DROP CONSTRAINT ' + QUOTENAME(@d_name) + N';';
            EXEC sys.sp_executesql @sql;
            PRINT N'[4] UNIQUE soltado temporalmente: ' + @d_name;
            FETCH NEXT FROM cuq INTO @d_name;
        END;
        CLOSE cuq;
        DEALLOCATE cuq;

        /* (c) ALTER COLUMN (solo nulabilidad). */
        SET @sql = N'ALTER TABLE dbo.departments ALTER COLUMN organization_id INT NOT NULL;';
        EXEC sys.sp_executesql @sql;
        PRINT N'[4] ALTER aplicado: departments.organization_id es NOT NULL.';

        /* (d) Recrear los UNIQUE con la MISMA definicion. */
        DECLARE cuq2 CURSOR LOCAL FAST_FORWARD FOR SELECT name, type_desc, key_cols, data_space_name, data_space_type_desc, is_padded, fill_factor, ignore_dup_key, allow_row_locks, allow_page_locks, optimize_for_sequential_key FROM @blocking_uq;
        OPEN cuq2;
        FETCH NEXT FROM cuq2 INTO @d_name, @d_type, @d_kcols, @d_space, @d_space_type, @d_padded, @d_fill, @d_ignore, @d_rowlocks, @d_pagelocks, @d_seq;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @sql = N'ALTER TABLE dbo.departments ADD CONSTRAINT ' + QUOTENAME(@d_name)
                     + N' UNIQUE ' + CASE WHEN @d_type = N'CLUSTERED' THEN N'CLUSTERED' ELSE N'NONCLUSTERED' END
                     + N' (' + @d_kcols + N') WITH (PAD_INDEX = ' + CASE WHEN @d_padded = 1 THEN N'ON' ELSE N'OFF' END
                     + CASE WHEN @d_fill BETWEEN 1 AND 100 THEN N', FILLFACTOR = ' + CONVERT(NVARCHAR(3), @d_fill) ELSE N'' END
                     + N', IGNORE_DUP_KEY = ' + CASE WHEN @d_ignore = 1 THEN N'ON' ELSE N'OFF' END
                     + N', ALLOW_ROW_LOCKS = ' + CASE WHEN @d_rowlocks = 1 THEN N'ON' ELSE N'OFF' END
                     + N', ALLOW_PAGE_LOCKS = ' + CASE WHEN @d_pagelocks = 1 THEN N'ON' ELSE N'OFF' END
                     + N', OPTIMIZE_FOR_SEQUENTIAL_KEY = ' + CASE WHEN @d_seq = 1 THEN N'ON' ELSE N'OFF' END
                     + N') ON ' + QUOTENAME(@d_space) + N';';
            EXEC sys.sp_executesql @sql;
            PRINT N'[4] UNIQUE recreado: ' + @d_name + N' (' + @d_kcols + N')';
            FETCH NEXT FROM cuq2 INTO @d_name, @d_type, @d_kcols, @d_space, @d_space_type, @d_padded, @d_fill, @d_ignore, @d_rowlocks, @d_pagelocks, @d_seq;
        END;
        CLOSE cuq2;
        DEALLOCATE cuq2;

        /* (e) Recrear las FK con WITH CHECK (quedan confiables). */
        DECLARE cfk2 CURSOR LOCAL FAST_FORWARD FOR
            SELECT name, parent_schema, parent_table, ref_schema, ref_table, parent_cols, ref_cols, on_delete, on_update, not_for_repl, is_disabled, is_not_trusted
            FROM @blocking_fk;
        OPEN cfk2;
        FETCH NEXT FROM cfk2 INTO @d_name, @d_schema, @d_table, @d_ref_schema, @d_ref_table, @d_pcols, @d_rcols, @d_del, @d_upd, @d_nfr, @d_is_disabled, @d_is_not_trusted;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @sql = N'ALTER TABLE ' + QUOTENAME(@d_schema) + N'.' + QUOTENAME(@d_table)
                     + N' WITH CHECK ADD CONSTRAINT ' + QUOTENAME(@d_name)
                      + N' FOREIGN KEY (' + @d_pcols + N') REFERENCES ' + QUOTENAME(@d_ref_schema) + N'.' + QUOTENAME(@d_ref_table) + N' (' + @d_rcols + N')'
                     + N' ON DELETE ' + @d_del + N' ON UPDATE ' + @d_upd
                      + CASE WHEN @d_nfr = 1 THEN N' NOT FOR REPLICATION' ELSE N'' END + N';';
            EXEC sys.sp_executesql @sql;
            IF @d_is_not_trusted = 1
            BEGIN
                SET @sql = N'ALTER TABLE ' + QUOTENAME(@d_schema) + N'.' + QUOTENAME(@d_table)
                         + N' NOCHECK CONSTRAINT ' + QUOTENAME(@d_name) + N';';
                EXEC sys.sp_executesql @sql;
            END;
            IF @d_is_disabled = 1
            BEGIN
                SET @sql = N'ALTER TABLE ' + QUOTENAME(@d_schema) + N'.' + QUOTENAME(@d_table)
                         + N' NOCHECK CONSTRAINT ' + QUOTENAME(@d_name) + N';';
                EXEC sys.sp_executesql @sql;
            END;
            PRINT N'[4] FK recreada (con validacion): ' + @d_name;
            FETCH NEXT FROM cfk2 INTO @d_name, @d_schema, @d_table, @d_ref_schema, @d_ref_table, @d_pcols, @d_rcols, @d_del, @d_upd, @d_nfr, @d_is_disabled, @d_is_not_trusted;
        END;
        CLOSE cfk2;
        DEALLOCATE cfk2;
    END

    /* 4.3 Verificacion dentro de la transaccion, ANTES del COMMIT. */
    SELECT @dept_nullable_after = CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END
    FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

    IF @dept_nullable_after <> 0
        RAISERROR(N'ABORTADO (grupo D): la columna sigue siendo NULL-able tras el ALTER. Se revierte.', 16, 1);

    SELECT @dept_total_mid = COUNT_BIG(*) FROM dbo.departments;
    IF @dept_total_mid <> @dept_total_tx
        RAISERROR(N'ABORTADO (grupo D): el numero de departamentos cambio (%I64d -> %I64d). Se revierte.', 16, 1, @dept_total_tx, @dept_total_mid);

    /* Los 2 UNIQUE esperados deben existir tras recrear. */
    SELECT @uq_after = COUNT(*) FROM sys.key_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.departments')
      AND name IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name');
    IF @uq_after <> 2
        RAISERROR(N'ABORTADO (grupo D): no se recrearon los 2 UNIQUE esperados (%d). Se revierte.', 16, 1, @uq_after);

    IF EXISTS (
        SELECT 1
        FROM @blocking_uq AS before_uq
        LEFT JOIN sys.indexes AS after_i
          ON after_i.object_id = OBJECT_ID(N'dbo.departments') AND after_i.name = before_uq.name
        OUTER APPLY (
            SELECT STUFF((SELECT N', ' + QUOTENAME(c2.name) + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END
                          FROM sys.index_columns AS ic2
                          JOIN sys.columns AS c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
                          WHERE ic2.object_id = after_i.object_id AND ic2.index_id = after_i.index_id AND ic2.is_included_column = 0
                          ORDER BY ic2.key_ordinal FOR XML PATH(N'')), 1, 2, N'') AS key_cols
        ) AS after_cols
        WHERE after_i.index_id IS NULL OR after_i.type_desc COLLATE DATABASE_DEFAULT <> before_uq.type_desc COLLATE DATABASE_DEFAULT
           OR after_cols.key_cols COLLATE DATABASE_DEFAULT <> before_uq.key_cols COLLATE DATABASE_DEFAULT
           OR after_i.is_padded <> before_uq.is_padded OR after_i.fill_factor <> before_uq.fill_factor
           OR after_i.ignore_dup_key <> before_uq.ignore_dup_key
           OR after_i.allow_row_locks <> before_uq.allow_row_locks OR after_i.allow_page_locks <> before_uq.allow_page_locks
           OR after_i.data_space_id <> (SELECT data_space_id FROM sys.data_spaces WHERE name COLLATE DATABASE_DEFAULT = before_uq.data_space_name COLLATE DATABASE_DEFAULT)
           OR after_i.optimize_for_sequential_key <> before_uq.optimize_for_sequential_key)
        RAISERROR(N'ABORTADO (grupo D): una UNIQUE no conserva columnas, orden, tipo u opciones del indice. Se revierte.', 16, 1);

    /* Las 2 FK esperadas deben existir, habilitadas y confiables. */
    SELECT @fk_after = COUNT(*) FROM sys.foreign_keys
    WHERE name IN (N'FK_users_department_same_org', N'FK_tickets_department_same_org')
      AND is_disabled = 0 AND is_not_trusted = 0;
    IF @fk_after <> 2
        RAISERROR(N'ABORTADO (grupo D): no se recrearon/confiaron las 2 FK esperadas (%d). Se revierte.', 16, 1, @fk_after);

    /* Ninguna FK de departments debe quedar deshabilitada o no confiable. */
    SELECT @fk_untrusted = COUNT(*) FROM sys.foreign_keys
    WHERE (referenced_object_id = OBJECT_ID(N'dbo.departments') OR parent_object_id = OBJECT_ID(N'dbo.departments'))
      AND (is_disabled = 1 OR is_not_trusted = 1);
    IF @fk_untrusted <> 0
        RAISERROR(N'ABORTADO (grupo D): hay %d FK de departments deshabilitada(s)/no confiable(s). Se revierte.', 16, 1, @fk_untrusted);

    COMMIT TRANSACTION;
    PRINT N'[4] COMMIT. departments.organization_id es NOT NULL; UNIQUE y FK recreadas y verificadas.';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    PRINT N'ERROR/ABORTADO en grupo D. Se revirtio la nulabilidad y las dependencias.';
    THROW;
END CATCH;

/* ---------------------------------------------------------------------------
 * 5. Validacion posterior (SIN escribir)
 * ------------------------------------------------------------------------- */
DECLARE @d_null_final BIGINT = -1;
DECLARE @dept_nn_final BIGINT = -1;
DECLARE @users_nn_final BIGINT = -1;
DECLARE @uq_final INT = -1;
DECLARE @fk_final INT = -1;
DECLARE @orfanos BIGINT = 0;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null_final OUTPUT;

SELECT @dept_nn_final = CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';
SELECT @users_nn_final = CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id';

/* Inventario final de restricciones: 2 UNIQUE y 4 FK de departments. */
SELECT @uq_final = COUNT(*) FROM sys.key_constraints
WHERE parent_object_id = OBJECT_ID(N'dbo.departments')
  AND name IN (N'UQ_departments_organization_id', N'UQ_departments_organization_name');
SELECT @fk_final = COUNT(*) FROM sys.foreign_keys
WHERE name IN (N'FK_departments_organization', N'FK_users_department_same_org',
               N'FK_tickets_department_same_org', N'FK_users_department')
  AND is_disabled = 0 AND is_not_trusted = 0;

/* Huerfanos de integridad (esperado 0): departments sin org valida y users sin org/rol/departamento same-org. */
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
             LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
             WHERE d.organization_id IS NULL OR o.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
             WHERE u.organization_id IS NOT NULL AND o.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.roles AS r ON r.id = u.role_id
             WHERE r.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.departments AS d ON d.id = u.department_id AND d.organization_id = u.organization_id
             WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

PRINT N'[5] departments.organization_id NULL: ' + CAST(@d_null_final AS NVARCHAR(20)) + N' (esperado 0).';
PRINT N'[5] departments.organization_id NOT NULL: ' + CAST(@dept_nn_final AS NVARCHAR(10)) + N' (esperado 1).';
PRINT N'[5] users.organization_id NOT NULL: ' + CAST(@users_nn_final AS NVARCHAR(10)) + N' (esperado 0 = NULL-able).';
PRINT N'[5] UNIQUE dependientes presentes: ' + CAST(@uq_final AS NVARCHAR(10)) + N' (esperado 2).';
PRINT N'[5] FK de departments presentes/confiables: ' + CAST(@fk_final AS NVARCHAR(10)) + N' (esperado 4).';
PRINT N'[5] Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0).';

/* ---------------------------------------------------------------------------
 * 6. Resumen automatico GO / NO-GO (del propio grupo D)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN GRUPO D (departments.organization_id NOT NULL) ===';
PRINT N'  departments.organization_id NOT NULL: ' + CAST(@dept_nn_final AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments.organization_id NULL: ' + CAST(@d_null_final AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  users.organization_id NOT NULL: ' + CAST(@users_nn_final AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  UNIQUE dependientes presentes: ' + CAST(@uq_final AS NVARCHAR(10)) + N' (esperado 2)';
PRINT N'  FK de departments presentes/confiables: ' + CAST(@fk_final AS NVARCHAR(10)) + N' (esperado 4)';
PRINT N'  Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0)';
IF @dept_nn_final = 1
   AND @d_null_final = 0
   AND @users_nn_final = 0
   AND @uq_final = 2
   AND @fk_final = 4
   AND @orfanos = 0
    PRINT N'GRUPO D: GO - departments.organization_id es NOT NULL y todas las restricciones/FK siguen intactas. Ejecute verify-after-groupD.sql para el veredicto formal.';
ELSE
    PRINT N'GRUPO D: NO-GO (post-COMMIT) - DETENER, documentar y escalar al auditor; NO restaurar el respaldo automaticamente.';
PRINT N'';

