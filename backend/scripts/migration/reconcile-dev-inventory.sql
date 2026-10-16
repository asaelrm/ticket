/* ============================================================================
 * SIFHA - Inventario de esquema (SOLO LECTURA) para SIFHA_Tickets_DEV
 *         EXCLUSIVO de la instancia SIFHADEV / base SIFHA_Tickets_DEV
 * ============================================================================
 *
 * Que es
 *   Un script de diagnostico que SOLO ejecuta SELECT sobre catalogo del sistema
 *   (sys.*) y consultas de conteo. NO escribe en la base: no hay INSERT/UPDATE/
 *   DELETE/MERGE sobre tablas de usuario, ni ALTER/CREATE/DROP, ni migraciones,
 *   seeds o restauraciones. Los unicos INSERT del script son sobre VARIABLES DE
 *   TABLA en memoria (@expected_tables, @expected_columns,
 *   @expected_precision_scale, @expected_indexes, @row_counts), que se
 *   descartan al terminar el lote y NO tocan la base.
 *
 * Para que sirve
 *   Producir el diff REAL entre el esquema instalado en SIFHA_Tickets_DEV y el
 *   esquema que el runtime exige (backend/src/db/mssql/schema.sql). Rellena el
 *   grupo "candidatas" del plan docs/PLAN-RECONCILIACION-DEV.md: tipos,
 *   nulabilidad, identity, restricciones, indices y claves foraneas de las 6
 *   tablas existentes, mas la lista de tablas/columnas faltantes.
 *
 *   Este paso va PRIMERO. El borrador DDL reconcile-dev-draft.sql NO debe
 *   ejecutarse hasta revisar la salida de este inventario y cerrar las
 *   decisiones humanas del plan.
 *
 * Seguridad
 *   - Guarda de identidad de servidor/instancia/base al inicio; si no coincide,
 *     ABORTA sin leer nada.
 *   - No imprime credenciales ni cadenas de conexion.
 *   - Idempotente y repetible: es solo lectura de la base.
 *   - Los INSERT son exclusivamente sobre variables de tabla (en memoria); no
 *     existe DML ni DDL persistente en ningun punto del script.
 *
 * Uso (manual)
 *   sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -i reconcile-dev-inventory.sql
 *   o abrir en SSMS conectado a SIFHA_Tickets_DEV y ejecutar.
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
PRINT N' INVENTARIO SOLO-LECTURA SIFHA_Tickets_DEV (nada se modifica)';
PRINT N'============================================================';

/* ---------------------------------------------------------------------------
 * 1. Identidad efectiva de la conexion.
 * ------------------------------------------------------------------------- */
SELECT
    DB_NAME()                                              AS base_actual,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))   AS servidor_efectivo,
    CONVERT(NVARCHAR(128), @@SERVERNAME)                   AS servidor_registrado,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName')) AS instancia_efectiva,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('MachineName'))  AS maquina,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ProductVersion')) AS version_producto,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('Edition'))      AS edicion;

/* ---------------------------------------------------------------------------
 * 2. Tablas requeridas por schema.sql: presentes / faltantes (24 en total).
 * ------------------------------------------------------------------------- */
DECLARE @expected_tables TABLE (table_name SYSNAME NOT NULL PRIMARY KEY);
INSERT INTO @expected_tables (table_name) VALUES
 (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
 (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
 (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
 (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
 (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
 (N'kb_ticket_articles'), (N'kb_article_history');

SELECT
    e.table_name AS tabla_requerida,
    CASE WHEN OBJECT_ID(N'dbo.' + e.table_name, N'U') IS NULL THEN N'FALTA' ELSE N'existe' END AS estado
FROM @expected_tables AS e
ORDER BY CASE WHEN OBJECT_ID(N'dbo.' + e.table_name, N'U') IS NULL THEN 0 ELSE 1 END, e.table_name;

SELECT COUNT(*) AS tablas_requeridas,
       SUM(CASE WHEN OBJECT_ID(N'dbo.' + table_name, N'U') IS NULL THEN 1 ELSE 0 END) AS tablas_faltantes,
       SUM(CASE WHEN OBJECT_ID(N'dbo.' + table_name, N'U') IS NOT NULL THEN 1 ELSE 0 END) AS tablas_existentes
FROM @expected_tables;

/* ---------------------------------------------------------------------------
 * 3. Columnas requeridas de las 6 tablas existentes: faltantes.
 *    (Para las tablas nuevas la diferencia es "no existe la tabla".)
 * ------------------------------------------------------------------------- */
DECLARE @expected_columns TABLE (
    table_name SYSNAME NOT NULL,
    column_name SYSNAME NOT NULL,
    type_name SYSNAME NOT NULL,
    char_length INT NULL,      -- caracteres; -1 = MAX; NULL = no aplica (tipo fijo)
    not_null BIT NOT NULL,
    is_identity BIT NOT NULL
);
INSERT INTO @expected_columns (table_name, column_name, type_name, char_length, not_null, is_identity) VALUES
 -- users
 (N'users', N'id', N'int', NULL, 1, 1),
 (N'users', N'organization_id', N'int', NULL, 0, 0),
 (N'users', N'department_id', N'int', NULL, 0, 0),
 (N'users', N'role_id', N'int', NULL, 1, 0),
 (N'users', N'name', N'nvarchar', 150, 1, 0),
 (N'users', N'last_name', N'nvarchar', 150, 1, 0),
 (N'users', N'username', N'nvarchar', 150, 1, 0),
 (N'users', N'email', N'nvarchar', 320, 1, 0),
 (N'users', N'password_hash', N'nvarchar', 500, 1, 0),
 (N'users', N'position', N'nvarchar', 200, 0, 0),
 (N'users', N'active', N'bit', NULL, 1, 0),
 (N'users', N'last_login_at', N'datetime2', NULL, 0, 0),
 (N'users', N'last_password_change_at', N'datetime2', NULL, 0, 0),
 (N'users', N'password_reset_token', N'nvarchar', 500, 0, 0),
 (N'users', N'password_reset_expires', N'datetime2', NULL, 0, 0),
 (N'users', N'created_at', N'datetime2', NULL, 1, 0),
 (N'users', N'updated_at', N'datetime2', NULL, 0, 0),
 -- departments
 (N'departments', N'id', N'int', NULL, 1, 1),
 (N'departments', N'organization_id', N'int', NULL, 1, 0),
 (N'departments', N'name', N'nvarchar', 150, 1, 0),
 (N'departments', N'description', N'nvarchar', -1, 0, 0),
 (N'departments', N'active', N'bit', NULL, 1, 0),
 (N'departments', N'created_at', N'datetime2', NULL, 1, 0),
 -- roles
 (N'roles', N'id', N'int', NULL, 1, 1),
 (N'roles', N'code', N'nvarchar', 100, 1, 0),
 (N'roles', N'name', N'nvarchar', 150, 1, 0),
 (N'roles', N'description', N'nvarchar', -1, 0, 0),
 (N'roles', N'active', N'bit', NULL, 1, 0),
 (N'roles', N'created_at', N'datetime2', NULL, 1, 0),
 -- permissions
 (N'permissions', N'id', N'int', NULL, 1, 1),
 (N'permissions', N'code', N'nvarchar', 100, 1, 0),
 (N'permissions', N'description', N'nvarchar', -1, 0, 0),
 (N'permissions', N'created_at', N'datetime2', NULL, 1, 0),
 -- role_permissions
 (N'role_permissions', N'role_id', N'int', NULL, 1, 0),
 (N'role_permissions', N'permission_id', N'int', NULL, 1, 0),
 -- sessions
 (N'sessions', N'sid', N'nvarchar', 255, 1, 0),
 (N'sessions', N'sess', N'nvarchar', -1, 1, 0),
 (N'sessions', N'expire', N'bigint', NULL, 1, 0);

SELECT
    c.table_name  AS tabla,
    c.column_name AS columna_faltante,
    'requerida en schema.sql' AS nota
FROM @expected_columns AS c
WHERE OBJECT_ID(N'dbo.' + c.table_name, N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.' + c.table_name, c.column_name) IS NULL
ORDER BY c.table_name, c.column_name;

/* Columnas adicionales (no requeridas) en las 6 tablas existentes. */
SELECT
    t.name AS tabla,
    c.name AS columna_adicional,
    ty.name AS tipo
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'users', N'departments', N'roles', N'permissions', N'role_permissions', N'sessions')
  AND NOT EXISTS (
      SELECT 1 FROM @expected_columns AS e
      WHERE e.table_name = t.name AND e.column_name = c.name
  )
ORDER BY t.name, c.name;

/* ---------------------------------------------------------------------------
 * 3b. Comparacion AUTOMATICA de columnas contra schema.sql.
 *     Solo compara las columnas que EXISTEN (las faltantes ya se listan mas
 *     arriba). Emite una fila por cada diferencia real de tipo, longitud,
 *     nulabilidad, IDENTITY, precision/escala (DECIMAL/NUMERIC) y escala
 *     (DATETIME2/TIME/DATETIMEOFFSET). No considera equivalentes tipos,
 *     longitudes, precisiones ni escalas distintas: cualquier discrepancia se
 *     reporta. Donde precision o escala NO aplican, no se genera diferencia.
 * ------------------------------------------------------------------------- */

/* Precision y escala esperadas (schema.sql) SOLO para columnas donde aplican:
 *   - DECIMAL/NUMERIC          : se comparan precision Y escala.
 *   - DATETIME2/TIME/OFFSET    : se compara unicamente la escala (segundos
 *                                fraccionarios); la "precision" de estos tipos
 *                                en sys.columns no es representativa y NO se
 *                                evalua.
 * En las 6 tablas canonicas no hay columnas DECIMAL/NUMERIC; se incluye la
 * plantilla comentada para futuras columnas de ese tipo. */
DECLARE @expected_precision_scale TABLE (
    table_name SYSNAME NOT NULL,
    column_name SYSNAME NOT NULL,
    expected_precision INT NULL,   -- solo DECIMAL/NUMERIC
    expected_scale INT NOT NULL,   -- DECIMAL/NUMERIC y temporales
    PRIMARY KEY (table_name, column_name)
);
INSERT INTO @expected_precision_scale (table_name, column_name, expected_precision, expected_scale) VALUES
 -- datetime2(3) declarados en schema.sql
 (N'users',       N'last_login_at',           NULL, 3),
 (N'users',       N'last_password_change_at', NULL, 3),
 (N'users',       N'password_reset_expires',  NULL, 3),
 (N'users',       N'created_at',              NULL, 3),
 (N'users',       N'updated_at',              NULL, 3),
 (N'departments', N'created_at',              NULL, 3),
 (N'roles',       N'created_at',              NULL, 3),
 (N'permissions', N'created_at',              NULL, 3);
 -- Plantilla para DECIMAL/NUMERIC (precision, escala):
 -- (N'users', N'columna_decimal', 18, 2),

;WITH actual_columns AS (
    SELECT
        t.name AS table_name,
        c.name AS column_name,
        LOWER(ty.name) AS type_name,
        CASE
            WHEN LOWER(ty.name) IN (N'nvarchar', N'nchar', N'varchar', N'char')
                THEN CASE WHEN c.max_length = -1 THEN -1
                          ELSE c.max_length / CASE WHEN LOWER(ty.name) IN (N'nvarchar', N'nchar') THEN 2 ELSE 1 END
                     END
            ELSE NULL
        END AS char_length,
        c.is_nullable,
        c.is_identity,
        c.precision AS numeric_precision,
        c.scale     AS numeric_scale
    FROM sys.columns AS c
    JOIN sys.tables AS t ON t.object_id = c.object_id
    JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
    WHERE t.schema_id = SCHEMA_ID(N'dbo')
      AND t.name IN (N'users', N'departments', N'roles', N'permissions', N'role_permissions', N'sessions')
)
SELECT
    e.table_name  AS tabla,
    e.column_name AS columna,
    d.aspecto,
    d.esperado,
    d.encontrado
FROM @expected_columns AS e
JOIN actual_columns AS a
  ON a.table_name = e.table_name AND a.column_name = e.column_name
LEFT JOIN @expected_precision_scale AS eps
  ON eps.table_name = e.table_name AND eps.column_name = e.column_name
CROSS APPLY (VALUES
    (N'tipo',
        e.type_name,
        a.type_name,
        CASE WHEN e.type_name <> a.type_name THEN 1 ELSE 0 END),
    (N'longitud',
        CASE WHEN e.char_length IS NULL THEN N'(no aplica)'
             WHEN e.char_length = -1 THEN N'MAX'
             ELSE CAST(e.char_length AS NVARCHAR(20)) END,
        CASE WHEN a.char_length IS NULL THEN N'(no aplica)'
             WHEN a.char_length = -1 THEN N'MAX'
             ELSE CAST(a.char_length AS NVARCHAR(20)) END,
        CASE WHEN e.char_length IS NOT NULL AND a.char_length IS NOT NULL AND e.char_length <> a.char_length THEN 1 ELSE 0 END),
    (N'nulabilidad',
        CASE WHEN e.not_null = 1 THEN N'NOT NULL' ELSE N'NULL' END,
        CASE WHEN a.is_nullable = 0 THEN N'NOT NULL' ELSE N'NULL' END,
        CASE WHEN e.not_null = CASE WHEN a.is_nullable = 0 THEN 1 ELSE 0 END THEN 0 ELSE 1 END),
    (N'identity',
        CASE WHEN e.is_identity = 1 THEN N'IDENTITY' ELSE N'NO IDENTITY' END,
        CASE WHEN a.is_identity = 1 THEN N'IDENTITY' ELSE N'NO IDENTITY' END,
        CASE WHEN e.is_identity = a.is_identity THEN 0 ELSE 1 END),
    -- Precision: solo aplica a DECIMAL/NUMERIC con expectativa declarada.
    (N'precision',
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric') AND eps.expected_precision IS NOT NULL
             THEN CAST(eps.expected_precision AS NVARCHAR(20)) ELSE N'(no aplica)' END,
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric')
             THEN CAST(a.numeric_precision AS NVARCHAR(20)) ELSE N'(no aplica)' END,
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric')
                  AND eps.expected_precision IS NOT NULL
                  AND a.numeric_precision <> eps.expected_precision
             THEN 1 ELSE 0 END),
    -- Escala: DECIMAL/NUMERIC, DATETIME2, TIME y DATETIMEOFFSET.
    (N'escala',
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric', N'time', N'datetime2', N'datetimeoffset')
                  AND eps.expected_scale IS NOT NULL
             THEN CAST(eps.expected_scale AS NVARCHAR(20)) ELSE N'(no aplica)' END,
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric', N'time', N'datetime2', N'datetimeoffset')
             THEN CAST(a.numeric_scale AS NVARCHAR(20)) ELSE N'(no aplica)' END,
        CASE WHEN LOWER(a.type_name) IN (N'decimal', N'numeric', N'time', N'datetime2', N'datetimeoffset')
                  AND eps.expected_scale IS NOT NULL
                  AND a.numeric_scale <> eps.expected_scale
             THEN 1 ELSE 0 END)
) AS d(aspecto, esperado, encontrado, es_diferencia)
WHERE d.es_diferencia = 1
ORDER BY e.table_name, e.column_name,
         CASE d.aspecto WHEN N'tipo' THEN 1 WHEN N'longitud' THEN 2 WHEN N'precision' THEN 3
                        WHEN N'escala' THEN 4 WHEN N'nulabilidad' THEN 5 WHEN N'identity' THEN 6 ELSE 9 END;

/* ---------------------------------------------------------------------------
 * 4. Definicion real de columnas de las 6 tablas existentes (para diff manual
 *    contra schema.sql: tipo, longitud, nulabilidad, identity, calculada).
 * ------------------------------------------------------------------------- */
SELECT
    t.name            AS tabla,
    c.column_id       AS ordinal,
    c.name            AS columna,
    ty.name           AS tipo,
    c.max_length      AS max_length_bytes,
    c.precision       AS precision_decimal,
    c.scale           AS escala,
    c.is_nullable     AS admite_null,
    c.is_identity     AS es_identity,
    c.is_computed     AS es_calculada
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'users', N'departments', N'roles', N'permissions', N'role_permissions', N'sessions')
ORDER BY t.name, c.column_id;

/* ---------------------------------------------------------------------------
 * 5. Restricciones reales de las 6 tablas existentes (PK, UQ, F, C, D).
 * ------------------------------------------------------------------------- */
SELECT
    t.name AS tabla,
    o.name AS restriccion,
    CASE o.type WHEN 'PK' THEN 'PRIMARY KEY' WHEN 'UQ' THEN 'UNIQUE'
                WHEN 'F' THEN 'FOREIGN KEY' WHEN 'C' THEN 'CHECK' WHEN 'D' THEN 'DEFAULT' END AS tipo,
    -- is_disabled / is_not_trusted NO existen en sys.objects: solo aplican a
    -- CHECK y FOREIGN KEY. Se obtienen de sus catalogos y quedan NULL (no
    -- aplica) para PK/UQ/DEFAULT.
    COALESCE(fk.is_disabled, cc.is_disabled)       AS deshabilitada,
    COALESCE(fk.is_not_trusted, cc.is_not_trusted) AS no_confiable
FROM sys.objects AS o
JOIN sys.tables AS t ON t.object_id = o.parent_object_id
LEFT JOIN sys.foreign_keys AS fk ON fk.object_id = o.object_id
LEFT JOIN sys.check_constraints AS cc ON cc.object_id = o.object_id
WHERE o.type IN ('PK', 'UQ', 'F', 'C', 'D')
  AND t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'users', N'departments', N'roles', N'permissions', N'role_permissions', N'sessions')
ORDER BY t.name, o.type, o.name;

/* ---------------------------------------------------------------------------
 * 6. Indices reales de las 6 tablas existentes.
 * ------------------------------------------------------------------------- */
SELECT
    t.name AS tabla,
    i.name AS indice,
    i.is_unique AS es_unico,
    i.is_primary_key AS es_pk,
    i.is_unique_constraint AS es_uq,
    i.type_desc AS tipo_indice
FROM sys.indexes AS i
JOIN sys.tables AS t ON t.object_id = i.object_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'users', N'departments', N'roles', N'permissions', N'role_permissions', N'sessions')
  AND i.name IS NOT NULL
ORDER BY t.name, i.name;

/* Indices que schema.sql exige y podrian faltar en estas tablas. */
DECLARE @expected_indexes TABLE (
    index_name SYSNAME NOT NULL,
    schema_name SYSNAME NOT NULL,
    table_name SYSNAME NOT NULL,
    PRIMARY KEY (schema_name, table_name, index_name)
);
INSERT INTO @expected_indexes (index_name, schema_name, table_name) VALUES
 (N'IX_users_organization_active', N'dbo', N'users'),
 (N'IX_users_department', N'dbo', N'users'),
 (N'IX_sessions_expire', N'dbo', N'sessions');

/* El nombre de indice solo es unico DENTRO de cada tabla, asi que la busqueda
 * exige coincidencia de nombre + esquema + tabla para no dar falsos positivos. */
SELECT
    e.schema_name AS esquema,
    e.table_name  AS tabla,
    e.index_name  AS indice_requerido,
    CASE WHEN EXISTS (
        SELECT 1
        FROM sys.indexes AS i
        JOIN sys.tables AS t ON t.object_id = i.object_id
        JOIN sys.schemas AS s ON s.schema_id = t.schema_id
        WHERE i.name = e.index_name
          AND t.name = e.table_name
          AND s.name = e.schema_name
    ) THEN N'existe' ELSE N'FALTA' END AS estado
FROM @expected_indexes AS e
ORDER BY e.schema_name, e.table_name, e.index_name;

/* ---------------------------------------------------------------------------
 * 7. Claves foraneas reales de las 6 tablas existentes.
 * ------------------------------------------------------------------------- */
SELECT
    fk.name AS fk,
    OBJECT_NAME(fk.parent_object_id) AS tabla_hija,
    OBJECT_NAME(fk.referenced_object_id) AS tabla_padre,
    fk.delete_referential_action_desc AS accion_delete,
    fk.is_disabled AS deshabilitada,
    fk.is_not_trusted AS no_confiable
FROM sys.foreign_keys AS fk
WHERE fk.parent_object_id IN (OBJECT_ID(N'dbo.users'), OBJECT_ID(N'dbo.departments'),
                              OBJECT_ID(N'dbo.roles'), OBJECT_ID(N'dbo.permissions'),
                              OBJECT_ID(N'dbo.role_permissions'), OBJECT_ID(N'dbo.sessions'))
   OR fk.referenced_object_id IN (OBJECT_ID(N'dbo.users'), OBJECT_ID(N'dbo.departments'),
                                  OBJECT_ID(N'dbo.roles'), OBJECT_ID(N'dbo.permissions'),
                                  OBJECT_ID(N'dbo.role_permissions'), OBJECT_ID(N'dbo.sessions'))
ORDER BY tabla_hija, fk.name;

/* ---------------------------------------------------------------------------
 * 8. Conteos de filas de las 6 tablas existentes (cada lectura protegida con
 *    OBJECT_ID para no fallar si alguna tabla faltara).
 * ------------------------------------------------------------------------- */
DECLARE @row_counts TABLE (tabla SYSNAME NOT NULL PRIMARY KEY, filas BIGINT NOT NULL);

IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'roles', COUNT_BIG(*) FROM dbo.roles;
IF OBJECT_ID(N'dbo.permissions', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'permissions', COUNT_BIG(*) FROM dbo.permissions;
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'role_permissions', COUNT_BIG(*) FROM dbo.role_permissions;
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'users', COUNT_BIG(*) FROM dbo.users;
IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'departments', COUNT_BIG(*) FROM dbo.departments;
IF OBJECT_ID(N'dbo.sessions', N'U') IS NOT NULL
    INSERT INTO @row_counts (tabla, filas) SELECT N'sessions', COUNT_BIG(*) FROM dbo.sessions;

SELECT tabla, filas FROM @row_counts ORDER BY tabla;

/* ---------------------------------------------------------------------------
 * 9. Comprobaciones de integridad de DATOS existentes (solo lectura).
 *
 *    IMPORTANTE (T-SQL): las COLUMNAS se resuelven en COMPILACION; COL_LENGTH
 *    es una comprobacion en tiempo de ejecucion y NO evita el error 207
 *    "Invalid column name" si la columna no existe. Por eso cada consulta que
 *    referencia columnas de tablas legacy se construye con SQL DINAMICO y solo
 *    se ejecuta tras confirmar (con OBJECT_ID/COL_LENGTH) que la tabla y TODAS
 *    las columnas usadas existen. El SQL dinamico aqui solo hace SELECT/COUNT;
 *    no hay DML ni DDL: sigue siendo 100% de solo lectura.
 * ------------------------------------------------------------------------- */
DECLARE @sql NVARCHAR(MAX);

/* 9.1 users.organization_id NULL (si la columna existe). */
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
    BEGIN
        DECLARE @users_null_org BIGINT;
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @users_null_org OUTPUT;
        PRINT N'users.organization_id NULL: ' + CAST(@users_null_org AS NVARCHAR(20));
    END
    ELSE
        PRINT N'users.organization_id: NO EXISTE (faltante confirmado)';
END
ELSE
    PRINT N'users: tabla ausente; no se comprueba organization_id';

/* 9.2 departments.organization_id NULL (si la columna existe). */
IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
    BEGIN
        DECLARE @dept_null_org BIGINT;
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @dept_null_org OUTPUT;
        PRINT N'departments.organization_id NULL: ' + CAST(@dept_null_org AS NVARCHAR(20));
    END
    ELSE
        PRINT N'departments.organization_id: NO EXISTE (faltante confirmado)';
END
ELSE
    PRINT N'departments: tabla ausente; no se comprueba organization_id';

/* 9.3 users.role_id huerfano (requiere users.role_id y roles.id). */
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.users', N'role_id') IS NOT NULL
   AND COL_LENGTH(N'dbo.roles', N'id') IS NOT NULL
BEGIN
    SET @sql = N'SELECT N''users.role_id huerfano'' AS comprobacion, COUNT_BIG(*) AS filas
                 FROM dbo.users AS u
                 WHERE u.role_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM dbo.roles AS r WHERE r.id = u.role_id);';
    EXEC sys.sp_executesql @sql;
END
ELSE
    PRINT N'Comprobacion users.role_id huerfano omitida: falta tabla o columna.';

/* 9.4 users.department_id huerfano (requiere users.department_id y departments.id). */
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.users', N'department_id') IS NOT NULL
   AND COL_LENGTH(N'dbo.departments', N'id') IS NOT NULL
BEGIN
    SET @sql = N'SELECT N''users.department_id huerfano'' AS comprobacion, COUNT_BIG(*) AS filas
                 FROM dbo.users AS u
                 WHERE u.department_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM dbo.departments AS d WHERE d.id = u.department_id);';
    EXEC sys.sp_executesql @sql;
END
ELSE
    PRINT N'Comprobacion users.department_id huerfano omitida: falta tabla o columna.';

/* 9.5 role_permissions.role_id huerfano (requiere role_permissions.role_id y roles.id). */
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.role_permissions', N'role_id') IS NOT NULL
   AND COL_LENGTH(N'dbo.roles', N'id') IS NOT NULL
BEGIN
    SET @sql = N'SELECT N''role_permissions.role_id huerfano'' AS comprobacion, COUNT_BIG(*) AS filas
                 FROM dbo.role_permissions AS rp
                 WHERE NOT EXISTS (SELECT 1 FROM dbo.roles AS r WHERE r.id = rp.role_id);';
    EXEC sys.sp_executesql @sql;
END
ELSE
    PRINT N'Comprobacion role_permissions.role_id huerfano omitida: falta tabla o columna.';

/* 9.6 role_permissions.permission_id huerfano (requiere role_permissions.permission_id y permissions.id). */
IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.permissions', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.role_permissions', N'permission_id') IS NOT NULL
   AND COL_LENGTH(N'dbo.permissions', N'id') IS NOT NULL
BEGIN
    SET @sql = N'SELECT N''role_permissions.permission_id huerfano'' AS comprobacion, COUNT_BIG(*) AS filas
                 FROM dbo.role_permissions AS rp
                 WHERE NOT EXISTS (SELECT 1 FROM dbo.permissions AS p WHERE p.id = rp.permission_id);';
    EXEC sys.sp_executesql @sql;
END
ELSE
    PRINT N'Comprobacion role_permissions.permission_id huerfano omitida: falta tabla o columna.';

PRINT N'============================================================';
PRINT N' FIN DEL INVENTARIO. No se modifico nada.';
PRINT N' Siguiente: revisar el diff y cerrar las decisiones del plan.';
PRINT N'============================================================';
