/* ============================================================================
 * SIFHA - Respaldo previo de SIFHA_Tickets_M5_Validation
 *         EXCLUSIVO de TI-DESK-01\SIFHADEV / SIFHA_Tickets_M5_Validation
 * ============================================================================
 *
 * Que hace
 *   - Verifica la identidad del servidor/instancia/base ANTES de tocar nada.
 *   - Crea UNA copia con nombre unico (fecha y hora) con COPY_ONLY y CHECKSUM.
 *   - Verifica la copia con RESTORE VERIFYONLY.
 *   - Muestra la ruta, el tamano y la fecha del respaldo recien creado.
 *
 * Que NO hace
 *   - No restaura ninguna base (solo RESTORE VERIFYONLY, que no escribe datos).
 *   - No borra ni sobrescribe respaldos: si el archivo ya existe, ABORTA.
 *   - No toca SIFHA_Tickets_DEV ni ninguna otra base: si el destino no coincide,
 *     ABORTA sin ejecutar el BACKUP.
 *   - No usa Integrated Security: la conexion de migracion es autenticacion SQL.
 *
 * Uso (manual, contra la base autorizada)
 *   En SSMS, conectado a SIFHA_Tickets_M5_Validation, ejecutar el script.
 *   Si el directorio por defecto de la instancia no sirve, edite @BackupDir en
 *   el paso 2 con una ruta LOCAL DEL SERVIDOR SQL (no del equipo cliente).
 *
 * Antes de ejecutar, compruebe que el servicio de SQL Server puede escribir en
 * la carpeta elegida (permiso de escritura para la cuenta del servicio).
 * ========================================================================== */

SET NOCOUNT ON;
/* BACKUP y RESTORE no deben ir dentro de una transaccion de usuario: se deja
 * XACT_ABORT en OFF para no alterar el comportamiento de esas instrucciones. */
SET XACT_ABORT OFF;

/* 1. Guarda de identidad: solo SIFHA_Tickets_M5_Validation en TI-DESK-01\SIFHADEV. */
DECLARE @expected_database SYSNAME = N'SIFHA_Tickets_M5_Validation';
DECLARE @expected_server NVARCHAR(128) = N'TI-DESK-01\SIFHADEV';
DECLARE @expected_instance NVARCHAR(128) = N'SIFHADEV';

DECLARE @current_database SYSNAME = LTRIM(RTRIM(DB_NAME()));
DECLARE @current_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))));
DECLARE @current_legacy_server NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), @@SERVERNAME)));
DECLARE @current_instance NVARCHAR(128) = LTRIM(RTRIM(CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName'))));

IF UPPER(ISNULL(@current_database, N'')) <> UPPER(@expected_database)
BEGIN
    RAISERROR(N'ABORTADO: la base actual "%s" no es la autorizada "%s". No se respalda nada.', 16, 1, @current_database, @expected_database);
    RETURN;
END;

IF UPPER(ISNULL(@current_instance, N'')) <> UPPER(@expected_instance)
BEGIN
    RAISERROR(N'ABORTADO: la instancia "%s" no es la autorizada "%s". No se respalda nada.', 16, 1, @current_instance, @expected_instance);
    RETURN;
END;

IF NOT (
    UPPER(ISNULL(@current_server, N'')) = UPPER(@expected_server)
    OR UPPER(ISNULL(@current_legacy_server, N'')) = UPPER(@expected_server)
)
BEGIN
    RAISERROR(N'ABORTADO: el servidor "%s"/"%s" no es el autorizado "%s". No se respalda nada.', 16, 1, @current_server, @current_legacy_server, @expected_server);
    RETURN;
END;

PRINT N'Identidad verificada: TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_Tickets_M5_Validation';

/* 2. Directorio del respaldo. EDITE @BackupDir si quiere otra carpeta del
 *    SERVIDOR SQL. Si lo deja NULL, se usa el directorio por defecto de la
 *    instancia (SERVERPROPERTY('InstanceDefaultBackupPath')). */
DECLARE @BackupDir NVARCHAR(4000) = NULL; -- <-- p.ej. N'D:\copias\ticket\'

IF @BackupDir IS NULL OR LTRIM(RTRIM(@BackupDir)) = N''
    SET @BackupDir = CONVERT(NVARCHAR(4000), SERVERPROPERTY('InstanceDefaultBackupPath'));

IF @BackupDir IS NULL OR LTRIM(RTRIM(@BackupDir)) = N''
BEGIN
    RAISERROR(N'ABORTADO: no hay directorio de respaldo. Defina @BackupDir con una ruta local del servidor SQL.', 16, 1);
    RETURN;
END;

IF RIGHT(@BackupDir, 1) <> N'\' SET @BackupDir = @BackupDir + N'\';

/* 3. Nombre unico: <base>_FULL_AAAAMMDD_HHMMSS.bak. Se construye en tiempo de
 *    ejecucion para no colisionar con respaldos anteriores. */
DECLARE @now DATETIME2(0) = SYSDATETIME();
DECLARE @fecha NVARCHAR(8) = CONVERT(NVARCHAR(8), @now, 112);           -- AAAAMMDD
DECLARE @hora  NVARCHAR(8) = REPLACE(CONVERT(NVARCHAR(8), @now, 108), N':', N''); -- HHMMSS
DECLARE @Stamp NVARCHAR(32) = @fecha + N'_' + @hora;
DECLARE @File NVARCHAR(4000) = @BackupDir + N'SIFHA_Tickets_M5_Validation_FULL_' + @Stamp + N'.bak';

/* 3b. Nombre del conjunto de respaldo. Se calcula en una variable porque las
 *     opciones de BACKUP (NAME/DESCRIPTION) solo admiten un literal o una
 *     variable, NUNCA una expresion con '+': concatenar aqui produce el error de
 *     sintaxis T-SQL "Msg 102, Level 15, State 1 ... near '+'". */
DECLARE @BackupName NVARCHAR(256) = N'SIFHA M5 copia previa ' + @Stamp;

/* 4. No sobrescribir: si el archivo ya existe, abortar (comprobacion best-effort;
 *    si no hay permiso para xp_fileexist, se continua porque el nombre es unico). */
DECLARE @file_exists INT = 0;
BEGIN TRY
    DECLARE @exists TABLE (FileExists INT, IsDirectory INT, ParentExists INT);
    INSERT INTO @exists EXEC master.dbo.xp_fileexist @File;
    SELECT @file_exists = MAX(FileExists) FROM @exists;
END TRY
BEGIN CATCH
    PRINT N'Aviso: no se pudo comprobar si el archivo existe (xp_fileexist no disponible). El nombre unico evita colisiones.';
END CATCH;

IF @file_exists = 1
BEGIN
    RAISERROR(N'ABORTADO: el archivo "%s" ya existe. No se sobrescriben respaldos; reintente en unos segundos.', 16, 1, @File);
    RETURN;
END;

PRINT N'Iniciando respaldo en: ' + @File;

/* 5. Copia con COPY_ONLY (no altera la cadena de respaldos), CHECKSUM e INIT
 *    (INIT es seguro porque el nombre es unico: el archivo no existia). */
BACKUP DATABASE [SIFHA_Tickets_M5_Validation]
    TO DISK = @File
    WITH COPY_ONLY,
         INIT,
         CHECKSUM,
         COMPRESSION,
         NAME = @BackupName,
         DESCRIPTION = N'Copia previa a la correccion de dbo.notifications (organization_id NULL + CK_notifications_ticket_requires_org).',
         STATS = 5;

/* 6. Comprobacion posterior: RESTORE VERIFYONLY (NO restaura datos). */
RESTORE VERIFYONLY
    FROM DISK = @File
    WITH CHECKSUM;

/* 7. Confirmacion de ruta, tamano y fecha a partir del catalogo de msdb
 *    (solo lectura). backup_size en bytes sin comprimir; compressed_backup_size
 *    es el tamano real en disco si se uso COMPRESSION. */
SELECT TOP (1)
       bs.database_name              AS base,
       bs.backup_start_date          AS inicio,
       bs.backup_finish_date         AS fin,
       bs.is_copy_only               AS es_copy_only,
       bs.backup_size                AS bytes_sin_comprimir,
       bs.compressed_backup_size     AS bytes_en_disco,
       mf.physical_device_name       AS archivo
FROM msdb.dbo.backupset AS bs
INNER JOIN msdb.dbo.backupmediafamily AS mf ON mf.media_set_id = bs.media_set_id
WHERE bs.database_name = N'SIFHA_Tickets_M5_Validation'
ORDER BY bs.backup_finish_date DESC;

PRINT N'RESPALDO COMPLETO y VERIFICADO: ' + @File;
PRINT N'Guarde esta ruta: es el punto de recuperacion antes de aplicar la correccion de dbo.notifications.';
