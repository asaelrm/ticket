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

Ruta de copias fuera del repositorio (por ejemplo `D:\copias\ticket\`). En SSMS,
conectado a `SIFHA_Tickets_M5_Validation`:

```sql
BACKUP DATABASE [SIFHA_Tickets_M5_Validation]
  TO DISK = N'D:\copias\ticket\SIFHA_M5_FULL_AAAAMMDD_HHMM.bak'
  WITH COPY_ONLY, INIT, CHECKSUM, COMPRESSION, STATS = 5;

RESTORE VERIFYONLY
  FROM DISK = N'D:\copias\ticket\SIFHA_M5_FULL_AAAAMMDD_HHMM.bak'
  WITH CHECKSUM;
```

`RESTORE VERIFYONLY` debe terminar con "the backup set on file 1 is valid".

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
