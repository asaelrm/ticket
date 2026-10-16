/* ============================================================================
 * SIFHA - Correccion idempotente y NO destructiva de dbo.notifications
 *         EXCLUSIVA para SIFHA_Tickets_M5_Validation
 * ============================================================================
 *
 * Que hace
 *   1. Cambia la nulabilidad de dbo.notifications.organization_id a NULL SOLO
 *      para avisos globales legitimos dirigidos a una cuenta SUPERADMIN sin
 *      organizacion.
 *   2. Agrega el CHECK CK_notifications_ticket_requires_org: una notificacion
 *      ligada a un ticket (ticket_id IS NOT NULL) SIEMPRE debe tener
 *      organization_id.
 *   No modifica ninguna otra columna (body, link, etc.), ni filas, ni indices.
 *
 * Exclusividad / garantia de destino
 *   El script valida ANTES de cambiar nada que la conexion corresponda
 *   EXACTAMENTE a:
 *     - servidor  : TI-DESK-01\SIFHADEV
 *     - instancia : SIFHADEV
 *     - base      : SIFHA_Tickets_M5_Validation
 *   Si cualquiera difiere, ABORTA sin tocar nada. Nunca debe ejecutarse sobre
 *   SIFHA_Tickets_DEV ni sobre ninguna otra base.
 *
 * Seguridad operativa
 *   - NO lo ejecuta la aplicacion ni los tests: es un script de administracion
 *     para ejecutar manualmente contra el destino autorizado.
 *   - Idempotente: se puede volver a ejecutar sin efecto si ya esta aplicado.
 *   - Transaccional: ALTER + CHECK en una sola transaccion con XACT_ABORT ON y
 *     TRY/CATCH; ante cualquier error se revierte por completo.
 *   - Auditoria de dependencias antes de alterar: aborta si la columna
 *     participa de la PRIMARY KEY o tiene DEFAULT, estadisticas de usuario o
 *     una columna calculada que dependa de ella.
 *   - Conserva las FK compuestas y los indices existentes (no se tocan).
 *   - Verificacion posterior: confirma que la columna admite NULL y que el
 *     CHECK quedo activo y confiable.
 *
 * Uso (manual, contra la base autorizada)
 *   sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_M5_Validation ^
 *          -i notifications-organization-nullable.sql
 *   o abrir en SSMS conectado a SIFHA_Tickets_M5_Validation y ejecutar.
 *   Se recomienda una instantanea/backup previo de la base.
 *
 * Plan de recuperacion (reversion manual solo si hiciera falta)
 *   - Deshacer el CHECK:
 *       ALTER TABLE dbo.notifications
 *         DROP CONSTRAINT CK_notifications_ticket_requires_org;
 *   - Volver organization_id a NOT NULL (solo si NO quedan filas con NULL):
 *       ALTER TABLE dbo.notifications ALTER COLUMN organization_id INT NOT NULL;
 * ========================================================================== */

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* 0. Guarda de identidad: solo SIFHA_Tickets_M5_Validation en TI-DESK-01\SIFHADEV. */
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_M5_Validation';
DECLARE @expected_server NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
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

PRINT N'Identidad verificada: TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_Tickets_M5_Validation';

/* 1. La tabla y la columna deben existir. */
IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: dbo.notifications no existe; no se aplica nada.', 16, 1);
    RETURN;
END;

IF COL_LENGTH(N'dbo.notifications', N'organization_id') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: dbo.notifications.organization_id no existe; no se aplica nada.', 16, 1);
    RETURN;
END;

/* 2. Auditoria de dependencias que podrian BLOQUEAR el ALTER COLUMN.
 *    (NOT NULL -> NULL si se permite con FK/indices no clusterizados, pero NO
 *    con la columna dentro de la PRIMARY KEY, un DEFAULT, estadisticas de
 *    usuario o una columna calculada dependiente.) */
DECLARE @pk_on_column INT = (
    SELECT COUNT(*)
    FROM sys.indexes AS i
    INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID(N'dbo.notifications')
      AND i.is_primary_key = 1
      AND c.name = N'organization_id'
);

DECLARE @default_on_column INT = (
    SELECT COUNT(*)
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'dbo.notifications')
      AND c.name = N'organization_id'
);

DECLARE @user_stats_on_column INT = (
    SELECT COUNT(*)
    FROM sys.stats AS s
    INNER JOIN sys.stats_columns AS sc ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id
    INNER JOIN sys.columns AS c ON c.object_id = sc.object_id AND c.column_id = sc.column_id
    WHERE s.object_id = OBJECT_ID(N'dbo.notifications')
      AND c.name = N'organization_id'
      AND s.user_created = 1
);

DECLARE @computed_ref INT = (
    SELECT COUNT(*)
    FROM sys.computed_columns AS cc
    WHERE cc.object_id = OBJECT_ID(N'dbo.notifications')
      AND cc.definition LIKE N'%organization_id%'
);

IF @pk_on_column > 0
BEGIN
    RAISERROR(N'ABORTADO: organization_id participa de la PRIMARY KEY; NOT NULL -> NULL no es posible sin rediseñar la clave.', 16, 1);
    RETURN;
END;

IF @default_on_column > 0 OR @user_stats_on_column > 0 OR @computed_ref > 0
BEGIN
    RAISERROR(N'ABORTADO: dependencias que impiden ALTER COLUMN (DEFAULT/estadisticas de usuario/columna calculada). Revise y reintente.', 16, 1);
    RETURN;
END;

/* Dependencias permitidas (se conservan): FK compuestas e indices. */
DECLARE @fk_on_column INT = (
    SELECT COUNT(*)
    FROM sys.foreign_key_columns AS fkc
    INNER JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.notifications')
      AND c.name = N'organization_id'
);
DECLARE @ix_on_column INT = (
    SELECT COUNT(*)
    FROM sys.indexes AS i
    INNER JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    INNER JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID(N'dbo.notifications')
      AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
      AND c.name = N'organization_id'
);
PRINT N'Dependencias permitidas detectadas (se conservan): FKs=' + CAST(@fk_on_column AS NVARCHAR(10))
    + N', indices no clusterizados=' + CAST(@ix_on_column AS NVARCHAR(10));

/* 3. Validar filas existentes ANTES de modificar restricciones.
 *    3a. Ninguna notificacion puede tener ticket_id y organization_id NULL. */
DECLARE @invalid_ticket INT = (
    SELECT COUNT(*)
    FROM dbo.notifications
    WHERE organization_id IS NULL AND ticket_id IS NOT NULL
);
IF @invalid_ticket > 0
BEGIN
    RAISERROR(N'ABORTADO: %d notificacion(es) con ticket_id y organization_id NULL. Corrija los datos antes de continuar.', 16, 1, @invalid_ticket);
    RETURN;
END;

/*    3b. Con organization_id NULL el destinatario debe ser un SUPERADMIN
 *    global legitimo: rol SUPERADMIN, sin organizacion, con el permiso global
 *    organization.manage. Cualquier otro caso se rechaza. */
DECLARE @invalid_recipient INT = (
    SELECT COUNT(*)
    FROM dbo.notifications AS n
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
      )
);
IF @invalid_recipient > 0
BEGIN
    RAISERROR(N'ABORTADO: %d notificacion(es) con organization_id NULL cuyo destinatario no es un SUPERADMIN global legitimo. Corrija los datos antes de continuar.', 16, 1, @invalid_recipient);
    RETURN;
END;

BEGIN TRY
    BEGIN TRANSACTION;

    /* 4. Cambiar la nulabilidad SOLO si la columna actualmente es NOT NULL. */
    IF EXISTS (
        SELECT 1
        FROM sys.columns AS c
        INNER JOIN sys.tables AS t ON t.object_id = c.object_id
        INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
        WHERE s.name = N'dbo'
          AND t.name = N'notifications'
          AND c.name = N'organization_id'
          AND c.is_nullable = 0
    )
    BEGIN
        ALTER TABLE dbo.notifications ALTER COLUMN organization_id INT NULL;
    END;

    /* 5. Crear el CHECK SOLO si no existe (por nombre canonico). */
    IF NOT EXISTS (
        SELECT 1
        FROM sys.check_constraints AS cc
        INNER JOIN sys.objects AS o ON o.object_id = cc.parent_object_id
        INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
        WHERE s.name = N'dbo'
          AND o.name = N'notifications'
          AND cc.name = N'CK_notifications_ticket_requires_org'
    )
    BEGIN
        ALTER TABLE dbo.notifications WITH CHECK
            ADD CONSTRAINT CK_notifications_ticket_requires_org
            CHECK (organization_id IS NOT NULL OR ticket_id IS NULL);
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

/* 6. Verificacion posterior: la columna admite NULL y el CHECK esta activo y
 *    confiable. Si algo no cuadra, avisar con error (no se revierte: la
 *    transaccion ya confirmo; use el plan de recuperacion si hiciera falta). */
DECLARE @still_not_null INT = (
    SELECT COUNT(*)
    FROM sys.columns AS c
    INNER JOIN sys.tables AS t ON t.object_id = c.object_id
    INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id
    WHERE s.name = N'dbo'
      AND t.name = N'notifications'
      AND c.name = N'organization_id'
      AND c.is_nullable = 0
);

DECLARE @check_state NVARCHAR(30) = N'ausente';
SELECT @check_state = CASE
        WHEN cc.is_disabled = 1 THEN N'deshabilitado'
        WHEN cc.is_not_trusted = 1 THEN N'no confiable'
        ELSE N'activo y confiable'
    END
FROM sys.check_constraints AS cc
INNER JOIN sys.objects AS o ON o.object_id = cc.parent_object_id
INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = N'dbo'
  AND o.name = N'notifications'
  AND cc.name = N'CK_notifications_ticket_requires_org';

IF @still_not_null > 0
BEGIN
    RAISERROR(N'VERIFICACION FALLIDA: organization_id sigue siendo NOT NULL.', 16, 1);
    RETURN;
END;

IF @check_state <> N'activo y confiable'
BEGIN
    RAISERROR(N'VERIFICACION FALLIDA: CK_notifications_ticket_requires_org "%s".', 16, 1, @check_state);
    RETURN;
END;

PRINT N'OK: dbo.notifications.organization_id admite NULL y CK_notifications_ticket_requires_org esta activo y confiable.';
PRINT N'Siguiente paso (solo lectura): ejecutar diagnose-m5-validation.js contra M5 (NO use verify-m5-validation.js: exige 0 filas y M5 ya tiene datos).';
