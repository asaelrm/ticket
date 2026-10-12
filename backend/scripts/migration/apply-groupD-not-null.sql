/* ============================================================================
 * SIFHA - GRUPO D (INDEPENDIENTE): departments.organization_id -> NOT NULL
 *         Exclusivo de la instancia TI-DESK-01\SIFHADEV / base SIFHA_Tickets_DEV
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
 *   7. Existen UQ_departments_organization_id y las FK que referencian
 *      departments(organization_id, id), habilitadas y confiables.
 *   8. Backend detenido; ventana de mantenimiento; respaldo verificado.
 *
 * GARANTIAS DE SEGURIDAD
 *   - UNA SOLA TRANSACCION atomica para el ALTER: si algo falla, ROLLBACK deja
 *     la nulabilidad como estaba.
 *   - El ALTER se re-valida DENTRO de la transaccion, con bloqueos
 *     (UPDLOCK/HOLDLOCK), justo antes de ejecutarse.
 *   - Solo cambia la NULABILIDAD de departments.organization_id. NO cambia el
 *     tipo, no borra datos, no elimina ni deshabilita restricciones/FK/indices.
 *   - Idempotente: si la columna ya es NOT NULL, no se ejecuta el ALTER y se
 *     informa; el resumen sigue siendo GO si el resto del estado es correcto.
 *   - NO usa DROP/TRUNCATE/DELETE, NO usa NOCHECK, NO altera otras columnas.
 *
 * ATOMICIDAD
 *   - ALTER TABLE ... ALTER COLUMN es transaccional en SQL Server. El bloque usa
 *     BEGIN TRANSACTION + TRY/CATCH + XACT_ABORT ON y ROLLBACK si algo falla.
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
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_DEV';
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

PRINT N'Identidad verificada: TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_Tickets_DEV';

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

/* Columna diana e integridad de dependencias: UQ + FK que referencian departments(organization_id, id). */
IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: falta dbo.departments.organization_id. Ejecute y verifique B antes.', 16, 1);
    RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_departments_organization_id')
BEGIN
    RAISERROR(N'ABORTADO: falta UQ_departments_organization_id (la exige FK_users_department_same_org). Ejecute y verifique B antes.', 16, 1);
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

/* Objetos que impedirian el ALTER COLUMN: estadisticas no automaticas y columnas calculadas dependientes. */
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
    FROM sys.computed_columns AS cc
    JOIN sys.sql_expression_dependencies AS sed
         ON sed.referencing_id = cc.object_id AND sed.referenced_id = OBJECT_ID(N'dbo.departments')
    WHERE cc.object_id = OBJECT_ID(N'dbo.departments')
)
BEGIN
    RAISERROR(N'ABORTADO: dependencias sobre departments que podrian bloquear ALTER COLUMN. Revise antes.', 16, 1);
    RETURN;
END;

PRINT N'[2] OK: UQ_departments_organization_id y FK sobre departments(organization_id, id) presentes y confiables.';

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
 * 4. TRANSACCION UNICA: re-validacion bloqueada + ALTER COLUMN + verificacion
 * ------------------------------------------------------------------------- */
DECLARE @cmuce_count_tx INT = -1;
DECLARE @dept_null_tx BIGINT = -1;
DECLARE @dept_total_tx BIGINT = -1;
DECLARE @dept_foreign_tx BIGINT = -1;
DECLARE @dept_nullable_tx BIGINT = -1;
DECLARE @dept_nullable_after BIGINT = -1;

BEGIN TRY
    BEGIN TRANSACTION;

    /* 4.1 Revalidacion autoritativa con bloqueos, antes del ALTER. */
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

    /* 4.2 ALTER COLUMN (solo si aun no es NOT NULL: idempotencia). */
    IF @dept_nullable_tx = 0
        PRINT N'[4] departments.organization_id ya es NOT NULL: ALTER omitido (idempotente).';
    ELSE
    BEGIN
        SET @sql = N'ALTER TABLE dbo.departments ALTER COLUMN organization_id INT NOT NULL;';
        EXEC sys.sp_executesql @sql;
        PRINT N'[4] ALTER aplicado: departments.organization_id es NOT NULL.';
    END;

    /* 4.3 Verificacion dentro de la transaccion, ANTES del COMMIT. */
    SELECT @dept_nullable_after = CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END
    FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

    IF @dept_nullable_after <> 0
        RAISERROR(N'ABORTADO (grupo D): la columna sigue siendo NULL-able tras el ALTER. Se revierte.', 16, 1);

    COMMIT TRANSACTION;
    PRINT N'[4] COMMIT. departments.organization_id es NOT NULL (comprobado antes del COMMIT).';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    PRINT N'ERROR/ABORTADO en grupo D. Se revirtio la nulabilidad.';
    THROW;
END CATCH;

/* ---------------------------------------------------------------------------
 * 5. Validacion posterior (SIN escribir)
 * ------------------------------------------------------------------------- */
DECLARE @d_null_final BIGINT = -1;
DECLARE @dept_nn_final BIGINT = -1;
DECLARE @users_nn_final BIGINT = -1;
DECLARE @orfanos BIGINT = 0;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null_final OUTPUT;

SELECT @dept_nn_final = CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';
SELECT @users_nn_final = CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id';

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
PRINT N'[5] Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0).';

/* ---------------------------------------------------------------------------
 * 6. Resumen automatico GO / NO-GO (del propio grupo D)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN GRUPO D (departments.organization_id NOT NULL) ===';
PRINT N'  departments.organization_id NOT NULL: ' + CAST(@dept_nn_final AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments.organization_id NULL: ' + CAST(@d_null_final AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  users.organization_id NOT NULL: ' + CAST(@users_nn_final AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0)';
IF @dept_nn_final = 1
   AND @d_null_final = 0
   AND @users_nn_final = 0
   AND @orfanos = 0
    PRINT N'GRUPO D: GO - departments.organization_id es NOT NULL. Ejecute verify-after-groupD.sql para el veredicto formal.';
ELSE
    PRINT N'GRUPO D: NO-GO (post-COMMIT) - DETENER, documentar y escalar al auditor; NO restaurar el respaldo automaticamente.';
PRINT N'';
