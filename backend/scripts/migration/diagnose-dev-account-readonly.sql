/* ============================================================================
 * SIFHA - Diagnostico SOLO LECTURA de la cuenta frente a SIFHA_Tickets_DEV
 *         EXCLUSIVO de TI-DESK-01\SIFHADEV / SIFHA_Tickets_DEV
 * ----------------------------------------------------------------------------
 * Que es
 *   Un preflight de SOLO LECTURA que responde a la pregunta operativa: "la
 *   cuenta con la que me conecto, puede ejecutar la secuencia de reconciliacion
 *   B -> C -> D -> E sobre SIFHA_Tickets_DEV sin necesitar otro login?".
 *
 *   Explica, ademas, el artefacto de visibilidad de metadatos documentado: una
 *   cuenta con GRANT solo a nivel de objeto ve menos tablas en sys.tables que
 *   las 24 reales (p. ej. 6), y eso NO significa que la base este incompleta.
 *
 * Que NO hace
 *   - Solo SELECT sobre el catalogo del sistema (sys.*), funciones de permiso
 *     y lecturas de conteo.
 *   - No contiene CREATE/ALTER/DROP/TRUNCATE/INSERT/UPDATE/DELETE/MERGE ni
 *     EXEC/sp_executesql. No modifica datos ni metadatos.
 *   - Aborta si el destino no es TI-DESK-01\SIFHADEV / SIFHA_Tickets_DEV.
 *
 * Uso (manual, solo lectura)
 *   sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -C -i diagnose-dev-account-readonly.sql
 *   o abrir en SSMS conectado a SIFHA_Tickets_DEV y ejecutar.
 *
 * Salida
 *   - Identidad efectiva de la conexion.
 *   - Permisos relevantes (db_owner, db_ddladmin, ALTER en SCHEMA::dbo,
 *     VIEW DEFINITION) y veredicto "PUEDE_EJECUTAR_SECUENCIA".
 *   - Tablas visibles vs 24 esperadas (detecta el artefacto de visibilidad).
 *   - Estado actual de departments.organization_id (nulabilidad) cuando es
 *     visible: si ya es NOT NULL, la fase D ya esta aplicada en DEV.
 * ========================================================================== */

SET NOCOUNT ON;

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

IF UPPER(ISNULL(@current_database, N'')) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: la base actual "%s" no es la autorizada "%s". No se lee nada.', 16, 1, @current_database, @expected_database);
    RETURN;
END;
IF UPPER(ISNULL(@current_instance, N'')) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: la instancia "%s" no es la autorizada "%s". No se lee nada.', 16, 1, @current_instance, @expected_instance);
    RETURN;
END;
IF NOT (
    UPPER(ISNULL(@current_server, N'')) = UPPER(@expected_server)
    OR UPPER(ISNULL(@current_legacy_server, N'')) = UPPER(@expected_server)
)
BEGIN
    RAISERROR(N'ABORTADO: el servidor "%s"/"%s" no es el autorizado "%s". No se lee nada.', 16, 1, @current_server, @current_legacy_server, @expected_server);
    RETURN;
END;

PRINT N'============================================================';
PRINT N' PREFLIGHT SOLO-LECTURA SIFHA_Tickets_DEV (nada se modifica)';
PRINT N'============================================================';

/* ---------------------------------------------------------------------------
 * 1. Identidad efectiva de la conexion.
 * ------------------------------------------------------------------------- */
SELECT
    DB_NAME()                                               AS base_actual,
    SUSER_SNAME()                                           AS login_efectivo,
    USER_NAME()                                             AS usuario_base,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))    AS servidor_efectivo,
    CONVERT(NVARCHAR(128), @@SERVERNAME)                    AS servidor_registrado,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))  AS instancia_efectiva,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('MachineName'))   AS maquina;

/* ---------------------------------------------------------------------------
 * 2. Permisos de la cuenta y veredicto operativo.
 *    La secuencia B->C->D->E necesita DDL (ALTER TABLE / constraints) sobre la
 *    base: se considera suficiente pertenecer a db_owner/db_ddladmin o tener
 *    ALTER sobre SCHEMA::dbo.
 * ------------------------------------------------------------------------- */
DECLARE @is_db_owner BIT   = ISNULL(IS_ROLEMEMBER('db_owner'), 0);
DECLARE @is_db_ddladmin BIT = ISNULL(IS_ROLEMEMBER('db_ddladmin'), 0);
DECLARE @is_db_datareader BIT  = ISNULL(IS_ROLEMEMBER('db_datareader'), 0);
DECLARE @is_db_datawriter BIT  = ISNULL(IS_ROLEMEMBER('db_datawriter'), 0);
DECLARE @can_alter_schema INT = ISNULL(HAS_PERMS_BY_NAME(N'dbo', N'SCHEMA', N'ALTER'), 0);
DECLARE @can_view_definition INT = ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'VIEW DEFINITION'), 0);
DECLARE @can_ddl BIT = CASE
    WHEN @is_db_owner = 1 OR @is_db_ddladmin = 1 OR @can_alter_schema = 1 THEN 1
    ELSE 0
END;

SELECT
    @is_db_owner          AS es_db_owner,
    @is_db_ddladmin       AS es_db_ddladmin,
    @is_db_datareader     AS es_db_datareader,
    @is_db_datawriter     AS es_db_datawriter,
    @can_alter_schema     AS puede_alter_schema_dbo,
    @can_view_definition  AS puede_view_definition,
    CASE WHEN @can_ddl = 1 THEN N'GO' ELSE N'NO-GO' END AS puede_ejecutar_secuencia,
    CASE WHEN @can_ddl = 1
         THEN N'La cuenta puede ejecutar el DDL de B->C->D->E en esta base.'
         ELSE N'La cuenta NO puede ejecutar el DDL: usar una cuenta con db_owner/db_ddladmin o ALTER en SCHEMA::dbo.' END AS nota;

/* ---------------------------------------------------------------------------
 * 3. Visibilidad de metadatos: tablas dbo visibles vs 24 esperadas.
 *    Un numero menor NO implica base incompleta: puede ser el artefacto de
 *    GRANT a nivel de objeto. Contrastar con el inventario real.
 * ------------------------------------------------------------------------- */
DECLARE @visible_tables INT = (
    SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(N'dbo')
);

SELECT
    @visible_tables AS tablas_dbo_visibles,
    24              AS tablas_esperadas,
    CASE WHEN @visible_tables >= 24
         THEN N'VISIBILIDAD COMPLETA'
         ELSE N'VISIBILIDAD PARCIAL (posible artefacto de permisos a nivel de objeto)' END AS diagnostico_visibilidad;

/* ---------------------------------------------------------------------------
 * 4. Estado actual de la columna diana del grupo D (si es visible).
 *    allows_null: 1 = NULL-able (D pendiente), 0 = NOT NULL (D ya aplicada).
 *    NULL = objeto/columna no visible con esta cuenta.
 * ------------------------------------------------------------------------- */
SELECT
    COLUMNPROPERTY(OBJECT_ID(N'dbo.departments'), N'organization_id', N'AllowsNull') AS departments_org_allows_null,
    COL_LENGTH(N'dbo.departments', N'organization_id')                               AS departments_org_length_bytes,
    COLUMNPROPERTY(OBJECT_ID(N'dbo.notifications'), N'organization_id', N'AllowsNull') AS notifications_org_allows_null;

PRINT N'------------------------------------------------------------';
PRINT N' FIN PREFLIGHT SOLO-LECTURA (no se modifico ningun dato)';
PRINT N'------------------------------------------------------------';
