/* ============================================================================
 * SIFHA - Permisos OPERATIVOS de minimo privilegio para la cuenta de la app
 *         Destino EXCLUSIVO: TI-DESK-01\SIFHADEV / SIFHA_Tickets_DEV
 * ----------------------------------------------------------------------------
 * Que hace
 *   Concede a la cuenta de aplicacion SOLO los permisos por TABLA y OPERACION
 *   que el backend realmente ejecuta sobre SQL Server. NO usa db_datareader ni
 *   db_datawriter (se evita el alcance global), NO concede db_owner/db_ddladmin
 *   y NO crea logins ni usuarios.
 *
 *   Base del mapa: analisis estatico de las consultas reales del backend
 *   (carpetas routes, middleware, db/mssql y utils). El proceso de aplicacion
 *   (incluye el mismo usuario de BD que ejecuta los jobs in-process y el
 *   correo si estan habilitados) necesita esta union.
 *
 * Mapa aplicado (tabla -> operaciones):
 *   organizations      : SELECT, INSERT, UPDATE
 *   permissions        : SELECT                     (solo lo escribe el seed)
 *   roles              : SELECT                     (solo lo escribe el seed)
 *   role_permissions   : SELECT, INSERT, DELETE
 *   departments        : SELECT, INSERT, UPDATE
 *   categories         : SELECT, INSERT, UPDATE
 *   users              : SELECT, INSERT, UPDATE
 *   teams              : SELECT, INSERT, UPDATE, DELETE
 *   team_members       : SELECT, INSERT, DELETE
 *   tickets            : SELECT, INSERT, UPDATE, DELETE
 *   canned_responses   : SELECT, INSERT, UPDATE
 *   ticket_comments    : SELECT, INSERT, DELETE
 *   ticket_attachments : SELECT, INSERT, DELETE
 *   ticket_history     : SELECT, INSERT
 *   sessions           : SELECT, INSERT, UPDATE, DELETE
 *   sequences          : SELECT, INSERT, UPDATE   (upsert/MERGE)
 *   settings           : SELECT, INSERT, UPDATE   (upsert/MERGE)
 *   org_settings       : SELECT, INSERT, UPDATE   (upsert/MERGE)
 *   email_logs         : SELECT, INSERT            (correo, si MAIL_ENABLED)
 *   notifications      : SELECT, INSERT, UPDATE, DELETE
 *   kb_categories      : SELECT, INSERT, UPDATE
 *   kb_articles        : SELECT, INSERT, UPDATE
 *   kb_ticket_articles : SELECT, INSERT, DELETE
 *   kb_article_history : SELECT, INSERT
 *
 * Seguridad de ejecucion
 *   @apply = 0 (por defecto): DRY-RUN. Solo imprime las sentencias GRANT.
 *   @apply = 1             : ejecuta los GRANT (idempotentes: re-ejecutables).
 *
 * Uso (SSMS o sqlcmd, con una cuenta privilegiada: db_owner o miembro de
 *      db_securityadmin con CONTROL en la base). NO usar sa.
 *   sqlcmd -S 100.100.4.60,1433 -d SIFHA_Tickets_DEV -C -b -i grant-app-account-minimal.sql
 *   (para aplicar, editar @apply = 1 o usar :setvar)
 *
 * Reversion: para cada tabla, REVOKE <operaciones> ON dbo.<tabla> FROM <cuenta>;
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
 * ------------------------------------------------------------------------- */
DECLARE @app_login SYSNAME = N'sifha_ticket_dev';   -- usuario de base de la app
DECLARE @apply BIT = 0;                              -- 0 = DRY-RUN, 1 = aplica

PRINT N'============================================================';
PRINT N' PERMISOS OPERATIVOS DE MINIMO PRIVILEGIO - SIFHA_Tickets_DEV';
PRINT N' Cuenta: ' + @app_login + N'   Modo: ' + CASE WHEN @apply = 1 THEN N'APLICAR' ELSE N'DRY-RUN (sin cambios)' END;
PRINT N'============================================================';

/* ---------------------------------------------------------------------------
 * 2. Consulta previa: existencia del usuario y estado actual.
 * ------------------------------------------------------------------------- */
IF USER_ID(@app_login) IS NULL
BEGIN
    RAISERROR(N'NO-GO: el usuario de base %s no existe en %s. Crear login/usuario antes.', 16, 1, @app_login, @expected_database);
    RETURN;
END;

PRINT N'--- Estado PREVIO: permisos explicitos actuales de ' + @app_login + N' ---';
SELECT
    o.name              AS tabla,
    p.permission_name   AS permiso,
    p.state_desc        AS estado
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE p.grantee_principal_id = USER_ID(@app_login)
  AND p.class = 1
ORDER BY o.name, p.permission_name;

/* ---------------------------------------------------------------------------
 * 3. Consulta previa: pertenencia a roles (para detectar privilegios amplios).
 * ------------------------------------------------------------------------- */
PRINT N'--- Estado PREVIO: roles de base de ' + @app_login + N' ---';
SELECT
    r.name AS rol,
    ISNULL(IS_ROLEMEMBER(r.name, @app_login), 0) AS es_miembro
FROM sys.database_principals r
WHERE r.type = 'R'
  AND r.name IN (N'db_owner', N'db_ddladmin', N'db_datawriter', N'db_datareader',
                 N'db_securityadmin', N'db_accessadmin', N'db_backupoperator');

/* ---------------------------------------------------------------------------
 * 4. Mapa de GRANTs (tabla -> operaciones). Unica fuente de verdad.
 *    Editar aqui para ajustar el minimo privilegio.
 * ------------------------------------------------------------------------- */
DECLARE @grants TABLE (tbl SYSNAME NOT NULL PRIMARY KEY, perms NVARCHAR(100) NOT NULL);
INSERT INTO @grants (tbl, perms) VALUES
    (N'organizations',      N'SELECT, INSERT, UPDATE'),
    (N'permissions',        N'SELECT'),
    (N'roles',              N'SELECT'),
    (N'role_permissions',   N'SELECT, INSERT, DELETE'),
    (N'departments',        N'SELECT, INSERT, UPDATE'),
    (N'categories',         N'SELECT, INSERT, UPDATE'),
    (N'users',              N'SELECT, INSERT, UPDATE'),
    (N'teams',              N'SELECT, INSERT, UPDATE, DELETE'),
    (N'team_members',       N'SELECT, INSERT, DELETE'),
    (N'tickets',            N'SELECT, INSERT, UPDATE, DELETE'),
    (N'canned_responses',   N'SELECT, INSERT, UPDATE'),
    (N'ticket_comments',    N'SELECT, INSERT, DELETE'),
    (N'ticket_attachments', N'SELECT, INSERT, DELETE'),
    (N'ticket_history',     N'SELECT, INSERT'),
    (N'sessions',           N'SELECT, INSERT, UPDATE, DELETE'),
    (N'sequences',          N'SELECT, INSERT, UPDATE'),
    (N'settings',           N'SELECT, INSERT, UPDATE'),
    (N'org_settings',       N'SELECT, INSERT, UPDATE'),
    (N'email_logs',         N'SELECT, INSERT'),
    (N'notifications',      N'SELECT, INSERT, UPDATE, DELETE'),
    (N'kb_categories',      N'SELECT, INSERT, UPDATE'),
    (N'kb_articles',        N'SELECT, INSERT, UPDATE'),
    (N'kb_ticket_articles', N'SELECT, INSERT, DELETE'),
    (N'kb_article_history', N'SELECT, INSERT');

/* ---------------------------------------------------------------------------
 * 5. Verificacion previa: todas las tablas del mapa deben existir en dbo.
 * ------------------------------------------------------------------------- */
DECLARE @missing NVARCHAR(MAX) = N'';
SELECT @missing = @missing + CASE WHEN @missing = N'' THEN N'' ELSE N', ' END + g.tbl
FROM @grants g
WHERE OBJECT_ID(N'dbo.' + g.tbl, N'U') IS NULL;

IF @missing <> N''
BEGIN
    RAISERROR(N'ABORTADO: faltan tablas esperadas en dbo: %s. Revisar el esquema antes de conceder permisos.', 16, 1, @missing);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 6. Aplicacion de GRANTs (idempotentes). DRY-RUN por defecto.
 *    Nota: GRANT es idempotente; re-ejecutar no acumula permisos.
 * ------------------------------------------------------------------------- */
DECLARE @tbl SYSNAME, @perms NVARCHAR(100), @sql NVARCHAR(MAX);
DECLARE grant_cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT tbl, perms FROM @grants ORDER BY tbl;

OPEN grant_cur;
FETCH NEXT FROM grant_cur INTO @tbl, @perms;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'GRANT ' + @perms + N' ON dbo.' + QUOTENAME(@tbl) + N' TO ' + QUOTENAME(@app_login) + N';';
    IF @apply = 1
    BEGIN
        EXEC sys.sp_executesql @sql;
        PRINT N'APLICADO: ' + @sql;
    END
    ELSE
        PRINT N'[DRY-RUN] ' + @sql;

    FETCH NEXT FROM grant_cur INTO @tbl, @perms;
END;
CLOSE grant_cur;
DEALLOCATE grant_cur;

/* ---------------------------------------------------------------------------
 * 7. Comprobacion posterior: permisos explicitos resultantes y veredicto.
 * ------------------------------------------------------------------------- */
PRINT N'--- Estado POSTERIOR: permisos explicitos de ' + @app_login + N' ---';
SELECT
    o.name            AS tabla,
    p.permission_name AS permiso,
    p.state_desc      AS estado
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE p.grantee_principal_id = USER_ID(@app_login)
  AND p.class = 1
ORDER BY o.name, p.permission_name;

SELECT
    DB_NAME()                                              AS base_actual,
    SUSER_SNAME()                                          AS login_operador,
    USER_NAME()                                            AS usuario_operador,
    @app_login                                             AS cuenta_app,
    ISNULL(IS_ROLEMEMBER(N'db_owner',    @app_login), 0)   AS app_es_dbowner,
    ISNULL(IS_ROLEMEMBER(N'db_ddladmin', @app_login), 0)   AS app_es_ddladmin,
    ISNULL(IS_ROLEMEMBER(N'db_datawriter', @app_login), 0) AS app_es_datawriter,
    ISNULL(IS_ROLEMEMBER(N'db_datareader', @app_login), 0) AS app_es_datareader;

PRINT N'------------------------------------------------------------';
PRINT N' FIN. Comprobar: app_es_dbowner=0, app_es_ddladmin=0,';
PRINT N'      app_es_datawriter=0 y app_es_datareader=0 (sin roles globales).';
PRINT N'------------------------------------------------------------';
