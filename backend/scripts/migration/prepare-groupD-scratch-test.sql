/*
 * SIFHA - Preparacion manual de SIFHA_GroupD_ScratchTest
 * SQL Server 2022 / ejecutar desde SSMS por un administrador autorizado.
 *
 * ESTE ARCHIVO NO EJECUTA NADA AUTOMATICAMENTE.
 *
 * Orden:
 *   1) Ejecutar el bloque SOLO LECTURA.
 *   2) Revisar backup, rutas y espacio.
 *   3) Editar las rutas MOVE del bloque administrativo y ejecutar cada
 *      operacion de forma manual, una por una.
 *   4) Confirmar la restauracion antes de iniciar las pruebas del grupo D.
 */

/* ========================================================================
 * BLOQUE A - SOLO LECTURA
 * ======================================================================== */
USE [master];
GO

SELECT
    DB_NAME() AS current_database,
    CONVERT(sysname, SERVERPROPERTY('ServerName')) AS server_name,
    CONVERT(sysname, SERVERPROPERTY('InstanceName')) AS instance_name,
    CONVERT(sysname, SERVERPROPERTY('Edition')) AS edition,
    CONVERT(sysname, SERVERPROPERTY('ProductVersion')) AS product_version;
GO

IF DB_ID(N'SIFHA_Tickets_DEV') IS NULL
    THROW 51000, N'ABORTADO: no existe SIFHA_Tickets_DEV.', 1;

IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NOT NULL
    THROW 51001, N'ABORTADO: SIFHA_GroupD_ScratchTest ya existe. No se sobrescribe.', 1;

SELECT name, state_desc, user_access_desc, recovery_model_desc
FROM sys.databases
WHERE name IN (N'SIFHA_Tickets_DEV', N'SIFHA_GroupD_ScratchTest');
GO

/* Sustituir solo el nombre del backup si el administrador debe elegir otro
   backup COPY_ONLY ya verificado. No ejecutar contra DEV. */
DECLARE @BackupFile nvarchar(4000) =
    N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_DEV_PreGrupoD_20261012.bak';
DECLARE @DataFile nvarchar(4000) =
    N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest.mdf';
DECLARE @LogFile nvarchar(4000) =
    N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest_log.ldf';

RESTORE VERIFYONLY FROM DISK = @BackupFile WITH CHECKSUM;
DECLARE @FileList TABLE (LogicalName nvarchar(128), PhysicalName nvarchar(260), [Type] char(1), FileGroupName nvarchar(128), Size bigint,
    MaxSize bigint, FileId bigint, CreateLSN numeric(25,0), DropLSN numeric(25,0), UniqueId uniqueidentifier,
    ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint, SourceBlockSize int,
    FileGroupId int, LogGroupGUID uniqueidentifier, DifferentialBaseLSN numeric(25,0),
    DifferentialBaseGUID uniqueidentifier, IsReadonly bit, IsPresent bit, TDEThumbprint varbinary(32), SnapshotURL nvarchar(360));
DECLARE @FileListSql nvarchar(max) =
    N'RESTORE FILELISTONLY FROM DISK = N''' + REPLACE(@BackupFile,'''','''''') + N''';';
INSERT INTO @FileList EXEC sys.sp_executesql @FileListSql;
SELECT LogicalName, [Type], PhysicalName, Size, BackupSizeInBytes FROM @FileList;

IF (SELECT COUNT(*) FROM @FileList) <> 2
   OR (SELECT COUNT(*) FROM @FileList WHERE [Type] = 'D') <> 1
   OR (SELECT COUNT(*) FROM @FileList WHERE [Type] = 'L') <> 1
BEGIN
    SELECT LogicalName, [Type], PhysicalName, Size FROM @FileList;
    THROW 51010, N'ABORTADO: el respaldo no contiene exactamente un archivo de datos y uno de log; los archivos adicionales requieren instrucciones MOVE explicitas.', 1;
END;

IF EXISTS (SELECT 1 FROM @FileList WHERE NULLIF(LTRIM(RTRIM(LogicalName)), N'') IS NULL)
    THROW 51011, N'ABORTADO: FILELISTONLY devolvio un nombre logico vacio.', 1;

IF EXISTS (SELECT 1 FROM sys.master_files WHERE physical_name IN (@DataFile, @LogFile))
    THROW 51005, N'ABORTADO: un archivo fisico de destino ya esta asociado a una base.', 1;

DECLARE @DataExists int, @DataIsDir int, @LogExists int, @LogIsDir int;
EXEC master.dbo.xp_fileexist @DataFile, @DataExists OUTPUT, @DataIsDir OUTPUT;
EXEC master.dbo.xp_fileexist @LogFile, @LogExists OUTPUT, @LogIsDir OUTPUT;
IF @DataExists = 1 OR @LogExists = 1 OR @DataIsDir = 1 OR @LogIsDir = 1
    THROW 51006, N'ABORTADO: los archivos fisicos MDF/LDF de destino ya existen o son directorios.', 1;

/* Rutas configuradas para la instancia y espacio libre por unidad. */
SELECT
    servicename,
    service_account,
    instant_file_initialization_enabled
FROM sys.dm_server_services
WHERE servicename LIKE N'SQL Server (%';

EXEC master.dbo.xp_fixeddrives;

CREATE TABLE #FixedDrives (drive char(1), free_mb int);
INSERT INTO #FixedDrives EXEC master.dbo.xp_fixeddrives;
SELECT drive, free_mb FROM #FixedDrives;

DECLARE @RequiredDataMb decimal(18,2), @RequiredLogMb decimal(18,2), @RequiredSameDriveMb decimal(18,2);
DECLARE @DataDrive char(1) = LEFT(@DataFile, 1), @LogDrive char(1) = LEFT(@LogFile, 1);
SELECT @RequiredDataMb = SUM(CASE WHEN [Type] = 'D' THEN Size ELSE 0 END) / 1048576.0,
       @RequiredLogMb = SUM(CASE WHEN [Type] = 'L' THEN Size ELSE 0 END) / 1048576.0
FROM @FileList;
IF @RequiredDataMb IS NULL OR @RequiredLogMb IS NULL OR @RequiredDataMb < 0 OR @RequiredLogMb < 0
    THROW 51012, N'ABORTADO: no se pudo determinar el espacio requerido desde FILELISTONLY.', 1;

IF @DataDrive = @LogDrive
BEGIN
    SET @RequiredSameDriveMb = @RequiredDataMb + @RequiredLogMb;
    SELECT @DataDrive AS shared_drive, free_mb, @RequiredSameDriveMb AS required_mb,
           CASE WHEN free_mb >= CEILING(@RequiredSameDriveMb) THEN 1 ELSE 0 END AS enough_space
    FROM #FixedDrives WHERE drive = @DataDrive;
    IF NOT EXISTS (SELECT 1 FROM #FixedDrives WHERE drive = @DataDrive
                   AND free_mb >= CEILING(@RequiredSameDriveMb))
        THROW 51007, N'ABORTADO: espacio insuficiente o indeterminable en la unidad compartida por MDF y LDF.', 1;
END
ELSE
BEGIN
    SELECT @DataDrive AS data_drive, d.free_mb AS data_free_mb, @RequiredDataMb AS data_required_mb,
           @LogDrive AS log_drive, l.free_mb AS log_free_mb, @RequiredLogMb AS log_required_mb,
           CASE WHEN d.free_mb >= CEILING(@RequiredDataMb)
                      AND l.free_mb >= CEILING(@RequiredLogMb) THEN 1 ELSE 0 END AS enough_space
    FROM #FixedDrives AS d CROSS JOIN #FixedDrives AS l
    WHERE d.drive = @DataDrive AND l.drive = @LogDrive;
    IF NOT EXISTS (SELECT 1 FROM #FixedDrives WHERE drive = @DataDrive
                   AND free_mb >= CEILING(@RequiredDataMb))
        THROW 51007, N'ABORTADO: espacio insuficiente o indeterminable en la unidad del archivo MDF.', 1;
    IF NOT EXISTS (SELECT 1 FROM #FixedDrives WHERE drive = @LogDrive
                   AND free_mb >= CEILING(@RequiredLogMb))
        THROW 51008, N'ABORTADO: espacio insuficiente o indeterminable en la unidad del archivo LDF.', 1;
END;

SELECT CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')) AS default_data_path,
       CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath')) AS default_log_path,
       @DataFile AS requested_data_file,
       @LogFile AS requested_log_file;

SELECT
    CAST(SUM(size) * 8.0 / 1024 AS decimal(18,2)) AS existing_database_size_mb
FROM sys.master_files
WHERE database_id = DB_ID(N'SIFHA_Tickets_DEV');
GO

/* ========================================================================
 * BLOQUE B - OPERACIONES ADMINISTRATIVAS; NO EJECUTAR SIN REVISION
 * ========================================================================
 * Requisitos previos:
 *   - El bloque A devolvio VERIFYONLY correcto.
 *   - FILELISTONLY mostro los nombres logicos reales.
 *   - Las rutas de MOVE existen y tienen espacio suficiente.
 *   - El destino sigue sin existir.
 *   - El bloque administrativo vuelve a leer FILELISTONLY y construye MOVE
 *     solo con los nombres logicos reales del respaldo.
 */

/* 1. Ultima guarda contra sobrescritura y colision de archivos. Debe
   permanecer en el mismo bloque ejecutable que el RESTORE, inmediatamente
   antes de el. Ejecutar manualmente. */
/*
USE [master];
GO
IF DB_ID(N'SIFHA_Tickets_DEV') IS NULL
    THROW 51002, N'ABORTADO: falta SIFHA_Tickets_DEV.', 1;
IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NOT NULL
    THROW 51003, N'ABORTADO: el scratch ya existe; no se sobrescribe.', 1;
DECLARE @DataFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest.mdf';
DECLARE @LogFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest_log.ldf';
IF EXISTS (SELECT 1 FROM sys.master_files WHERE physical_name IN (@DataFile, @LogFile))
    THROW 51005, N'ABORTADO: un archivo fisico de destino ya esta asociado a una base.', 1;
DECLARE @DataExists int, @DataIsDir int, @LogExists int, @LogIsDir int;
EXEC master.dbo.xp_fileexist @DataFile, @DataExists OUTPUT, @DataIsDir OUTPUT;
EXEC master.dbo.xp_fileexist @LogFile, @LogExists OUTPUT, @LogIsDir OUTPUT;
IF @DataExists = 1 OR @LogExists = 1 OR @DataIsDir = 1 OR @LogIsDir = 1
    THROW 51006, N'ABORTADO: los archivos fisicos MDF/LDF de destino ya existen o son directorios.', 1;

-- 2. Restauracion aislada. NO usar WITH REPLACE. FILELISTONLY se ejecuta
-- dentro del mismo bloque para que MOVE use nombres reales, nunca marcadores.
-- Si aparecen archivos adicionales, el bloque aborta antes del RESTORE.
DECLARE @BackupFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_DEV_PreGrupoD_20261012.bak';
DECLARE @DataLogical sysname, @LogLogical sysname, @RestoreSql nvarchar(max);
DECLARE @FileList TABLE (LogicalName nvarchar(128), PhysicalName nvarchar(260), [Type] char(1), FileGroupName nvarchar(128), Size bigint,
    MaxSize bigint, FileId bigint, CreateLSN numeric(25,0), DropLSN numeric(25,0), UniqueId uniqueidentifier,
    ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint, SourceBlockSize int,
    FileGroupId int, LogGroupGUID uniqueidentifier, DifferentialBaseLSN numeric(25,0),
    DifferentialBaseGUID uniqueidentifier, IsReadonly bit, IsPresent bit, TDEThumbprint varbinary(32), SnapshotURL nvarchar(360));
DECLARE @FileListSql nvarchar(max) =
    N'RESTORE FILELISTONLY FROM DISK = N''' + REPLACE(@BackupFile,'''','''''') + N''';';
INSERT INTO @FileList EXEC sys.sp_executesql @FileListSql;
IF (SELECT COUNT(*) FROM @FileList) <> 2
   OR (SELECT COUNT(*) FROM @FileList WHERE [Type] = 'D') <> 1
   OR (SELECT COUNT(*) FROM @FileList WHERE [Type] = 'L') <> 1
    THROW 51013, N'ABORTADO: el respaldo contiene archivos adicionales o no tiene exactamente un archivo de datos y uno de log; no se ejecuta RESTORE.', 1;
SELECT @DataLogical = LogicalName FROM @FileList WHERE [Type] = 'D';
SELECT @LogLogical = LogicalName FROM @FileList WHERE [Type] = 'L';
IF NULLIF(@DataLogical, N'') IS NULL OR NULLIF(@LogLogical, N'') IS NULL
    THROW 51014, N'ABORTADO: no se obtuvieron nombres logicos validos desde FILELISTONLY.', 1;

SET @RestoreSql = N'RESTORE DATABASE [SIFHA_GroupD_ScratchTest] FROM DISK = N''' + REPLACE(@BackupFile,'''','''''') + N''' WITH '
    + N'MOVE N''' + REPLACE(@DataLogical,'''','''''') + N''' TO N''' + REPLACE(@DataFile,'''','''''') + N''', '
    + N'MOVE N''' + REPLACE(@LogLogical,'''','''''') + N''' TO N''' + REPLACE(@LogFile,'''','''''') + N''', '
    + N'RECOVERY, CHECKSUM, STATS = 10;';
EXEC sys.sp_executesql @RestoreSql;
GO
*/

/* 3. Verificacion inmediata de la restauracion. Solo lectura. */
/*
USE [master];
GO
SELECT name, state_desc, user_access_desc
FROM sys.databases
WHERE name = N'SIFHA_GroupD_ScratchTest';
GO
DBCC CHECKDB (N'SIFHA_GroupD_ScratchTest') WITH NO_INFOMSGS, ALL_ERRORMSGS;
GO
*/

/* 4. Permisos minimos para un login EXCLUSIVO de pruebas.
   Esto afecta solo a SIFHA_GroupD_ScratchTest, nunca a DEV.
   No se concede db_ddladmin, sysadmin, dbcreator, securityadmin, db_owner ni
   permisos en master o DEV. El administrador debe crear el login mediante
   su procedimiento seguro de secretos; la contraseña no aparece aqui.
   Ejecutar manualmente y solo si el login es el autorizado. */
/*
USE [SIFHA_GroupD_ScratchTest];
GO
IF SUSER_ID(N'SIFHA_GroupD_ScratchTestRunner') IS NULL
    THROW 51004, N'ABORTADO: no existe el login autorizado.', 1;
IF DATABASE_PRINCIPAL_ID(N'SIFHA_GroupD_ScratchTestRunner') IS NULL
    CREATE USER [SIFHA_GroupD_ScratchTestRunner] FOR LOGIN [SIFHA_GroupD_ScratchTestRunner];
ALTER ROLE [db_datareader] ADD MEMBER [SIFHA_GroupD_ScratchTestRunner];
GRANT ALTER ON SCHEMA::dbo TO [SIFHA_GroupD_ScratchTestRunner];
GRANT VIEW DEFINITION TO [SIFHA_GroupD_ScratchTestRunner];
GO
*/

/* 5. Comprobacion final de permisos efectivos (solo lectura).
   HAS_PERMS_BY_NAME se ejecuta bajo el contexto del login de pruebas, no
   bajo sa. EXECUTE AS se revierte tanto en la ruta normal como en CATCH. */
/*
USE [SIFHA_GroupD_ScratchTest];
GO
EXECUTE AS LOGIN = N'SIFHA_GroupD_ScratchTestRunner';
BEGIN TRY
    SELECT SUSER_SNAME() AS effective_login,
           DB_NAME() AS database_name,
           IS_ROLEMEMBER(N'db_datareader') AS is_reader,
           HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'VIEW DEFINITION') AS can_view_definition,
           HAS_PERMS_BY_NAME(N'dbo', N'SCHEMA', N'ALTER') AS can_alter_dbo_schema,
           HAS_PERMS_BY_NAME(N'dbo.departments', N'OBJECT', N'ALTER') AS can_alter_departments,
           HAS_PERMS_BY_NAME(N'dbo.users', N'OBJECT', N'ALTER') AS can_alter_users,
           HAS_PERMS_BY_NAME(N'dbo.tickets', N'OBJECT', N'ALTER') AS can_alter_tickets;

    IF IS_ROLEMEMBER(N'db_datareader') <> 1
       OR HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'VIEW DEFINITION') <> 1
       OR HAS_PERMS_BY_NAME(N'dbo.departments', N'OBJECT', N'ALTER') <> 1
       OR HAS_PERMS_BY_NAME(N'dbo.users', N'OBJECT', N'ALTER') <> 1
       OR HAS_PERMS_BY_NAME(N'dbo.tickets', N'OBJECT', N'ALTER') <> 1
        THROW 51009, N'ABORTADO: el login de pruebas no tiene todos los permisos requeridos por el grupo D.', 1;
END TRY
BEGIN CATCH
    REVERT;
    THROW;
END CATCH;
REVERT;
GO
*/

/* No eliminar el scratch desde este archivo. Su ciclo de vida debe ser
   confirmado expresamente despues de completar las pruebas. */
