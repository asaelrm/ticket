/* ============================================================================
 * SIFHA - VERIFICADOR FINAL SOLO LECTURA post-GRUPO D (estado reconciliado)
 * Reconciliacion de SIFHA_GroupD_ScratchTest (instancia SIFHADEV)
 * ----------------------------------------------------------------------------
 * EXCLUSIVAMENTE SELECT / sys.* / conteos. NO contiene CREATE, ALTER, DROP,
 * INSERT, UPDATE ni DELETE. NO modifica datos ni metadatos. Puede ejecutarse
 * con un login de solo lectura.
 *
 * Cuando ejecutarlo:
 *   DESPUES del grupo D (reconcile-dev-draft.sql con @AuthorizeDdl=1 y
 *   @MakeDepartmentsNotNull=1; "Fase 8: departments.organization_id es NOT NULL.")
 *   y SIEMPRE ANTES de arrancar el backend contra DEV: el arranque crea
 *   sesiones y hace crecer `sessions`, y este verificador esta calibrado al
 *   estado reconaliado (97 registros).
 *
 * Resultado esperado (post-D, pre-arranque):
 *   - 24/24 tablas presentes.
 *   - 97 registros totales (organizations 1 = CMUCE; roles 3, permissions 24,
 *     role_permissions 41, users 1, departments 25, sessions 2; 17 nuevas en 0).
 *   - 1 organizacion con code = 'CMUCE'; usuarios y departamentos asignados a
 *     ella (0 filas con NULL o con otra organizacion).
 *   - departments.organization_id es NOT NULL (is_nullable = 0) y
 *     users.organization_id sigue siendo NULL-able (paridad con schema.sql).
 *   - 9/9 longitudes NVARCHAR en objetivo.
 *   - 0 constraints/FK/indice esperados faltantes; 0 huerfanos de integridad.
 *   - Usuario ADMIN (id 4, rol_id 7, department_id 68, en CMUCE) y rol ADMIN
 *     (unico, con permisos asignados) conservados; roles=3, permissions=24,
 *     role_permissions=41 sin huerfanos (conservacion de roles/permisos).
 *   - Paridad canonica (nulabilidad + IDENTITY) de las 7 tablas con datos.
 *   -> Resumen final: "VERIFICADOR FINAL: GO".
 *
 * Estado tras el grupo C (antes de D): este script muestra NULL 0/0 pero
 * "departments.organization_id NO es NOT NULL" -> NO-GO (esperado: falta D).
 * ============================================================================ */

SET NOCOUNT ON;

/* ---------------------------------------------------------------------------
 * 0. Guarda de identidad (solo lectura)
 * ------------------------------------------------------------------------- */
DECLARE @db SYSNAME = DB_NAME();
DECLARE @inst NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));
DECLARE @srv NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));

SELECT @db AS base_actual,
       @srv AS servidor,
       @inst AS instancia,
       CASE WHEN UPPER(@db) = UPPER(N'SIFHA_GroupD_ScratchTest') AND UPPER(ISNULL(@inst, N'')) = N'SIFHADEV'
            THEN N'OK' ELSE N'NO AUTORIZADA' END AS contexto;

IF UPPER(@db) <> UPPER(N'SIFHA_GroupD_ScratchTest') OR UPPER(ISNULL(@inst, N'')) <> N'SIFHADEV'
BEGIN
    RAISERROR(N'ABORTADO: este verificador solo aplica a SIFHA_GroupD_ScratchTest en SIFHADEV.', 16, 1);
    RETURN;
END;

DECLARE @faltantes_tablas INT = 0;
DECLARE @desvios_conteo INT = 0;
DECLARE @faltantes_uq INT = 0;
DECLARE @faltantes_fk INT = 0;
DECLARE @faltantes_ix INT = 0;
DECLARE @longitud_ok INT = 0;
DECLARE @longitud_diff INT = 0;
DECLARE @total_rows BIGINT = 0;
DECLARE @u_null BIGINT = -1;
DECLARE @d_null BIGINT = -1;
DECLARE @cmuce_count INT = -1;
DECLARE @cmuce_id INT = NULL;
DECLARE @dept_nn INT = -1;   -- 1 = departments.organization_id NOT NULL
DECLARE @users_nn INT = -1;  -- 0 = users.organization_id NULL-able (canonico)
DECLARE @orfanos INT = 0;
DECLARE @paridad_diff INT = 0;
DECLARE @admin_role_count INT = -1;   -- 1 = existe exactamente un rol con code ADMIN
DECLARE @admin_role_id INT = NULL;    -- id del rol ADMIN (esperado 7)
DECLARE @admin_user_ok INT = -1;      -- 1 = usuario id 4 con rol ADMIN, dept 68, en CMUCE
DECLARE @admin_has_perms INT = -1;    -- 1 = el rol ADMIN conserva permisos asignados
DECLARE @ExpectedAdminUserId INT = 4;
DECLARE @ExpectedAdminRoleId INT = 7;
DECLARE @ExpectedAdminDepartmentId INT = 68;
DECLARE @sql NVARCHAR(MAX);
DECLARE @n BIGINT;

/* ---------------------------------------------------------------------------
 * 1. Tablas requeridas (24) - presencia
 * ------------------------------------------------------------------------- */
PRINT N'--- [1] Tablas requeridas (24): PRESENTE / FALTA ---';
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
 * 2. Conteo de registros por tabla (esperado 97 despues de D)
 *    loops con SQL dinamico: si la tabla no existe, actual = -1 (FALTA)
 * ------------------------------------------------------------------------- */
PRINT N'--- [2] Conteo de registros (esperado total: 97 tras D) ---';
DECLARE @tabla_cur SYSNAME;
DECLARE @esperado BIGINT;
DECLARE @actual BIGINT;

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT tabla, esperado
    FROM (VALUES
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
    ) AS t(tabla, esperado)
    ORDER BY t.tabla;

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

PRINT N'Total de registros en las 24 tablas (esperado 97 tras D): ' + CAST(@total_rows AS NVARCHAR(20));

/* ---------------------------------------------------------------------------
 * 3. Organizacion CMUCE y pertenencia de users/departments
 * ------------------------------------------------------------------------- */
PRINT N'--- [3] Organizacion CMUCE (esperada: 1 fila) y pertenencia ---';
IF OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL
BEGIN
    SELECT id, code, name, active, created_at AS creada
    FROM dbo.organizations
    ORDER BY id;

    SELECT @cmuce_count = ISNULL(SUM(CASE WHEN code = N'CMUCE' THEN 1 ELSE 0 END), 0),
           @cmuce_id = MAX(CASE WHEN code = N'CMUCE' THEN id END)
    FROM dbo.organizations;
END
ELSE
    PRINT N'organizations no existe (aun no creada).';

IF @cmuce_count = 1 AND @cmuce_id IS NOT NULL
BEGIN
    PRINT N'CMUCE encontrada con id = ' + CAST(@cmuce_id AS NVARCHAR(10));

    -- Departamentos/usuarios que NO pertenezcan exactamente a CMUCE (0 esperado)
    IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL OR organization_id <> @oid;';
        EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @n OUTPUT;
        SELECT @n AS departments_fuera_de_CMUCE;
    END;

    IF COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL OR organization_id <> @oid;';
        EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @n OUTPUT;
        SELECT @n AS users_fuera_de_CMUCE;
    END;
END
ELSE
    PRINT N'CMUCE no encontrada (aun no creada o code distinto): @cmuce_count = ' + CAST(ISNULL(@cmuce_count, -1) AS NVARCHAR(10));

/* ---------------------------------------------------------------------------
 * 4. organization_id: NULL esperado 0/0 post-C, y nulabilidad canonica post-D
 * ------------------------------------------------------------------------- */
PRINT N'--- [4] organization_id NULL (esperado 0/0) y nulabilidad post-D ---';
IF COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
    PRINT N'users.organization_id: NO EXISTE';
ELSE
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_null OUTPUT;
    PRINT N'users con organization_id NULL: ' + CAST(@u_null AS NVARCHAR(20));
END;

IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
    PRINT N'departments.organization_id: NO EXISTE';
ELSE
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null OUTPUT;
    PRINT N'departments con organization_id NULL: ' + CAST(@d_null AS NVARCHAR(20));
END;

SET @dept_nn = ISNULL((
    SELECT CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
    FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id'
), -1);
SET @users_nn = ISNULL((
    SELECT CASE WHEN c.is_nullable = 0 THEN 1 ELSE 0 END
    FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id'
), -1);

PRINT N'departments.organization_id NOT NULL (1 = si, canonico): ' + CAST(@dept_nn AS NVARCHAR(10));
PRINT N'users.organization_id NOT NULL (0 = NULL-able, canonico): ' + CAST(@users_nn AS NVARCHAR(10));

/* ---------------------------------------------------------------------------
 * 5. Longitudes NVARCHAR de las 9 columnas corregidas
 * ------------------------------------------------------------------------- */
PRINT N'--- [5] Longitudes NVARCHAR (9 corregidas, caracteres) ---';
SELECT x.tabla, x.columna, x.objetivo,
       c.max_length / 2 AS actual_chars,
       CASE WHEN c.max_length = -1 THEN N'NVARCHAR(MAX)'
            WHEN c.max_length / 2 = x.objetivo THEN N'OK'
            ELSE N'DIFIERE' END AS estado
FROM (VALUES
    (N'departments', N'name', 150), (N'roles', N'name', 150),
    (N'users', N'email', 320), (N'users', N'last_name', 150), (N'users', N'name', 150),
    (N'users', N'password_hash', 500), (N'users', N'password_reset_token', 500),
    (N'users', N'position', 200), (N'users', N'username', 150)
) AS x(tabla, columna, objetivo)
LEFT JOIN sys.columns AS c
       ON c.object_id = OBJECT_ID(N'dbo.' + x.tabla) AND c.name = x.columna
ORDER BY x.tabla, x.columna;

SELECT @longitud_ok = COUNT(*)
FROM (VALUES
    (N'departments', N'name', 150), (N'roles', N'name', 150),
    (N'users', N'email', 320), (N'users', N'last_name', 150), (N'users', N'name', 150),
    (N'users', N'password_hash', 500), (N'users', N'password_reset_token', 500),
    (N'users', N'position', 200), (N'users', N'username', 150)
) AS x(tabla, columna, objetivo)
WHERE EXISTS (
    SELECT 1 FROM sys.columns AS c
    WHERE c.object_id = OBJECT_ID(N'dbo.' + x.tabla) AND c.name = x.columna
      AND c.max_length <> -1 AND c.max_length / 2 = x.objetivo
);

SELECT @longitud_diff = 9 - @longitud_ok;

/* ---------------------------------------------------------------------------
 * 6. Constraints UNIQUE (UQ_*) esperados
 * ------------------------------------------------------------------------- */
PRINT N'--- [6] Constraints UQ_* esperados ---';
SELECT v.constraint_name AS constraint_esperado,
       CASE WHEN kc.object_id IS NULL THEN N'FALTA' ELSE N'PRESENTE' END AS estado
FROM (VALUES
    (N'UQ_organizations_code'),
    (N'UQ_departments_organization_id'), (N'UQ_departments_organization_name'),
    (N'UQ_users_organization_id'), (N'UQ_users_username'), (N'UQ_users_email'),
    (N'UQ_roles_code'), (N'UQ_permissions_code'),
    (N'UQ_categories_organization_name'), (N'UQ_categories_organization_id'),
    (N'UQ_teams_organization_name'), (N'UQ_teams_organization_id'),
    (N'UQ_tickets_organization_ticket_number'), (N'UQ_tickets_organization_id'),
    (N'UQ_canned_responses_organization_id'),
    (N'UQ_ticket_comments_organization_id'),
    (N'UQ_ticket_attachments_stored_name'),
    (N'UQ_kb_categories_organization_name'), (N'UQ_kb_categories_organization_id'),
    (N'UQ_kb_articles_organization_id')
) AS v(constraint_name)
LEFT JOIN sys.key_constraints AS kc ON kc.name = v.constraint_name
ORDER BY CASE WHEN kc.object_id IS NULL THEN 0 ELSE 1 END, v.constraint_name;

SELECT @faltantes_uq = COUNT(*)
FROM (VALUES
    (N'UQ_organizations_code'),
    (N'UQ_departments_organization_id'), (N'UQ_departments_organization_name'),
    (N'UQ_users_organization_id'), (N'UQ_users_username'), (N'UQ_users_email'),
    (N'UQ_roles_code'), (N'UQ_permissions_code'),
    (N'UQ_categories_organization_name'), (N'UQ_categories_organization_id'),
    (N'UQ_teams_organization_name'), (N'UQ_teams_organization_id'),
    (N'UQ_tickets_organization_ticket_number'), (N'UQ_tickets_organization_id'),
    (N'UQ_canned_responses_organization_id'),
    (N'UQ_ticket_comments_organization_id'),
    (N'UQ_ticket_attachments_stored_name'),
    (N'UQ_kb_categories_organization_name'), (N'UQ_kb_categories_organization_id'),
    (N'UQ_kb_articles_organization_id')
) AS v(constraint_name)
WHERE NOT EXISTS (SELECT 1 FROM sys.key_constraints AS kc WHERE kc.name = v.constraint_name);

/* ---------------------------------------------------------------------------
 * 7. Claves foraneas esperadas (habilitadas y confiables)
 * ------------------------------------------------------------------------- */
PRINT N'--- [7] FKs esperadas (habilitadas y confiables) ---';
SELECT v.fk AS fk_esperado,
       CASE WHEN fk.object_id IS NULL THEN N'FALTA'
            WHEN fk.is_disabled = 1 THEN N'DESHABILITADA'
            WHEN fk.is_not_trusted = 1 THEN N'NO CONFIABLE'
            ELSE N'PRESENTE' END AS estado
FROM (VALUES
    (N'FK_role_permissions_role'), (N'FK_role_permissions_permission'),
    (N'FK_departments_organization'), (N'FK_users_organization'),
    (N'FK_users_role'), (N'FK_users_department_same_org'),
    (N'FK_categories_organization'), (N'FK_teams_organization'),
    (N'FK_team_members_team_same_org'), (N'FK_team_members_user_same_org'),
    (N'FK_tickets_organization'), (N'FK_tickets_reporter_same_org'),
    (N'FK_tickets_team_same_org'), (N'FK_tickets_category_same_org'),
    (N'FK_tickets_department_same_org'),
    (N'FK_canned_responses_organization'), (N'FK_canned_responses_owner_same_org'),
    (N'FK_canned_responses_team_same_org'),
    (N'FK_ticket_comments_ticket_same_org'),
    (N'FK_ticket_attachments_ticket_same_org'),
    (N'FK_ticket_history_ticket_same_org'),
    (N'FK_org_settings_organization'), (N'FK_email_logs_ticket_same_org'),
    (N'FK_notifications_user_same_org'), (N'FK_notifications_ticket_same_org'),
    (N'FK_kb_categories_organization'), (N'FK_kb_articles_organization'),
    (N'FK_kb_articles_category_same_org'),
    (N'FK_kb_ticket_articles_article_same_org'),
    (N'FK_kb_article_history_article_same_org')
) AS v(fk)
LEFT JOIN sys.foreign_keys AS fk ON fk.name = v.fk
ORDER BY CASE WHEN fk.object_id IS NULL THEN 0 ELSE 1 END, v.fk;

SELECT @faltantes_fk = COUNT(*)
FROM (VALUES
    (N'FK_role_permissions_role'), (N'FK_role_permissions_permission'),
    (N'FK_departments_organization'), (N'FK_users_organization'),
    (N'FK_users_role'), (N'FK_users_department_same_org'),
    (N'FK_categories_organization'), (N'FK_teams_organization'),
    (N'FK_team_members_team_same_org'), (N'FK_team_members_user_same_org'),
    (N'FK_tickets_organization'), (N'FK_tickets_reporter_same_org'),
    (N'FK_tickets_team_same_org'), (N'FK_tickets_category_same_org'),
    (N'FK_tickets_department_same_org'),
    (N'FK_canned_responses_organization'), (N'FK_canned_responses_owner_same_org'),
    (N'FK_canned_responses_team_same_org'),
    (N'FK_ticket_comments_ticket_same_org'),
    (N'FK_ticket_attachments_ticket_same_org'),
    (N'FK_ticket_history_ticket_same_org'),
    (N'FK_org_settings_organization'), (N'FK_email_logs_ticket_same_org'),
    (N'FK_notifications_user_same_org'), (N'FK_notifications_ticket_same_org'),
    (N'FK_kb_categories_organization'), (N'FK_kb_articles_organization'),
    (N'FK_kb_articles_category_same_org'),
    (N'FK_kb_ticket_articles_article_same_org'),
    (N'FK_kb_article_history_article_same_org')
) AS v(fk)
WHERE NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys AS fk
    WHERE fk.name = v.fk AND fk.is_disabled = 0 AND fk.is_not_trusted = 0
);

/* ---------------------------------------------------------------------------
 * 8. Indices IX_* esperados
 * ------------------------------------------------------------------------- */
PRINT N'--- [8] Indices IX_* esperados ---';
SELECT v.ix AS indice_esperado,
       CASE WHEN i.object_id IS NULL THEN N'FALTA' ELSE N'PRESENTE' END AS estado
FROM (VALUES
    (N'IX_organizations_active'),
    (N'IX_users_organization_active'), (N'IX_users_department'),
    (N'IX_tickets_org_status_priority'), (N'IX_tickets_org_assigned'),
    (N'IX_tickets_org_created'), (N'IX_tickets_org_sla_due'),
    (N'IX_tickets_org_category'), (N'IX_tickets_org_department'),
    (N'IX_team_members_user'),
    (N'IX_canned_responses_org_scope_active'),
    (N'IX_ticket_comments_org_ticket_internal'),
    (N'IX_ticket_attachments_org_ticket'), (N'IX_ticket_attachments_comment'),
    (N'IX_ticket_history_org_ticket_created'),
    (N'IX_sessions_expire'),
    (N'IX_email_logs_org_created'),
    (N'IX_notifications_org_user_read'), (N'IX_notifications_org_ticket'),
    (N'IX_kb_articles_org_status_published'), (N'IX_kb_articles_org_category'),
    (N'IX_kb_ticket_articles_ticket'),
    (N'IX_kb_article_history_article')
) AS v(ix)
LEFT JOIN sys.indexes AS i
       ON i.name = v.ix AND i.object_id = object_id(
          CASE WHEN v.ix IN (N'IX_organizations_active') THEN N'dbo.organizations'
               WHEN v.ix IN (N'IX_users_organization_active', N'IX_users_department') THEN N'dbo.users'
               WHEN v.ix LIKE N'IX_tickets_org[_]%' THEN N'dbo.tickets'
               WHEN v.ix = N'IX_team_members_user' THEN N'dbo.team_members'
               WHEN v.ix = N'IX_canned_responses_org_scope_active' THEN N'dbo.canned_responses'
               WHEN v.ix = N'IX_ticket_comments_org_ticket_internal' THEN N'dbo.ticket_comments'
               WHEN v.ix IN (N'IX_ticket_attachments_org_ticket', N'IX_ticket_attachments_comment') THEN N'dbo.ticket_attachments'
               WHEN v.ix = N'IX_ticket_history_org_ticket_created' THEN N'dbo.ticket_history'
               WHEN v.ix = N'IX_sessions_expire' THEN N'dbo.sessions'
               WHEN v.ix = N'IX_email_logs_org_created' THEN N'dbo.email_logs'
               WHEN v.ix LIKE N'IX_notifications_org[_]%' THEN N'dbo.notifications'
               WHEN v.ix LIKE N'IX_kb_articles_org[_]%' THEN N'dbo.kb_articles'
               WHEN v.ix = N'IX_kb_ticket_articles_ticket' THEN N'dbo.kb_ticket_articles'
               WHEN v.ix = N'IX_kb_article_history_article' THEN N'dbo.kb_article_history'
               ELSE N'dbo.x_no_existe' END)
ORDER BY CASE WHEN i.object_id IS NULL THEN 0 ELSE 1 END, v.ix;

SELECT @faltantes_ix = COUNT(*)
FROM (VALUES
    (N'IX_organizations_active', N'dbo.organizations'),
    (N'IX_users_organization_active', N'dbo.users'), (N'IX_users_department', N'dbo.users'),
    (N'IX_tickets_org_status_priority', N'dbo.tickets'), (N'IX_tickets_org_assigned', N'dbo.tickets'),
    (N'IX_tickets_org_created', N'dbo.tickets'), (N'IX_tickets_org_sla_due', N'dbo.tickets'),
    (N'IX_tickets_org_category', N'dbo.tickets'), (N'IX_tickets_org_department', N'dbo.tickets'),
    (N'IX_team_members_user', N'dbo.team_members'),
    (N'IX_canned_responses_org_scope_active', N'dbo.canned_responses'),
    (N'IX_ticket_comments_org_ticket_internal', N'dbo.ticket_comments'),
    (N'IX_ticket_attachments_org_ticket', N'dbo.ticket_attachments'),
    (N'IX_ticket_attachments_comment', N'dbo.ticket_attachments'),
    (N'IX_ticket_history_org_ticket_created', N'dbo.ticket_history'),
    (N'IX_sessions_expire', N'dbo.sessions'),
    (N'IX_email_logs_org_created', N'dbo.email_logs'),
    (N'IX_notifications_org_user_read', N'dbo.notifications'),
    (N'IX_notifications_org_ticket', N'dbo.notifications'),
    (N'IX_kb_articles_org_status_published', N'dbo.kb_articles'),
    (N'IX_kb_articles_org_category', N'dbo.kb_articles'),
    (N'IX_kb_ticket_articles_ticket', N'dbo.kb_ticket_articles'),
    (N'IX_kb_article_history_article', N'dbo.kb_article_history')
) AS v(ix, tabla)
WHERE NOT EXISTS (
    SELECT 1 FROM sys.indexes AS i
    WHERE i.name = v.ix AND i.object_id = OBJECT_ID(v.tabla)
);

/* ---------------------------------------------------------------------------
 * 9. Integridad referencial: huerfanos y pertenencia (0 esperado)
 * ------------------------------------------------------------------------- */
PRINT N'--- [9] Integridad referencial (huerfanos, esperado 0) ---';

-- 9.1 departments huerfanos de organizacion (o pertenencia fuera de CMUCE)
IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
BEGIN
    SET @sql = N'
        SELECT d.id, d.name, d.organization_id
        FROM dbo.departments AS d
        LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
        WHERE d.organization_id IS NOT NULL AND o.id IS NULL
           OR (d.organization_id IS NOT NULL AND @oid IS NOT NULL AND d.organization_id <> @oid);';
    EXEC sys.sp_executesql @sql, N'@oid INT', @oid = @cmuce_id;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
                 LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
                 WHERE d.organization_id IS NOT NULL AND o.id IS NULL
                    OR (d.organization_id IS NOT NULL AND @oid IS NOT NULL AND d.organization_id <> @oid);';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;
    PRINT N'  departments huerfanos / fuera de CMUCE: ' + CAST(@n AS NVARCHAR(20));
END;

-- 9.2 users huerfanos (org / rol / departamento same-org)
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
BEGIN
    IF OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL
       AND COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT u.id, u.username
                     FROM dbo.users AS u LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
                     WHERE u.organization_id IS NOT NULL AND o.id IS NULL;';
        EXEC sys.sp_executesql @sql;
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                     LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
                     WHERE u.organization_id IS NOT NULL AND o.id IS NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
        SET @orfanos = @orfanos + @n;
        PRINT N'  users sin organizacion valida: ' + CAST(@n AS NVARCHAR(20));
    END;

    SET @sql = N'SELECT u.id, u.username
                 FROM dbo.users AS u LEFT JOIN dbo.roles AS r ON r.id = u.role_id
                 WHERE r.id IS NULL;';
    EXEC sys.sp_executesql @sql;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.roles AS r ON r.id = u.role_id
                 WHERE r.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;
    PRINT N'  users sin rol valido: ' + CAST(@n AS NVARCHAR(20));

    IF COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
       AND COL_LENGTH(N'dbo.users', N'department_id') IS NOT NULL
       AND COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
    BEGIN
        SET @sql = N'SELECT u.id, u.username, u.department_id
                     FROM dbo.users AS u
                     LEFT JOIN dbo.departments AS d
                            ON d.id = u.department_id AND d.organization_id = u.organization_id
                     WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
        EXEC sys.sp_executesql @sql;
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                     LEFT JOIN dbo.departments AS d
                            ON d.id = u.department_id AND d.organization_id = u.organization_id
                     WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
        SET @orfanos = @orfanos + @n;
        PRINT N'  users con departamento no coincidente (same-org): ' + CAST(@n AS NVARCHAR(20));
    END;
END;

-- 9.3 role_permissions huerfanos (rol / permiso)
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL
BEGIN
    SET @sql = N'SELECT rp.role_id, rp.permission_id
                 FROM dbo.role_permissions AS rp
                 LEFT JOIN dbo.roles AS r ON r.id = rp.role_id
                 LEFT JOIN dbo.permissions AS p ON p.id = rp.permission_id
                 WHERE r.id IS NULL OR p.id IS NULL;';
    EXEC sys.sp_executesql @sql;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.role_permissions AS rp
                 LEFT JOIN dbo.roles AS r ON r.id = rp.role_id
                 LEFT JOIN dbo.permissions AS p ON p.id = rp.permission_id
                 WHERE r.id IS NULL OR p.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos = @orfanos + @n;
    PRINT N'  role_permissions huerfanas: ' + CAST(@n AS NVARCHAR(20));
END;

PRINT N'  TOTAL huerfanos: ' + CAST(@orfanos AS NVARCHAR(20));

/* ---------------------------------------------------------------------------
 * 10. Paridad canonica: nulabilidad + IDENTITY de las 7 tablas con datos
 * ------------------------------------------------------------------------- */
PRINT N'--- [10] Paridad canonica (nulabilidad + IDENTITY, columnas clave) ---';
;WITH exp(tabla, columna, notnull, ident) AS (
    SELECT v.tabla, v.columna, v.notnull, v.ident
    FROM (VALUES
        (N'organizations', N'id', 1, 1), (N'organizations', N'code', 1, 0),
        (N'organizations', N'name', 1, 0), (N'organizations', N'active', 1, 0),
        (N'organizations', N'created_at', 1, 0),
        (N'roles', N'id', 1, 1), (N'roles', N'code', 1, 0),
        (N'roles', N'name', 1, 0), (N'roles', N'active', 1, 0),
        (N'permissions', N'id', 1, 1), (N'permissions', N'code', 1, 0),
        (N'role_permissions', N'role_id', 1, 0), (N'role_permissions', N'permission_id', 1, 0),
        (N'departments', N'id', 1, 1), (N'departments', N'organization_id', 1, 0),
        (N'departments', N'name', 1, 0), (N'departments', N'active', 1, 0),
        (N'users', N'id', 1, 1), (N'users', N'organization_id', 0, 0),
        (N'users', N'department_id', 0, 0), (N'users', N'role_id', 1, 0),
        (N'users', N'name', 1, 0), (N'users', N'last_name', 1, 0),
        (N'users', N'username', 1, 0), (N'users', N'email', 1, 0),
        (N'users', N'password_hash', 1, 0), (N'users', N'position', 0, 0),
        (N'users', N'active', 1, 0), (N'users', N'password_reset_token', 0, 0),
        (N'sessions', N'sid', 1, 0), (N'sessions', N'sess', 1, 0), (N'sessions', N'expire', 1, 0)
    ) AS v(tabla, columna, notnull, ident)
)
SELECT e.tabla, e.columna,
       CASE WHEN e.notnull = 1 THEN N'NOT NULL' ELSE N'NULL' END AS nulabilidad_esperada,
       CASE WHEN e.ident = 1 THEN N'IDENTITY' ELSE N'-' END AS identity_esperada,
       CASE WHEN c.object_id IS NULL THEN N'FALTA'
            WHEN (e.notnull = 1 AND c.is_nullable = 1) OR (e.notnull = 0 AND c.is_nullable = 0) THEN N'NULABILIDAD DIFIERE'
            WHEN (e.ident = 1 AND ic.column_id IS NULL) OR (e.ident = 0 AND ic.column_id IS NOT NULL) THEN N'IDENTITY DIFIERE'
            ELSE N'OK' END AS estado
FROM exp AS e
LEFT JOIN sys.tables AS t ON t.name = e.tabla AND t.schema_id = SCHEMA_ID(N'dbo')
LEFT JOIN sys.columns AS c ON c.object_id = t.object_id AND c.name = e.columna
LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
ORDER BY e.tabla, e.columna;

;WITH exp(tabla, columna, notnull, ident) AS (
    SELECT v.tabla, v.columna, v.notnull, v.ident
    FROM (VALUES
        (N'organizations', N'id', 1, 1), (N'organizations', N'code', 1, 0),
        (N'organizations', N'name', 1, 0), (N'organizations', N'active', 1, 0),
        (N'organizations', N'created_at', 1, 0),
        (N'roles', N'id', 1, 1), (N'roles', N'code', 1, 0),
        (N'roles', N'name', 1, 0), (N'roles', N'active', 1, 0),
        (N'permissions', N'id', 1, 1), (N'permissions', N'code', 1, 0),
        (N'role_permissions', N'role_id', 1, 0), (N'role_permissions', N'permission_id', 1, 0),
        (N'departments', N'id', 1, 1), (N'departments', N'organization_id', 1, 0),
        (N'departments', N'name', 1, 0), (N'departments', N'active', 1, 0),
        (N'users', N'id', 1, 1), (N'users', N'organization_id', 0, 0),
        (N'users', N'department_id', 0, 0), (N'users', N'role_id', 1, 0),
        (N'users', N'name', 1, 0), (N'users', N'last_name', 1, 0),
        (N'users', N'username', 1, 0), (N'users', N'email', 1, 0),
        (N'users', N'password_hash', 1, 0), (N'users', N'position', 0, 0),
        (N'users', N'active', 1, 0), (N'users', N'password_reset_token', 0, 0),
        (N'sessions', N'sid', 1, 0), (N'sessions', N'sess', 1, 0), (N'sessions', N'expire', 1, 0)
    ) AS v(tabla, columna, notnull, ident)
)
SELECT @paridad_diff = COUNT(*)
FROM exp AS e
LEFT JOIN sys.tables AS t ON t.name = e.tabla AND t.schema_id = SCHEMA_ID(N'dbo')
LEFT JOIN sys.columns AS c ON c.object_id = t.object_id AND c.name = e.columna
LEFT JOIN sys.identity_columns AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
WHERE c.object_id IS NULL
   OR (e.notnull = 1 AND c.is_nullable = 1) OR (e.notnull = 0 AND c.is_nullable = 0)
   OR (e.ident = 1 AND ic.column_id IS NULL) OR (e.ident = 0 AND ic.column_id IS NOT NULL);

/* ---------------------------------------------------------------------------
 * 11. Usuario ADMIN (id 4) y conservacion de roles/permisos originales
 * ------------------------------------------------------------------------- */
PRINT N'--- [11] Usuario ADMIN (id 4) y conservacion de roles/permisos ---';

IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
BEGIN
    SELECT id, code, name, active FROM dbo.roles ORDER BY id;

    SELECT @admin_role_count = ISNULL(SUM(CASE WHEN code = N'ADMIN' THEN 1 ELSE 0 END), 0),
           @admin_role_id = MAX(CASE WHEN code = N'ADMIN' THEN id END)
    FROM dbo.roles;
END
ELSE
    PRINT N'roles no existe.';

PRINT N'  Rol code = ADMIN: ' + CAST(ISNULL(@admin_role_count, -1) AS NVARCHAR(10)) + N' (esperado 1)'
      + N'; id = ' + CAST(ISNULL(@admin_role_id, -1) AS NVARCHAR(10))
      + N' (esperado ' + CAST(@ExpectedAdminRoleId AS NVARCHAR(10)) + N').';

IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
BEGIN
    SELECT id, username, role_id, department_id, organization_id, active
    FROM dbo.users WHERE id = @ExpectedAdminUserId;

    SET @admin_user_ok = ISNULL((
        SELECT TOP 1 CASE
            WHEN u.role_id = @ExpectedAdminRoleId
             AND u.department_id = @ExpectedAdminDepartmentId
             AND (@cmuce_id IS NULL OR u.organization_id = @cmuce_id)
            THEN 1 ELSE 0 END
        FROM dbo.users AS u
        WHERE u.id = @ExpectedAdminUserId
    ), -1);
END
ELSE
    SET @admin_user_ok = -1;

PRINT N'  Usuario ADMIN id ' + CAST(@ExpectedAdminUserId AS NVARCHAR(10))
      + N' (rol ' + CAST(@ExpectedAdminRoleId AS NVARCHAR(10))
      + N', dept ' + CAST(@ExpectedAdminDepartmentId AS NVARCHAR(10))
      + N', en CMUCE): ' + CAST(@admin_user_ok AS NVARCHAR(10)) + N' (esperado 1).';

IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL AND @admin_role_id IS NOT NULL
    SET @admin_has_perms = CASE WHEN EXISTS (
        SELECT 1 FROM dbo.role_permissions WHERE role_id = @admin_role_id
    ) THEN 1 ELSE 0 END;
ELSE
    SET @admin_has_perms = -1;

PRINT N'  Rol ADMIN conserva permisos asignados: ' + CAST(@admin_has_perms AS NVARCHAR(10)) + N' (esperado 1).';
PRINT N'  (Conservacion agregada de roles/permisos se valida en [2]: roles=3, permissions=24, role_permissions=41 y 0 huerfanos en [9].)';

/* ---------------------------------------------------------------------------
 * 12. Resumen automatico GO / NO-GO (solo lectura)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN VERIFICADOR FINAL (estado reconciliado post-D) ===';
PRINT N'  Tablas presentes: ' + CAST(24 - @faltantes_tablas AS NVARCHAR(10)) + N'/24';
PRINT N'  Registros totales (24 tablas): ' + CAST(@total_rows AS NVARCHAR(20)) + N' (esperado 97)';
PRINT N'  Desviaciones de conteo por tabla: ' + CAST(@desvios_conteo AS NVARCHAR(10));
PRINT N'  Organizaciones con code CMUCE: ' + CAST(ISNULL(@cmuce_count, -1) AS NVARCHAR(10)) + N' (esperado 1)';
IF @u_null >= 0
    PRINT N'  users.organization_id NULL: ' + CAST(@u_null AS NVARCHAR(20)) + N' (esperado 0)';
IF @d_null >= 0
    PRINT N'  departments.organization_id NULL: ' + CAST(@d_null AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  departments.organization_id NOT NULL (1 = si): ' + CAST(@dept_nn AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  users.organization_id NULL-able (0 = si): ' + CAST(@users_nn AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  Longitudes NVARCHAR OK: ' + CAST(@longitud_ok AS NVARCHAR(10)) + N'/9';
PRINT N'  CONSTRAINT UQ_* faltantes: ' + CAST(@faltantes_uq AS NVARCHAR(10));
PRINT N'  FK faltantes/deshabilitadas: ' + CAST(@faltantes_fk AS NVARCHAR(10));
PRINT N'  Indices IX_* faltantes: ' + CAST(@faltantes_ix AS NVARCHAR(10));
PRINT N'  Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  Desviaciones de paridad canonica: ' + CAST(@paridad_diff AS NVARCHAR(10)) + N' (esperado 0)';
PRINT N'  Rol ADMIN unico: ' + CAST(ISNULL(@admin_role_count, -1) AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  Usuario ADMIN id 4 correcto: ' + CAST(@admin_user_ok AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  Rol ADMIN con permisos: ' + CAST(@admin_has_perms AS NVARCHAR(10)) + N' (esperado 1)';

IF (24 - @faltantes_tablas) = 24
   AND @desvios_conteo = 0
   AND @total_rows = 97
   AND @cmuce_count = 1
   AND @u_null = 0
   AND @d_null = 0
   AND @dept_nn = 1
   AND @users_nn = 0
   AND @longitud_ok = 9
   AND @faltantes_uq = 0
   AND @faltantes_fk = 0
   AND @faltantes_ix = 0
   AND @orfanos = 0
   AND @paridad_diff = 0
   AND @admin_role_count = 1
   AND @admin_role_id = @ExpectedAdminRoleId
   AND @admin_user_ok = 1
   AND @admin_has_perms = 1
    PRINT N'VERIFICADOR FINAL: GO - reconciliacion completa (post-D), lista para el grupo E (arranque).';
ELSE
    PRINT N'VERIFICADOR FINAL: NO-GO - revisar el detalle de las secciones [1]-[11].';
PRINT N'';
