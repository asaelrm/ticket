/* ============================================================================
 * SIFHA - VERIFICADOR POST-GRUPO D (SOLO LECTURA)
 *         Exclusivo de la instancia TI-DESK-01\SIFHADEV / base SIFHA_Tickets_DEV
 * ============================================================================
 *
 * 100% de SOLO LECTURA: unicamente SELECT / sys.* / conteos. NO contiene CREATE,
 * ALTER, DROP, INSERT, UPDATE ni DELETE. NO modifica datos ni metadatos. Puede
 * ejecutarse con un login de solo lectura.
 *
 * Cuando ejecutarlo:
 *   DESPUES del grupo D (apply-groupD-not-null.sql) y ANTES de arrancar el
 *   backend contra DEV. Tambien vale como comprobacion previa (mostrara NO-GO
 *   en la seccion [4] si el grupo D aun no se ha aplicado).
 *
 * Resultado esperado (post-D, pre-arranque):
 *   - 24/24 tablas presentes.
 *   - 97 registros totales (organizations 1 = CMUCE; roles 3, permissions 24,
 *     role_permissions 41, users 1, departments 25, sessions 2; 17 tablas en 0).
 *   - 1 organizacion con code = 'CMUCE'; los 25 departamentos pertenecen a ella.
 *   - departments.organization_id es INT NOT NULL (is_nullable = 0).
 *   - users.organization_id sigue siendo NULL-able (paridad con schema.sql).
 *   - 0 NULL, 0 registros fuera de CMUCE, 0 huerfanos de integridad.
 *   - UQ, FK e IX_* esperados presentes; FK habilitadas y confiables.
 *   -> Resumen final: "VERIFICADOR POST-D: GO".
 * ============================================================================ */

SET NOCOUNT ON;

/* ---------------------------------------------------------------------------
 * 0. Guarda de identidad (solo lectura)
 * ------------------------------------------------------------------------- */
DECLARE @db SYSNAME = DB_NAME();
DECLARE @inst NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));
DECLARE @srv NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));

SELECT @db AS base_actual, @srv AS servidor, @inst AS instancia,
       CASE WHEN UPPER(@db) = N'SIFHA_TICKETS_DEV' AND UPPER(ISNULL(@inst, N'')) = N'SIFHADEV'
            THEN N'OK' ELSE N'NO AUTORIZADA' END AS contexto;

IF UPPER(@db) <> N'SIFHA_TICKETS_DEV' OR UPPER(ISNULL(@inst, N'')) <> N'SIFHADEV'
BEGIN
    RAISERROR(N'ABORTADO: este verificador solo aplica a SIFHA_Tickets_DEV en SIFHADEV.', 16, 1);
    RETURN;
END;

DECLARE @faltantes_tablas INT = 0;
DECLARE @desvios_conteo INT = 0;
DECLARE @faltantes_uq INT = 0;
DECLARE @faltantes_fk INT = 0;
DECLARE @faltantes_ix INT = 0;
DECLARE @total_rows BIGINT = 0;
DECLARE @cmuce_count INT = -1;
DECLARE @cmuce_id INT = NULL;
DECLARE @dept_total BIGINT = -1;
DECLARE @dept_null BIGINT = -1;
DECLARE @dept_foreign BIGINT = -1;
DECLARE @dept_nn INT = -1;       -- 1 = departments.organization_id NOT NULL
DECLARE @dept_type_ok BIT = 0;   -- 1 = INT
DECLARE @users_nn INT = -1;      -- 0 = users.organization_id NULL-able (canonico)
DECLARE @orfanos INT = 0;
DECLARE @sql NVARCHAR(MAX);
DECLARE @n BIGINT;

/* ---------------------------------------------------------------------------
 * 1. Tablas requeridas (24)
 * ------------------------------------------------------------------------- */
PRINT N'--- [1] Tablas requeridas (24) ---';
SELECT v.tabla,
       CASE WHEN o.object_id IS NULL THEN N'FALTA' ELSE N'PRESENTE' END AS estado
FROM (VALUES
    (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
    (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
    (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
    (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
    (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
    (N'kb_ticket_articles'), (N'kb_article_history')
) AS v(tabla)
LEFT JOIN sys.objects AS o
       ON o.object_id = OBJECT_ID(N'dbo.' + v.tabla) AND o.type = N'U'
ORDER BY CASE WHEN o.object_id IS NULL THEN 0 ELSE 1 END, v.tabla;

SELECT @faltantes_tablas = COUNT(*)
FROM (VALUES
    (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
    (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
    (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
    (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
    (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
    (N'kb_ticket_articles'), (N'kb_article_history')
) AS v(tabla)
WHERE OBJECT_ID(N'dbo.' + v.tabla, N'U') IS NULL;

/* ---------------------------------------------------------------------------
 * 2. Conteo de registros (esperado 97)
 * ------------------------------------------------------------------------- */
PRINT N'--- [2] Conteo de registros (esperado total: 97) ---';
DECLARE @tabla_cur SYSNAME;
DECLARE @esperado BIGINT;
DECLARE @actual BIGINT;

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT tabla, esperado FROM (VALUES
        (N'organizations', CAST(1 AS BIGINT)),
        (N'roles', CAST(3 AS BIGINT)), (N'permissions', CAST(24 AS BIGINT)),
        (N'role_permissions', CAST(41 AS BIGINT)), (N'users', CAST(1 AS BIGINT)),
        (N'departments', CAST(25 AS BIGINT)), (N'sessions', CAST(2 AS BIGINT)),
        (N'categories', CAST(0 AS BIGINT)), (N'teams', CAST(0 AS BIGINT)),
        (N'team_members', CAST(0 AS BIGINT)), (N'tickets', CAST(0 AS BIGINT)),
        (N'canned_responses', CAST(0 AS BIGINT)), (N'ticket_comments', CAST(0 AS BIGINT)),
        (N'ticket_attachments', CAST(0 AS BIGINT)), (N'ticket_history', CAST(0 AS BIGINT)),
        (N'sequences', CAST(0 AS BIGINT)), (N'settings', CAST(0 AS BIGINT)),
        (N'org_settings', CAST(0 AS BIGINT)), (N'email_logs', CAST(0 AS BIGINT)),
        (N'notifications', CAST(0 AS BIGINT)), (N'kb_categories', CAST(0 AS BIGINT)),
        (N'kb_articles', CAST(0 AS BIGINT)), (N'kb_ticket_articles', CAST(0 AS BIGINT)),
        (N'kb_article_history', CAST(0 AS BIGINT))
    ) AS t(tabla, esperado) ORDER BY t.tabla;

OPEN cur;
FETCH NEXT FROM cur INTO @tabla_cur, @esperado;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(N'dbo.' + QUOTENAME(@tabla_cur), N'U') IS NULL
        SET @actual = -1;
    ELSE
    BEGIN
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.' + QUOTENAME(@tabla_cur) + N';';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @actual OUTPUT;
    END;

    SELECT @tabla_cur AS tabla, @esperado AS esperado, @actual AS actual,
           CASE WHEN @actual = @esperado THEN N'OK'
                WHEN @actual = -1   THEN N'FALTA TABLA'
                ELSE N'DIFIERE' END AS estado;

    IF @actual >= 0
    BEGIN
        SET @total_rows = @total_rows + @actual;
        IF @actual <> @esperado SET @desvios_conteo = @desvios_conteo + 1;
    END;
    FETCH NEXT FROM cur INTO @tabla_cur, @esperado;
END;
CLOSE cur;
DEALLOCATE cur;

PRINT N'Total de registros en las 24 tablas (esperado 97): ' + CAST(@total_rows AS NVARCHAR(20));

/* ---------------------------------------------------------------------------
 * 3. CMUCE y pertenencia de departments
 * ------------------------------------------------------------------------- */
PRINT N'--- [3] CMUCE (esperada 1 fila) y pertenencia de departments ---';
IF OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL
BEGIN
    SELECT id, code, name, active, created_at AS creada FROM dbo.organizations ORDER BY id;
    SELECT @cmuce_count = ISNULL(SUM(CASE WHEN code = N'CMUCE' THEN 1 ELSE 0 END), 0),
           @cmuce_id = MAX(CASE WHEN code = N'CMUCE' THEN id END)
    FROM dbo.organizations;
END
ELSE
    PRINT N'organizations no existe.';

IF @cmuce_count = 1 AND @cmuce_id IS NOT NULL
BEGIN
    PRINT N'CMUCE encontrada con id = ' + CAST(@cmuce_id AS NVARCHAR(10));
    IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL OR organization_id <> @oid;';
        EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @n OUTPUT;
        SELECT @n AS departments_fuera_de_CMUCE;
    END;
END
ELSE
    PRINT N'CMUCE no encontrada (aun no creada): @cmuce_count = ' + CAST(ISNULL(@cmuce_count, -1) AS NVARCHAR(10));

/* ---------------------------------------------------------------------------
 * 4. departments.organization_id: nulabilidad + tipo (resultado post-D)
 * ------------------------------------------------------------------------- */
PRINT N'--- [4] departments.organization_id: NOT NULL + INT (resultado post-D) ---';
SELECT @dept_total = COUNT_BIG(*) FROM dbo.departments;
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @dept_null OUTPUT;
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NOT NULL AND organization_id <> @oid;';
EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @dept_foreign OUTPUT;

SELECT @dept_nn = ISNULL(CONVERT(INT, CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END), -1)
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

SELECT @dept_type_ok = CASE WHEN TYPE_NAME(c.user_type_id) = N'int' THEN 1 ELSE 0 END
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

SELECT @users_nn = ISNULL(CONVERT(INT, CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END), -1)
FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id';

PRINT N'  departments totales: ' + CAST(@dept_total AS NVARCHAR(20)) + N' (esperado 25)';
PRINT N'  departments.organization_id NULL: ' + CAST(@dept_null AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  departments fuera de CMUCE: ' + CAST(@dept_foreign AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  departments.organization_id NOT NULL (1 = si): ' + CAST(@dept_nn AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments.organization_id es INT (1 = si): ' + CAST(@dept_type_ok AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  users.organization_id NOT NULL (0 = NULL-able, canonico): ' + CAST(@users_nn AS NVARCHAR(10)) + N' (esperado 0)';

/* ---------------------------------------------------------------------------
 * 5. UNIQUE, FK e IX_* esperados
 * ------------------------------------------------------------------------- */
PRINT N'--- [5] Constraints, FKs e indices esperados ---';
SELECT @faltantes_uq = COUNT(*)
FROM (VALUES
    (N'UQ_organizations_code'),
    (N'UQ_departments_organization_id'), (N'UQ_departments_organization_name'),
    (N'UQ_users_organization_id'), (N'UQ_users_username'), (N'UQ_users_email'),
    (N'UQ_roles_code'), (N'UQ_permissions_code')
) AS v(constraint_name)
WHERE NOT EXISTS (SELECT 1 FROM sys.key_constraints AS kc WHERE kc.name = v.constraint_name);

SELECT @faltantes_fk = COUNT(*)
FROM (VALUES
    (N'FK_departments_organization'), (N'FK_users_organization'), (N'FK_users_role'),
    (N'FK_users_department_same_org'), (N'FK_tickets_department_same_org')
) AS v(fk)
WHERE NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys AS fk
    WHERE fk.name = v.fk AND fk.is_disabled = 0 AND fk.is_not_trusted = 0
);

SELECT @faltantes_ix = COUNT(*)
FROM (VALUES
    (N'IX_organizations_active', N'dbo.organizations'),
    (N'IX_users_organization_active', N'dbo.users'), (N'IX_users_department', N'dbo.users')
) AS v(ix, tabla)
WHERE NOT EXISTS (SELECT 1 FROM sys.indexes AS i WHERE i.name = v.ix AND i.object_id = OBJECT_ID(v.tabla));

PRINT N'  UQ_* faltantes (nucleo): ' + CAST(@faltantes_uq AS NVARCHAR(10));
PRINT N'  FK faltantes/deshabilitadas (departments/users): ' + CAST(@faltantes_fk AS NVARCHAR(10));
PRINT N'  IX_* faltantes (nucleo): ' + CAST(@faltantes_ix AS NVARCHAR(10));

/* ---------------------------------------------------------------------------
 * 6. Integridad referencial (huerfanos, esperado 0)
 * ------------------------------------------------------------------------- */
PRINT N'--- [6] Integridad referencial (huerfanos, esperado 0) ---';
IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
                 LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
                 WHERE d.organization_id IS NULL OR o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;
    PRINT N'  departments huerfanos: ' + CAST(@n AS NVARCHAR(20));
END;

IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
                 WHERE u.organization_id IS NOT NULL AND o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.roles AS r ON r.id = u.role_id WHERE r.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.departments AS d ON d.id = u.department_id AND d.organization_id = u.organization_id
                 WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;
    PRINT N'  users huerfanos (org/rol/departamento): acumulado ' + CAST(@orfanos AS NVARCHAR(20));
END;
PRINT N'  TOTAL huerfanos: ' + CAST(@orfanos AS NVARCHAR(20));

/* ---------------------------------------------------------------------------
 * 7. Resumen automatico GO / NO-GO (solo lectura)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN VERIFICADOR POST-D ===';
PRINT N'  Tablas presentes: ' + CAST(24 - @faltantes_tablas AS NVARCHAR(10)) + N'/24';
PRINT N'  Registros totales (24 tablas): ' + CAST(@total_rows AS NVARCHAR(20)) + N' (esperado 97)';
PRINT N'  Desviaciones de conteo por tabla: ' + CAST(@desvios_conteo AS NVARCHAR(10));
PRINT N'  Organizaciones con code CMUCE: ' + CAST(ISNULL(@cmuce_count, -1) AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments totales / NULL / fuera de CMUCE: '
      + CAST(@dept_total AS NVARCHAR(20)) + N' / ' + CAST(@dept_null AS NVARCHAR(20))
      + N' / ' + CAST(@dept_foreign AS NVARCHAR(20)) + N' (esperado 25 / 0 / 0)';
PRINT N'  departments.organization_id NOT NULL (1 = si): ' + CAST(@dept_nn AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments.organization_id INT (1 = si): ' + CAST(@dept_type_ok AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  users.organization_id NULL-able (0 = si): ' + CAST(@users_nn AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  UQ_* / FK / IX_* faltantes (nucleo): '
      + CAST(@faltantes_uq AS NVARCHAR(10)) + N' / ' + CAST(@faltantes_fk AS NVARCHAR(10))
      + N' / ' + CAST(@faltantes_ix AS NVARCHAR(10));
PRINT N'  Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(10)) + N' (esperado 0)';

IF (24 - @faltantes_tablas) = 24
   AND @desvios_conteo = 0
   AND @total_rows = 97
   AND @cmuce_count = 1
   AND @dept_total = 25
   AND @dept_null = 0
   AND @dept_foreign = 0
   AND @dept_nn = 1
   AND @dept_type_ok = 1
   AND @users_nn = 0
   AND @faltantes_uq = 0
   AND @faltantes_fk = 0
   AND @faltantes_ix = 0
   AND @orfanos = 0
    PRINT N'VERIFICADOR POST-D: GO - departments.organization_id es INT NOT NULL y el estado reconciliado es coherente.';
ELSE
    PRINT N'VERIFICADOR POST-D: NO-GO - revisar el detalle de las secciones [1]-[6].';
PRINT N'';
