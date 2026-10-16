/* ============================================================================
 * SIFHA - GRUPO C (INDEPENDIENTE): backfill de organization_id -> CMUCE
 *         Exclusivo de la instancia TI-DESK-01\SIFHADEV / base SIFHA_Tickets_DEV
 * ============================================================================
 *
 * OBJETIVO
 *   Asignar a la organizacion CMUCE ("Centro Medico UCE") los registros
 *   existentes heredados: los 25 departamentos y la unica cuenta autorizada
 *   (id 4). NO vuelve a ejecutar las fases 1-6 ni el grupo D.
 *
 * PRECONDICIONES (el script las comprueba y aborta si no se cumplen)
 *   1. Grupo B ya ejecutado y verificado: verify-after-groupB.sql -> GO.
 *   2. Existen dbo.organizations, dbo.departments, dbo.users, dbo.roles.
 *   3. Existen las columnas organization_id (departments/users) y las FK
 *      criticas con su DEFINICION real correcta (tabla padre/referenciada,
 *      pareja de columnas y ON DELETE/UPDATE NO ACTION), habilitadas y
 *      confiables; en particular FK_users_department_same_org.
 *   4. Estado de datos esperado: exactamente 25 departamentos y 1 usuario
 *      (id 4, role_id 7 = ADMIN, department_id 68), sin duplicados de nombre y
 *      sin registros en otra organizacion (o ya CMUCE si C se re-ejecuta).
 *   5. Backend detenido; ventana de mantenimiento; respaldo verificado.
 *
 * GARANTIAS DE SEGURIDAD
 *   - UNA SOLA TRANSACCION atomica: revalidacion + crear/reutilizar CMUCE +
 *     asignaciones + verificacion final. Si algo falla, ROLLBACK deja la base
 *     como estaba (incluida la organizacion).
 *   - Los datos criticos se REVALIDAN DENTRO de la transaccion, con bloqueos
 *     (sp_getapplock exclusivo + UPDLOCK/HOLDLOCK), ANTES de cualquier
 *     INSERT/UPDATE; se evita cualquier condicion de carrera.
 *   - Solo escribe dbo.organizations (si falta CMUCE) y la columna
 *     organization_id de departments/users. NO toca password_hash, role_id,
 *     permisos, roles ni sesiones.
 *   - NO usa DROP/TRUNCATE/DELETE, NO deshabilita restricciones, NO altera el
 *     esquema, NO usa NOCHECK.
 *   - Idempotente: si CMUCE ya existe se reutiliza por code (validando nombre y
 *     active); si los registros ya estan asignados, los UPDATE afectan 0 filas.
 *
 * ORDEN SEGURO DE LOS UPDATE (clave por la FK compuesta)
 *   La FK FK_users_department_same_org exige que (users.organization_id,
 *   users.department_id) exista en departments(organization_id, id).
 *   Por eso se actualiza PRIMERO departments y DESPUES users:
 *     - Al asignar departments, el usuario 4 aun tiene organization_id = NULL, y
 *       una fila con NULL en cualquier columna de la FK esta exenta (MATCH SIMPLE).
 *     - Al asignar despues users, el departamento 68 ya esta en CMUCE, de modo que
 *       (CMUCE, 68) existe en departments y la FK se satisface.
 *   El orden inverso (users antes que departments) violaria la FK. Es obligatorio.
 *
 * ATOMICIDAD
 *   - Toda la operacion (validacion + escritura + verificacion) ocurre dentro de
 *     una unica transaccion con TRY/CATCH y XACT_ABORT ON.
 *   - Cualquier RAISERROR de validacion salta al CATCH, que ejecuta ROLLBACK: no
 *     queda ni la organizacion ni las asignaciones.
 *   - sp_getapplock con @LockOwner = 'Transaction' libera el bloqueo de aplicacion
 *     al terminar la transaccion (COMMIT o ROLLBACK).
 *
 * COMPORTAMIENTO EN UNA SEGUNDA EJECUCION (idempotencia)
 *   - CMUCE se reutiliza (no se inserta de nuevo) y se valida su nombre/active.
 *   - departments y users ya asignados -> UPDATE ... WHERE organization_id IS NULL
 *     afecta 0 filas.
 *   - No se duplican organizaciones ni registros y no se altera ningun dato
 *     innecesariamente.
 *
 * NO REVERSION AUTOMATICA POST-COMMIT
 *   - Antes del COMMIT: TRY/CATCH + XACT_ABORT revierte todo.
 *   - Despues del COMMIT: la transaccion ya quedo confirmada. NO se recomienda
 *     restaurar automaticamente el respaldo. El respaldo verificado es una red de
 *     seguridad PREVIA, no un rollback automatico. Ante cualquier resultado
 *     inesperado post-COMMIT: DETENER, documentar y escalar al auditor para
 *     decidir de forma explicita. Cualquier reversion manual seria una operacion
 *     separada, autorizada y planificada.
 *
 * AUTORIZACION EXPLICITA
 *   El script NO hace nada salvo que @AuthorizeBackfill = 1 Y @BackupVerified = 1.
 *
 * NO EJECUTAR hasta la ventana autorizada.
 * ============================================================================ */

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_WARNINGS ON;

/* ---------------------------------------------------------------------------
 * PARAMETROS E INTERRUPTORES
 * ------------------------------------------------------------------------- */
DECLARE @AuthorizeBackfill BIT = 0;   /* PONER EN 1 para autorizar la ejecucion. */
DECLARE @BackupVerified   BIT = 0;    /* PONER EN 1 tras crear y VERIFICAR el respaldo. */

DECLARE @LegacyOrganizationCode NVARCHAR(50)  = N'CMUCE';
DECLARE @LegacyOrganizationName NVARCHAR(200) = N'Centro M' + NCHAR(233) + N'dico UCE';
DECLARE @AuthorizedUserId       INT = 4;      /* unica cuenta autorizada a asignar */
DECLARE @ExpectedRoleId         INT = 7;      /* rol esperado del usuario autorizado */
DECLARE @ExpectedRoleCode       NVARCHAR(100) = N'ADMIN';
DECLARE @ExpectedUserDepartmentId INT = 68;   /* departamento esperado del usuario */
DECLARE @ExpectedDepartments    INT = 25;     /* departamentos heredados esperados */
DECLARE @ExpectedUsers          INT = 1;      /* usuarios heredados esperados */

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
 * 1. Autorizacion explicita
 * ------------------------------------------------------------------------- */
IF @AuthorizeBackfill = 0 OR @BackupVerified = 0
BEGIN
    PRINT N'';
    PRINT N'*** NO AUTORIZADO: el grupo C no se ejecuta. ***';
    PRINT N'*** Para autorizar: @AuthorizeBackfill = 1 Y @BackupVerified = 1 (respaldo creado y VERIFICADO). ***';
    PRINT N'';
    RETURN;
END;

PRINT N'Autorizacion explicita recibida: @AuthorizeBackfill=1, @BackupVerified=1.';

/* ---------------------------------------------------------------------------
 * 2. Prechequeos estructurales (SIN escribir)
 *    2a. Existencia de tablas y columnas.
 *    2b. FK criticas validadas por su DEFINICION real (no solo por nombre).
 * ------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL
   OR OBJECT_ID(N'dbo.departments', N'U') IS NULL
   OR OBJECT_ID(N'dbo.users', N'U') IS NULL
   OR OBJECT_ID(N'dbo.roles', N'U') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: faltan tablas base (organizations/departments/users/roles). Ejecute y verifique el grupo B antes.', 16, 1);
    RETURN;
END;

IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
   OR COL_LENGTH(N'dbo.departments', N'id') IS NULL
   OR COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
   OR COL_LENGTH(N'dbo.users', N'department_id') IS NULL
   OR COL_LENGTH(N'dbo.users', N'role_id') IS NULL
BEGIN
    RAISERROR(N'ABORTADO: faltan columnas requeridas (organization_id/department_id/role_id/id). Ejecute el grupo B antes.', 16, 1);
    RETURN;
END;

/* 2b. Definicion real esperada de cada FK critica: (fk, padre, referenciada,
 *     columna padre, columna referenciada, ordinal, accion ON DELETE, accion
 *     ON UPDATE). Se valida:
 *       - que la pareja de columnas exacta exista (por ordinal),
 *       - tabla padre y referenciada correctas,
 *       - la accion referencial exacta por FK (codigos sys.foreign_keys:
 *         0 = NO_ACTION, 1 = CASCADE, 2 = SET_NULL, 3 = SET_DEFAULT),
 *       - habilitada (is_disabled = 0) y confiable (is_not_trusted = 0),
 *       - numero de columnas de la FK igual al esperado (sin columnas extra).
 *     Nota: FK_users_department usa ON DELETE SET_NULL (2); el resto NO ACTION (0). */
DECLARE @fk_expected TABLE
(
    fk           SYSNAME,
    parent_table SYSNAME,
    ref_table    SYSNAME,
    parent_col   SYSNAME,
    ref_col      SYSNAME,
    ord          INT,
    del_action   INT,
    upd_action   INT
);

INSERT INTO @fk_expected (fk, parent_table, ref_table, parent_col, ref_col, ord, del_action, upd_action)
VALUES
    (N'FK_departments_organization',  N'departments', N'organizations', N'organization_id', N'id',              1, 0, 0),
    (N'FK_users_organization',        N'users',       N'organizations', N'organization_id', N'id',              1, 0, 0),
    (N'FK_users_role',                N'users',       N'roles',         N'role_id',         N'id',              1, 0, 0),
    (N'FK_users_department_same_org', N'users',       N'departments',   N'organization_id', N'organization_id', 1, 0, 0),
    (N'FK_users_department_same_org', N'users',       N'departments',   N'department_id',   N'id',              2, 0, 0),
    (N'FK_users_department',          N'users',       N'departments',   N'department_id',   N'id',              1, 2, 0);

DECLARE @fk_pair_problems INT;
DECLARE @fk_colcount_problems INT;
DECLARE @fk_problems INT;

/* 2b-i. Cada pareja de columnas esperada debe existir con el estado correcto. */
SELECT @fk_pair_problems = COUNT(*)
FROM @fk_expected AS e
WHERE NOT EXISTS
(
    SELECT 1
    FROM sys.foreign_keys AS fk
    JOIN sys.objects AS pt ON pt.object_id = fk.parent_object_id
    JOIN sys.objects AS rt ON rt.object_id = fk.referenced_object_id
    JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
    WHERE fk.name = e.fk
      AND fk.is_disabled = 0
      AND fk.is_not_trusted = 0
      AND fk.delete_referential_action = e.del_action
      AND fk.update_referential_action = e.upd_action
      AND SCHEMA_NAME(pt.schema_id) = N'dbo'
      AND SCHEMA_NAME(rt.schema_id) = N'dbo'
      AND pt.name = e.parent_table
      AND rt.name = e.ref_table
      AND fkc.constraint_column_id = e.ord
      AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = e.parent_col
      AND COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) = e.ref_col
);

/* 2b-ii. Cada FK debe tener exactamente el numero de columnas esperado. */
SELECT @fk_colcount_problems = COUNT(*)
FROM
(
    SELECT e.fk, COUNT(*) AS columnas_esperadas
    FROM @fk_expected AS e
    GROUP BY e.fk
) AS g
WHERE NOT EXISTS
(
    SELECT 1
    FROM sys.foreign_keys AS fk
    JOIN sys.objects AS pt ON pt.object_id = fk.parent_object_id
    JOIN sys.objects AS rt ON rt.object_id = fk.referenced_object_id
    WHERE fk.name = g.fk
      AND SCHEMA_NAME(pt.schema_id) = N'dbo'
      AND SCHEMA_NAME(rt.schema_id) = N'dbo'
      AND (SELECT COUNT(*) FROM sys.foreign_key_columns AS fkc WHERE fkc.constraint_object_id = fk.object_id) = g.columnas_esperadas
);

SET @fk_problems = @fk_pair_problems + @fk_colcount_problems;

/* Reporte visual del estado por FK. */
SELECT v.fk AS fk_critica,
       CASE WHEN fk.object_id IS NULL THEN N'FALTA'
            WHEN fk.is_disabled = 1 THEN N'DESHABILITADA'
            WHEN fk.is_not_trusted = 1 THEN N'NO CONFIABLE'
            ELSE N'PRESENTE' END AS estado_nombre,
       (SELECT COUNT(*) FROM sys.foreign_key_columns AS fkc WHERE fkc.constraint_object_id = fk.object_id) AS columnas_actuales,
       v.columnas_esperadas
FROM (SELECT DISTINCT fk, COUNT(*) OVER (PARTITION BY fk) AS columnas_esperadas FROM @fk_expected) AS v
LEFT JOIN sys.foreign_keys AS fk ON fk.name = v.fk
ORDER BY v.fk;

IF @fk_problems > 0
BEGIN
    RAISERROR(N'ABORTADO: la definicion real de alguna FK critica no coincide (parejas/columnas/tablas/estado). Revise en especial FK_users_department_same_org. Ejecute y verifique el grupo B antes. No se modifica nada.', 16, 1);
    RETURN;
END;

PRINT N'[2] OK: tablas, columnas y FK criticas validadas POR DEFINICION real (habilitadas y confiables).';

/* ---------------------------------------------------------------------------
 * 3. Pre-chequeo informativo de datos (SIN escribir; no autoritativo)
 *    Se repite de forma autoritativa DENTRO de la transaccion (seccion 4).
 * ------------------------------------------------------------------------- */
DECLARE @users_total INT;
DECLARE @depts_total INT;
DECLARE @dup_names   INT;
DECLARE @role_id   INT = -1;
DECLARE @role_code NVARCHAR(100) = NULL;
DECLARE @role_name NVARCHAR(150) = NULL;
DECLARE @user4_dept INT = NULL;
DECLARE @user4_role_id INT = NULL;
DECLARE @sql NVARCHAR(MAX);
DECLARE @n BIGINT;

SELECT @users_total = COUNT(*) FROM dbo.users;
SELECT @depts_total = COUNT(*) FROM dbo.departments;

PRINT N'[3] Usuarios totales: ' + CAST(@users_total AS NVARCHAR(10)) + N' (esperado ' + CAST(@ExpectedUsers AS NVARCHAR(10)) + N').';
PRINT N'[3] Departamentos totales: ' + CAST(@depts_total AS NVARCHAR(10)) + N' (esperado ' + CAST(@ExpectedDepartments AS NVARCHAR(10)) + N').';

IF @users_total <> @ExpectedUsers
BEGIN
    RAISERROR(N'ABORTADO: usuarios totales = %d; el grupo C solo autoriza el escenario de %d usuario. Revisar el estado real.', 16, 1, @users_total, @ExpectedUsers);
    RETURN;
END;

IF @depts_total <> @ExpectedDepartments
BEGIN
    RAISERROR(N'ABORTADO: departamentos totales = %d; el grupo C espera %d. Revisar el estado real.', 16, 1, @depts_total, @ExpectedDepartments);
    RETURN;
END;

/* La UQ UQ_departments_organization_name (organization_id, name) exige nombres de
 * departamento unicos: al pasar todos a la misma organizacion se validaria. */
SELECT @dup_names = COUNT(*) FROM (
    SELECT name FROM dbo.departments GROUP BY name HAVING COUNT(*) > 1
) AS d;

IF @dup_names > 0
BEGIN
    RAISERROR(N'ABORTADO: hay %d nombres de departamento duplicados; al asignarlos a la misma organizacion se violaria UQ_departments_organization_name. Resolver antes.', 16, 1, @dup_names);
    RETURN;
END;

/* El usuario autorizado debe existir y cumplir EXACTAMENTE id/role_id/ADMIN/department_id. */
IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE id = @AuthorizedUserId)
BEGIN
    RAISERROR(N'ABORTADO: no existe el usuario autorizado id = %d.', 16, 1, @AuthorizedUserId);
    RETURN;
END;

SELECT @role_id      = r.id,
       @role_code    = r.code,
       @role_name    = r.name,
       @user4_dept   = u.department_id,
       @user4_role_id = u.role_id
FROM dbo.users AS u
LEFT JOIN dbo.roles AS r ON r.id = u.role_id
WHERE u.id = @AuthorizedUserId;

PRINT N'[3] Usuario autorizado id=' + CAST(@AuthorizedUserId AS NVARCHAR(10))
    + N' rol_id=' + ISNULL(CAST(@user4_role_id AS NVARCHAR(10)), N'NULL')
    + N' rol_code=' + ISNULL(@role_code, N'(sin rol)')
    + N' rol_nombre=' + ISNULL(@role_name, N'(sin rol)')
    + N' department_id=' + ISNULL(CAST(@user4_dept AS NVARCHAR(10)), N'NULL') + N'.';

IF @role_id IS NULL
BEGIN
    RAISERROR(N'ABORTADO: el usuario %d no tiene un rol valido; no se asigna.', 16, 1, @AuthorizedUserId);
    RETURN;
END;

IF ISNULL(@user4_role_id, -1) <> @ExpectedRoleId
   OR UPPER(ISNULL(@role_code, N'')) <> @ExpectedRoleCode
   OR ISNULL(@user4_dept, -1) <> @ExpectedUserDepartmentId
BEGIN
    RAISERROR(N'ABORTADO: el usuario autorizado no cumple exactamente id=4 / role_id=7 / ADMIN / department_id=68. No se asigna.', 16, 1);
    RETURN;
END;

PRINT N'[3] OK: usuario autorizado coincide con id=4 / role_id=7 / ADMIN / department_id=68.';

/* ---------------------------------------------------------------------------
 * 4. TRANSACCION UNICA: revalidacion autoritativa + CMUCE + asignaciones + chequeos
 *    Todos los datos criticos se revalidan DENTRO de la transaccion con bloqueos
 *    (UPDLOCK/HOLDLOCK) ANTES de cualquier INSERT/UPDATE. Cualquier fallo -> ROLLBACK.
 * ------------------------------------------------------------------------- */
DECLARE @org_id INT = NULL;
DECLARE @org_name NVARCHAR(200) = NULL;
DECLARE @org_active BIT = NULL;
DECLARE @org_created BIT = 0;
DECLARE @org_other INT = -1;

DECLARE @rc_applock INT;
DECLARE @u_total BIGINT = -1;
DECLARE @u4_id INT = NULL;
DECLARE @u4_role_id INT = NULL;
DECLARE @u4_role_code NVARCHAR(100) = NULL;
DECLARE @u4_org INT = NULL;
DECLARE @u4_dept INT = NULL;
DECLARE @d_total BIGINT = -1;
DECLARE @dup_names_tx INT = -1;
DECLARE @d_foreign BIGINT = -1;
DECLARE @u_foreign BIGINT = -1;
DECLARE @d_null BIGINT = -1;
DECLARE @u_null_other BIGINT = -1;
DECLARE @d_null_after BIGINT = -1;
DECLARE @d_assigned_after BIGINT = -1;
DECLARE @u_null_after BIGINT = -1;
DECLARE @u_assigned_after BIGINT = -1;
DECLARE @orfanos_tx BIGINT = -1;
DECLARE @rc_dep BIGINT = 0;
DECLARE @rc_usr BIGINT = 0;

BEGIN TRY
    BEGIN TRANSACTION;

    /* 4.1 Serializa el grupo C contra ejecuciones concurrentes. */
    EXEC @rc_applock = sys.sp_getapplock
         @Resource = N'SIFHA_Tickets_DEV:GroupC:CMUCE',
         @LockMode = N'Exclusive',
         @LockOwner = N'Transaction',
         @LockTimeout = 0;

    IF @rc_applock < 0
        RAISERROR(N'ABORTADO (grupo C): no se pudo adquirir el bloqueo de aplicacion (rc=%d). Otra ejecucion en curso.', 16, 1, @rc_applock);

    /* 4.2 Resolver CMUCE por code CON BLOQUEO (sin escribir aun). */
    SELECT @org_id = id, @org_name = name, @org_active = active
    FROM dbo.organizations WITH (UPDLOCK, HOLDLOCK)
    WHERE code = @LegacyOrganizationCode;

    /* 4.3 Revalidacion autoritativa de USUARIOS (bloqueada) ANTES de escribir. */
    SELECT @u_total = COUNT_BIG(*) FROM dbo.users WITH (UPDLOCK, HOLDLOCK);
    IF @u_total <> @ExpectedUsers
        RAISERROR(N'ABORTADO (grupo C): usuarios totales = %I64d; se esperaba %d. No se modifica nada.', 16, 1, @u_total, @ExpectedUsers);

    SELECT @u4_id        = u.id,
           @u4_role_id   = u.role_id,
           @u4_role_code = r.code,
           @u4_org       = u.organization_id,
           @u4_dept      = u.department_id
    FROM dbo.users AS u WITH (UPDLOCK, HOLDLOCK)
    LEFT JOIN dbo.roles AS r WITH (UPDLOCK, HOLDLOCK) ON r.id = u.role_id
    WHERE u.id = @AuthorizedUserId;

    IF @u4_id IS NULL
        RAISERROR(N'ABORTADO (grupo C): no existe el usuario autorizado id = %d. No se modifica nada.', 16, 1, @AuthorizedUserId);

    IF ISNULL(@u4_role_id, -1) <> @ExpectedRoleId
       OR UPPER(ISNULL(@u4_role_code, N'')) <> @ExpectedRoleCode
       OR ISNULL(@u4_dept, -1) <> @ExpectedUserDepartmentId
    BEGIN
        PRINT N'[4.3] Usuario id=' + CAST(@AuthorizedUserId AS NVARCHAR(10))
            + N' encontrado: role_id=' + ISNULL(CAST(@u4_role_id AS NVARCHAR(20)), N'NULL')
            + N' code=' + ISNULL(@u4_role_code, N'NULL')
            + N' department_id=' + ISNULL(CAST(@u4_dept AS NVARCHAR(20)), N'NULL') + N'.';
        RAISERROR(N'ABORTADO (grupo C): el usuario autorizado no coincide con id=4 / role_id=7 / ADMIN / department_id=68. No se modifica nada.', 16, 1);
    END;

    /* El usuario autorizado no puede pertenecer a otra organizacion (si ya esta
     * en CMUCE, es un re-run idempotente). */
    IF @u4_org IS NOT NULL AND @u4_org <> ISNULL(@org_id, -1)
        RAISERROR(N'ABORTADO (grupo C): el usuario id=%d ya pertenece a otra organizacion (id=%d). No se modifica nada.', 16, 1, @AuthorizedUserId, @u4_org);

    /* 4.4 Revalidacion autoritativa de DEPARTAMENTOS (bloqueada). */
    SELECT @d_total = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK);
    IF @d_total <> @ExpectedDepartments
        RAISERROR(N'ABORTADO (grupo C): departamentos totales = %I64d; se esperaban %d. No se modifica nada.', 16, 1, @d_total, @ExpectedDepartments);

    SELECT @dup_names_tx = COUNT(*)
    FROM (
        SELECT name FROM dbo.departments WITH (UPDLOCK, HOLDLOCK)
        GROUP BY name HAVING COUNT(*) > 1
    ) AS d;

    IF @dup_names_tx > 0
        RAISERROR(N'ABORTADO (grupo C): %d nombres de departamento duplicados; UQ_departments_organization_name impediria la asignacion. No se modifica nada.', 16, 1, @dup_names_tx);

    /* 4.5 Unica organizacion permitida (CMUCE). Cualquier otra -> aborto. */
    SELECT @org_other = COUNT(*) FROM dbo.organizations WITH (UPDLOCK, HOLDLOCK) WHERE code IS NULL OR code <> @LegacyOrganizationCode;
    IF @org_other > 0
        RAISERROR(N'ABORTADO (grupo C): existen %d organizaciones distintas de CMUCE; el estado esperado es una unica organizacion. No se modifica nada.', 16, 1, @org_other);

    /* 4.6 Ningun registro puede pertenecer a otra organizacion (ANTES de escribir). */
    IF @org_id IS NULL
    BEGIN
        /* CMUCE no existe: cualquier organization_id NO nulo es de otra organizacion. */
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NOT NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_foreign OUTPUT;
        IF @d_foreign > 0
            RAISERROR(N'ABORTADO (grupo C): %I64d departments ya pertenecen a una organizacion distinta de CMUCE. No se modifica nada.', 16, 1, @d_foreign);

        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NOT NULL;';
        EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_foreign OUTPUT;
        IF @u_foreign > 0
            RAISERROR(N'ABORTADO (grupo C): %I64d users ya pertenecen a una organizacion distinta de CMUCE. No se modifica nada.', 16, 1, @u_foreign);
    END
    ELSE
    BEGIN
        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NOT NULL AND organization_id <> @oid;';
        EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @d_foreign OUTPUT;
        IF @d_foreign > 0
            RAISERROR(N'ABORTADO (grupo C): %I64d departments ya pertenecen a otra organizacion distinta de CMUCE. No se modifica nada.', 16, 1, @d_foreign);

        SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NOT NULL AND organization_id <> @oid;';
        EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @u_foreign OUTPUT;
        IF @u_foreign > 0
            RAISERROR(N'ABORTADO (grupo C): %I64d users ya pertenecen a otra organizacion distinta de CMUCE. No se modifica nada.', 16, 1, @u_foreign);
    END

    /* 4.7 Si CMUCE ya existe, su nombre y estado deben coincidir (no se corrige). */
    IF @org_id IS NOT NULL
    BEGIN
        IF @org_name IS NULL OR @org_name <> @LegacyOrganizationName COLLATE Latin1_General_BIN2 OR ISNULL(@org_active, CONVERT(BIT, 0)) <> CONVERT(BIT, 1)
        BEGIN
            PRINT N'[4.7] CMUCE existente con name=' + ISNULL(@org_name, N'NULL')
                + N' active=' + ISNULL(CAST(@org_active AS NVARCHAR(10)), N'NULL') + N'.';
            RAISERROR(N'ABORTADO (grupo C): CMUCE existe pero su nombre/estado no coinciden con "Centro Medico UCE" y active=1. No se corrige automaticamente.', 16, 1);
        END;
    END;

    /* 4.8 PRIMERA ESCRITURA: crear CMUCE si falta. */
    IF @org_id IS NULL
    BEGIN
        INSERT INTO dbo.organizations (code, name, active, created_at)
        VALUES (@LegacyOrganizationCode, @LegacyOrganizationName, 1, SYSUTCDATETIME());
        SET @org_id = CONVERT(INT, SCOPE_IDENTITY());
        SET @org_created = 1;
        PRINT N'[4] CMUCE creada con id ' + CAST(@org_id AS NVARCHAR(20)) + N'.';
    END
    ELSE
        PRINT N'[4] CMUCE reutilizada (id ' + CAST(@org_id AS NVARCHAR(20)) + N').';

    /* 4.9 ORDEN OBLIGATORIO: PRIMERO departments. */
    SET @sql = N'UPDATE dbo.departments SET organization_id = @oid WHERE organization_id IS NULL;
                 SELECT @rc = @@ROWCOUNT;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @rc BIGINT OUTPUT', @oid = @org_id, @rc = @rc_dep OUTPUT;
    PRINT N'[4] departments asignados a CMUCE = ' + CAST(@rc_dep AS NVARCHAR(20)) + N'.';

    /* Ningun otro usuario NULL (no autorizado). */
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE organization_id IS NULL AND id <> @uid;';
    EXEC sys.sp_executesql @sql, N'@uid INT, @n BIGINT OUTPUT', @uid = @AuthorizedUserId, @n = @u_null_other OUTPUT;
    IF @u_null_other > 0
        RAISERROR(N'ABORTADO (grupo C): hay %I64d usuarios sin organizacion distintos del autorizado (id %d). El grupo C solo autoriza ese usuario.', 16, 1, @u_null_other, @AuthorizedUserId);

    /* 4.10 DESPUES: el usuario autorizado. */
    SET @sql = N'UPDATE dbo.users SET organization_id = @oid WHERE id = @uid AND organization_id IS NULL;
                 SELECT @rc = @@ROWCOUNT;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @uid INT, @rc BIGINT OUTPUT', @oid = @org_id, @uid = @AuthorizedUserId, @rc = @rc_usr OUTPUT;
    PRINT N'[4] users asignados a CMUCE = ' + CAST(@rc_usr AS NVARCHAR(20)) + N' (solo id ' + CAST(@AuthorizedUserId AS NVARCHAR(10)) + N'; password_hash, role_id y permisos NO se tocaron).';

    /* 4.11 Chequeos de integridad/conteo DENTRO de la transaccion, ANTES del COMMIT. */
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null_after OUTPUT;
    IF @d_null_after > 0
        RAISERROR(N'ABORTADO (grupo C): quedan %I64d departments sin organization_id. Se revierte todo.', 16, 1, @d_null_after);

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id = @oid;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @d_assigned_after OUTPUT;
    IF @d_assigned_after <> @ExpectedDepartments
        RAISERROR(N'ABORTADO (grupo C): departments asignados = %I64d; se esperaban %d. Se revierte todo.', 16, 1, @d_assigned_after, @ExpectedDepartments);

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_null_after OUTPUT;
    IF @u_null_after > 0
        RAISERROR(N'ABORTADO (grupo C): quedan %I64d users sin organization_id. Se revierte todo.', 16, 1, @u_null_after);

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id = @oid;';
    EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @u_assigned_after OUTPUT;
    IF @u_assigned_after <> @ExpectedUsers
        RAISERROR(N'ABORTADO (grupo C): users asignados = %I64d; se esperaba %d. Se revierte todo.', 16, 1, @u_assigned_after, @ExpectedUsers);

    /* 4.12 Huerfanos de integridad referencial (deben ser 0) ANTES del COMMIT. */
    SET @orfanos_tx = 0;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
                 LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
                 WHERE d.organization_id IS NULL OR o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos_tx = @orfanos_tx + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
                 WHERE u.organization_id IS NULL OR o.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos_tx = @orfanos_tx + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.roles AS r ON r.id = u.role_id
                 WHERE r.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos_tx = @orfanos_tx + @n;

    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
                 LEFT JOIN dbo.departments AS d ON d.id = u.department_id AND d.organization_id = u.organization_id
                 WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
    SET @orfanos_tx = @orfanos_tx + @n;

    IF @orfanos_tx > 0
        RAISERROR(N'ABORTADO (grupo C): %I64d huerfanos de integridad referencial. Se revierte todo.', 16, 1, @orfanos_tx);

    COMMIT TRANSACTION;
    PRINT N'[4] COMMIT. CMUCE + asignaciones confirmados (todas las comprobaciones pasaron antes del COMMIT).';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    PRINT N'ERROR/ABORTADO en grupo C (CMUCE + backfill). Se revirtio TODO (organizacion y datos).';
    THROW;
END CATCH;

/* ---------------------------------------------------------------------------
 * 5. Validacion posterior (SIN escribir)
 * ------------------------------------------------------------------------- */
DECLARE @cmuce_count INT = -1;
DECLARE @assigned_depts BIGINT = -1;
DECLARE @assigned_users BIGINT = -1;
DECLARE @u_null BIGINT = -1;
DECLARE @orfanos BIGINT = 0;

SELECT @cmuce_count = ISNULL(SUM(CASE WHEN code = N'CMUCE' THEN 1 ELSE 0 END), 0)
FROM dbo.organizations;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id = @oid;';
EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @assigned_depts OUTPUT;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id = @oid;';
EXEC sys.sp_executesql @sql, N'@oid INT, @n BIGINT OUTPUT', @oid = @org_id, @n = @assigned_users OUTPUT;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_null OUTPUT;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_null OUTPUT;

/* Huerfanos: departments sin org valida + users sin org valida + users sin rol + same-org. */
SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments AS d
             LEFT JOIN dbo.organizations AS o ON o.id = d.organization_id
             WHERE d.organization_id IS NULL OR o.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.organizations AS o ON o.id = u.organization_id
             WHERE u.organization_id IS NULL OR o.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.roles AS r ON r.id = u.role_id
             WHERE r.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users AS u
             LEFT JOIN dbo.departments AS d ON d.id = u.department_id AND d.organization_id = u.organization_id
             WHERE u.organization_id IS NOT NULL AND u.department_id IS NOT NULL AND d.id IS NULL;';
EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @n OUTPUT;
SET @orfanos = @orfanos + @n;

PRINT N'[5] CMUCE (code) filas: ' + CAST(@cmuce_count AS NVARCHAR(10)) + N' (esperado 1).';
PRINT N'[5] departments asignados a CMUCE: ' + CAST(@assigned_depts AS NVARCHAR(20)) + N' (esperado 25).';
PRINT N'[5] users asignados a CMUCE: ' + CAST(@assigned_users AS NVARCHAR(20)) + N' (esperado 1).';
PRINT N'[5] organization_id NULL: ' + CAST(@d_null AS NVARCHAR(20)) + N' departments, ' + CAST(@u_null AS NVARCHAR(20)) + N' users (esperado 0/0).';
PRINT N'[5] Huerfanos de integridad: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0).';

/* ---------------------------------------------------------------------------
 * 6. Resumen automatico GO / NO-GO (del propio grupo C)
 * ------------------------------------------------------------------------- */
PRINT N'';
PRINT N'=== RESUMEN GRUPO C (backfill CMUCE) ===';
PRINT N'  CMUCE creada en esta ejecucion: ' + CASE WHEN @org_created = 1 THEN N'SI' ELSE N'NO (reutilizada)' END;
PRINT N'  CMUCE filas por code: ' + CAST(@cmuce_count AS NVARCHAR(10)) + N' (esperado 1)';
PRINT N'  departments asignados: ' + CAST(@assigned_depts AS NVARCHAR(20)) + N'/' + CAST(@ExpectedDepartments AS NVARCHAR(10));
PRINT N'  users asignados: ' + CAST(@assigned_users AS NVARCHAR(20)) + N'/' + CAST(@ExpectedUsers AS NVARCHAR(10));
PRINT N'  NULL organization_id: ' + CAST(@d_null AS NVARCHAR(20)) + N' departments, ' + CAST(@u_null AS NVARCHAR(20)) + N' users (esperado 0/0)';
PRINT N'  Huerfanos: ' + CAST(@orfanos AS NVARCHAR(20)) + N' (esperado 0)';
IF @cmuce_count = 1
   AND @assigned_depts = @ExpectedDepartments
   AND @assigned_users = @ExpectedUsers
   AND @d_null = 0
   AND @u_null = 0
   AND @orfanos = 0
    PRINT N'GRUPO C: GO - CMUCE + asignaciones aplicadas. Ejecute verify-after-groupC.sql para el veredicto formal.';
ELSE
    PRINT N'GRUPO C: NO-GO (post-COMMIT) - DETENER, documentar y escalar al auditor; NO restaurar el respaldo automaticamente.';
PRINT N'';
