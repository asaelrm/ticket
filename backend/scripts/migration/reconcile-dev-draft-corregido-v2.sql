/* ============================================================================
 * SIFHA - BORRADOR de reconciliacion de esquema para SIFHA_Tickets_DEV
 *         EXCLUSIVO de la instancia SIFHADEV / base SIFHA_Tickets_DEV
 * ============================================================================
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !!  NO EJECUTAR TODAVIA.                                                  !!
 * !!  Es un BORRADOR para revision. Por diseno esta APAGADO por defecto:    !!
 * !!  sin @AuthorizeDdl = 1 no escribe absolutamente nada. Las fases de     !!
 * !!  datos (@AuthorizeBackfill) y de endurecimiento (@MakeDepartmentsNotNull)
 * !!  tienen su propio interruptor y exigen decisiones humanas del plan     !!
 * !!  docs/PLAN-RECONCILIACION-DEV.md.                                      !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * Antes de ejecutar (cuando se autorice):
 *   1. Ejecutar reconcile-dev-inventory.sql y revisar el diff real.
 *   2. Cerrar las decisiones humanas pendientes del plan
 *   3. Tomar y VERIFICAR el respaldo de la base.
 *   4. Recien entonces activar los interruptores de la seccion "Parametros".
 *
 * Que hace (por fases, en orden de dependencias de FK)
 *   Fase 1  crea dbo.organizations (vacia).
 *   Fase 2  anade organization_id a dbo.users y dbo.departments (NULL por ahora)
 *           y cualquier columna faltante detectada por el inventario.
 *   Fase 2b CORRIGE las 9 diferencias de LONGITUD NVARCHAR detectadas por el
 *           inventario. Solo ajusta longitud; conserva tipo/nulabilidad.
 *           Las reducciones (roles.name 200->150, users.position 255->200) exigen
 *           MAX(LEN) <= objetivo y se listan los indices afectados (fase 2b).
 *   Fase 3  anade las unicidades compuestas que exigen las FK del esquema
 *           (org_id, id / org_id, name) y las unicidades de codigo/nombre de
 *           tablas existentes (username, email, roles.code, permissions.code).
 *   Fase 4  crea las 17 tablas faltantes (categories, teams, team_members, tickets,
 *           canned_responses, ticket_comments, ticket_attachments, ticket_history,
 *           sequences, settings, org_settings, email_logs, notifications,
 *           kb_categories, kb_articles, kb_ticket_articles, kb_article_history).
 *   Fase 5  anade las FK de users/departments al esquema canonico.
 *   Fase 6  crea los indices IX_* que exige schema.sql.
 *   Fase 7  (GATE) backfill de organization_id. Organizacion CONFIRMADA por el
 *           equipo: code CMUCE / "Centro Medico UCE". NUNCA se inventa el id:
 *           se resuelve por code (o se crea con ese code/name). Incluye un
 *           pre-chequeo SOLO-LECTURA del rol real de la cuenta (CONFIRMADO:
 *           ADMIN, de organizacion) para no suponer nada, y solo actualiza
 *           organization_id (nunca password_hash, role_id ni role_permissions).
 *   Fase 8  (GATE) departments.organization_id a NOT NULL solo si quedan 0 NULL.
 *   Verificacion posterior: 24 tablas presentes + 96 registros conservados
 *           (roles 3, permissions 24, role_permissions 41, users 1,
 *           departments 25, sessions 2) + longitudes aplicadas.
 *
 * Que NO hace
 *   - No crea ni borra la base. No restaura instantaneas.
 *   - No copia datos de SQLite, de la base de integracion ni de ningun dump.
 *   - No contiene contrasenas ni cadenas de conexion.
 *   - No inventa organization_id ni toca usuarios sin autorizacion explicita.
 *
 * Plan de reversion
 *   - fases 1-6/2b corren en una sola transaccion (XACT_ABORT ON + TRY/CATCH): si
 *     algo falla, ROLLBACK deja la base como estaba.
 *   - Red de seguridad principal tras el commit: RESTAURAR el respaldo previo.
 *   - La seccion final "REVERSION MANUAL" lista los DROP inversos, en orden
 *     inverso a la creacion. Usarla solo si no se puede restaurar el .bak.
 * ========================================================================== */

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ---------------------------------------------------------------------------
 * PARAMETROS E INTERRUPTORES (por defecto todo apagado)
 * ------------------------------------------------------------------------- */

/* Interruptor maestro del DDL ADITIVO (fases 1-6 y 2b). 0 = solo simula/imprime. */
DECLARE @AuthorizeDdl BIT = 0;

/* El humano confirma que tomo y VERIFICO el respaldo previo. */
DECLARE @BackupVerified BIT = 0;

/* Fase 7: backfill de organization_id. Exige autorizacion + code real.
 * Organizacion inicial CONFIRMADA por el equipo: Centro Medico UCE (CMUCE).
 * Los 25 departamentos y la cuenta de usuario existente pertenecen a ella.
 * El id NO se inventa: en fase 7 se resuelve por @LegacyOrganizationCode (o se
 * crea la organizacion con este code/name). */
DECLARE @AuthorizeBackfill BIT = 0;
DECLARE @LegacyOrganizationCode NVARCHAR(50) = N'CMUCE';
DECLARE @LegacyOrganizationName NVARCHAR(200) = N'Centro M' + NCHAR(233) + N'dico UCE';
DECLARE @BackfillDepartments BIT = 0;  -- decision CONFIRMADA (25 deptos -> CMUCE). Activar al autorizar.
DECLARE @BackfillUsers BIT = 0;        -- decision CONFIRMADA: la cuenta tiene rol ADMIN (de organizacion),
                                       -- no SUPERADMIN global, asi que se asocia a CMUCE. Aun asi el
                                       -- pre-chequeo de la fase 7 imprime el rol real (no se asume).

/* Fase 8: departments.organization_id a NOT NULL (solo si 0 NULL). */
DECLARE @MakeDepartmentsNotNull BIT = 0;

/* Variable reutilizada para SQL dinamico (solo lectura / DDL dentro de gates). */
DECLARE @sql NVARCHAR(MAX);

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
 * 0b. Comprobacion de respaldo previo.
 *     No se puede demostrar desde T-SQL que exista un .bak reciente, asi que se
 *     EXIGE la confirmacion humana explicita antes de cualquier DDL.
 * ------------------------------------------------------------------------- */
IF @AuthorizeDdl = 1 AND @BackupVerified = 0
BEGIN
    RAISERROR(N'ABORTADO: active @BackupVerified = 1 solo despues de crear y VERIFICAR un respaldo (BACKUP + RESTORE VERIFYONLY).', 16, 1);
    RETURN;
END;

IF @AuthorizeDdl = 0
BEGIN
    PRINT N'';
    PRINT N'*** MODO SIMULACION: @AuthorizeDdl = 0. No se ejecuta ningun DDL. ***';
    PRINT N'*** Cambie @AuthorizeDdl = 1 (con respaldo verificado) para aplicar. ***';
    PRINT N'';
END;

/* ===========================================================================
 * DDL ADITIVO (fases 1-6 y 2b) - una sola transaccion
 * ========================================================================= */
IF @AuthorizeDdl = 1
BEGIN
    BEGIN TRY
        BEGIN TRANSACTION;

        /* -------------------------------------------------------------------
         * FASE 1: tabla raiz organizations.
         * ----------------------------------------------------------------- */
        IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.organizations (
              id INT IDENTITY(1,1) NOT NULL,
              code NVARCHAR(50) NOT NULL,
              name NVARCHAR(200) NOT NULL,
              description NVARCHAR(MAX) NULL,
              active BIT NOT NULL CONSTRAINT DF_organizations_active DEFAULT (1),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_organizations_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_organizations PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_organizations_code UNIQUE (code)
            );
            PRINT N'Fase 1: dbo.organizations creada.';
        END
        ELSE PRINT N'Fase 1: dbo.organizations ya existia.';

        /* -------------------------------------------------------------------
         * FASE 2: columnas organizacion/faltantes en tablas existentes.
         *   - users.organization_id es NULL en schema.sql (superadmin global).
         *   - departments.organization_id es NOT NULL en schema.sql; aqui se
         *     anade NULLABLE y se endurece en la fase 8 tras el backfill.
         *   - Si el inventario revelo OTRAS columnas faltantes, agreguelas aqui
         *     antes de continuar (placeholder).
         * ----------------------------------------------------------------- */
        IF COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
        BEGIN
            ALTER TABLE dbo.users ADD organization_id INT NULL;
            PRINT N'Fase 2: dbo.users.organization_id anadida (NULL).';
        END;

        IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
        BEGIN
            ALTER TABLE dbo.departments ADD organization_id INT NULL;
            PRINT N'Fase 2: dbo.departments.organization_id anadida (NULL; NOT NULL en fase 8).';
        END;

        /* Placeholder de decisiones: si faltan columnas de tipo/nulabilidad en
         * users/departments segun el inventario, ALTER TABLE ... ALTER COLUMN. */

        /* -------------------------------------------------------------------
         * FASE 2b: nueve diferencias de LONGITUD (NVARCHAR) del inventario.
         *   - Solo se ajusta la longitud; se conserva el TIPO y la NULABILIDAD
         *     actuales (leidos de sys.columns al momento de ejecutar).
         *   - Las reducciones (roles.name 200->150, users.position 255->200) se
         *     ejecutan SOLO si MAX(LEN) <= objetivo; si hay datos mas largos,
         *     RAISERROR revierte toda la transaccion aditiva.
         *   - Se listan (solo lectura) los indices que referencian esas columnas
         *     antes de alterar; los UNIQUE se recalculan en el ALTER.
         * ----------------------------------------------------------------- */
        DECLARE @corrections TABLE (
            table_name SYSNAME NOT NULL,
            column_name SYSNAME NOT NULL,
            target_chars INT NOT NULL,   -- caracteres (no bytes)
            PRIMARY KEY (table_name, column_name)
        );
        INSERT INTO @corrections (table_name, column_name, target_chars) VALUES
         (N'departments', N'name', 150),
         (N'roles',       N'name', 150),
         (N'users',       N'email', 320),
         (N'users',       N'last_name', 150),
         (N'users',       N'name', 150),
         (N'users',       N'password_hash', 500),
         (N'users',       N'password_reset_token', 500),
         (N'users',       N'position', 200),
         (N'users',       N'username', 150);

        /* Indices que usan las columnas a corregir (informacion, no bloquea). */
        SELECT i.name AS indice, t.name AS tabla, c.name AS columna,
               CASE WHEN i.is_unique = 1 THEN N'UNIQUE' ELSE N'' END AS tipo_indice
        FROM sys.indexes AS i
        JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.tables AS t ON t.object_id = i.object_id
        JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE t.schema_id = SCHEMA_ID(N'dbo')
          AND EXISTS (SELECT 1 FROM @corrections AS k WHERE k.table_name = t.name AND k.column_name = c.name)
        ORDER BY t.name, c.name, i.name;

        /* Pre-chequeo de datos: ninguna fila puede exceder el objetivo. */
        DECLARE @c_tab SYSNAME, @c_col SYSNAME, @c_target INT, @c_sql NVARCHAR(MAX), @c_max_len INT, @c_isnull INT;
        DECLARE c_cur CURSOR LOCAL FAST_FORWARD FOR
            SELECT table_name, column_name, target_chars FROM @corrections ORDER BY table_name, column_name;
        OPEN c_cur;
        FETCH NEXT FROM c_cur INTO @c_tab, @c_col, @c_target;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @c_sql = N'SELECT @m = MAX(LEN(' + QUOTENAME(@c_col) + N')) FROM dbo.' + QUOTENAME(@c_tab) + N';';
            SET @c_max_len = NULL;
            EXEC sys.sp_executesql @c_sql, N'@m INT OUTPUT', @m = @c_max_len OUTPUT;
            IF @c_max_len > @c_target
                RAISERROR(N'ABORTADO (fase 2b): %s.%s tiene datos de hasta %d caracteres; no se reduce a %d. Revise datos u objetivo.', 16, 1, @c_tab, @c_col, @c_max_len, @c_target);
            FETCH NEXT FROM c_cur INTO @c_tab, @c_col, @c_target;
        END;
        CLOSE c_cur;
        DEALLOCATE c_cur;

        /* Aplica cada ALTER COLUMN conservando la nulabilidad actual. */
        DECLARE c_cur2 CURSOR LOCAL FAST_FORWARD FOR
            SELECT k.table_name, k.column_name, k.target_chars, cols.is_nullable
            FROM @corrections AS k
            JOIN sys.columns AS cols
              ON cols.object_id = OBJECT_ID(N'dbo.' + k.table_name) AND cols.name = k.column_name
            ORDER BY k.table_name, k.column_name;
        OPEN c_cur2;
        FETCH NEXT FROM c_cur2 INTO @c_tab, @c_col, @c_target, @c_isnull;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @c_sql = N'ALTER TABLE dbo.' + QUOTENAME(@c_tab) + N' ALTER COLUMN ' + QUOTENAME(@c_col)
                       + N' NVARCHAR(' + CAST(@c_target AS NVARCHAR(10)) + N') '
                       + CASE WHEN @c_isnull = 1 THEN N'NULL' ELSE N'NOT NULL' END + N';';
            EXEC sys.sp_executesql @c_sql;
            PRINT N'Fase 2b: ' + @c_tab + N'.' + @c_col + N' -> NVARCHAR(' + CAST(@c_target AS NVARCHAR(10)) + N').';
            FETCH NEXT FROM c_cur2 INTO @c_tab, @c_col, @c_target, @c_isnull;
        END;
        CLOSE c_cur2;
        DEALLOCATE c_cur2;
        PRINT N'Fase 2b: 9 longitudes NVARCHAR ajustadas a schema.sql.';

        /* -------------------------------------------------------------------
         * FASE 3: unicidades compuestas que exigen las FK del esquema.
         * ----------------------------------------------------------------- */
        /* Prechequeo: UQ_departments_organization_name fallaria con nombres
         * duplicados dentro de la misma organizacion. Con organization_id NULL
         * en todas, equivale a exigir nombres unicos globales. */
        IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_departments_organization_name' AND parent_object_id = OBJECT_ID(N'dbo.departments'))
        BEGIN
            /* SQL dinamico: organization_id se agrega en fase 2 y puede no
               existir cuando SQL Server compila el lote en modo simulacion. */
            DECLARE @departments_has_duplicates BIT = 0;
            SET @sql = N'IF EXISTS (
                SELECT 1 FROM dbo.departments
                GROUP BY organization_id, name
                HAVING COUNT(*) > 1
            ) SET @duplicates = 1;';
            EXEC sys.sp_executesql @sql,
                N'@duplicates BIT OUTPUT',
                @duplicates = @departments_has_duplicates OUTPUT;
            IF @departments_has_duplicates = 1
            BEGIN
                /* RAISERROR severidad 16 dentro del TRY desvia al CATCH, que
                 * revierte toda la transaccion aditiva (no se usa RETURN, que
                 * dejaria la transaccion abierta). */
                RAISERROR(N'ABORTADO (fase 3): hay departments con (organization_id, name) duplicado; resuelva los datos antes de crear UQ_departments_organization_name.', 16, 1);
            END;
            ALTER TABLE dbo.departments ADD CONSTRAINT UQ_departments_organization_name UNIQUE (organization_id, name);
            PRINT N'Fase 3: UQ_departments_organization_name creada.';
        END;

        IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_departments_organization_id' AND parent_object_id = OBJECT_ID(N'dbo.departments'))
        BEGIN
            ALTER TABLE dbo.departments ADD CONSTRAINT UQ_departments_organization_id UNIQUE (organization_id, id);
            PRINT N'Fase 3: UQ_departments_organization_id creada.';
        END;

        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_users_organization_id' AND parent_object_id = OBJECT_ID(N'dbo.users'))
        BEGIN
            ALTER TABLE dbo.users ADD CONSTRAINT UQ_users_organization_id UNIQUE (organization_id, id);
            PRINT N'Fase 3: UQ_users_organization_id creada.';
        END;

        /* Fase 3 (complemento): unicidades de CODIGO/NOMBRE que schema.sql exige
         * en tablas existentes y que NO dependen de organizacion. Pre-chequeos
         * de duplicados -> RAISERROR (el CATCH revierte toda la transaccion).
         * Si el legacy ya las tiene con el mismo nombre, se omiten. */
        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.users', N'username') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_users_username' AND parent_object_id = OBJECT_ID(N'dbo.users'))
        BEGIN
            IF EXISTS (SELECT 1 FROM dbo.users GROUP BY username HAVING COUNT(*) > 1)
                RAISERROR(N'ABORTADO (fase 3): usernames duplicados; no se puede crear UQ_users_username.', 16, 1);
            ALTER TABLE dbo.users ADD CONSTRAINT UQ_users_username UNIQUE (username);
            PRINT N'Fase 3: UQ_users_username creada.';
        END;

        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.users', N'email') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_users_email' AND parent_object_id = OBJECT_ID(N'dbo.users'))
        BEGIN
            IF EXISTS (SELECT 1 FROM dbo.users GROUP BY email HAVING COUNT(*) > 1)
                RAISERROR(N'ABORTADO (fase 3): emails duplicados; no se puede crear UQ_users_email.', 16, 1);
            ALTER TABLE dbo.users ADD CONSTRAINT UQ_users_email UNIQUE (email);
            PRINT N'Fase 3: UQ_users_email creada.';
        END;

        IF OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.roles', N'code') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_roles_code' AND parent_object_id = OBJECT_ID(N'dbo.roles'))
        BEGIN
            IF EXISTS (SELECT 1 FROM dbo.roles GROUP BY code HAVING COUNT(*) > 1)
                RAISERROR(N'ABORTADO (fase 3): roles.code duplicados; no se puede crear UQ_roles_code.', 16, 1);
            ALTER TABLE dbo.roles ADD CONSTRAINT UQ_roles_code UNIQUE (code);
            PRINT N'Fase 3: UQ_roles_code creada.';
        END;

        IF OBJECT_ID(N'dbo.permissions', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.permissions', N'code') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_permissions_code' AND parent_object_id = OBJECT_ID(N'dbo.permissions'))
        BEGIN
            IF EXISTS (SELECT 1 FROM dbo.permissions GROUP BY code HAVING COUNT(*) > 1)
                RAISERROR(N'ABORTADO (fase 3): permissions.code duplicados; no se puede crear UQ_permissions_code.', 16, 1);
            ALTER TABLE dbo.permissions ADD CONSTRAINT UQ_permissions_code UNIQUE (code);
            PRINT N'Fase 3: UQ_permissions_code creada.';
        END;

        /* -------------------------------------------------------------------
         * FASE 4: tablas faltantes (DDL tomado de schema.sql, idempotente).
         * ----------------------------------------------------------------- */

        IF OBJECT_ID(N'dbo.categories', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.categories (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              name NVARCHAR(150) NOT NULL,
              description NVARCHAR(MAX) NULL,
              color NVARCHAR(7) NOT NULL CONSTRAINT DF_categories_color DEFAULT (N'#64748b'),
              active BIT NOT NULL CONSTRAINT DF_categories_active DEFAULT (1),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_categories_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_categories PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_categories_organization_name UNIQUE (organization_id, name),
              CONSTRAINT UQ_categories_organization_id UNIQUE (organization_id, id),
              CONSTRAINT CK_categories_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
              CONSTRAINT FK_categories_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.teams', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.teams (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              name NVARCHAR(150) NOT NULL,
              description NVARCHAR(MAX) NULL,
              active BIT NOT NULL CONSTRAINT DF_teams_active DEFAULT (1),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_teams_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_teams PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_teams_organization_name UNIQUE (organization_id, name),
              CONSTRAINT UQ_teams_organization_id UNIQUE (organization_id, id),
              CONSTRAINT FK_teams_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.team_members', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.team_members (
              organization_id INT NOT NULL,
              team_id INT NOT NULL,
              user_id INT NOT NULL,
              CONSTRAINT PK_team_members PRIMARY KEY CLUSTERED (team_id, user_id),
              CONSTRAINT FK_team_members_team_same_org FOREIGN KEY (organization_id, team_id)
                REFERENCES dbo.teams(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_team_members_user_same_org FOREIGN KEY (organization_id, user_id)
                REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.tickets', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.tickets (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              ticket_number NVARCHAR(32) NOT NULL,
              title NVARCHAR(300) NOT NULL,
              description NVARCHAR(MAX) NOT NULL,
              reporter_id INT NOT NULL,
              assigned_to_id INT NULL,
              assigned_team_id INT NULL,
              category_id INT NULL,
              department_id INT NULL,
              priority NVARCHAR(16) NOT NULL CONSTRAINT DF_tickets_priority DEFAULT (N'MEDIUM'),
              status NVARCHAR(20) NOT NULL CONSTRAINT DF_tickets_status DEFAULT (N'OPEN'),
              sla_due_at DATETIME2(3) NULL,
              resolution NVARCHAR(MAX) NULL,
              resolution_category NVARCHAR(200) NULL,
              root_cause NVARCHAR(500) NULL,
              time_spent_minutes INT NULL,
              resolved_by INT NULL,
              resolved_at DATETIME2(3) NULL,
              closed_by INT NULL,
              closed_at DATETIME2(3) NULL,
              reopened_at DATETIME2(3) NULL,
              reopened_by INT NULL,
              reopen_reason NVARCHAR(MAX) NULL,
              pending_reason NVARCHAR(500) NULL,
              resolution_notified BIT NOT NULL CONSTRAINT DF_tickets_resolution_notified DEFAULT (0),
              cancel_reason NVARCHAR(MAX) NULL,
              cancelled_by INT NULL,
              cancelled_at DATETIME2(3) NULL,
              csat_rating TINYINT NULL,
              csat_comment NVARCHAR(MAX) NULL,
              csat_answered_at DATETIME2(3) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_tickets_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_tickets PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_tickets_organization_ticket_number UNIQUE (organization_id, ticket_number),
              CONSTRAINT UQ_tickets_organization_id UNIQUE (organization_id, id),
              CONSTRAINT CK_tickets_priority CHECK (priority IN (N'LOW', N'MEDIUM', N'HIGH', N'CRITICAL')),
              CONSTRAINT CK_tickets_status CHECK (status IN (N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING', N'RESOLVED', N'CLOSED', N'CANCELLED')),
              CONSTRAINT CK_tickets_time_spent CHECK (time_spent_minutes IS NULL OR time_spent_minutes >= 0),
              CONSTRAINT CK_tickets_csat_rating CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5),
              CONSTRAINT FK_tickets_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_reporter_same_org FOREIGN KEY (organization_id, reporter_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_assigned_user_same_org FOREIGN KEY (organization_id, assigned_to_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_team_same_org FOREIGN KEY (organization_id, assigned_team_id) REFERENCES dbo.teams(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_category_same_org FOREIGN KEY (organization_id, category_id) REFERENCES dbo.categories(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_department_same_org FOREIGN KEY (organization_id, department_id) REFERENCES dbo.departments(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_resolved_by_same_org FOREIGN KEY (organization_id, resolved_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_closed_by_same_org FOREIGN KEY (organization_id, closed_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_reopened_by_same_org FOREIGN KEY (organization_id, reopened_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_tickets_cancelled_by_same_org FOREIGN KEY (organization_id, cancelled_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.canned_responses', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.canned_responses (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              title NVARCHAR(100) NOT NULL,
              body NVARCHAR(2000) NOT NULL,
              scope NVARCHAR(10) NOT NULL,
              owner_id INT NULL,
              team_id INT NULL,
              is_active BIT NOT NULL CONSTRAINT DF_canned_responses_active DEFAULT (1),
              use_count INT NOT NULL CONSTRAINT DF_canned_responses_use_count DEFAULT (0),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_canned_responses_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_canned_responses PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_canned_responses_organization_id UNIQUE (organization_id, id),
              CONSTRAINT CK_canned_responses_scope CHECK (scope IN (N'GLOBAL', N'PERSONAL', N'TEAM')),
              CONSTRAINT CK_canned_responses_title CHECK (LEN(LTRIM(RTRIM(title))) BETWEEN 1 AND 100),
              CONSTRAINT CK_canned_responses_body CHECK (LEN(LTRIM(RTRIM(body))) BETWEEN 1 AND 2000),
              CONSTRAINT CK_canned_responses_use_count CHECK (use_count >= 0),
              CONSTRAINT CK_canned_responses_scope_links CHECK (
                (scope = N'GLOBAL' AND owner_id IS NULL AND team_id IS NULL) OR
                (scope = N'PERSONAL' AND owner_id IS NOT NULL AND team_id IS NULL) OR
                (scope = N'TEAM' AND owner_id IS NULL AND team_id IS NOT NULL)
              ),
              CONSTRAINT FK_canned_responses_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
              CONSTRAINT FK_canned_responses_owner_same_org FOREIGN KEY (organization_id, owner_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_canned_responses_team_same_org FOREIGN KEY (organization_id, team_id) REFERENCES dbo.teams(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.ticket_comments', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.ticket_comments (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              ticket_id INT NOT NULL,
              user_id INT NULL,
              message NVARCHAR(MAX) NOT NULL,
              is_internal BIT NOT NULL CONSTRAINT DF_ticket_comments_internal DEFAULT (0),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_comments_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_ticket_comments PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_ticket_comments_organization_id UNIQUE (organization_id, id),
              CONSTRAINT FK_ticket_comments_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_ticket_comments_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.ticket_attachments', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.ticket_attachments (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              ticket_id INT NOT NULL,
              comment_id INT NULL,
              original_name NVARCHAR(500) NOT NULL,
              stored_name NVARCHAR(500) NOT NULL,
              mime_type NVARCHAR(255) NOT NULL,
              size_bytes BIGINT NOT NULL,
              uploader_id INT NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_attachments_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_ticket_attachments PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_ticket_attachments_stored_name UNIQUE (stored_name),
              CONSTRAINT CK_ticket_attachments_size CHECK (size_bytes >= 0),
              CONSTRAINT FK_ticket_attachments_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_ticket_attachments_comment_same_org FOREIGN KEY (organization_id, comment_id) REFERENCES dbo.ticket_comments(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_ticket_attachments_uploader_same_org FOREIGN KEY (organization_id, uploader_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.ticket_history', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.ticket_history (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              ticket_id INT NOT NULL,
              user_id INT NULL,
              action NVARCHAR(100) NOT NULL,
              description NVARCHAR(MAX) NULL,
              old_value NVARCHAR(MAX) NULL,
              new_value NVARCHAR(MAX) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_ticket_history_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_ticket_history PRIMARY KEY CLUSTERED (id),
              CONSTRAINT FK_ticket_history_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_ticket_history_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.sequences', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.sequences (
              name NVARCHAR(150) NOT NULL,
              value BIGINT NOT NULL,
              CONSTRAINT PK_sequences PRIMARY KEY CLUSTERED (name),
              CONSTRAINT CK_sequences_value CHECK (value >= 0)
            );
        END;

        IF OBJECT_ID(N'dbo.settings', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.settings (
              [key] NVARCHAR(100) NOT NULL,
              value NVARCHAR(MAX) NULL,
              updated_by INT NULL,
              updated_at DATETIME2(3) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_settings_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_settings PRIMARY KEY CLUSTERED ([key]),
              CONSTRAINT FK_settings_updated_by FOREIGN KEY (updated_by) REFERENCES dbo.users(id) ON DELETE SET NULL
            );
        END;

        IF OBJECT_ID(N'dbo.org_settings', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.org_settings (
              organization_id INT NOT NULL,
              [key] NVARCHAR(100) NOT NULL,
              value NVARCHAR(MAX) NOT NULL,
              updated_by INT NULL,
              updated_at DATETIME2(3) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_org_settings_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_org_settings PRIMARY KEY CLUSTERED (organization_id, [key]),
              CONSTRAINT FK_org_settings_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE CASCADE,
              CONSTRAINT FK_org_settings_updated_by FOREIGN KEY (updated_by) REFERENCES dbo.users(id) ON DELETE SET NULL
            );
        END;

        IF OBJECT_ID(N'dbo.email_logs', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.email_logs (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NULL,
              kind NVARCHAR(100) NOT NULL,
              to_email NVARCHAR(320) NOT NULL,
              subject NVARCHAR(500) NOT NULL,
              ticket_id INT NULL,
              status NVARCHAR(20) NOT NULL,
              error NVARCHAR(MAX) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_email_logs_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_email_logs PRIMARY KEY CLUSTERED (id),
              CONSTRAINT CK_email_logs_status CHECK (status IN (N'smtp', N'dev', N'error')),
              CONSTRAINT FK_email_logs_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.notifications', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.notifications (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NULL,
              user_id INT NOT NULL,
              ticket_id INT NULL,
              type NVARCHAR(100) NOT NULL,
              title NVARCHAR(500) NOT NULL,
              body NVARCHAR(500) NULL,
              link NVARCHAR(500) NULL,
              read_at DATETIME2(3) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_notifications_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_notifications PRIMARY KEY CLUSTERED (id),
              CONSTRAINT CK_notifications_ticket_requires_org CHECK (organization_id IS NOT NULL OR ticket_id IS NULL),
              CONSTRAINT FK_notifications_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_notifications_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE CASCADE
            );
        END;

        IF OBJECT_ID(N'dbo.kb_categories', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.kb_categories (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              name NVARCHAR(150) NOT NULL,
              description NVARCHAR(MAX) NULL,
              color NVARCHAR(7) NOT NULL CONSTRAINT DF_kb_categories_color DEFAULT (N'#64748b'),
              active BIT NOT NULL CONSTRAINT DF_kb_categories_active DEFAULT (1),
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_categories_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_kb_categories PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_kb_categories_organization_name UNIQUE (organization_id, name),
              CONSTRAINT UQ_kb_categories_organization_id UNIQUE (organization_id, id),
              CONSTRAINT CK_kb_categories_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
              CONSTRAINT FK_kb_categories_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.kb_articles', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.kb_articles (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              category_id INT NULL,
              author_id INT NULL,
              title NVARCHAR(200) NOT NULL,
              summary NVARCHAR(500) NOT NULL,
              description NVARCHAR(MAX) NOT NULL,
              solution NVARCHAR(MAX) NOT NULL,
              keywords NVARCHAR(MAX) NULL,
              status NVARCHAR(20) NOT NULL CONSTRAINT DF_kb_articles_status DEFAULT (N'DRAFT'),
              is_featured BIT NOT NULL CONSTRAINT DF_kb_articles_featured DEFAULT (0),
              view_count INT NOT NULL CONSTRAINT DF_kb_articles_view_count DEFAULT (0),
              published_at DATETIME2(3) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_articles_created_at DEFAULT (SYSUTCDATETIME()),
              updated_at DATETIME2(3) NULL,
              CONSTRAINT PK_kb_articles PRIMARY KEY CLUSTERED (id),
              CONSTRAINT UQ_kb_articles_organization_id UNIQUE (organization_id, id),
              CONSTRAINT CK_kb_articles_status CHECK (status IN (N'DRAFT', N'PUBLISHED', N'ARCHIVED')),
              CONSTRAINT CK_kb_articles_view_count CHECK (view_count >= 0),
              CONSTRAINT CK_kb_articles_title CHECK (LEN(LTRIM(RTRIM(title))) BETWEEN 1 AND 200),
              CONSTRAINT CK_kb_articles_summary CHECK (LEN(LTRIM(RTRIM(summary))) BETWEEN 1 AND 500),
              CONSTRAINT FK_kb_articles_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION,
              CONSTRAINT FK_kb_articles_category_same_org FOREIGN KEY (organization_id, category_id) REFERENCES dbo.kb_categories(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_kb_articles_author_same_org FOREIGN KEY (organization_id, author_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.kb_ticket_articles', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.kb_ticket_articles (
              organization_id INT NOT NULL,
              article_id INT NOT NULL,
              ticket_id INT NOT NULL,
              created_by INT NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_ticket_articles_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_kb_ticket_articles PRIMARY KEY CLUSTERED (article_id, ticket_id),
              CONSTRAINT FK_kb_ticket_articles_article_same_org FOREIGN KEY (organization_id, article_id) REFERENCES dbo.kb_articles(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_kb_ticket_articles_ticket_same_org FOREIGN KEY (organization_id, ticket_id) REFERENCES dbo.tickets(organization_id, id) ON DELETE NO ACTION,
              CONSTRAINT FK_kb_ticket_articles_creator_same_org FOREIGN KEY (organization_id, created_by) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        IF OBJECT_ID(N'dbo.kb_article_history', N'U') IS NULL
        BEGIN
            CREATE TABLE dbo.kb_article_history (
              id INT IDENTITY(1,1) NOT NULL,
              organization_id INT NOT NULL,
              article_id INT NOT NULL,
              user_id INT NULL,
              action NVARCHAR(100) NOT NULL,
              field NVARCHAR(100) NULL,
              old_value NVARCHAR(MAX) NULL,
              new_value NVARCHAR(MAX) NULL,
              created_at DATETIME2(3) NOT NULL CONSTRAINT DF_kb_article_history_created_at DEFAULT (SYSUTCDATETIME()),
              CONSTRAINT PK_kb_article_history PRIMARY KEY CLUSTERED (id),
              CONSTRAINT FK_kb_article_history_article_same_org FOREIGN KEY (organization_id, article_id) REFERENCES dbo.kb_articles(organization_id, id) ON DELETE CASCADE,
              CONSTRAINT FK_kb_article_history_user_same_org FOREIGN KEY (organization_id, user_id) REFERENCES dbo.users(organization_id, id) ON DELETE NO ACTION
            );
        END;

        PRINT N'Fase 4: tablas faltantes procesadas.';

        /* -------------------------------------------------------------------
         * FASE 5: FK de las tablas existentes al esquema canonico.
         *   Se anade solo si no existe ya una FK sobre la misma columna, para no
         *   duplicar las heredadas con nombre distinto (el validador las reporta
         *   como aviso, no bloqueante).
         * ----------------------------------------------------------------- */
        IF OBJECT_ID(N'dbo.departments', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM sys.foreign_key_columns AS fkc
               JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'organization_id'
           )
        BEGIN
            ALTER TABLE dbo.departments ADD CONSTRAINT FK_departments_organization
                FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
            PRINT N'Fase 5: FK_departments_organization creada.';
        END;

        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM sys.foreign_key_columns AS fkc
               JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.users') AND c.name = N'organization_id'
           )
        BEGIN
            ALTER TABLE dbo.users ADD CONSTRAINT FK_users_organization
                FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
            PRINT N'Fase 5: FK_users_organization creada.';
        END;

        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM sys.foreign_key_columns AS fkc
               JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.users') AND c.name = N'role_id'
           )
        BEGIN
            ALTER TABLE dbo.users ADD CONSTRAINT FK_users_role
                FOREIGN KEY (role_id) REFERENCES dbo.roles(id) ON DELETE NO ACTION;
            PRINT N'Fase 5: FK_users_role creada.';
        END;

        IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL
           AND COL_LENGTH(N'dbo.users', N'department_id') IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM sys.foreign_key_columns AS fkc
               JOIN sys.columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.users') AND c.name = N'department_id'
           )
        BEGIN
            ALTER TABLE dbo.users ADD CONSTRAINT FK_users_department_same_org
                FOREIGN KEY (organization_id, department_id) REFERENCES dbo.departments(organization_id, id) ON DELETE NO ACTION;
            PRINT N'Fase 5: FK_users_department_same_org creada.';
        END;

        /* -------------------------------------------------------------------
         * FASE 6: indices IX_* del esquema (solo si faltan).
         * ----------------------------------------------------------------- */
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_organizations_active' AND object_id = OBJECT_ID(N'dbo.organizations'))
            CREATE INDEX IX_organizations_active ON dbo.organizations(active);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_users_organization_active' AND object_id = OBJECT_ID(N'dbo.users'))
            CREATE INDEX IX_users_organization_active ON dbo.users(organization_id, active);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_users_department' AND object_id = OBJECT_ID(N'dbo.users'))
            CREATE INDEX IX_users_department ON dbo.users(department_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_status_priority' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_status_priority ON dbo.tickets(organization_id, status, priority);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_assigned' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_assigned ON dbo.tickets(organization_id, assigned_to_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_created' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_created ON dbo.tickets(organization_id, created_at DESC);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_sla_due' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_sla_due ON dbo.tickets(organization_id, sla_due_at);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_category' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_category ON dbo.tickets(organization_id, category_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_tickets_org_department' AND object_id = OBJECT_ID(N'dbo.tickets'))
            CREATE INDEX IX_tickets_org_department ON dbo.tickets(organization_id, department_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_team_members_user' AND object_id = OBJECT_ID(N'dbo.team_members'))
            CREATE INDEX IX_team_members_user ON dbo.team_members(organization_id, user_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_canned_responses_org_scope_active' AND object_id = OBJECT_ID(N'dbo.canned_responses'))
            CREATE INDEX IX_canned_responses_org_scope_active ON dbo.canned_responses(organization_id, scope, is_active);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ticket_comments_org_ticket_internal' AND object_id = OBJECT_ID(N'dbo.ticket_comments'))
            CREATE INDEX IX_ticket_comments_org_ticket_internal ON dbo.ticket_comments(organization_id, ticket_id, is_internal);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ticket_attachments_org_ticket' AND object_id = OBJECT_ID(N'dbo.ticket_attachments'))
            CREATE INDEX IX_ticket_attachments_org_ticket ON dbo.ticket_attachments(organization_id, ticket_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ticket_attachments_comment' AND object_id = OBJECT_ID(N'dbo.ticket_attachments'))
            CREATE INDEX IX_ticket_attachments_comment ON dbo.ticket_attachments(comment_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ticket_history_org_ticket_created' AND object_id = OBJECT_ID(N'dbo.ticket_history'))
            CREATE INDEX IX_ticket_history_org_ticket_created ON dbo.ticket_history(organization_id, ticket_id, created_at DESC);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_sessions_expire' AND object_id = OBJECT_ID(N'dbo.sessions'))
            CREATE INDEX IX_sessions_expire ON dbo.sessions(expire);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_email_logs_org_created' AND object_id = OBJECT_ID(N'dbo.email_logs'))
            CREATE INDEX IX_email_logs_org_created ON dbo.email_logs(organization_id, created_at DESC);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_notifications_org_user_read' AND object_id = OBJECT_ID(N'dbo.notifications'))
            CREATE INDEX IX_notifications_org_user_read ON dbo.notifications(organization_id, user_id, read_at);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_notifications_org_ticket' AND object_id = OBJECT_ID(N'dbo.notifications'))
            CREATE INDEX IX_notifications_org_ticket ON dbo.notifications(organization_id, ticket_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kb_articles_org_status_published' AND object_id = OBJECT_ID(N'dbo.kb_articles'))
            CREATE INDEX IX_kb_articles_org_status_published ON dbo.kb_articles(organization_id, status, published_at DESC);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kb_articles_org_category' AND object_id = OBJECT_ID(N'dbo.kb_articles'))
            CREATE INDEX IX_kb_articles_org_category ON dbo.kb_articles(organization_id, category_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kb_ticket_articles_ticket' AND object_id = OBJECT_ID(N'dbo.kb_ticket_articles'))
            CREATE INDEX IX_kb_ticket_articles_ticket ON dbo.kb_ticket_articles(organization_id, ticket_id);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kb_article_history_article' AND object_id = OBJECT_ID(N'dbo.kb_article_history'))
            CREATE INDEX IX_kb_article_history_article ON dbo.kb_article_history(organization_id, article_id, created_at DESC);

        PRINT N'Fase 6: indices verificados/creados.';

        COMMIT TRANSACTION;
        PRINT N'DDL ADITIVO (fases 1-6 y 2b) confirmado.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        PRINT N'ERROR en DDL aditivo. Se revirtio todo el bloque (fases 1-6/2b).';
        THROW;
    END CATCH;
END

/* ===========================================================================
 * PRE-CHEQUEO DE ROL (SOLO LECTURA) - antes de la fase 7.
 *   No supone el rol de la cuenta: lo imprime para decidir si la cuenta va a la
 *   organizacion (organization_id = CMUCE) o queda global (organization_id NULL).
 *   No muestra username/email/password_hash.
 * ========================================================================= */
IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL AND OBJECT_ID(N'dbo.roles', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.users', N'role_id') IS NOT NULL
   AND COL_LENGTH(N'dbo.roles', N'id') IS NOT NULL
   AND COL_LENGTH(N'dbo.roles', N'code') IS NOT NULL
   AND COL_LENGTH(N'dbo.roles', N'name') IS NOT NULL
BEGIN
    PRINT N'--- Pre-chequeo de rol (solo lectura) ---';
    SELECT u.id AS usuario_id, r.id AS rol_id, r.code AS rol_code, r.name AS rol_nombre
    FROM dbo.users AS u
    JOIN dbo.roles AS r ON r.id = u.role_id
    ORDER BY u.id;
    PRINT N'--- Si hay una cuenta SUPERADMIN/global: dejar @BackfillUsers = 0. ---';
    PRINT N'--- Si las cuentas son de organizacion: @BackfillUsers = 1 asigna CMUCE. ---';
END;

/* ===========================================================================
 * FASE 7 (GATE): backfill de organization_id (atomico, CMUCE incluida)
 *   - Organizacion CONFIRMADA: code CMUCE, nombre "Centro Medico UCE".
 *     El id NO se inventa: se resuelve por code (o se crea la organizacion).
 *   - @BackfillDepartments cubre los 25 departamentos (decision confirmada).
 *   - @BackfillUsers cubre la cuenta (decision confirmada, sujeta al rol).
 *   - Los UPDATEs usan SQL dinamico (columnas creadas por el DDL en fase 2;
 *     se compila solo al llegar aqui, tras la fase 2).
 * ========================================================================= */
IF @AuthorizeDdl = 1 AND @AuthorizeBackfill = 1
BEGIN
    /* Todas las comprobaciones y escrituras de fase 7 quedan en UNA transaccion.
       No crear CMUCE fuera del TRY/TRANSACTION. */
    BEGIN TRY
        BEGIN TRANSACTION;

        IF NULLIF(LTRIM(RTRIM(@LegacyOrganizationCode)), N'') IS NULL
            THROW 51070, N'ABORTADO fase 7: falta el codigo de organizacion.', 1;

        IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL
            THROW 51071, N'ABORTADO fase 7: falta dbo.organizations. Ejecutar antes fase B.', 1;

        IF @BackfillDepartments = 1 AND COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
            THROW 51072, N'ABORTADO fase 7: falta departments.organization_id.', 1;

        IF @BackfillUsers = 1 AND COL_LENGTH(N'dbo.users', N'organization_id') IS NULL
            THROW 51073, N'ABORTADO fase 7: falta users.organization_id.', 1;

        IF @BackfillDepartments = 0 AND @BackfillUsers = 0
            THROW 51074, N'ABORTADO fase 7: ambos backfills estan desactivados.', 1;

        DECLARE @org_id INT;
        SELECT @org_id = id
        FROM dbo.organizations WITH (UPDLOCK, HOLDLOCK)
        WHERE code = @LegacyOrganizationCode;

        IF @org_id IS NULL
        BEGIN
            IF NULLIF(LTRIM(RTRIM(@LegacyOrganizationName)), N'') IS NULL
                THROW 51075, N'ABORTADO fase 7: falta el nombre de la organizacion.', 1;

            INSERT INTO dbo.organizations (code, name, active, created_at)
            VALUES (@LegacyOrganizationCode, @LegacyOrganizationName, 1, SYSUTCDATETIME());
            SET @org_id = CONVERT(INT, SCOPE_IDENTITY());
            PRINT N'Fase 7: organizacion creada dentro de la transaccion, id ' + CAST(@org_id AS NVARCHAR(20));
        END
        ELSE
            PRINT N'Fase 7: organizacion existente reutilizada, id ' + CAST(@org_id AS NVARCHAR(20));

        IF @BackfillDepartments = 1
        BEGIN
            DECLARE @rc_dep BIGINT;
            SET @sql = N'UPDATE dbo.departments SET organization_id = @oid WHERE organization_id IS NULL;
                         SELECT @rc = @@ROWCOUNT;';
            EXEC sys.sp_executesql @sql, N'@oid INT, @rc BIGINT OUTPUT', @oid = @org_id, @rc = @rc_dep OUTPUT;
            PRINT N'Fase 7: departments asignados a CMUCE = ' + CAST(@rc_dep AS NVARCHAR(20));
        END
        ELSE PRINT N'Fase 7: departments sin tocar.';

        IF @BackfillUsers = 1
        BEGIN
            DECLARE @rc_usr BIGINT;
            SET @sql = N'UPDATE dbo.users SET organization_id = @oid WHERE organization_id IS NULL;
                         SELECT @rc = @@ROWCOUNT;';
            EXEC sys.sp_executesql @sql, N'@oid INT, @rc BIGINT OUTPUT', @oid = @org_id, @rc = @rc_usr OUTPUT;
            PRINT N'Fase 7: users asignados a CMUCE = ' + CAST(@rc_usr AS NVARCHAR(20));
            PRINT N'Fase 7: password_hash, role_id y role_permissions no se modificaron.';
        END
        ELSE PRINT N'Fase 7: users sin tocar.';

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        PRINT N'ERROR fase 7: transaccion completa revertida, incluida la creacion de CMUCE.';
        THROW;
    END CATCH;
END
ELSE PRINT N'Fase 7 OMITIDA: @AuthorizeBackfill = 0 o @AuthorizeDdl = 0.';

/* ===========================================================================
 * FASE 8 (GATE): departments.organization_id a NOT NULL
 *   Solo si no queda ninguna fila con NULL.
 * ========================================================================= */
IF @AuthorizeDdl = 1 AND @MakeDepartmentsNotNull = 1
BEGIN
    IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NULL
    BEGIN
        RAISERROR(N'ABORTADO (fase 8): falta dbo.departments.organization_id; ejecute antes el DDL (fase 2).', 16, 1);
        RETURN;
    END;

    DECLARE @dept_null BIGINT;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @dept_null OUTPUT;

    IF @dept_null > 0
    BEGIN
        RAISERROR(N'ABORTADO (fase 8): quedan %I64d departments sin organization_id; no se puede pasar a NOT NULL.', 16, 1, @dept_null);
        RETURN;
    END;

    BEGIN TRY
        BEGIN TRANSACTION;
        SET @sql = N'ALTER TABLE dbo.departments ALTER COLUMN organization_id INT NOT NULL;';
        EXEC sys.sp_executesql @sql;
        COMMIT TRANSACTION;
        PRINT N'Fase 8: departments.organization_id es NOT NULL.';
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        PRINT N'ERROR en fase 8. Se revirtio.';
        THROW;
    END CATCH;
END
ELSE PRINT N'Fase 8 OMITIDA: @MakeDepartmentsNotNull = 0 o departamentos con NULL.';

/* ===========================================================================
 * VERIFICACION POSTERIOR (solo lectura)
 * ========================================================================= */
PRINT N'--- Tablas presentes (de 24 requeridas) ---';
SELECT
    (SELECT COUNT(*) FROM (VALUES
        (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
        (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
        (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
        (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
        (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
        (N'kb_ticket_articles'), (N'kb_article_history')
    ) AS t(name)
    WHERE OBJECT_ID(N'dbo.' + t.name, N'U') IS NOT NULL) AS tablas_presentes_de_24;

/* Conservacion de los 96 registros originales (6 tablas pre-existentes). */
PRINT N'--- Conservacion de registros (esperado total: 96) ---';
SELECT tabla, actual, esperado,
       CASE WHEN actual = esperado THEN N'OK' ELSE N'DIFIERE' END AS estado
FROM (
    SELECT N'roles' AS tabla,
           CAST((SELECT COUNT_BIG(*) FROM dbo.roles) AS BIGINT) AS actual,
           CAST(3 AS BIGINT) AS esperado
    UNION ALL SELECT N'permissions',
           CAST((SELECT COUNT_BIG(*) FROM dbo.permissions) AS BIGINT),
           CAST(24 AS BIGINT)
    UNION ALL SELECT N'role_permissions',
           CAST((SELECT COUNT_BIG(*) FROM dbo.role_permissions) AS BIGINT),
           CAST(41 AS BIGINT)
    UNION ALL SELECT N'users',
           CAST((SELECT COUNT_BIG(*) FROM dbo.users) AS BIGINT),
           CAST(1 AS BIGINT)
    UNION ALL SELECT N'departments',
           CAST((SELECT COUNT_BIG(*) FROM dbo.departments) AS BIGINT),
           CAST(25 AS BIGINT)
    UNION ALL SELECT N'sessions',
           CAST((SELECT COUNT_BIG(*) FROM dbo.sessions) AS BIGINT),
           CAST(2 AS BIGINT)
) AS c
ORDER BY c.tabla;

SELECT CAST(SUM(c.actual) AS BIGINT) AS total_actual,
       CAST(SUM(c.esperado) AS BIGINT) AS total_esperado,
       CASE WHEN SUM(c.actual) = SUM(c.esperado) THEN N'96 conservados' ELSE N'DIFIERE' END AS resultado
FROM (
    SELECT CAST((SELECT COUNT_BIG(*) FROM dbo.roles) AS BIGINT) AS actual, CAST(3 AS BIGINT) AS esperado
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.permissions), 24
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.role_permissions), 41
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.users), 1
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.departments), 25
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.sessions), 2
) AS c;

/* Asignacion de organization_id (usando SQL dinamico: la columna la crea el
 * DDL de la fase 2; si no existe, se reporta y no falla la compilacion). */
PRINT N'--- organization_id (solo lectura) ---';
IF COL_LENGTH(N'dbo.users', N'organization_id') IS NOT NULL
BEGIN
    DECLARE @u_org_null BIGINT;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.users WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @u_org_null OUTPUT;
    PRINT N'users con organization_id NULL: ' + CAST(@u_org_null AS NVARCHAR(20));
END
ELSE PRINT N'users.organization_id: NO EXISTE (aun no aplicado)';

IF COL_LENGTH(N'dbo.departments', N'organization_id') IS NOT NULL
BEGIN
    DECLARE @d_org_null BIGINT;
    SET @sql = N'SELECT @n = COUNT_BIG(*) FROM dbo.departments WHERE organization_id IS NULL;';
    EXEC sys.sp_executesql @sql, N'@n BIGINT OUTPUT', @n = @d_org_null OUTPUT;
    PRINT N'departments con organization_id NULL: ' + CAST(@d_org_null AS NVARCHAR(20));
END
ELSE PRINT N'departments.organization_id: NO EXISTE (aun no aplicado)';

/* Longitudes NVARCHAR (9 corregidas): esperado vs actual (solo sys.columns). */
PRINT N'--- Longitudes NVARCHAR corregidas (caracteres) ---';
SELECT x.tabla, x.columna, x.esperado, x.actual,
       CASE WHEN x.esperado = x.actual THEN N'OK' ELSE N'DIFIERE' END AS estado
FROM (
    SELECT N'departments' AS tabla, N'name' AS columna, 150 AS esperado,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.departments') AND c.name = N'name' AND c.max_length <> -1) AS actual
    UNION ALL SELECT N'roles', N'name', 150,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.roles') AND c.name = N'name' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'email', 320,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'email' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'last_name', 150,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'last_name' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'name', 150,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'name' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'password_hash', 500,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'password_hash' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'password_reset_token', 500,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'password_reset_token' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'position', 200,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'position' AND c.max_length <> -1)
    UNION ALL SELECT N'users', N'username', 150,
           (SELECT c.max_length / 2 FROM sys.columns AS c
             WHERE c.object_id = OBJECT_ID(N'dbo.users') AND c.name = N'username' AND c.max_length <> -1)
) AS x
ORDER BY x.tabla, x.columna;

/* Resumen AUTOMATICO de verificacion: evita declarar exito cuando una fase
 * quedo incompleta (p.ej. faltan tablas o no se conservaron los 96 registros).
 * En modo simulacion (interruptores en 0) es NORMAL que salga INCOMPLETA: eso
 * describe el estado actual y NO debe tomarse como exito. */
DECLARE @v_presentes BIGINT, @v_faltantes BIGINT, @v_reg_ok BIT;
SELECT @v_presentes = COUNT(*)
FROM (VALUES
    (N'organizations'), (N'roles'), (N'permissions'), (N'role_permissions'),
    (N'departments'), (N'categories'), (N'users'), (N'teams'), (N'team_members'),
    (N'tickets'), (N'canned_responses'), (N'ticket_comments'), (N'ticket_attachments'),
    (N'ticket_history'), (N'sessions'), (N'sequences'), (N'settings'), (N'org_settings'),
    (N'email_logs'), (N'notifications'), (N'kb_categories'), (N'kb_articles'),
    (N'kb_ticket_articles'), (N'kb_article_history')
) AS t(name)
WHERE OBJECT_ID(N'dbo.' + t.name, N'U') IS NOT NULL;
SET @v_faltantes = 24 - @v_presentes;

SELECT @v_reg_ok = CASE WHEN SUM(actual) = SUM(esperado)
                              AND MIN(CASE WHEN actual = esperado THEN 1 ELSE 0 END) = 1
                        THEN 1 ELSE 0 END
FROM (
    SELECT CAST((SELECT COUNT_BIG(*) FROM dbo.roles) AS BIGINT) AS actual, CAST(3 AS BIGINT) AS esperado
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.permissions), 24
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.role_permissions), 41
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.users), 1
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.departments), 25
    UNION ALL SELECT (SELECT COUNT_BIG(*) FROM dbo.sessions), 2
) AS c;

IF @v_faltantes = 0 AND @v_reg_ok = 1
    PRINT N'VERIFICACION PARCIAL: 24 tablas presentes y conteos originales correctos; AUN FALTA validar FKs, indices, columnas y asociaciones antes de declarar exito.';
ELSE
    PRINT N'VERIFICACION POSTERIOR: INCOMPLETA -- faltan ' + CAST(@v_faltantes AS NVARCHAR(10))
        + N' tabla(s); registros conservados: '
        + CASE WHEN @v_reg_ok = 1 THEN N'si' ELSE N'NO (revisar el detalle)' END
        + N'. En modo simulacion es esperado; NO declarar exito.';
PRINT N'Siguiente: validar estructura completa con schemaValidator en modo solo lectura; no activar runtime ni ejecutar escrituras hasta autorizar.';

/* ===========================================================================
 * REVERSION MANUAL (ultimo recurso; preferir RESTAURAR el respaldo .bak)
 * ---------------------------------------------------------------------------
 * Orden inverso a la creacion. NO ejecutar sin autorizacion.
 *
 *   IF OBJECT_ID(N'dbo.kb_article_history', N'U') IS NOT NULL DROP TABLE dbo.kb_article_history;
 *   IF OBJECT_ID(N'dbo.kb_ticket_articles', N'U') IS NOT NULL DROP TABLE dbo.kb_ticket_articles;
 *   IF OBJECT_ID(N'dbo.kb_articles', N'U') IS NOT NULL DROP TABLE dbo.kb_articles;
 *   IF OBJECT_ID(N'dbo.kb_categories', N'U') IS NOT NULL DROP TABLE dbo.kb_categories;
 *   IF OBJECT_ID(N'dbo.notifications', N'U') IS NOT NULL DROP TABLE dbo.notifications;
 *   IF OBJECT_ID(N'dbo.email_logs', N'U') IS NOT NULL DROP TABLE dbo.email_logs;
 *   IF OBJECT_ID(N'dbo.org_settings', N'U') IS NOT NULL DROP TABLE dbo.org_settings;
 *   IF OBJECT_ID(N'dbo.settings', N'U') IS NOT NULL DROP TABLE dbo.settings;
 *   IF OBJECT_ID(N'dbo.sequences', N'U') IS NOT NULL DROP TABLE dbo.sequences;
 *   IF OBJECT_ID(N'dbo.ticket_history', N'U') IS NOT NULL DROP TABLE dbo.ticket_history;
 *   IF OBJECT_ID(N'dbo.ticket_attachments', N'U') IS NOT NULL DROP TABLE dbo.ticket_attachments;
 *   IF OBJECT_ID(N'dbo.ticket_comments', N'U') IS NOT NULL DROP TABLE dbo.ticket_comments;
 *   IF OBJECT_ID(N'dbo.canned_responses', N'U') IS NOT NULL DROP TABLE dbo.canned_responses;
 *   IF OBJECT_ID(N'dbo.tickets', N'U') IS NOT NULL DROP TABLE dbo.tickets;
 *   IF OBJECT_ID(N'dbo.team_members', N'U') IS NOT NULL DROP TABLE dbo.team_members;
 *   IF OBJECT_ID(N'dbo.teams', N'U') IS NOT NULL DROP TABLE dbo.teams;
 *   IF OBJECT_ID(N'dbo.categories', N'U') IS NOT NULL DROP TABLE dbo.categories;
 *   -- En tablas EXISTENTES solo se revierten los objetos/datos anadidos:
 *   --   ALTER TABLE dbo.users DROP CONSTRAINT FK_users_department_same_org;
 *   --   ALTER TABLE dbo.users DROP CONSTRAINT FK_users_organization;
 *   --   ALTER TABLE dbo.users DROP CONSTRAINT UQ_users_organization_id;
 *   --   ALTER TABLE dbo.users DROP COLUMN organization_id;
 *   --   ALTER TABLE dbo.departments DROP CONSTRAINT FK_departments_organization;
 *   --   ALTER TABLE dbo.departments DROP CONSTRAINT UQ_departments_organization_id;
 *   --   ALTER TABLE dbo.departments DROP CONSTRAINT UQ_departments_organization_name;
 *   --   ALTER TABLE dbo.departments DROP COLUMN organization_id;
 *   --   (y deshacer el backfill de la fase 7 restaurando el respaldo)
 *   -- La fase 2b (longitudes) NO se revierte por ALTER manual: las longitudes
 *   -- originales se recuperan RESTAURANDO el .bak previo (preferido).
 *   IF OBJECT_ID(N'dbo.organizations', N'U') IS NOT NULL DROP TABLE dbo.organizations;
 * ========================================================================== */
