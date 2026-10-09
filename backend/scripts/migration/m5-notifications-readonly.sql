/* ============================================================================
 * SIFHA - Comprobaciones de SOLO LECTURA sobre dbo.notifications (M5)
 *         EXCLUSIVO de TI-DESK-01\SIFHADEV / SIFHA_Tickets_M5_Validation
 * ============================================================================
 *
 * Para que sirve
 *   Ejecutar ANTES y DESPUES de aplicar notifications-organization-nullable.sql
 *   para demostrar que:
 *     - se conserva el numero de notificaciones (p.ej. 26);
 *     - no hay filas anomalas (ticket sin organizacion);
 *     - el destinatario de una notificacion global es un SUPERADMIN legitimo;
 *     - la huella (checksum) no cambia al modificar solo el esquema.
 *
 * Que NO hace
 *   - Solo SELECT. No inserta, actualiza, borra ni altera nada.
 *   - Aborta si el destino no es TI-DESK-01\SIFHADEV / SIFHA_Tickets_M5_Validation.
 * ========================================================================== */

SET NOCOUNT ON;

DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_M5_Validation';
DECLARE @expected_server NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
DECLARE @current_legacy_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), @@SERVERNAME)));
DECLARE @current_instance NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));

IF UPPER(ISNULL(@current_database, N'')) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: la base actual "%s" no es la autorizada "%s".', 16, 1, @current_database, @expected_database);
    RETURN;
END;
IF UPPER(ISNULL(@current_instance, N'')) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: la instancia "%s" no es la autorizada "%s".', 16, 1, @current_instance, @expected_instance);
    RETURN;
END;
IF NOT (
    UPPER(ISNULL(@current_server, N'')) = UPPER(@expected_server)
    OR UPPER(ISNULL(@current_legacy_server, N'')) = UPPER(@expected_server)
)
BEGIN
    RAISERROR(N'ABORTADO: el servidor "%s"/"%s" no es el autorizado "%s".', 16, 1, @current_server, @current_legacy_server, @expected_server);
    RETURN;
END;

PRINT N'=== Identidad verificada: TI-DESK-01\SIFHADEV / SIFHA_Tickets_M5_Validation (solo lectura) ===';

/* 1. Recuento y huella. ISNULL(organization_id, -1) incluye las filas NULL en
 *    el checksum, para que un cambio de nulabilidad de datos se detecte. */
SELECT
    COUNT(*)                                                        AS total_notificaciones,
    SUM(CASE WHEN organization_id IS NULL THEN 1 ELSE 0 END)        AS con_organizacion_null,
    SUM(CASE WHEN ticket_id IS NOT NULL THEN 1 ELSE 0 END)          AS ligadas_a_ticket,
    CHECKSUM_AGG(BINARY_CHECKSUM(id,
                                 ISNULL(organization_id, -1),
                                 ISNULL(ticket_id, -1),
                                 user_id))                          AS huella
FROM dbo.notifications;

/* 2. Anomalias que el script de correccion rechazaria (ambas deben ser 0). */
SELECT
    (SELECT COUNT(*) FROM dbo.notifications WHERE organization_id IS NULL AND ticket_id IS NOT NULL)
        AS anomalias_ticket_sin_org,
    (SELECT COUNT(*) FROM dbo.notifications AS n
     WHERE n.organization_id IS NULL
       AND NOT EXISTS (
           SELECT 1
           FROM dbo.users AS u
           INNER JOIN dbo.roles AS r ON r.id = u.role_id
           WHERE u.id = n.user_id
             AND u.organization_id IS NULL
             AND r.code = N'SUPERADMIN'
             AND EXISTS (
                 SELECT 1
                 FROM dbo.role_permissions AS rp
                 INNER JOIN dbo.permissions AS p ON p.id = rp.permission_id
                 WHERE rp.role_id = r.id AND p.code = N'organization.manage'
             )
       )) AS anomalias_destinatario_no_superadmin;

/* 3. Estado del esquema de dbo.notifications.organization_id. */
SELECT
    c.is_nullable                 AS organization_id_admite_null,   -- 1 = corregido
    dc.name                       AS default_constraint,            -- NULL = ok
    CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS en_primary_key
FROM sys.columns AS c
INNER JOIN sys.tables AS t ON t.object_id = c.object_id
INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
LEFT JOIN sys.default_constraints AS dc
       ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
LEFT JOIN (
    SELECT ic.object_id, ic.column_id
    FROM sys.indexes AS i
    INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
) AS pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE s.name = N'dbo' AND t.name = N'notifications' AND c.name = N'organization_id';

/* 4. Estado del CHECK. */
SELECT
    cc.name                       AS restriccion,
    cc.is_disabled                AS deshabilitada,   -- 0 = ok
    cc.is_not_trusted             AS no_confiable,    -- 0 = ok
    cc.definition                 AS definicion
FROM sys.check_constraints AS cc
INNER JOIN sys.objects AS o ON o.object_id = cc.parent_object_id
INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = N'dbo' AND o.name = N'notifications'
  AND cc.name = N'CK_notifications_ticket_requires_org';

PRINT N'=== Fin de las comprobaciones (solo lectura) ===';
