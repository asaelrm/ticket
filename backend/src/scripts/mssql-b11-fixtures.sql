-- ============================================================================
-- B11-B1 · fixtures sintéticos de autenticación para SIFHA_Tickets_DEV
-- ============================================================================
--
-- CÓMO EJECUTARLO
--   1. Abra SSMS y conéctese a la instancia SIFHADEV con Windows Authentication.
--   2. Active el modo SQLCMD: menú Consulta > Modo SQLCMD (Ctrl+Shift+Q).
--   3. Pegue en las líneas :setvar de más abajo los dos valores que imprimió
--        node src/scripts/mssql-b11-password.mjs
--   4. Ejecute el script entero.
--
-- IMPORTANTE · NO ACTIVE "CONTINUAR CON EL ERROR"
--   Las barreras están separadas por GO, una por lote. Si en SSMS activase la
--   casilla "Continuar con el error" (pestaña Advanced / Avanzado de la
--   consulta), SSMS seguiría con el siguiente lote cuando una barrera falla y
--   el setup continuaría sin comprobar. Déjela DESACTIVADA: es el valor por
--   defecto y es lo que hace que un THROW detenga el script.
--
-- POR QUÉ UN ARCHIVO .sql Y NO UN SCRIPT DE NODE
--   Windows Authentication contra SIFHADEV se rechaza desde Node/mssql/tedious:
--   el propio motor responde "The login is from an untrusted domain and cannot
--   be used with Integrated authentication". Además tedious calcularía NTLMv2
--   en JavaScript, lo que obligaría a entregar la contraseña de Windows al
--   proceso. SSMS usa el testigo de la sesión de Windows y no maneja ninguna
--   contraseña, que es justo lo que se pidió.
--
-- LO QUE ESTE SCRIPT NO HACE
--   No hay DDL, ni GRANT/REVOKE, ni DROP, ni TRUNCATE, ni DELETE sin WHERE.
--   No se toca ADMIN, EMPLOYEE ni TECHNICIAN, ni ninguna otra cuenta.
--   No contiene contraseñas ni hashes reales: el hash llega por variable.
--   No usa la cuenta sa: el propio script aborta si ORIGINAL_LOGIN() es sa.
-- ============================================================================

-- Generados por:  node src/scripts/mssql-b11-password.mjs
--   B11_ACTION   ->  setup | verify | cleanup
--   B11_MARKER   ->  b11b1-<sello>-<hex>
--   B11_PWD_HASH ->  bcrypt de una contraseña sintética, generado en memoria
:setvar B11_ACTION "PON_AQUI_setup_verify_o_cleanup"
:setvar B11_MARKER "PON_AQUI_EL_MARCADOR_b11b1"
:setvar B11_PWD_HASH "PON_AQUI_EL_HASH_BCRYPT"

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

-- ---------------------------------------------------------------------------
-- Barreras. Se comprueban ANTES de tocar nada y en el propio SQL, para que un
-- cambio futuro del cliente no pueda saltarlas.
-- ---------------------------------------------------------------------------
IF DB_NAME() <> N'SIFHA_Tickets_DEV'
  THROW 50000, 'Este script solo puede ejecutarse en SIFHA_Tickets_DEV.', 1;
GO
IF UPPER(ORIGINAL_LOGIN()) = N'SA'
  THROW 50001, 'Este script no se ejecuta como sa. Use su identidad Windows administrativa.', 1;
GO
IF N'$(B11_ACTION)' NOT IN (N'setup', N'verify', N'cleanup')
  THROW 50002, 'B11_ACTION debe ser setup, verify o cleanup.', 1;
GO
IF N'$(B11_MARKER)' NOT LIKE N'b11b1-%'
  THROW 50003, 'B11_MARKER debe empezar por "b11b1-". Use el marcador que imprimio mssql-b11-password.mjs.', 1;
GO
IF N'$(B11_ACTION)' = N'setup'
   AND (LEN(N'$(B11_PWD_HASH)') < 20 OR N'$(B11_PWD_HASH)' LIKE N'PON_AQUI%')
  THROW 50004, 'Falta el hash bcrypt. Genere uno con mssql-b11-password.mjs y peguelo en :setvar B11_PWD_HASH.', 1;
GO

-- ---------------------------------------------------------------------------
-- SETUP · idempotente. Una única transacción: o entra todo, o no entra nada.
--
-- El permiso role.manage NO existe todavía en SIFHA_Tickets_DEV (el catálogo
-- está vacío), así que sin sembrarlo la cadena
--   users.role_id -> roles.id -> role_permissions.role_id -> permissions.id
-- no tiene nada que enlazar y el usuario manager jamás obtendría el permiso.
--
-- dashboard.view sí es un código real de la aplicación (src/seed.js). Se usa
-- para el usuario negativo: si su rol no tuviera NINGÚN permiso, su 403 no
-- probaría que requirePermission filtra por código, sino que el rol estaba
-- vacío. No se inventa ningún permiso nuevo.
-- ---------------------------------------------------------------------------
IF N'$(B11_ACTION)' = N'setup'
BEGIN
  BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @managerCode   NVARCHAR(100) = N'B11_ROLE_MANAGER';
    DECLARE @noManageCode  NVARCHAR(100) = N'B11_ROLE_NO_MANAGE';
    DECLARE @targetCode    NVARCHAR(100) = N'B11_TARGET_ROLE';
    DECLARE @marker        NVARCHAR(100) = N'b11-%$(B11_MARKER)%';
    DECLARE @pwdHash       NVARCHAR(255) = N'$(B11_PWD_HASH)';

    DECLARE @roleManageId   INT;
    DECLARE @dashboardId    INT;
    DECLARE @managerRoleId  INT;
    DECLARE @noManageRoleId INT;
    DECLARE @targetRoleId   INT;

    -- 1. Permisos mínimos, solo si faltan.
    IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = N'role.manage')
      INSERT INTO dbo.permissions (code, description) VALUES (N'role.manage', N'Permiso de fixture B11: role.manage');
    IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = N'dashboard.view')
      INSERT INTO dbo.permissions (code, description) VALUES (N'dashboard.view', N'Permiso de fixture B11: dashboard.view');

    SELECT @roleManageId = id FROM dbo.permissions WHERE code = N'role.manage';
    SELECT @dashboardId  = id FROM dbo.permissions WHERE code = N'dashboard.view';
    IF @roleManageId IS NULL OR @dashboardId IS NULL
      THROW 50005, 'No se pudieron resolver los permisos mínimos de B11.', 1;

    -- 2. Los tres roles de B11, solo si faltan.
    IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE code = @managerCode)
      INSERT INTO dbo.roles (code, name) VALUES (@managerCode, N'Rol de fixture B11: B11_ROLE_MANAGER');
    IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE code = @noManageCode)
      INSERT INTO dbo.roles (code, name) VALUES (@noManageCode, N'Rol de fixture B11: B11_ROLE_NO_MANAGE');
    IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE code = @targetCode)
      INSERT INTO dbo.roles (code, name) VALUES (@targetCode, N'Rol de fixture B11: B11_TARGET_ROLE');

    SELECT @managerRoleId  = id FROM dbo.roles WHERE code = @managerCode;
    SELECT @noManageRoleId = id FROM dbo.roles WHERE code = @noManageCode;
    SELECT @targetRoleId   = id FROM dbo.roles WHERE code = @targetCode;
    IF @managerRoleId IS NULL OR @noManageRoleId IS NULL OR @targetRoleId IS NULL
      THROW 50006, 'No se pudieron resolver los tres roles de B11.', 1;

    -- 3. Asociación rol -> permiso. Es la ÚNICA vía por la que el usuario
    --    manager obtiene role.manage: no se hardcodea nada en req.user.
    --    B11_TARGET_ROLE se queda sin permisos a propósito.
    IF NOT EXISTS (SELECT 1 FROM dbo.role_permissions WHERE role_id = @managerRoleId AND permission_id = @roleManageId)
      INSERT INTO dbo.role_permissions (role_id, permission_id) VALUES (@managerRoleId, @roleManageId);
    IF NOT EXISTS (SELECT 1 FROM dbo.role_permissions WHERE role_id = @noManageRoleId AND permission_id = @dashboardId)
      INSERT INTO dbo.role_permissions (role_id, permission_id) VALUES (@noManageRoleId, @dashboardId);

    -- 4. Usuarios. Correos solo @example.invalid y prefijo b11-*.
    --    Si la cuenta ya existe NO se le cambia la contraseña: el manifiesto
    --    que usará la prueba seguiría siendo válido. Se verifica que la cuenta
    --    existente es realmente la nuestra y, si no, se aborta.
    IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = N'b11-manager-$(B11_MARKER)')
      INSERT INTO dbo.users (name, last_name, username, email, password_hash, position, role_id, active)
      VALUES (N'B11', N'Fixture', N'b11-manager-$(B11_MARKER)', N'b11-manager-$(B11_MARKER)@example.invalid',
              @pwdHash, N'Fixture B11', @managerRoleId, 1);
    ELSE IF NOT EXISTS (
      SELECT 1 FROM dbo.users u JOIN dbo.roles r ON r.id = u.role_id
      WHERE u.username = N'b11-manager-$(B11_MARKER)'
        AND u.email = N'b11-manager-$(B11_MARKER)@example.invalid' AND r.code = @managerCode)
      THROW 50007, 'El usuario b11-manager-$(B11_MARKER) existe pero no es el fixture de B11. No se modifica.', 1;

    IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = N'b11-no-manage-$(B11_MARKER)')
      INSERT INTO dbo.users (name, last_name, username, email, password_hash, position, role_id, active)
      VALUES (N'B11', N'Fixture', N'b11-no-manage-$(B11_MARKER)', N'b11-no-manage-$(B11_MARKER)@example.invalid',
              @pwdHash, N'Fixture B11', @noManageRoleId, 1);
    ELSE IF NOT EXISTS (
      SELECT 1 FROM dbo.users u JOIN dbo.roles r ON r.id = u.role_id
      WHERE u.username = N'b11-no-manage-$(B11_MARKER)'
        AND u.email = N'b11-no-manage-$(B11_MARKER)@example.invalid' AND r.code = @noManageCode)
      THROW 50008, 'El usuario b11-no-manage-$(B11_MARKER) existe pero no es el fixture de B11. No se modifica.', 1;

    -- El usuario inactivo lleva el rol neutro: /me responderá 403 antes de
    -- mirar permisos, así que no necesita ninguno.
    IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = N'b11-inactive-$(B11_MARKER)')
      INSERT INTO dbo.users (name, last_name, username, email, password_hash, position, role_id, active)
      VALUES (N'B11', N'Fixture', N'b11-inactive-$(B11_MARKER)', N'b11-inactive-$(B11_MARKER)@example.invalid',
              @pwdHash, N'Fixture B11', @targetRoleId, 0);
    ELSE IF NOT EXISTS (
      SELECT 1 FROM dbo.users u JOIN dbo.roles r ON r.id = u.role_id
      WHERE u.username = N'b11-inactive-$(B11_MARKER)'
        AND u.email = N'b11-inactive-$(B11_MARKER)@example.invalid' AND r.code = @targetCode)
      THROW 50009, 'El usuario b11-inactive-$(B11_MARKER) existe pero no es el fixture de B11. No se modifica.', 1;

    COMMIT TRANSACTION;

    SELECT N'B11 setup completado' AS resultado, @managerRoleId AS rol_manager_id,
           @noManageRoleId AS rol_no_manage_id, @targetRoleId AS rol_target_id,
           N'b11-manager-$(B11_MARKER)'   AS usuario_manager,
           N'b11-no-manage-$(B11_MARKER)' AS usuario_sin_permiso,
           N'b11-inactive-$(B11_MARKER)'  AS usuario_inactivo;
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH
END
ELSE IF N'$(B11_ACTION)' = N'verify'
BEGIN
  -- Solo lectura. Es el mismo resultado que imprime mssql-b11-verify.js, para
  -- poder comprobarlo desde SSMS sin Node.
  SELECT
    (SELECT COUNT(*) FROM dbo.users WHERE username LIKE N'b11-%$(B11_MARKER)%')            AS B11_USERS_REMAINING,
    (SELECT COUNT(*) FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE')) AS B11_ROLES_REMAINING,
    (SELECT COUNT(*) FROM dbo.role_permissions
      WHERE role_id IN (SELECT id FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE')))
                                                                                         AS B11_ROLE_PERMISSIONS_REMAINING,
    (SELECT COUNT(*) FROM dbo.sessions
      WHERE CAST(JSON_VALUE(sess, '$.userId') AS INT)
            IN (SELECT id FROM dbo.users WHERE username LIKE N'b11-%$(B11_MARKER)%'))    AS B11_SESSIONS_REMAINING,
    (SELECT COUNT(*) FROM dbo.permissions WHERE code IN (N'role.manage', N'dashboard.view')) AS B11_PERMISSIONS_REMAINING;
END
ELSE IF N'$(B11_ACTION)' = N'cleanup'
BEGIN
  -- Orden impuesto por las FK:
  --   1. sesiones de los usuarios B11 (sessions no tiene FK a users: se
  --      resuelven por JSON_VALUE sobre los ids ya acotados por el marcador)
  --   2. role_permissions de los roles B11
  --   3. usuarios B11   (FK_users_role NO tiene CASCADE: sin este paso, borrar
  --      el rol fallaría)
  --   4. roles B11
  --   5. permisos sembrados, solo si ningún otro rol los referencia
  BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @marker2 NVARCHAR(100) = N'b11-%$(B11_MARKER)%';

    DELETE FROM dbo.sessions
    WHERE CAST(JSON_VALUE(sess, '$.userId') AS INT)
          IN (SELECT id FROM dbo.users WHERE username LIKE @marker2);

    DELETE FROM dbo.role_permissions
    WHERE role_id IN (SELECT id FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE'));

    -- Doble barrera: prefijo del marcador Y pertenencia al conjunto de roles
    -- de B11. Un usuario real nunca cumple las dos.
    DELETE FROM dbo.users
    WHERE username LIKE @marker2
      AND role_id IN (SELECT id FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE'));

    DELETE FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE');

    -- Los permisos son catálogo compartido: solo se borran si quedaron huérfanos.
    DELETE FROM dbo.permissions
    WHERE code IN (N'role.manage', N'dashboard.view')
      AND NOT EXISTS (
        SELECT 1 FROM dbo.role_permissions rp
        WHERE rp.permission_id = dbo.permissions.id
      );

    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH

  SELECT
    (SELECT COUNT(*) FROM dbo.users WHERE username LIKE N'b11-%$(B11_MARKER)%')            AS B11_USERS_REMAINING,
    (SELECT COUNT(*) FROM dbo.roles WHERE code IN (N'B11_ROLE_MANAGER', N'B11_ROLE_NO_MANAGE', N'B11_TARGET_ROLE')) AS B11_ROLES_REMAINING,
    (SELECT COUNT(*) FROM dbo.sessions
      WHERE CAST(JSON_VALUE(sess, '$.userId') AS INT)
            IN (SELECT id FROM dbo.users WHERE username LIKE N'b11-%$(B11_MARKER)%'))    AS B11_SESSIONS_REMAINING;
END
GO