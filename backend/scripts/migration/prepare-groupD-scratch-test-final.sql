/* SIFHA Ticket - SQL Server 2022
   Preparacion de SIFHA_GroupD_ScratchTest.
   PASO 1: Seleccionar y ejecutar SOLO BLOQUE A.
   PASO 2: Revisar todos los resultados y autorizar BLOQUE B por separado.
   NUNCA ejecutar la migracion D en SIFHA_Tickets_DEV desde este archivo.
   Esta version NO utiliza xp_fileexist.
*/

/* ========== BLOQUE A: COMPROBACIONES (NO RESTAURA) ========== */
USE [master];
GO
SET NOCOUNT ON;
IF DB_ID(N'SIFHA_Tickets_DEV') IS NULL
    THROW 51000, N'ABORTADO: no existe SIFHA_Tickets_DEV.', 1;
IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NOT NULL
    THROW 51001, N'ABORTADO: la base de pruebas ya existe.', 1;

DECLARE @BackupFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_DEV_PreGrupoD_20261012.bak';
DECLARE @DataFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest.mdf';
DECLARE @LogFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest_log.ldf';

SELECT name, state_desc FROM sys.databases
WHERE name IN (N'SIFHA_Tickets_DEV', N'SIFHA_GroupD_ScratchTest');
RESTORE VERIFYONLY FROM DISK = @BackupFile WITH CHECKSUM;

CREATE TABLE #BackupFilesA (
 LogicalName nvarchar(128), PhysicalName nvarchar(260), [Type] char(1),
 FileGroupName nvarchar(128), Size bigint, MaxSize bigint, FileId bigint,
 CreateLSN numeric(25,0), DropLSN numeric(25,0), UniqueId uniqueidentifier,
 ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint,
 SourceBlockSize int, FileGroupId int, LogGroupGUID uniqueidentifier,
 DifferentialBaseLSN numeric(25,0), DifferentialBaseGUID uniqueidentifier,
 IsReadonly bit, IsPresent bit, TDEThumbprint varbinary(32), SnapshotURL nvarchar(360)
);
DECLARE @FileListSql nvarchar(max) =
 N'RESTORE FILELISTONLY FROM DISK = N''' + REPLACE(@BackupFile, N'''', N'''''') + N''';';
INSERT INTO #BackupFilesA EXEC sys.sp_executesql @FileListSql;
SELECT LogicalName, [Type], PhysicalName, Size / 1048576.0 AS size_mb FROM #BackupFilesA;
IF (SELECT COUNT(*) FROM #BackupFilesA) <> 2
   OR (SELECT COUNT(*) FROM #BackupFilesA WHERE [Type] = 'D') <> 1
   OR (SELECT COUNT(*) FROM #BackupFilesA WHERE [Type] = 'L') <> 1
    THROW 51002, N'ABORTADO: el backup no contiene exactamente un archivo de datos y uno de log.', 1;
IF EXISTS (SELECT 1 FROM #BackupFilesA WHERE NULLIF(LTRIM(RTRIM(LogicalName)), N'') IS NULL)
    THROW 51003, N'ABORTADO: nombre logico vacio.', 1;
IF @DataFile = @LogFile
    THROW 51004, N'ABORTADO: MDF y LDF tienen el mismo destino.', 1;
IF EXISTS (SELECT 1 FROM sys.master_files WHERE physical_name IN (@DataFile, @LogFile))
    THROW 51005, N'ABORTADO: archivo de destino asociado a una base.', 1;

-- Funcion documentada de SQL Server 2017+; no usar xp_fileexist.
DECLARE @DataExists int = NULL, @LogExists int = NULL;
DECLARE @DataParent int = NULL, @LogParent int = NULL;
SELECT @DataExists = file_exists, @DataParent = parent_directory_exists
FROM sys.dm_os_file_exists(@DataFile);
SELECT @LogExists = file_exists, @LogParent = parent_directory_exists
FROM sys.dm_os_file_exists(@LogFile);
SELECT @DataFile AS mdf_destino, @DataExists AS mdf_existe, @DataParent AS carpeta_mdf_existe,
       @LogFile AS ldf_destino, @LogExists AS ldf_existe, @LogParent AS carpeta_ldf_existe;
IF COALESCE(@DataExists, 1) <> 0 OR COALESCE(@LogExists, 1) <> 0
   OR COALESCE(@DataParent, 0) <> 1 OR COALESCE(@LogParent, 0) <> 1
    THROW 51006, N'ABORTADO: archivos de destino existentes, rutas inexistentes o estado no verificable.', 1;

CREATE TABLE #FixedDrivesA (drive char(1), free_mb int);
INSERT INTO #FixedDrivesA EXEC master.dbo.xp_fixeddrives;
DECLARE @DataDrive char(1) = UPPER(LEFT(@DataFile, 1));
DECLARE @LogDrive char(1) = UPPER(LEFT(@LogFile, 1));
DECLARE @RequiredDataMb decimal(18,2), @RequiredLogMb decimal(18,2);
SELECT @RequiredDataMb = SUM(CASE WHEN [Type] = 'D' THEN Size ELSE 0 END) / 1048576.0,
       @RequiredLogMb = SUM(CASE WHEN [Type] = 'L' THEN Size ELSE 0 END) / 1048576.0
FROM #BackupFilesA;
IF @RequiredDataMb IS NULL OR @RequiredLogMb IS NULL
    THROW 51007, N'ABORTADO: no se pudo calcular el tamano requerido.', 1;
SELECT drive, free_mb FROM #FixedDrivesA;
IF NOT EXISTS (SELECT 1 FROM #FixedDrivesA
               WHERE UPPER(drive) = @DataDrive
                 AND free_mb >= CEILING(@RequiredDataMb + CASE WHEN @DataDrive = @LogDrive THEN @RequiredLogMb ELSE 0 END))
    THROW 51008, N'ABORTADO: espacio insuficiente o desconocido para MDF y LDF.', 1;
IF @DataDrive <> @LogDrive
   AND NOT EXISTS (SELECT 1 FROM #FixedDrivesA
                   WHERE UPPER(drive) = @LogDrive AND free_mb >= CEILING(@RequiredLogMb))
    THROW 51009, N'ABORTADO: espacio insuficiente o desconocido para LDF.', 1;
SELECT @RequiredDataMb AS mdf_requerido_mb, @RequiredLogMb AS ldf_requerido_mb,
       @DataDrive AS unidad_mdf, @LogDrive AS unidad_ldf,
       CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')) AS ruta_datos_servidor,
       CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath')) AS ruta_log_servidor;
PRINT N'BLOQUE A CORRECTO. Revisar resultados antes de autorizar BLOQUE B.';
GO

/* ========== BLOQUE B: RESTAURACION (NO EJECUTAR TODAVIA) ==========
   Seleccionar este bloque POR SEPARADO SOLO tras confirmar BLOQUE A.
   Mantener @AutorizarRestauracion = 0 hasta autorizacion explicita.
   No incluye CREATE LOGIN, GRANT ni migracion D.
*/
USE [master];
GO
SET NOCOUNT ON;
DECLARE @AutorizarRestauracion bit = 0;
IF @AutorizarRestauracion <> 1
    THROW 51100, N'RESTAURACION BLOQUEADA: requiere autorizacion explicita.', 1;
IF DB_ID(N'SIFHA_Tickets_DEV') IS NULL
    THROW 51101, N'ABORTADO: no existe la base principal.', 1;
IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NOT NULL
    THROW 51102, N'ABORTADO: scratch ya existe.', 1;

DECLARE @BackupFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_DEV_PreGrupoD_20261012.bak';
DECLARE @DataFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest.mdf';
DECLARE @LogFile nvarchar(4000) = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\DATA\SIFHA_GroupD_ScratchTest_log.ldf';
IF @DataFile = @LogFile
    THROW 51103, N'ABORTADO: destinos MDF/LDF identicos.', 1;
IF EXISTS (SELECT 1 FROM sys.master_files WHERE physical_name IN (@DataFile, @LogFile))
    THROW 51104, N'ABORTADO: destino asociado a otra base.', 1;
DECLARE @DataExists int = NULL, @LogExists int = NULL;
DECLARE @DataParent int = NULL, @LogParent int = NULL;
SELECT @DataExists = file_exists, @DataParent = parent_directory_exists
FROM sys.dm_os_file_exists(@DataFile);
SELECT @LogExists = file_exists, @LogParent = parent_directory_exists
FROM sys.dm_os_file_exists(@LogFile);
IF COALESCE(@DataExists, 1) <> 0 OR COALESCE(@LogExists, 1) <> 0
   OR COALESCE(@DataParent, 0) <> 1 OR COALESCE(@LogParent, 0) <> 1
    THROW 51105, N'ABORTADO: archivos existentes o rutas no verificables.', 1;
RESTORE VERIFYONLY FROM DISK = @BackupFile WITH CHECKSUM;
CREATE TABLE #BackupFilesB (
 LogicalName nvarchar(128), PhysicalName nvarchar(260), [Type] char(1),
 FileGroupName nvarchar(128), Size bigint, MaxSize bigint, FileId bigint,
 CreateLSN numeric(25,0), DropLSN numeric(25,0), UniqueId uniqueidentifier,
 ReadOnlyLSN numeric(25,0), ReadWriteLSN numeric(25,0), BackupSizeInBytes bigint,
 SourceBlockSize int, FileGroupId int, LogGroupGUID uniqueidentifier,
 DifferentialBaseLSN numeric(25,0), DifferentialBaseGUID uniqueidentifier,
 IsReadonly bit, IsPresent bit, TDEThumbprint varbinary(32), SnapshotURL nvarchar(360)
);
DECLARE @FileListSql nvarchar(max) =
 N'RESTORE FILELISTONLY FROM DISK = N''' + REPLACE(@BackupFile, N'''', N'''''') + N''';';
INSERT INTO #BackupFilesB EXEC sys.sp_executesql @FileListSql;
IF (SELECT COUNT(*) FROM #BackupFilesB) <> 2
   OR (SELECT COUNT(*) FROM #BackupFilesB WHERE [Type] = 'D') <> 1
   OR (SELECT COUNT(*) FROM #BackupFilesB WHERE [Type] = 'L') <> 1
    THROW 51106, N'ABORTADO: estructura de archivos inesperada en el backup.', 1;
DECLARE @DataLogical sysname, @LogLogical sysname, @RestoreSql nvarchar(max);
SELECT @DataLogical = LogicalName FROM #BackupFilesB WHERE [Type] = 'D';
SELECT @LogLogical = LogicalName FROM #BackupFilesB WHERE [Type] = 'L';
IF NULLIF(@DataLogical, N'') IS NULL OR NULLIF(@LogLogical, N'') IS NULL
    THROW 51107, N'ABORTADO: nombres logicos invalidos.', 1;
CREATE TABLE #FixedDrivesB (drive char(1), free_mb int);
INSERT INTO #FixedDrivesB EXEC master.dbo.xp_fixeddrives;
DECLARE @DataDrive char(1) = UPPER(LEFT(@DataFile, 1));
DECLARE @LogDrive char(1) = UPPER(LEFT(@LogFile, 1));
DECLARE @RequiredDataMb decimal(18,2), @RequiredLogMb decimal(18,2);
SELECT @RequiredDataMb = SUM(CASE WHEN [Type] = 'D' THEN Size ELSE 0 END) / 1048576.0,
       @RequiredLogMb = SUM(CASE WHEN [Type] = 'L' THEN Size ELSE 0 END) / 1048576.0
FROM #BackupFilesB;
IF NOT EXISTS (SELECT 1 FROM #FixedDrivesB
               WHERE UPPER(drive) = @DataDrive
                 AND free_mb >= CEILING(@RequiredDataMb + CASE WHEN @DataDrive = @LogDrive THEN @RequiredLogMb ELSE 0 END))
    THROW 51108, N'ABORTADO: espacio insuficiente para MDF/LDF.', 1;
IF @DataDrive <> @LogDrive
   AND NOT EXISTS (SELECT 1 FROM #FixedDrivesB
                   WHERE UPPER(drive) = @LogDrive AND free_mb >= CEILING(@RequiredLogMb))
    THROW 51109, N'ABORTADO: espacio insuficiente para LDF.', 1;
IF DB_ID(N'SIFHA_GroupD_ScratchTest') IS NOT NULL
    THROW 51110, N'ABORTADO: scratch aparecio durante las comprobaciones.', 1;
IF EXISTS (SELECT 1 FROM sys.master_files WHERE physical_name IN (@DataFile, @LogFile))
    THROW 51111, N'ABORTADO: archivo destino ocupado durante comprobaciones.', 1;
SET @RestoreSql = N'RESTORE DATABASE [SIFHA_GroupD_ScratchTest] FROM DISK = N'''
 + REPLACE(@BackupFile, N'''', N'''''') + N''' WITH '
 + N'MOVE N''' + REPLACE(@DataLogical, N'''', N'''''') + N''' TO N'''
 + REPLACE(@DataFile, N'''', N'''''') + N''', '
 + N'MOVE N''' + REPLACE(@LogLogical, N'''', N'''''') + N''' TO N'''
 + REPLACE(@LogFile, N'''', N'''''') + N''', RECOVERY, CHECKSUM, STATS = 10;';
EXEC sys.sp_executesql @RestoreSql;
SELECT name, state_desc FROM sys.databases
WHERE name IN (N'SIFHA_Tickets_DEV', N'SIFHA_GroupD_ScratchTest');
GO

/* ========== BLOQUE C: POSTERIOR A RESTAURACION ========== */
-- Ejecutar SOLO tras confirmar scratch ONLINE:
-- DBCC CHECKDB (N'SIFHA_GroupD_ScratchTest') WITH NO_INFOMSGS, ALL_ERRORMSGS;
