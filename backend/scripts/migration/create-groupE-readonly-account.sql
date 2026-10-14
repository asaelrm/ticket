/* ============================================================================
 * SIFHA - Cuenta de VALIDACION de SOLO LECTURA para el Grupo E
 *         Destino EXCLUSIVO: TI-DESK-01\SIFHADEV / SIFHA_Tickets_DEV
 * ----------------------------------------------------------------------------
 * Objetivo
 *   Proveer una cuenta con permisos EXCLUSIVAMENTE de SELECT sobre las tablas
 *   de la base, para ejecutar el "arranque en seco" del Grupo E y las pruebas
 *   de lectura sin riesgo de escritura.
 *
 *   NO concede INSERT/UPDATE/DELETE, ni db_datareader, ni db_datawriter, ni
 *   db_owner/db_ddladmin, ni DDL. Solo SELECT por tabla (y, opcionalmente,
 *   VIEW DEFINITION para verificadores de catalogo).
 *
 * Requisito previo (lo hace el administrador, fuera de este script)
 *   Debe existir un LOGIN en el servidor. Este script crea, si procede, el
 *   USUARIO de base a partir de ese login y le concede los SELECT.
 *   Plantilla de creacion de login (contrasena gestionada por el admin):
 *     CREATE LOGIN [sifha_group_e] WITH PASSWORD = N'<gestionada por admin>',
 *       CHECK_POLICY = ON, CHECK_EXPIRATION = ON, DEFAULT_DATABASE = [SIFHA_Tickets_DEV];
 *
 * Seguridad de ejecucion
 *   @apply = 0 (por defecto): DRY-RUN. Solo imprime las sentencias.
 *   @apply = 1             : ejecuta (idempotente y re-ejecutable).
 *
 * Uso (SSMS o sqlcmd, con cuenta privilegiada: db_owner/db_securityadmin):
 *   sqlcmd -S 100.100.4.60,1433 -d SIFHA_Tickets_DEV -C -b -i create-groupE-readonly-account.sql
 * ========================================================================== */

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ---------------------------------------------------------------------------
 * 0. Guarda de identidad: solo SIFHA_Tickets_DEV en TI-DESK-01\SIFHADEV.
 * ------------------------------------------------------------------------- */
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_DEV';
DECLARE @expected_server NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
DECLARE @current_legacy_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), @@SERVERNAME)));
DECLARE @current_instance NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));

IF UPPER(@current_database) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: se esperaba la base %s y se esta en %s.', 16, 1, @expected_database, @current_database);
    RETURN;
END;

IF UPPER(@current_instance) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: se esperaba la instancia %s y se esta en %s.', 16, 1, @expected_instance, @current_instance);
    RETURN;
END;

IF NOT (UPPER(@current_server) = UPPER(@expected_server) OR UPPER(@current_legacy_server) = UPPER(@expected_server))
BEGIN
    RAISERROR(N'ABORTADO: se esperaba el servidor %s y se esta en %s / %s.', 16, 1, @expected_server, @current_server, @current_legacy_server);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 1. Parametros.
 *    @group_e_login         : nombre del login/usuario de solo lectura.
 *    @create_user_if_missing: 1 = crea el usuario de base si el login existe.
 *    @grant_view_definition : 1 = concede VIEW DEFINITION (catalogo/verificadores).
 *    @apply                 : 0 = DRY-RUN, 1 = aplica.
 * ------------------------------------------------------------------------- */
DECLARE @group_e_login SYSNAME = N'sifha_group_e';
DECLARE @create_user_if_missing BIT = 0;
DECLARE @grant_view_definition BIT = 0;
DECLARE @apply BIT = 0;

PRINT N'============================================================';
PRINT N' CUENTA DE SOLO LECTURA (GRUPO E) - SIFHA_Tickets_DEV';
PRINT N' Login: ' + @group_e_login + N'   Modo: ' + CASE WHEN @apply = 1 THEN N'APLICAR' ELSE N'DRY-RUN (sin cambios)' END;
PRINT N'============================================================';

/* ---------------------------------------------------------------------------
 * 2. Alta opcional del usuario de base (a partir de un login existente).
 * ------------------------------------------------------------------------- */
IF USER_ID(@group_e_login) IS NULL
BEGIN
    IF SUSER_ID(@group_e_login) IS NULL
    BEGIN
        RAISERROR(N'NO-GO: el login %s no existe en el servidor. El administrador debe crearlo antes de ejecutar este script.', 16, 1, @group_e_login);
        RETURN;
    END;

    IF @create_user_if_missing = 1 AND @apply = 1
    BEGIN
        DECLARE @sql_create NVARCHAR(MAX) =
            N'CREATE USER ' + QUOTENAME(@group_e_login) + N' FOR LOGIN ' + QUOTENAME(@group_e_login) + N';';
        EXEC sys.sp_executesql @sql_create;
        PRINT N'APLICADO: usuario de base creado para el login ' + @group_e_login;
    END
    ELSE
        PRINT N'[PENDIENTE] el usuario de base no existe; ejecutar con @create_user_if_missing = 1.';
END
ELSE
    PRINT N'OK: el usuario de base ' + @group_e_login + N' ya existe.';

/* ---------------------------------------------------------------------------
 * 3. Verificacion previa: las 24 tablas esperadas deben existir en dbo.
 * ------------------------------------------------------------------------- */
DECLARE @expected_tables INT = 24;
DECLARE @present_tables INT = (
    SELECT COUNT(*) FROM sys.tables
    WHERE schema_id = SCHEMA_ID(N'dbo')
      AND name IN (
            N'organizations', N'permissions', N'roles', N'role_permissions',
            N'departments', N'categories', N'users', N'teams', N'team_members',
            N'tickets', N'canned_responses', N'ticket_comments',
            N'ticket_attachments', N'ticket_history', N'sessions', N'sequences',
            N'settings', N'org_settings', N'email_logs', N'notifications',
            N'kb_categories', N'kb_articles', N'kb_ticket_articles',
            N'kb_article_history'
      )
);

PRINT N'--- Estado PREVIO: permisos explicitos actuales de ' + @group_e_login + N' ---';
IF USER_ID(@group_e_login) IS NOT NULL
    SELECT
        o.name            AS tabla,
        p.permission_name AS permiso,
        p.state_desc      AS estado
    FROM sys.database_permissions p
    JOIN sys.objects o ON o.object_id = p.major_id
    WHERE p.grantee_principal_id = USER_ID(@group_e_login)
      AND p.class = 1
    ORDER BY o.name, p.permission_name;
ELSE
    PRINT N'(el usuario no existe todavia: no hay permisos previos)';

IF @present_tables < @expected_tables
BEGIN
    RAISERROR(N'ABORTADO: solo %d de %d tablas esperadas presentes en dbo. Revisar esquema.', 16, 1, @present_tables, @expected_tables);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 4. Concesion EXCLUSIVA de SELECT por tabla (idempotente). DRY-RUN por defecto.
 * ------------------------------------------------------------------------- */
DECLARE @tbl SYSNAME, @sql NVARCHAR(MAX);
DECLARE select_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT name
    FROM sys.tables
    WHERE schema_id = SCHEMA_ID(N'dbo')
      AND name IN (
            N'organizations', N'permissions', N'roles', N'role_permissions',
            N'departments', N'categories', N'users', N'teams', N'team_members',
            N'tickets', N'canned_responses', N'ticket_comments',
            N'ticket_attachments', N'ticket_history', N'sessions', N'sequences',
            N'settings', N'org_settings', N'email_logs', N'notifications',
            N'kb_categories', N'kb_articles', N'kb_ticket_articles',
            N'kb_article_history'
      )
    ORDER BY name;

OPEN select_cur;
FETCH NEXT FROM select_cur INTO @tbl;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'GRANT SELECT ON dbo.' + QUOTENAME(@tbl) + N' TO ' + QUOTENAME(@group_e_login) + N';';
    IF @apply = 1
    BEGIN
        EXEC sys.sp_executesql @sql;
        PRINT N'APLICADO: ' + @sql;
    END
    ELSE
        PRINT N'[DRY-RUN] ' + @sql;

    FETCH NEXT FROM select_cur INTO @tbl;
END;
CLOSE select_cur;
DEALLOCATE select_cur;

/* ---------------------------------------------------------------------------
 * 5. VIEW DEFINITION opcional (para verificadores que leen catalogo).
 * ------------------------------------------------------------------------- */
IF @grant_view_definition = 1
BEGIN
    SET @sql = N'GRANT VIEW DEFINITION TO ' + QUOTENAME(@group_e_login) + N';';
    IF @apply = 1
    BEGIN
        EXEC sys.sp_executesql @sql;
        PRINT N'APLICADO: ' + @sql;
    END
    ELSE
        PRINT N'[DRY-RUN] ' + @sql;
END
ELSE
    PRINT N'INFO: VIEW DEFINITION no solicitado (no se concede).';

/* ---------------------------------------------------------------------------
 * 6. Comprobacion posterior.
 * ------------------------------------------------------------------------- */
PRINT N'--- Estado POSTERIOR: permisos explicitos de ' + @group_e_login + N' ---';
SELECT
    o.name            AS tabla,
    p.permission_name AS permiso,
    p.state_desc      AS estado
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE p.grantee_principal_id = USER_ID(@group_e_login)
  AND p.class = 1
ORDER BY o.name, p.permission_name;

SELECT
    DB_NAME()                                              AS base_actual,
    SUSER_SNAME()                                          AS login_operador,
    USER_NAME()                                            AS usuario_operador,
    @group_e_login                                         AS cuenta_grupo_e,
    ISNULL(IS_ROLEMEMBER(N'db_owner',      @group_e_login), 0) AS es_dbowner,
    ISNULL(IS_ROLEMEMBER(N'db_ddladmin',   @group_e_login), 0) AS es_ddladmin,
    ISNULL(IS_ROLEMEMBER(N'db_datawriter', @group_e_login), 0) AS es_datawriter,
    ISNULL(IS_ROLEMEMBER(N'db_datareader', @group_e_login), 0) AS es_datareader;

PRINT N'------------------------------------------------------------';
PRINT N' FIN. Comprobar: todos los permisos son SELECT y los cuatro';
PRINT N'      indicadores de rol global son 0.';
PRINT N'------------------------------------------------------------';
