/* ============================================================================
 * SIFHA - FIX PUNTUAL: crear la FK compuesta FK_users_department_same_org
 *         users(organization_id, department_id) -> departments(organization_id, id)
 *         EXCLUSIVO de la instancia TI-DESK-01\SIFHADEV / base SIFHA_Tickets_DEV
 * ============================================================================
 *
 * CONTEXTO
 *   Tras el grupo B (fases 1-6/2b) el verificador post-B reporta 1 FK faltante:
 *   la compuesta FK_users_department_same_org. La fase 5 del borrador la omitia
 *   porque su guarda comprobaba "existe alguna FK sobre users.department_id" y la
 *   FK legacy FK_users_department (department_id -> departments.id) ya existe.
 *   Este script crea UNICAMENTE esa FK, de forma aislada y controlada.
 *
 * QUE HACE
 *   - Guarda de identidad: servidor, instancia y base (aborta si no coinciden).
 *   - Comprueba tablas y columnas (users.organization_id/department_id,
 *     departments.organization_id/id).
 *   - Comprueba EXACTAMENTE la clave UNIQUE referenciada UQ_departments_organization_id:
 *     key_ordinal 1 = organization_id, key_ordinal 2 = id, sin columnas extra.
 *   - Comprueba la integridad de los datos (0 huerfanos) con la semantica
 *     MATCH SIMPLE: solo pueden violar las filas con organization_id y
 *     department_id NO nulos sin department coincidente.
 *   - Si la FK objetivo YA existe, verifica que su DEFINICION real sea exactamente
 *     users.organization_id -> departments.organization_id y
 *     users.department_id   -> departments.id (en ese orden), con
 *     ON DELETE / ON UPDATE NO ACTION. Si difiere en cualquier punto, ABORTA sin
 *     tocar nada.
 *   - Si la FK objetivo NO existe, la crea (unica escritura) en una transaccion,
 *     con WITH CHECK.
 *   - Si la FK existe pero esta DESHABILITADA o NO es CONFIABLE: informa NO-GO y
 *     NO la habilita automaticamente (requiere accion manual).
 *   - CONFIRMA el estado final (presente/habilitada/confiable).
 *
 * QUE NO HACE
 *   - No borra ni recrea la FK legacy FK_users_department: se CONSERVA.
 *   - No modifica datos (0 UPDATE/INSERT/DELETE) ni dbo.organizations.
 *   - No habilita FKs preexistentes (no ejecuta WITH CHECK CHECK CONSTRAINT).
 *   - No toca longitudes NVARCHAR, ni UQ, ni indices, ni otras tablas.
 *   - No activa ni ejecuta los grupos C ni D.
 *
 * SEGURIDAD / REVERSION
 *   - UNICA operacion de escritura posible: crear FK_users_department_same_org,
 *     dentro de TRY/CATCH + transaccion, y solo si no existe con la definicion
 *     canonica. Los pre-chequeos son solo lectura; si fallan, RAISERROR + RETURN.
 *   - Reversion manual (SOLO con autorizacion):
 *       ALTER TABLE dbo.users DROP CONSTRAINT FK_users_department_same_org;
 * ============================================================================ */

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_WARNINGS ON;

DECLARE @did_write BIT = 0;

/* ---------------------------------------------------------------------------
 * 0. Guarda de identidad (servidor / instancia / base)
 * ------------------------------------------------------------------------- */
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_DEV';
DECLARE @expected_server   NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server   NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
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

PRINT N'Identidad verificada: TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_Tickets_DEV';

/* ---------------------------------------------------------------------------
 * 1. Precondiciones de esquema: tablas y columnas
 * ------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.users', N'U') IS NULL OR OBJECT_ID(N'dbo.departments', N'U') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: faltan dbo.users y/o dbo.departments. Ejecute el grupo B antes.', 16, 1);
    RETURN;
END;

IF COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
   OR COL_LENGTH(N'dbo.users', N'department_id') IS NULL
   OR COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
   OR COL_LENGTH(N'dbo.departments', N'id') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: faltan columnas requeridas (users.organization_id/department_id o departments.organization_id/id). Ejecute el grupo B (fase 2) antes.', 16, 1);
    RETURN;
END;

PRINT N'[1] OK: tablas y columnas requeridas presentes.';

/* ---------------------------------------------------------------------------
 * 2. Clave UNIQUE referenciada UQ_departments_organization_id.
 *    Verificacion EXACTA por orden de columna clave (key_ordinal):
 *       key_ordinal 1 = organization_id
 *       key_ordinal 2 = id
 *       y ninguna columna clave adicional (total de claves = 2).
 * ------------------------------------------------------------------------- */
DECLARE @uq_key_count INT = 0;
DECLARE @uq_key1 SYSNAME = NULL;
DECLARE @uq_key2 SYSNAME = NULL;

SELECT @uq_key_count = COUNT(*),
       @uq_key1 = MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END),
       @uq_key2 = MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END)
FROM sys.key_constraints AS kc
JOIN sys.index_columns AS ic
     ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN sys.columns AS c
     ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.name = N'UQ_departments_organization_id'
  AND kc.parent_object_id = OBJECT_ID(N'dbo.departments')
  AND kc.type = N'UQ'
  AND ic.key_ordinal > 0;   /* solo columnas clave; excluye INCLUDE */

IF @uq_key_count <> 2
   OR ISNULL(@uq_key1, N'') <> N'organization_id'
   OR ISNULL(@uq_key2, N'') <> N'id'
BEGIN
    RAISERROR(N'ABORTADO: UQ_departments_organization_id no tiene la clave exacta (organization_id[id=1], id[id=2]) o tiene columnas clave adicionales (claves detectadas=%d, 1=%s, 2=%s). Ejecute el grupo B (fase 3) antes.',
              16, 1, @uq_key_count, @uq_key1, @uq_key2);
    RETURN;
END;

PRINT N'[2] OK: UQ_departments_organization_id = (organization_id, id) en orden canonico, sin claves extra.';

/* ---------------------------------------------------------------------------
 * 3. Integridad de datos: 0 huerfanos (MATCH SIMPLE)
 * ------------------------------------------------------------------------- */
DECLARE @huerfanos BIGINT;
SELECT @huerfanos = COUNT_BIG(*)
FROM dbo.users AS u
LEFT JOIN dbo.departments AS d
       ON d.organization_id = u.organization_id AND d.id = u.department_id
WHERE u.organization_id IS NOT NULL
  AND u.department_id IS NOT NULL
  AND d.id IS NULL;

PRINT N'[3] Huerfanos (organization_id y department_id no nulos sin department coincidente): ' + CAST(@huerfanos AS NVARCHAR(20));

IF @huerfanos > 0
BEGIN
    RAISERROR(N'ABORTADO: hay %I64d users huerfanos respecto a departments(organization_id, id); resuelva los datos antes de crear la FK.', 16, 1, @huerfanos);
    RETURN;
END;

/* ---------------------------------------------------------------------------
 * 4. Estado y DEFINICION de la FK objetivo (si ya existe).
 *    Si existe con definicion distinta a la canonica -> ABORTA sin tocar nada.
 * ------------------------------------------------------------------------- */
DECLARE @fk_exists BIT = 0;
DECLARE @fk_def_ok BIT = 0;
DECLARE @fk_is_disabled BIT = NULL;
DECLARE @fk_is_not_trusted BIT = NULL;

IF EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = N'FK_users_department_same_org'
      AND parent_object_id = OBJECT_ID(N'dbo.users')
)
BEGIN
    SET @fk_exists = 1;

    DECLARE @fk_ref_table SYSNAME = NULL;
    DECLARE @fk_delete_action NVARCHAR(60) = NULL;
    DECLARE @fk_update_action NVARCHAR(60) = NULL;
    DECLARE @fk_col_count INT = 0;
    DECLARE @fk_parent_col1 SYSNAME = NULL;   /* constraint_column_id = 1 */
    DECLARE @fk_parent_col2 SYSNAME = NULL;   /* constraint_column_id = 2 */
    DECLARE @fk_ref_col1 SYSNAME = NULL;      /* constraint_column_id = 1 */
    DECLARE @fk_ref_col2 SYSNAME = NULL;      /* constraint_column_id = 2 */

    SELECT @fk_ref_table     = OBJECT_NAME(fk.referenced_object_id),
           @fk_is_disabled   = fk.is_disabled,
           @fk_is_not_trusted = fk.is_not_trusted,
           @fk_delete_action = fk.delete_referential_action_desc,
           @fk_update_action = fk.update_referential_action_desc
    FROM sys.foreign_keys AS fk
    WHERE fk.name = N'FK_users_department_same_org'
      AND fk.parent_object_id = OBJECT_ID(N'dbo.users');

    SELECT @fk_col_count  = COUNT(*),
           @fk_parent_col1 = MAX(CASE WHEN fkc.constraint_column_id = 1 THEN pc.name END),
           @fk_parent_col2 = MAX(CASE WHEN fkc.constraint_column_id = 2 THEN pc.name END),
           @fk_ref_col1    = MAX(CASE WHEN fkc.constraint_column_id = 1 THEN rc.name END),
           @fk_ref_col2    = MAX(CASE WHEN fkc.constraint_column_id = 2 THEN rc.name END)
    FROM sys.foreign_key_columns AS fkc
    JOIN sys.foreign_keys AS fk ON fk.object_id = fkc.constraint_object_id
    JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE fk.name = N'FK_users_department_same_org'
      AND fk.parent_object_id = OBJECT_ID(N'dbo.users');

    IF @fk_col_count <> 2
       OR @fk_ref_table <> N'departments'
       OR ISNULL(@fk_parent_col1, N'') <> N'organization_id'
       OR ISNULL(@fk_parent_col2, N'') <> N'department_id'
       OR ISNULL(@fk_ref_col1, N'')    <> N'organization_id'
       OR ISNULL(@fk_ref_col2, N'')    <> N'id'
       OR ISNULL(@fk_delete_action, N'') <> N'NO_ACTION'
       OR ISNULL(@fk_update_action, N'') <> N'NO_ACTION'
    BEGIN
        RAISERROR(N'ABORTADO: existe una FK con el nombre FK_users_department_same_org pero con una DEFINICION DISTINTA a la canonica. No se modifica nada. Detectado: ref=%s, parent(1)=%s parent(2)=%s, ref(1)=%s ref(2)=%s, cols=%d, ON DELETE=%s, ON UPDATE=%s.',
                  16, 1, @fk_ref_table, @fk_parent_col1, @fk_parent_col2, @fk_ref_col1, @fk_ref_col2, @fk_col_count, @fk_delete_action, @fk_update_action);
        RETURN;
    END;

    SET @fk_def_ok = 1;
    PRINT N'[4] La FK objetivo ya existe y su definicion coincide exactamente con la canonica.';
END
ELSE
BEGIN
    PRINT N'[4] La FK objetivo no existe; se procedera a crearla (unica escritura prevista).';
END;

/* ---------------------------------------------------------------------------
 * 5. Crear la FK solo si NO existe (idempotente), en transaccion, WITH CHECK.
 *    Si existe pero esta deshabilitada/no confiable: NO-GO, sin auto-habilitar.
 * ------------------------------------------------------------------------- */
IF @fk_exists = 0
BEGIN
    BEGIN TRY
        BEGIN TRANSACTION;

        ALTER TABLE dbo.users WITH CHECK
            ADD CONSTRAINT FK_users_department_same_org
            FOREIGN KEY (organization_id, department_id)
            REFERENCES dbo.departments(organization_id, id)
            ON DELETE NO ACTION;

        COMMIT TRANSACTION;

        SET @did_write = 1;
        SET @fk_exists = 1;
        SET @fk_def_ok = 1;
        SET @fk_is_disabled = 0;
        SET @fk_is_not_trusted = 0;

        PRINT N'[5] FK_users_department_same_org creada (WITH CHECK).';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        PRINT N'[5] ERROR al crear FK_users_department_same_org. Se revirtio (sin cambios).';
        THROW;
    END CATCH;
END
ELSE
BEGIN
    IF @fk_is_disabled = 1 OR @fk_is_not_trusted = 1
    BEGIN
        PRINT N'[5] NO-GO: la FK ya existe pero esta DESHABILITADA o NO es CONFIABLE. No se habilita automaticamente; requiere revision manual (NO se ejecuta WITH CHECK CHECK CONSTRAINT).';
    END
    ELSE
    BEGIN
        PRINT N'[5] Idempotente: la FK ya existe, con definicion canonica, habilitada y confiable. No se escribe nada.';
    END;
END;

/* ---------------------------------------------------------------------------
 * 6. Confirmacion: FK presente, habilitada y confiable; legacy conservada.
 * ------------------------------------------------------------------------- */
PRINT N'[6] --- Estado final de FK_users_department_same_org ---';
SELECT fk.name AS fk,
       CASE WHEN fk.is_disabled = 0 THEN N'HABILITADA' ELSE N'DESHABILITADA' END AS habilitada,
       CASE WHEN fk.is_not_trusted = 0 THEN N'CONFIABLE' ELSE N'NO CONFIABLE' END AS confiable,
       OBJECT_NAME(fk.referenced_object_id) AS tabla_padre,
       OBJECT_NAME(fk.parent_object_id) AS tabla_hija
FROM sys.foreign_keys AS fk
WHERE fk.name = N'FK_users_department_same_org'
  AND fk.parent_object_id = OBJECT_ID(N'dbo.users');

PRINT N'[6] --- FK legacy conservada (no se toca) ---';
SELECT fk.name AS fk_legacy_preservada,
       CASE WHEN fk.is_disabled = 0 THEN N'HABILITADA' ELSE N'DESHABILITADA' END AS habilitada
FROM sys.foreign_keys AS fk
WHERE fk.name = N'FK_users_department'
  AND fk.parent_object_id = OBJECT_ID(N'dbo.users');

/* ---------------------------------------------------------------------------
 * 7. Resumen automatico GO / NO-GO (del propio fix)
 * ------------------------------------------------------------------------- */
DECLARE @final_ok BIT = 0;
IF @fk_exists = 1
   AND @fk_def_ok = 1
   AND @fk_is_disabled = 0
   AND @fk_is_not_trusted = 0
    SET @final_ok = 1;

PRINT N'';
PRINT N'=== RESUMEN FIX FK_users_department_same_org ===';
PRINT N'  FK existe con definicion canonica: ' + CASE WHEN (@fk_exists = 1 AND @fk_def_ok = 1) THEN N'SI' ELSE N'NO' END;
PRINT N'  FK habilitada y confiable: ' + CASE WHEN (@fk_exists = 1 AND @fk_is_disabled = 0 AND @fk_is_not_trusted = 0) THEN N'SI' ELSE N'NO' END;
PRINT N'  Huerfanos: ' + CAST(@huerfanos AS NVARCHAR(20)) + N' (esperado 0)';
PRINT N'  Escritura realizada por este script: ' + CASE WHEN @did_write = 1 THEN N'SI (crear FK_users_department_same_org)' ELSE N'NO' END;
IF @final_ok = 1
    PRINT N'FIX: GO - FK_users_department_same_org presente, con definicion canonica, habilitada y confiable. Re-ejecute verify-after-groupB.sql para el GO global del grupo B.';
ELSE IF @fk_exists = 1 AND @fk_def_ok = 1
    PRINT N'FIX: NO-GO - la FK existe (definicion canonica) pero esta DESHABILITADA o NO es CONFIABLE; no se auto-habilita. Requiere revision manual.';
ELSE
    PRINT N'FIX: NO-GO - la FK no quedo presente/conforme; revise el detalle de [6].';
PRINT N'';
