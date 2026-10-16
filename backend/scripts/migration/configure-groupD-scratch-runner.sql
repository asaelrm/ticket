/*
 * Configuracion manual del login exclusivo para pruebas del grupo D.
 * Ejecutar desde SSMS por un administrador autorizado.
 *
 * Este archivo no contiene contraseñas y no ejecuta CREATE LOGIN
 * automaticamente. Cree primero el login desde la interfaz segura de SSMS
 * con el nombre SIFHA_GroupD_ScratchTestRunner y una contraseña introducida
 * directamente allí; despues ejecute este bloque completo.
 */

USE [master];
GO

IF DB_ID(N'SIFHA_Tickets_DEV') IS NULL
    THROW 51100, N'ABORTADO: falta SIFHA_Tickets_DEV; no se modifica ninguna base.', 1;
IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NULL
    THROW 51101, N'ABORTADO: falta SIFHA_GroupD_ScratchTest.', 1;
IF SUSER_ID(N'SIFHA_GroupD_ScratchTestRunner') IS NULL
    THROW 51102, N'ABORTADO: cree primero el login desde SSMS sin guardar la contraseña en archivos.', 1;
IF IS_SRVROLEMEMBER(N'sysadmin', N'SIFHA_GroupD_ScratchTestRunner') = 1
    THROW 51103, N'ABORTADO: el login de pruebas no puede ser sysadmin.', 1;
GO

USE [SIFHA_GroupD_ScratchTest];
GO

IF DATABASE_PRINCIPAL_ID(N'SIFHA_GroupD_ScratchTestRunner') IS NULL
    CREATE USER [SIFHA_GroupD_ScratchTestRunner] FOR LOGIN [SIFHA_GroupD_ScratchTestRunner];

ALTER ROLE [db_datareader] ADD MEMBER [SIFHA_GroupD_ScratchTestRunner];
GRANT ALTER ON SCHEMA::dbo TO [SIFHA_GroupD_ScratchTestRunner];
GRANT VIEW DEFINITION TO [SIFHA_GroupD_ScratchTestRunner];
GO

/* Validacion de permisos efectivos del usuario de pruebas. */
EXECUTE AS USER = N'SIFHA_GroupD_ScratchTestRunner';
BEGIN TRY
    SELECT USER_NAME() AS effective_user,
           IS_ROLEMEMBER(N'db_datareader') AS is_reader,
           HAS_PERMS_BY_NAME(N'dbo', N'SCHEMA', N'ALTER') AS can_alter_dbo,
           HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'VIEW DEFINITION') AS can_view_definition;
END TRY
BEGIN CATCH
    REVERT;
    THROW;
END CATCH;
REVERT;
GO
