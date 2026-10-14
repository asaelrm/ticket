# Guía SSMS — Aplicar permisos de SQL Server (sesión de administrador)

Guía operativa, lista para copiar y pegar, para que un **administrador
autorizado** deje la base `SIFHA_Tickets_DEV` (servidor
`TI-DESK-01\SIFHADEV` / `100.100.4.60,1433`) con los permisos correctos.

- **Cuenta de aplicación** (`sifha_ticket_dev`): permisos operativos de **mínimo
  privilegio** (SELECT/INSERT/UPDATE/DELETE por tabla, según el uso real).
- **Cuenta de solo lectura del Grupo E** (`sifha_group_e`): **exclusivamente
  `SELECT`**, para validación sin riesgo de escritura.

> Requisitos: SSMS conectado con una cuenta con **`db_owner`** (o miembro de
> `db_securityadmin` con `CONTROL`) en `SIFHA_Tickets_DEV`. **No usar `sa`.**
> Las contraseñas las gestiona el administrador y **no** se guardan en el
> repositorio. Ejecutar **siempre** conectado a `SIFHA_Tickets_DEV`: los scripts
> abortan si la base o la instancia no coinciden.

---

## Parte A — Cuenta de aplicación `sifha_ticket_dev`

Script: `backend/scripts/migration/grant-app-account-minimal.sql`
(DRY-RUN por defecto: `@apply = 0`).

### A.1 Prerrequisito: el usuario de base debe existir

El script exige que exista el **usuario** `sifha_ticket_dev`; si no existe,
aborta con `NO-GO`. Si el login ya existe en el servidor (es el caso: la app
conecta con él), basta con crear el usuario de base. **Conectado a
`SIFHA_Tickets_DEV`:**

```sql
IF USER_ID(N'sifha_ticket_dev') IS NULL
    CREATE USER [sifha_ticket_dev] FOR LOGIN [sifha_ticket_dev];
```

> Si el **login** tampoco existiera, créelo primero en `master` (nivel servidor):
> ```sql
> CREATE LOGIN [sifha_ticket_dev] WITH PASSWORD = N'<gestionada por el admin>',
>     CHECK_POLICY = ON, CHECK_EXPIRATION = ON, DEFAULT_DATABASE = [SIFHA_Tickets_DEV];
> ```

### A.2 Ejecutar el script de permisos

1. Conectado a `SIFHA_Tickets_DEV`, abrir
   `backend/scripts/migration/grant-app-account-minimal.sql`.
2. (Opcional) Primero en seco para revisar: dejar `@apply = 0` y ejecutar.
   Verá la lista de `GRANT` que se aplicarán, sin cambios.
3. Cambiar en el encabezado del script:

```sql
DECLARE @apply BIT = 1;          -- 0 = DRY-RUN, 1 = aplica
DECLARE @revoke_extra BIT = 0;   -- 1 = además REVOKE del DML sobrante (mínimo privilegio estricto)
```

   - `@revoke_extra = 1` retira `SELECT/INSERT/UPDATE/DELETE` sobrantes en las 24
     tablas (p. ej. un `departments.DELETE` heredado). Alcance acotado: **solo** las
     24 tablas y esos 4 permisos; no toca referencias, `EXECUTE` ni objetos fuera
     del mapa. Úselo si quiere el mínimo privilegio estricto.
4. Ejecutar el script completo.

### A.3 Resultado esperado

- Se imprimen los `GRANT` **APLICADOS** por tabla.
- La consulta final de roles debe dar **0** en las cuatro columnas:
  `app_es_dbowner = 0`, `app_es_ddladmin = 0`, `app_es_datawriter = 0`,
  `app_es_datareader = 0`.
- Reutilizable: los `GRANT` son idempotentes (re-ejecutar no acumula permisos).

Cobertura del mapa (tabla → operaciones), **solo** lo que el backend ejecuta:

| Tabla | Operaciones |
|---|---|
| `organizations`, `departments`, `categories`, `users`, `canned_responses`, `kb_categories`, `kb_articles` | SELECT, INSERT, UPDATE |
| `permissions`, `roles` | SELECT |
| `role_permissions`, `team_members`, `ticket_comments`, `ticket_attachments`, `kb_ticket_articles` | SELECT, INSERT, DELETE |
| `teams`, `tickets`, `notifications` | SELECT, INSERT, UPDATE, DELETE |
| `ticket_history`, `email_logs`, `kb_article_history` | SELECT, INSERT |
| `sessions` | SELECT, INSERT, UPDATE, DELETE |
| `sequences`, `settings`, `org_settings` | SELECT, INSERT, UPDATE |

---

## Parte B — Cuenta de solo lectura del Grupo E `sifha_group_e`

Script: `backend/scripts/migration/create-groupE-readonly-account.sql`
(DRY-RUN por defecto). El script **crea el usuario de base** a partir de un login
existente, pero **no crea el login** (lo hace el administrador).

### B.1 Crear el login (nivel servidor, en `master`)

```sql
CREATE LOGIN [sifha_group_e] WITH PASSWORD = N'<gestionada por el admin>',
    CHECK_POLICY = ON, CHECK_EXPIRATION = ON, DEFAULT_DATABASE = [SIFHA_Tickets_DEV];
```

### B.2 Ejecutar el script

1. Conectado a `SIFHA_Tickets_DEV`, abrir
   `backend/scripts/migration/create-groupE-readonly-account.sql`.
2. Ajustar en el encabezado:

```sql
DECLARE @create_user_if_missing BIT = 1;  -- crea el usuario de base si falta
DECLARE @grant_view_definition BIT = 0;   -- 1 = concede VIEW DEFINITION (catalogo)
DECLARE @apply BIT = 1;                   -- 0 = DRY-RUN, 1 = aplica
```

3. Ejecutar el script completo.

### B.3 Resultado esperado

- Se imprimen los `GRANT SELECT` **APLICADOS** por tabla (24 tablas).
- Indicadores de rol global en **0**: `es_dbowner = 0`, `es_ddladmin = 0`,
  `es_datawriter = 0`, `es_datareader = 0`.
- **No** otorga INSERT/UPDATE/DELETE, ni DDL, ni roles globales.

Con esta cuenta puede ejecutarse el «arranque en seco» del Grupo E sin escrituras
(ver `docs/GRUPO-E-VALIDACION.md`).

---

## Parte C — `RESTORE VERIFYONLY` del respaldo M5

Respaldo (registrado en `msdb`, `is_copy_only = 1`, 11 624 448 bytes sin
comprimir / 782 771 bytes en disco):

```
C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak
```

### C.1 Requisitos

- **Permiso `CREATE DATABASE`** (rol `dbcreator` o `sysadmin`). La cuenta de la
  app **no** lo tiene (`HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') = 0`),
  por eso `RESTORE VERIFYONLY` falla hoy con **Msg 3013 / 262**.
- La cuenta (o el servicio SQL Server) debe poder **leer** la ruta del `.bak`
  (ruta **local del servidor**, no del equipo cliente).

### C.2 Comando (SSMS, cualquier base o `master`)

```sql
RESTORE VERIFYONLY
    FROM DISK = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak'
    WITH CHECKSUM;
```

Si termina con *«The backup set on file 1 is valid»*, el respaldo es legible y
coherente (VERIFYONLY **no** restaura ni escribe datos).

### C.3 Comprobación adicional (opcional, solo lectura)

```sql
RESTORE HEADERONLY
    FROM DISK = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak';

RESTORE FILELISTONLY
    FROM DISK = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak';
```

---

## Parte D — Verificación y reversión

### D.1 Verificar permisos resultantes (solo lectura)

```sql
-- Permisos explícitos de cada cuenta.
SELECT o.name AS tabla, p.permission_name AS permiso, p.state_desc AS estado
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE p.grantee_principal_id = USER_ID(N'sifha_ticket_dev')
  AND p.class = 1
ORDER BY o.name, p.permission_name;

SELECT o.name AS tabla, p.permission_name AS permiso, p.state_desc AS estado
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE p.grantee_principal_id = USER_ID(N'sifha_group_e')
  AND p.class = 1
ORDER BY o.name, p.permission_name;

-- Ninguna de las dos debe pertenecer a roles globales.
SELECT principal, IS_ROLEMEMBER(N'db_owner', principal) AS owner,
       IS_ROLEMEMBER(N'db_datawriter', principal) AS writer,
       IS_ROLEMEMBER(N'db_datareader', principal) AS reader
FROM (VALUES (N'sifha_ticket_dev'), (N'sifha_group_e')) AS v(principal);
```

### D.2 Reversión

```sql
-- Cuenta de aplicación: revocar el DML concedido (repetir por tabla/operación).
REVOKE SELECT, INSERT, UPDATE, DELETE ON dbo.tickets FROM [sifha_ticket_dev];

-- Cuenta de solo lectura: revocar SELECT y, si procede, quitar el usuario.
REVOKE SELECT ON dbo.tickets FROM [sifha_group_e];
-- DROP USER [sifha_group_e];
-- DROP LOGIN [sifha_group_e];
```

---

## Resumen de operaciones administrativas preparadas

| # | Operación | Nivel | Script / comando | Estado |
|---|---|---|---|---|
| 1 | Crear/confirmar usuario de la app | Base | `CREATE USER ... FOR LOGIN` (Parte A.1) | Pendiente (admin) |
| 2 | Aplicar permisos de la app | Base | `grant-app-account-minimal.sql` con `@apply = 1` | Pendiente (admin) |
| 3 | Crear login de solo lectura | Servidor | `CREATE LOGIN [sifha_group_e] ...` (Parte B.1) | Pendiente (admin) |
| 4 | Aplicar SELECT de solo lectura | Base | `create-groupE-readonly-account.sql` con `@apply = 1` | Pendiente (admin) |
| 5 | Verificar el respaldo M5 | Servidor | `RESTORE VERIFYONLY ... WITH CHECKSUM` (Parte C.2) | Pendiente (admin) |

Ninguna de estas operaciones se ha ejecutado: requieren una sesión de
administrador autorizada. Los scripts están en modo DRY-RUN por defecto.
