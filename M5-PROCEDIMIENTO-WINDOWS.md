# M5 — Procedimiento de respaldo, corrección y validación (Windows/SSMS)

Corrección de las **dos diferencias bloqueantes** de `dbo.notifications` en la
base de validación `SIFHA_Tickets_M5_Validation` del servidor
`TI-DESK-01\SIFHADEV`.

> Ejecutar SOLO con autorización explícita. NUNCA sobre `SIFHA_Tickets_DEV`,
> `master` ni ninguna otra base. NUNCA usar Integrated Security: la conexión de
> migración usa autenticación SQL.

## 0. Requisitos

- `sqlcmd` o SSMS con permisos `db_owner` sobre `SIFHA_Tickets_M5_Validation`.
- Login de migración: `sifha_migration_dev` (contraseña fuera del repositorio).
- Script: `backend/scripts/migration/notifications-organization-nullable.sql`.
- Diagnóstico: `backend/scripts/migration/diagnose-m5-validation.js`.

## 1. Respaldo previo (obligatorio)

Script preparado: `backend/scripts/migration/backup-m5.sql` (solo BACKUP; no
restaura datos).

Pasos:

1. En SSMS, conectado a `SIFHA_Tickets_M5_Validation`, abrir `backup-m5.sql`.
2. Si el directorio por defecto de la instancia no sirve, editar `@BackupDir`
   (paso 2 del script) con una ruta **local del servidor SQL** y comprobar que
   la cuenta del servicio tiene permiso de escritura en esa carpeta.
3. Ejecutar el script completo. Verifica identidad, aborta si el destino no es
   `TI-DESK-01\SIFHADEV / SIFHA_Tickets_M5_Validation`, no sobrescribe (nombre
   único con fecha y hora) y hace `COPY_ONLY ... WITH CHECKSUM, COMPRESSION`.
4. Debe terminar con `RESPALDO COMPLETO y VERIFICADO: <ruta>`; la verificación
   es un `RESTORE VERIFYONLY` (no restaura la base).
5. El script muestra al final una fila con `base`, `inicio`, `fin`,
   `es_copy_only`, `bytes_en_disco` y `archivo`. Guarde esa ruta: es el punto de
   recuperación.

### Confirmar existencia y tamaño del `.bak` (solo lectura)

Desde el catálogo de SQL Server (no requiere acceso al sistema de archivos):

```sql
SELECT TOP (1) mf.physical_device_name AS archivo,
       bs.backup_size AS bytes_sin_comprimir,
       bs.compressed_backup_size AS bytes_en_disco,
       bs.backup_finish_date AS fecha
FROM msdb.dbo.backupset AS bs
INNER JOIN msdb.dbo.backupmediafamily AS mf ON mf.media_set_id = bs.media_set_id
WHERE bs.database_name = N'SIFHA_Tickets_M5_Validation'
ORDER BY bs.backup_finish_date DESC;
```

Si SSMS corre en el propio `TI-DESK-01`, también puede comprobarse el archivo:

```powershell
Get-Item 'D:\copias\ticket\SIFHA_Tickets_M5_Validation_FULL_*.bak' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName, Length, LastWriteTime
```

## 2. Diagnóstico de solo lectura (antes)

Desde `D:\ticket\backend`, sin tocar `.env` y sin mostrar secretos (las
credenciales se leen de `.env` con `--env-file-if-exists`; las variables de
entorno tienen prioridad y fijan el destino M5):

```powershell
$env:DB_CLIENT='mssql'
$env:DB_SERVER='100.100.4.60'
$env:DB_INSTANCE='SIFHADEV'
$env:DB_DATABASE='SIFHA_Tickets_M5_Validation'
$env:MIGRATION_TARGET_DATABASE='SIFHA_Tickets_M5_Validation'
$env:DB_ENCRYPT='true'
$env:DB_TRUST_SERVER_CERTIFICATE='true'
node --env-file-if-exists=.env scripts/migration/diagnose-m5-validation.js
Remove-Item Env:\DB_CLIENT, Env:\DB_SERVER, Env:\DB_INSTANCE, Env:\DB_DATABASE, Env:\MIGRATION_TARGET_DATABASE, Env:\DB_ENCRYPT, Env:\DB_TRUST_SERVER_CERTIFICATE
```

Antes del fix se esperan **exactamente dos** bloqueos:

- `dbo.notifications.organization_id es NOT NULL y el esquema lo declara NULL`
- `falta la restricción CK_notifications_ticket_requires_org en dbo.notifications`

Códigos de salida: `0` sin bloqueos, `1` con bloqueos, `2` destino rechazado,
`3` error de conexión/ejecución.

Además, en SSMS ejecute
`backend/scripts/migration/m5-notifications-readonly.sql` (solo lectura) y
anote el `total_notificaciones` (debe ser 26) y la `huella` (checksum). Son la
referencia para demostrar que el cambio de esquema no altera los datos.

## 3. Aplicar la corrección

En SSMS, conectado a `SIFHA_Tickets_M5_Validation`, abrir y ejecutar el script
completo (o usar `sqlcmd`). Es **idempotente y transaccional**:

- Verifica servidor, instancia y base; si no coinciden, aborta sin cambios.
- Audita dependencias que impedirían el `ALTER COLUMN`.
- Rechaza datos anómalos (notificación con ticket y organización NULL, o
  destinatario NULL que no sea SUPERADMIN global legítimo).
- En una sola transacción: pasa `organization_id` a `NULL` y crea
  `CK_notifications_ticket_requires_org`.

Opción `sqlcmd` (pide la contraseña de forma interactiva; NO se escribe en el
repositorio):

```powershell
sqlcmd -S "TI-DESK-01\SIFHADEV" -d "SIFHA_Tickets_M5_Validation" ``
       -U sifha_migration_dev ``
       -i .\backend\scripts\migration\notifications-organization-nullable.sql
```

Al terminar debe imprimir:
`OK: dbo.notifications.organization_id admite NULL y CK_notifications_ticket_requires_org esta activo y confiable.`

## 4. Validación posterior

Repetir el paso 2 (diagnóstico de solo lectura). Ahora el resultado debe ser
`status: pass` y `exit_code: 0`, sin diferencias bloqueantes y con integridad de
datos correcta.

Volver a ejecutar `m5-notifications-readonly.sql` y comprobar que:

- `total_notificaciones` sigue siendo 26 (o el valor anotado antes);
- la `huella` es idéntica a la anterior;
- `organization_id_admite_null` = 1;
- `en_primary_key` = 0 y `default_constraint` = NULL;
- la fila del CHECK aparece con `deshabilitada` = 0 y `no_confiable` = 0.

## 5. Reversión (solo si fuera necesaria)

```sql
ALTER TABLE dbo.notifications DROP CONSTRAINT CK_notifications_ticket_requires_org;

-- Solo si NO quedan filas con organization_id NULL:
ALTER TABLE dbo.notifications ALTER COLUMN organization_id INT NOT NULL;
```

O restaurar la copia del paso 1 (`RESTORE DATABASE ... WITH RECOVERY`).

## 6. Activar el runtime MSSQL

Solo después de un diagnóstico en código 0 y con autorización explícita:

```
MSSQL_RUNTIME=true
DB_CLIENT=mssql
```

El arranque MSSQL **no** migra, no siembra y no restaura instantáneas: solo
valida el esquema (solo lectura) y, si falla, no abre el puerto HTTP.
