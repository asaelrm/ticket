/* ============================================================================
 * SIFHA - VERIFICADOR SOLO LECTURA post-GRUPO C (backfill CMUCE)
 * Reconciliacion de SIFHA_Tickets_DEV (instancia SIFHADEV)
 * ----------------------------------------------------------------------------
 * EXCLUSIVAMENTE SELECT / sys.* / conteos. NO contiene CREATE, ALTER, DROP,
 * INSERT, UPDATE ni DELETE. NO modifica datos ni metadatos. Puede ejecutarse
 * con un login de solo lectura.
 *
 * Cuando ejecutarlo:
 *   DESPUES de backfill-organization-CMUCE.sql, con COMMIT y el resumen
 *   "GRUPO C: GO".
 *
 * Resultado esperado (post-C):
 *   - 24/24 tablas presentes.
 *   - 97 registros totales (organizations 1 [CMUCE], roles 3, permissions 24,
 *     role_permissions 41, users 1, departments 25, sessions 2; 18 nuevas en 0).
 *   - organizations con code = 'CMUCE' = 1.
 *   - departments.organization_id asignados = 25 ; users.organization_id asignados = 1.
 *   - users.organization_id NULL = 0 ; departments.organization_id NULL = 0.
 *   - 0 huerfanos de integridad (organization/department/role/same-org).
 *   - FK_users_department_same_org habilitada y confiable; FK_users_department
 *     (legacy) preservada. 0 constraints/FK/indice esperados faltantes.
 *   - departments.organization_id SIGUE siendo NULLABLE (el NOT NULL llega en D;
 *     aqui solo se informa, no se exige).
 *   -> Resumen final: "VERIFICADOR POST-C: GO".
 *
 * Si se ejecuta ANTES del grupo C, se reportaran FALTAS/DIFIERE sin romper
 * (todas las lecturas estan guardadas con OBJECT_ID / COL_LENGTH / dinamico).
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
DECLARE @cmuce_name NVARCHAR(200) = NULL;
DECLARE @u_null BIGINT = -1;
DECLARE @d_null BIGINT = -1;
DECLARE @d_assigned BIGINT = -1;
DECLARE @u_assigned BIGINT = -1;
DECLARE @orfanos BIGINT = -1;
DECLARE @u4_org INT = NULL;
DECLARE @u4_role INT = NULL;
DECLARE @u4_dept INT = NULL;
DECLARE @d_notnull INT = -1;
DECLARE @sql NVARCHAR(MAX);

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
 * 2. Conteo de registros por tabla (esperado total 97 tras C: organizations=1)
 * ------------------------------------------------------------------------- */
PRINT N'--- [2] Conteo de registros (esperado total: 97 tras grupo C) ---';
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

PRINT N'Total de registros en las 24 tablas (esperado 97 tras C): ' + CAST(@total_rows AS NVARCHAR(20));

/* ---------------------------------------------------------------------------
 * 3. Organizacion CMUCE: existencia, unicidad y nombre
 * ------------------------------------------------------------------------- */
PRINT N'--- [3] Organizacion CMUCE ---';
IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL OR COL_LENGTH(N'dbo.organizations', N'code') IS NULL
    PRINT N'organizations / code: NO EXISTE (aun no aplicado)';
ELSE
BEGIN
    SELECT @cmuce_count = COUNT(*),
           @cmuce_id = MIN(id)
    FROM dbo.organizations
    WHERE code = N'CMUCE';

    IF @cmuce_id IS NOT NULL
        SELECT @cmuce_name = name FROM dbo.organizations WHERE id = @cmuce_id;

    SELECT code, id, name, active, created_at
    FROM dbo.organizations
    WHERE code = N'CMUCE';

    PRINT N'CMUCE filas por code: ' + CAST(@cmuce_count AS NVARCHAR(10)) + N' (esperado 1).';
    PRINT N'CMUCE id: ' + ISNULL(CAST(@cmuce_id AS NVARCHAR(20)), N'(nulo)')
        + N' ; nombre: ' + ISNULL(@cmuce_name, N'(nulo)') + N'.';
END;

/* ---------------------------------------------------------------------------
 * 4. organization_id NULL (esperado post-C: users=0, departments=0)
 * ------------------------------------------------------------------------- */
PRINT N'--- [4] organization_id NULL (esperado post-C: users=0, departments=0) ---';
IF COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
    PRINT N'users.organization_id: NO EXISTE (aun no aplicado)';
ELSE
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_null OUTPUT;
    PRINT N'users con organization_id NULL: ' + CAST(@u_null AS NVARCHAR(20)) + N' (esperado 0).';
END;

IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
    PRINT N'departments.organization_id: NO EXISTE (aun no aplicado)';
ELSE
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null OUTPUT;
    PRINT N'departments con organization_id NULL: ' + CAST(@d_null AS NVARCHAR(20)) + N' (esperado 0).';
END;

/* ---------------------------------------------------------------------------
 * 5. Asignaciones a CMUCE (esperado: departments=25, users=1)
 * ------------------------------------------------------------------------- */
PRINT N'--- [5] Asignaciones a CMUCE (departments=25, users=1) ---';
IF @cmuce_id IS NULL
    PRINT N'CMUCE no existe: no se pueden contar asignaciones.';
ELSE
BEGIN
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id = @oid;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @d_assigned OUTPUT;
    PRINT N'departments.organization_id = CMUCE: ' + CAST(@d_assigned AS NVARCHAR(20)) + N' (esperado 25).';

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id = @oid;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @cmuce_id, @n = @u_assigned OUTPUT;
    PRINT N'users.organization_id = CMUCE: ' + CAST(@u_assigned AS NVARCHAR(20)) + N' (esperado 1).';
END;

/* ---------------------------------------------------------------------------
 * 6. Usuario heredado id = 4 (organization_id = CMUCE, role_id = 7, dept = 68)
 * ------------------------------------------------------------------------- */
PRINT N'--- [6] Usuario heredado id = 4 (CMUCE / role_id=7 / department_id=68) ---';
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
    PRINT N'users: NO EXISTE (aun no aplicado)';
ELSE
BEGIN
    SELECT id, username, organization_id, role_id, department_id
    FROM dbo.users
    WHERE id = 4;

    SELECT @u4_org = organization_id, @u4_role = role_id, @u4_dept = department_id
    FROM dbo.users WHERE id = 4;

    PRINT N'id=4 organization_id=' + ISNULL(CAST(@u4_org AS NVARCHAR(20)), N'NULL')
        + N' role_id=' + ISNULL(CAST(@u4_role AS NVARCHAR(20)), N'NULL')
        + N' department_id=' + ISNULL(CAST(@u4_dept AS NVARCHAR(20)), N'NULL') + N'.';
END;

/* ---------------------------------------------------------------------------
 * 7. Huerfanos de integridad (esperado 0)
 * ------------------------------------------------------------------------- */
PRINT N'--- [7] Huerfanos de integridad (esperado 0) ---';
IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL
    PRINT N'organizations: NO EXISTE (aun no aplicado)';
ELSE
BEGIN
    SET @orfanos = 0;
    DECLARE @n BIGINT = 0;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
                 LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
                 WHERE d.organization_id IS NULL OR o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    PRINT N'departments sin organizacion valida: ' + CAST(@n AS NVARCHAR(20)) + N' (esperado 0).';
    SET @orfanos = @orfanos + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
                 WHERE u.organization_id IS NULL OR o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    PRINT N'users sin organizacion valida: ' + CAST(@n AS NVARCHAR(20)) + N' (esperado 0).';
    SET @orfanos = @orfanos + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.roles AS r ON r.id = u.role_id
                 WHERE r.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    PRINT N'users sin rol valido: ' + CAST(@n AS NVARCHAR(20)) + N' (esperado 0).';
    SET @orfanos = @orfanos + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.departments AS d ON d.id = u.department_id AND d.organization_id = u.organization_id
                 WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    PRINT N'users con departamento same-org inexistente: ' + CAST(@n AS NVARCHAR(20)) + N' (esperado 0).';
    SET @orfanos = @orfanos + @n;

    PRINT N'TOTAL huerfanos: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0).';
END;

/* ---------------------------------------------------------------------------
 * 8. Nullability de departments.organization_id (informativo: D la vuelve NOT NULL)
 * ------------------------------------------------------------------------- */
PRINT N'--- [8] departments.organization_id nullability (informativo; NOT NULL llega en D) ---';
SELECT c.name AS columna,
       CASE WHEN c.is_nullable = 1 THEN N'NULLABLE' ELSE N'NOT NULL' END AS estado,
       CASE WHEN c.is_nullable = 1 THEN N'ESPERADO post-C (NOT NULL llega en D)' ELSE N'YA NOT NULL' END AS nota
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id';

SELECT @d_notnull = COUNT(*)
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id' AND c.is_nullable = 0;

/* ---------------------------------------------------------------------------
 * 9. Constraints UNIQUE (UQ_*) esperados
 * ------------------------------------------------------------------------- */
PRINT N'--- [9] Constraints UQ_* esperados ---';
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
 * 10. Claves foraneas esperadas (habilitadas y confiables) + legacy preservada
 * ------------------------------------------------------------------------- */
PRINT N'--- [10] FKs esperadas (habilitadas y confiables) ---';
SELECT v.fk AS fk_esperado,
       CASE WHEN fk.object_id IS NULL THEN N'FALTA'
            WHEN fk.is_disabled = 1 THEN N'DESHABILITADA'
            WHEN fk.is_not_trusted = 1 THEN N'NO CONFIABLE'
            ELSE N'PRESENTE' END AS estado
FROM (VALUES
    (N'FK_role_permissions_role'), (N'FK_role_permissions_permission'),
    (N'FK_departments_organization'), (N'FK_users_organization'),
    (N'FK_users_role'), (N'FK_users_department_same_org'), (N'FK_users_department'),
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
    (N'FK_users_role'), (N'FK_users_department_same_org'), (N'FK_users_department'),
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
 * 11. Indices IX_* esperados
 * ------------------------------------------------------------------------- */
PRINT N'--- [11] Indices IX_* esperados ---';
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
 * 12. Resumen automatico GO / NO-GO (solo lectura)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN VERIFICADOR POST-GRUPO C ===';
PRINT N'  Tablas presentes: ' + CAST(24 - @faltantes_tablas AS NVARCHAR(10)) + N'/24';
PRINT N'  Registros totales (24 tablas): ' + CAST(@total_rows AS NVARCHAR(20)) + N' (esperado 97)';
PRINT N'  Desviaciones de conteo por tabla: ' + CAST(@desvios_conteo AS NVARCHAR(10));
PRINT N'  CMUCE filas por code: ' + CAST(@cmuce_count AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments.organization_id = CMUCE: ' + CAST(@d_assigned AS NVARCHAR(20)) + N' (esperado 25)';
PRINT N'  users.organization_id = CMUCE: ' + CAST(@u_assigned AS NVARCHAR(20)) + N' (esperado 1)';
IF @u_null >= 0
    PRINT N'  users.organization_id NULL: ' + CAST(@u_null AS NVARCHAR(20)) + N' (esperado 0)';
IF @d_null >= 0
    PRINT N'  departments.organization_id NULL: ' + CAST(@d_null AS NVARCHAR(20)) + N' (esperado 0)';
IF @orfanos >= 0
    PRINT N'  Huerfanos totales: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  CONSTRAINT UQ_* faltantes: ' + CAST(@faltantes_uq AS NVARCHAR(10));
PRINT N'  FK faltantes/deshabilitadas/no confiables: ' + CAST(@faltantes_fk AS NVARCHAR(10));
PRINT N'  Indices IX_* faltantes: ' + CAST(@faltantes_ix AS NVARCHAR(10));
IF @d_notnull >= 0
    PRINT N'  departments.organization_id NOT NULL: ' + CASE WHEN @d_notnull = 1 THEN N'SI (D ya aplicado)' ELSE N'NO (esperado post-C; D pendiente)' END;

IF (24 - @faltantes_tablas) = 24
   AND @desvios_conteo = 0
   AND @total_rows = 97
   AND @cmuce_count = 1
   AND @d_assigned = 25
   AND @u_assigned = 1
   AND @u_null = 0
   AND @d_null = 0
   AND @orfanos = 0
   AND @u4_org IS NOT NULL AND @cmuce_id IS NOT NULL AND @u4_org = @cmuce_id
   AND @u4_role = 7
   AND @u4_dept = 68
   AND @faltantes_uq = 0
   AND @faltantes_fk = 0
   AND @faltantes_ix = 0
    PRINT N'VERIFICADOR POST-C: GO - backfill CMUCE consistente y listo para el grupo D.';
ELSE
    PRINT N'VERIFICADOR POST-C: NO-GO - revisar el detalle de las secciones [1]-[11].';
PRINT N'';
