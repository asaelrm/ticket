/* ============================================================================
 * SIFHA - Permisos MINIMOS de la cuenta de aplicacion sobre SIFHA_Tickets_DEV
 *         EXCLUSIVO de TI-DESK-01\SIFHADEV / SIFHA_Tickets_DEV
 * ----------------------------------------------------------------------------
 * Que es
 *   Un script idempotente y revisable que corrige los permisos de la cuenta de
 *   aplicacion sobre SIFHA_Tickets_DEV siguiendo el principio de MINIMO
 *   privilegio. NO ejecutado por el agente; queda listo para revision y
 *   ejecucion controlada por una cuenta autorizada.
 *
 * Que NO hace
 *   - No concede db_owner, db_ddladmin ni sysadmin.
 *   - No crea logins (la creacion de un login con contrasena es competencia del
 *     administrador). Solo una cuenta privilegiada ejecuta este script.
 *
 * Uso (manual, cuenta autorizada: db_owner o db_securityadmin)
 *   sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -C -b -i grant-app-account-minimal.sql
 *   o abrir en SSMS conectado a SIFHA_Tickets_DEV y ejecutar.
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

IF @current_database <> @expected_database
BEGIN
    RAISERROR(N'ABORTADO: se esperaba la base %s y se esta en %s.', 16, 1, @expected_database, @current_database);
    RETURN;
END;

IF @current_instance <> @expected_instance
BEGIN
    RAISERROR(N'ABORTADO: se esperaba la instancia %s y se esta en %s.', 16, 1, @expected_instance, @current_instance);
    RETURN;
END;

IF NOT (@current_server = @expected_server OR @current_legacy_server = @expected_server)
BEGIN
    RAISERROR(N'ABORTADO: se esperaba el servidor %s y se esta en %s / %s.', 16, 1, @expected_server, @current_server, @current_legacy_server);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 1. Parametros.
 *    @app_login     : usuario de base de la aplicacion.
 *    @group_e_login : usuario de solo lectura del Grupo E (NULL = no aprovisionar).
 * ------------------------------------------------------------------------- */
DECLARE @app_login SYSNAME = N'sifha_ticket_dev';
DECLARE @group_e_login SYSNAME = NULL;

PRINT N'============================================================';
PRINT N' PERMISOS MINIMOS SIFHA_Tickets_DEV (alteracion de roles)';
PRINT N'============================================================';

/* ---------------------------------------------------------------------------
 * 2. Existencia del usuario de aplicacion.
 * ------------------------------------------------------------------------- */
IF USER_ID(@app_login) IS NULL
BEGIN
    RAISERROR(N'NO-GO: el usuario de base %s no existe en %s. Crear el login/usuario antes de conceder roles.', 16, 1, @app_login, @expected_database);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 3. Minimo privilegio de aplicacion (idempotente).
 *    db_datareader = SELECT en todas las tablas.
 *    db_datawriter = INSERT/UPDATE/DELETE en todas las tablas.
 *    NO db_owner / NO db_ddladmin.
 *    Nota: ADD MEMBER no admite variables; se usa SQL dinamico con QUOTENAME
 *    sobre un nombre de usuario controlado localmente.
 * ------------------------------------------------------------------------- */
DECLARE @sql NVARCHAR(MAX);

IF IS_ROLEMEMBER(N'db_datareader', @app_login) = 1
    PRINT N'OK: ' + @app_login + N' ya es miembro de db_datareader.';
ELSE
BEGIN
    SET @sql = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@app_login) + N';';
    EXEC sys.sp_executesql @sql;
    PRINT N'GRANT: ' + @app_login + N' agregado a db_datareader.';
END;

IF IS_ROLEMEMBER(N'db_datawriter', @app_login) = 1
    PRINT N'OK: ' + @app_login + N' ya es miembro de db_datawriter.';
ELSE
BEGIN
    SET @sql = N'ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@app_login) + N';';
    EXEC sys.sp_executesql @sql;
    PRINT N'GRANT: ' + @app_login + N' agregado a db_datawriter.';
END;

/* ---------------------------------------------------------------------------
 * 4. Cuenta de SOLO LECTURA del Grupo E (opcional): solo db_datareader.
 * ------------------------------------------------------------------------- */
IF @group_e_login IS NOT NULL
BEGIN
    IF USER_ID(@group_e_login) IS NULL
        PRINT N'AVISO: el usuario de solo lectura ' + @group_e_login + N' no existe; no se aprovisiona.';
    ELSE IF IS_ROLEMEMBER(N'db_datareader', @group_e_login) = 1
        PRINT N'OK: ' + @group_e_login + N' ya es miembro de db_datareader.';
    ELSE
    BEGIN
        SET @sql = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@group_e_login) + N';';
        EXEC sys.sp_executesql @sql;
        PRINT N'GRANT: ' + @group_e_login + N' agregado a db_datareader (solo lectura).';
    END;
END;
ELSE
    PRINT N'INFO: @group_e_login = NULL; no se aprovisiona cuenta de solo lectura del Grupo E.';

/* ---------------------------------------------------------------------------
 * 5. Resumen de permisos efectivos tras la operacion (solo lectura).
 * ------------------------------------------------------------------------- */
SELECT
    DB_NAME()                                              AS base_actual,
    SUSER_SNAME()                                          AS login_conectado,
    USER_NAME()                                            AS usuario_operador,
    @app_login                                             AS usuario_aplicacion,
    ISNULL(IS_ROLEMEMBER(N'db_datareader', @app_login), 0) AS app_es_dbreader,
    ISNULL(IS_ROLEMEMBER(N'db_datawriter', @app_login), 0) AS app_es_dbwriter,
    ISNULL(IS_ROLEMEMBER(N'db_owner',      @app_login), 0) AS app_es_dbowner,
    ISNULL(IS_ROLEMEMBER(N'db_ddladmin',   @app_login), 0) AS app_es_ddladmin;

PRINT N'------------------------------------------------------------';
PRINT N' FIN. Verificar que app_es_dbowner = 0 y app_es_ddladmin = 0.';
PRINT N'------------------------------------------------------------';
