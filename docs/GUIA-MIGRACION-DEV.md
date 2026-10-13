# Guía operativa de migración — `SIFHA_Tickets_DEV`

**Fecha:** 2026-10-13
**Rama:** `integracion-casa-oficina-11oct`
**Commit base:** `7723d87` (publicado) + serie local de cierre
**Servidor / instancia / base destino:** `TI-DESK-01\SIFHADEV` / `SIFHADEV` / `SIFHA_Tickets_DEV`
**Plan técnico de referencia:** `docs/PLAN-RECONCILIACION-DEV.md` (autoridad de detalle)
**Procedimiento M5 de referencia:** `M5-PROCEDIMIENTO-WINDOWS.md`

> Esta guía **no ejecuta** nada sobre SQL Server. Consolida el orden, las
> dependencias, el respaldo, la recuperación, los criterios GO/NO-GO y el
> checklist de entrega. No inventa scripts: todos los archivos citados existen en
> el repositorio y se indican por su ruta real.

---

## 0. Principio rector: migración dirigida por estado

El plan original (`docs/PLAN-RECONCILIACION-DEV.md`) partía de un estado legacy de
**6 tablas**. El preflight de solo lectura del 2026-10-13 (`docs/ESTADO-ENTREGA.md`
§12.3) mostró que `SIFHA_Tickets_DEV` responde con **24/24 tablas visibles** y
`notifications.organization_id` **ya NULL-able**, con
`departments.organization_id` aún **NULL-able**.

Por tanto, **no se debe asumir que una fase está pendiente**: antes de aplicar
cualquier grupo hay que **leer el estado real** con los verificadores e **omitir
aquellas fases cuyo veredicto ya sea `GO`**. Los verificadores son 100 % `SELECT`
y pueden ejecutarse con antelación sin efectos.

Regla de oro: **verificador primero, DDL después**. Si un verificador ya está
`GO`, esa fase **no se ejecuta** (se documenta el salto).

---

## 1. Inventario de scripts (rutas reales)

### 1.1 Migración por grupos (DEV)

| Grupo | Script | Escribe | Destino | Rol |
|---|---|---|---|---|
| A (simulación) | `backend/scripts/migration/reconcile-dev-draft.sql` (los 6 interruptores en `0`) | No | DEV | Ensayo de solo lectura |
| B (DDL aditivo) | `backend/scripts/migration/reconcile-dev-draft.sql` (config B) | Sí (DDL) | DEV | Reconciliación del esquema |
| B (fix puntual) | `backend/scripts/migration/fix-users-department-same-org.sql` | Sí (DDL) | DEV | Crea solo `FK_users_department_same_org` si B1 = NO-GO por esa FK |
| C (backfill) | `backend/scripts/migration/backfill-organization-CMUCE.sql` | Sí (datos) | DEV | CMUCE + 25 deptos + usuario id 4 |
| C (backfill, alternativa) | `backend/scripts/migration/reconcile-dev-draft.sql` (config C) | Sí (datos) | DEV | Fase 7 del borrador |
| D (endurecimiento) | `backend/scripts/migration/apply-groupD-not-null.sql` | Sí (DDL) | DEV | `departments.organization_id` → `NOT NULL` |
| D (endurecimiento, alternativa) | `backend/scripts/migration/reconcile-dev-draft.sql` (config D) | Sí (DDL) | DEV | Fase 8 del borrador |

### 1.2 Verificadores y diagnóstico (solo lectura)

| Script | Para qué | Escribe |
|---|---|---|
| `backend/scripts/migration/diagnose-dev-account-readonly.sql` | Permisos de la cuenta + visibilidad de metadatos + nulabilidad de columnas diana | No |
| `backend/scripts/migration/reconcile-dev-inventory.sql` | Diff real de esquema contra `schema.sql` (tipos, nulabilidad, IDENTITY, restricciones, índices) | No |
| `backend/scripts/migration/verify-after-groupB.sql` | Estado post-B (24 tablas, 96 filas, NULL 1/25, longitudes, UQ/FK/IX) | No |
| `backend/scripts/migration/verify-after-groupC.sql` | Estado post-C (24 tablas, 97 filas, CMUCE=1, 25/1 asignados, NULL 0/0) | No |
| `backend/scripts/migration/verify-after-groupD.sql` | Estado post-D (97 filas, `departments.organization_id` `NOT NULL`) | No |
| `backend/scripts/migration/verify-final-reconciliation.sql` | Estado reconciliado final (97 filas, paridad canónica, ADMIN id 4, 0 huérfanos) | No |

### 1.3 M5 (corrección de `dbo.notifications`)

| Script | Destino | Escribe |
|---|---|---|
| `backend/scripts/migration/notifications-organization-nullable.sql` | **Exclusivo `SIFHA_Tickets_M5_Validation`** (aborta en DEV) | Sí (DDL) |
| `backend/scripts/migration/backup-m5.sql` | **Exclusivo `SIFHA_Tickets_M5_Validation`** | Sí (BACKUP) |
| `backend/scripts/migration/m5-notifications-readonly.sql` | **Exclusivo `SIFHA_Tickets_M5_Validation`** | No |
| `backend/scripts/migration/diagnose-m5-validation.js` | Diagnóstico M5 (Node) | No |

> **Importante (M5 en DEV):** no existe un script M5 específico para
> `SIFHA_Tickets_DEV`; los de M5 están **sellados** a `SIFHA_Tickets_M5_Validation`
> y abortan en cualquier otra base. En DEV el objetivo M5 se comprueba por
> **lectura** (columna y CHECK) dentro de los verificadores; ver §4.12.

### 1.4 Scripts reservados a la base scratch (NO usar en DEV)

`prepare-groupD-scratch-test.sql`, `prepare-groupD-scratch-test-final.sql`,
`apply-groupD-not-null-scratch-test.sql`, `apply-groupD-not-null-scratch-test-authorized.sql`,
`verify-after-groupD-scratch-test.sql`, `verify-final-reconciliation-scratch-test.sql`,
`configure-groupD-scratch-runner.sql`, `inventory-groupD-scratch-test.sql`,
`diagnose-groupD-unique-blocker.sql`, `check-groupD-scratch-after-*.sql`.
Operan sobre `SIFHA_GroupD_ScratchTest` (ya certificada; ver `docs/ESTADO-ENTREGA.md` §5.4).

### 1.5 Borradores históricos superados (NO ejecutar)

`backend/scripts/migration/reconcile-dev-draft-corregido (1).sql` y
`reconcile-dev-draft-corregido-v2.sql`. Se conservan por trazabilidad; su única
corrección válida ya está consolidada en `reconcile-dev-draft.sql`.

---

## 2. Orden, dependencias, prerrequisitos y GO/NO-GO (Fase 2)

### 2.1 Orden exacto de ejecución

```
[0]  Diagnóstico de solo lectura (obligatorio primero)
       diagnose-dev-account-readonly.sql + reconcile-dev-inventory.sql
       + verify-after-groupB.sql + verify-after-groupC.sql
       + verify-after-groupD.sql + verify-final-reconciliation.sql
       |  -> Decidir qué fases faltan según el veredicto de cada verificador.
[1]  Respaldo completo verificado de SIFHA_Tickets_DEV  (Fase 3)
[2]  M5 (DEV): verificación de solo lectura de notifications  (§4.12)
[3]  B  -> verify-after-groupB.sql          (solo si B no estaba GO)
[3b] fix-users-department-same-org.sql      (solo si B1 = NO-GO por esa FK)
[4]  C  -> verify-after-groupC.sql          (solo si C no estaba GO)
[5]  D  -> verify-after-groupD.sql          (solo si D no estaba GO)
[6]  E  -> verify-final-reconciliation.sql  + arranque en seco (solo lectura)
```

### 2.2 Dependencias entre fases

- **C no puede ejecutarse sin B** (necesita `organization_id` y las UQ compuestas).
- **D no puede ejecutarse sin C** (aborta si queda algún `departments.organization_id` NULL).
- **La FK compuesta `FK_users_department_same_org` pertenece a B**; si falta, se corrige con `fix-users-department-same-org.sql` **antes** de C.
- **B y A y E son repetibles/idempotentes**; C y D también son idempotentes pero C y D exigen B.
- **E (arranque)** debe correr **después** del verificador final y **antes** de cualquier login real (el login crea filas en `sessions` y altera el conteo de 97).

### 2.3 Prerrequisitos comunes

- Cuenta con `db_owner`/`db_ddladmin` o `ALTER ON SCHEMA::dbo` (preflight `GO`).
- Cuenta con `BACKUP DATABASE` (o `sysadmin`/`db_backupoperator`) para el respaldo.
- **Ventana de mantenimiento** con el **backend detenido** (los `ALTER` toman `SCH-M`).
- Respaldo completo verificado (§3).
- Autorización humana expresa para las fases que escriben.

### 2.4 Criterios GO/NO-GO (resumen; detalle en el plan §18)

| Hito | GO | NO-GO |
|---|---|---|
| Preflight | `puede_ejecutar_secuencia = GO`, 24/24 tablas | cuenta sin DDL o base/instancia distinta |
| B | `DDL ADITIVO (fases 1-6 y 2b) confirmado.` + `VERIFICACION POSTERIOR: OK` (96) + `VERIFICADOR POST-B: GO` | `RAISERROR`/rollback, registros ≠ 96, longitudes ≠ 9/9, `NO-GO` |
| C | `departments asignados = 25` + `users asignados = 1` + `VERIFICADOR POST-C: GO` | rol SUPERADMIN/global, conteos ≠ 25/1, `NO-GO` |
| D | `Fase 8: departments.organization_id es NOT NULL.` + `VERIFICADOR POST-D: GO` | quedan NULL, `NO-GO` |
| E | `VERIFICADOR FINAL: GO` + `schemaValidator` OK + `GET` de lectura 200 | `NO-GO`, diff de esquema, arranque sin HTTP, `5xx` |

**Regla permanente:** ante cualquier `NO-GO`, **detener la secuencia**, documentar y
escalar; nunca forzar interruptores ni continuar a la fase siguiente.

### 2.5 Riesgos y reversibilidad por fase

| Fase | Riesgo principal | Reversibilidad |
|---|---|---|
| B | Error 2b (datos más largos que el objetivo) o 3 (duplicados) | `TRY/CATCH` + `XACT_ABORT` → **rollback** automático; base intacta |
| B (fix FK) | FK ya existente / huérfanos | Idempotente; transacción |
| C | Backfill con organización equivocada / violar UQ de nombre | `sp_getapplock` + transacción atómica → rollback; si ya hizo `COMMIT`, **restaurar respaldo** |
| D | Quedan NULL o dependencias inesperadas | Transacción → rollback; tras `COMMIT`, **restaurar respaldo** |
| E | Diff no previsto en `schemaValidator` | Solo lectura; no revierte nada (se corrige antes de promocionar) |

- **Ventana de mantenimiento:** obligatoria para B/C/D (backend detenido). E puede
  hacerse con el arranque controlado en seco.
- **Bloqueos posibles:** cuenta sin DDL; `departments` con nombres duplicados
  (bloquea C); datos más largos que el objetivo (bloquea B/2b); estadísticas
  manuales sobre `organization_id` (bloquea D); respaldo no accesible desde el
  servidor.
- **Reversibilidad global:** la red de recuperación es el **respaldo verificado**
  (§3). Las fases 2b/C/D **no** se revierten por DDL manual fiable: se restauran
  con el `.bak`.

---

## 3. Respaldo y recuperación (Fase 3) — procedimiento SSMS

> No existe un script de respaldo específico de `SIFHA_Tickets_DEV` en el
> repositorio (`backup-m5.sql` es exclusivo de `SIFHA_Tickets_M5_Validation`).
> El respaldo de DEV se hace con SSMS o `sqlcmd` (bloques de abajo). **Estos
> comandos NO se ejecutan en esta sesión.**

### 3.0 Confirmar servidor, instancia y base (solo lectura)

```sql
SELECT
    DB_NAME()                                              AS base_actual,
    SUSER_SNAME()                                          AS login,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))   AS servidor,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName')) AS instancia;
```

Debe devolver `SIFHA_Tickets_DEV` / `TI-DESK-01\SIFHADEV` / `SIFHADEV`.

### 3.1 Respaldo completo exclusivo de `SIFHA_Tickets_DEV`

Puede usarse el script preparado `scripts/backup-central.ps1` (respaldo
centralizado del repositorio) o el bloque SSMS:

```sql
DECLARE @stamp NVARCHAR(20) = FORMAT(SYSUTCDATETIME(), N'yyyyMMdd_HHmmss');
DECLARE @file  NVARCHAR(4000) =
    N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\'
  + N'SIFHA_Tickets_DEV_FULL_' + @stamp + N'.bak';

BACKUP DATABASE [SIFHA_Tickets_DEV]
  TO DISK = @file
  WITH COPY_ONLY, INIT, CHECKSUM, COMPRESSION, STATS = 5;

SELECT @file AS archivo_respaldo;   -- ANOTAR esta ruta local del servidor
```

- `COPY_ONLY`: no altera la cadena de respaldos.
- Nombre único por fecha/hora: **nunca sobrescribir**.
- Anotar ruta local del servidor + hora (se usará en el `RESTORE`).

### 3.2 Verificar el respaldo con `RESTORE VERIFYONLY`

```sql
RESTORE VERIFYONLY
  FROM DISK = N'<ruta_local_del_.bak>'
  WITH CHECKSUM;
```

Debe terminar sin error (`The backup set on file ... is valid`). `VERIFYONLY`
**no restaura** la base. Anotar el resultado en el log de ejecución.

### 3.3 Comprobar integridad de la base (`DBCC CHECKDB`)

Requiere permisos elevados y **ventana autorizada** (consume recursos). Ejecutar
**solo si la ventana lo permite**:

```sql
DBCC CHECKDB (N'SIFHA_Tickets_DEV') WITH NO_INFOMSGS, ALL_ERRORMSGS;
```

Si no hay ventana, se documenta como omisión consciente y se confía en
`VERIFYONLY`.

### 3.4 Copia externa y hash (evidencia)

Copiar el `.bak` fuera del servidor y registrar el **SHA-256**:

```powershell
Get-FileHash -Algorithm SHA256 "<ruta_externa>\SIFHA_Tickets_DEV_FULL_<stamp>.bak"
```

> Nota crítica de rutas: SQL Server **solo** lee rutas locales del servidor. La
> copia externa **no** es válida en un `FROM DISK`; para restaurar desde la copia
> externa hay que copiarla primero a una ruta local del servidor y revalidar el
> hash.

### 3.5 Plan de recuperación

Pre-`COMMIT` (fallo en B/C/D): el `TRY/CATCH` ya revirtió; **no hay nada que
restaurar**, solo documentar.

Post-`COMMIT` (verificador `NO-GO`): **decisión explícita y autorizada del
auditor**. Restaurar siempre desde la **ruta local** del `.bak` verificado, con el
backend detenido:

```sql
RESTORE DATABASE [SIFHA_Tickets_DEV]
  FROM DISK = N'<ruta_local_del_.bak_verificado>'
  WITH REPLACE, RECOVERY, CHECKSUM;
```

Después: `RESTORE VERIFYONLY` y re-ejecutar `verify-after-groupB.sql` para
confirmar el estado de partida.

Respaldos históricos registrados (referencia): `SIFHA_Tickets_DEV_PreReconciliacion_20261011.bak`
y `SIFHA_Tickets_DEV_PreGrupoD_20261012.bak` (este último usado para recrear el
scratch). SHA-256 del de reconciliación:
`C6057D038074070973F2D9D473C431F6D6B9823567D02484E9F0C35B6DFCB69A`.

### 3.6 Criterios para detener la migración

Detener y escalar si: la base/instancia no coinciden; no hay respaldo verificado;
un verificador da `NO-GO`; aparece un `RAISERROR`; el backend sigue vivo; el log
no se puede firmar; o la ventana de mantenimiento no está confirmada.

---

## 4. Guía administrativa paso a paso (Fase 4)

Convención de interruptores en `reconcile-dev-draft.sql` (sección
"PARAMETROS E INTERRUPTORES"): `@AuthorizeDdl`, `@BackupVerified`,
`@AuthorizeBackfill`, `@BackfillDepartments`, `@BackfillUsers`,
`@MakeDepartmentsNotNull`.

### Paso 1 — Diagnóstico previo (solo lectura)

1. Conectar en SSMS a `TI-DESK-01\SIFHADEV`, base `SIFHA_Tickets_DEV`, con la
   cuenta privilegiada (`cmucesd\lrosario` o `sa`).
2. Ejecutar `backend/scripts/migration/diagnose-dev-account-readonly.sql`.
   Esperado: `puede_ejecutar_secuencia = GO`.
3. Ejecutar `backend/scripts/migration/reconcile-dev-inventory.sql` (diff de esquema).
4. Ejecutar **los cuatro verificadores** para conocer el estado real:
   `verify-after-groupB.sql`, `verify-after-groupC.sql`, `verify-after-groupD.sql`,
   `verify-final-reconciliation.sql`.
5. **Decisión:** anotar qué verificadores ya están `GO`. Las fases ya `GO` se
   **omiten** (se documenta el salto).

### Paso 2 — Respaldo (Fase 3)

Ejecutar §3.1 y §3.2. No continuar sin `VERIFYONLY` correcto y ruta anotada.

### Paso 3 — Verificación del respaldo

Confirmar el resultado de `RESTORE VERIFYONLY` (§3.2) y registrar ruta + hash.

### Paso 4 — Migración B (solo si `verify-after-groupB.sql` = NO-GO/pre-B)

- **Opción recomendada (script único):** `reconcile-dev-draft.sql` en **config B**:
  `@AuthorizeDdl=1`, `@BackupVerified=1`; los otros cuatro en `0`.
- **Alternativa:** no aplica (B no tiene script independiente; el borrador es la vía).
- Ejecutar con `sqlcmd -b` o SSMS **F5**, backend detenido. Volcar a `run_B.log`.
- Una sola transacción; ante error, rollback automático.

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\reconcile-dev-draft.sql -o run_B.log
```

### Paso 5 — Verificador B

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\verify-after-groupB.sql -o verify-B.log
```

Esperado: `VERIFICADOR POST-B: GO` (24 tablas, 96 filas, NULL 1/25, 9/9 longitudes,
20 UQ, 30 FK, 23 IX). Si `NO-GO` **solo** por `FK_users_department_same_org`:
ejecutar `fix-users-department-same-org.sql` y **repetir este paso** (no restaurar).

### Paso 6 — Migración C (solo si `verify-after-groupC.sql` = NO-GO)

- **Opción recomendada (autocontenida):**
  `backend/scripts/migration/backfill-organization-CMUCE.sql` con
  `@AuthorizeBackfill=1` y `@BackupVerified=1`.
- **Alternativa:** `reconcile-dev-draft.sql` en config C
  (`@AuthorizeDdl=1`, `@BackupVerified=1`, `@AuthorizeBackfill=1`,
  `@BackfillDepartments=1`, `@BackfillUsers=1`, `@MakeDepartmentsNotNull=0`).
- Esperado: CMUCE reutilizada/creada, `departments asignados = 25`,
  `users asignados = 1` (solo id 4), `GRUPO C: GO`.

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\backfill-organization-CMUCE.sql -o run_C.log
```

### Paso 7 — Verificador C

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\verify-after-groupC.sql -o verify-C.log
```

Esperado: `VERIFICADOR POST-C: GO` (97 filas, CMUCE=1, NULL 0/0, 0 huérfanos;
usuario id 4 con `role_id=7`, `department_id=68`). Solo con `GO` se desbloquea D.

### Paso 8 — Migración D (solo si `verify-after-groupD.sql` = NO-GO)

- **Opción recomendada (autocontenida):**
  `backend/scripts/migration/apply-groupD-not-null.sql` con `@AuthorizeDdl=1` y
  `@BackupVerified=1` (idempotente; gestiona las UQ/FK dependientes en la misma
  transacción).
- **Alternativa:** `reconcile-dev-draft.sql` config D
  (`@AuthorizeDdl=1`, `@BackupVerified=1`, `@MakeDepartmentsNotNull=1`; datos en `0`).
- Esperado: `departments.organization_id` `NOT NULL`, `GRUPO D: GO`.

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\apply-groupD-not-null.sql -o run_D.log
```

### Paso 9 — Verificador D

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\verify-after-groupD.sql -o verify-D.log
```

Esperado: `VERIFICADOR POST-D: GO` (97 filas, `departments.organization_id`
`INT NOT NULL`, `users.organization_id` NULL-able, 0 huérfanos).

### Paso 10 — Migración E

No hay DDL: es la **verificación final** (Paso 11) + arranque en seco (Paso 12).
No ejecutar el borrador en E. El grupo E no escribe.

### Paso 11 — Verificador E (verificador final)

```
sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b ^
  -i backend\scripts\migration\verify-final-reconciliation.sql -o verify-final.log
```

Esperado: `VERIFICADOR FINAL: GO` (24/24 tablas, 97 registros, CMUCE=1, NULL 0/0,
`departments.organization_id` NOT NULL, `users.organization_id` NULL-able, 9/9
longitudes, UQ/FK/IX completas, 0 huérfanos, usuario ADMIN id 4 conservado).
Este es el **punto de control E1**.

### Paso 12 — M5 en DEV (verificación, no DDL)

En `SIFHA_Tickets_DEV` el objetivo M5 es que `notifications.organization_id` sea
`NULL`-able y exista `CK_notifications_ticket_requires_org`. El preflight ya
confirmó la nulabilidad. Comprobar por lectura:

```sql
SELECT COLUMNPROPERTY(OBJECT_ID(N'dbo.notifications'), N'organization_id', N'AllowsNull') AS permite_null,
       OBJECT_ID(N'dbo.notifications') AS tabla,
       (SELECT COUNT(*) FROM sys.check_constraints
         WHERE parent_object_id = OBJECT_ID(N'dbo.notifications')
           AND name = N'CK_notifications_ticket_requires_org'
           AND is_disabled = 0 AND is_not_trusted = 0) AS check_activo_confiable;
```

- Si `permite_null = 1` **y** `check_activo_confiable = 1` → **M5 cumplido en DEV;
  no ejecutar nada** (los scripts de M5 son exclusivos de `SIFHA_Tickets_M5_Validation`).
- Si falta el CHECK o la columna no es `NULL`-able → **detener y escalar**: no hay
  script M5 aplicable a DEV (los existentes abortan en DEV) y crear uno sería una
  tarea nueva que requiere autorización.

### Paso 13 — Pruebas funcionales posteriores (solo lectura)

Con el backend en modo MSSQL (`DB_CLIENT=mssql`, `MSSQL_RUNTIME=true`,
`DB_DATABASE=SIFHA_Tickets_DEV`, credenciales por entorno):

1. Arrancar (`npm start`), capturar salida en `backend-start.log`. Esperado:
   `[db] Esquema SQL Server verificado (solo lectura): 24 tablas y N columnas.` +
   `[ticket] API escuchando en http://localhost:<puerto>`.
2. `GET /api/health` → `200`.
3. `GET /api/departments`, `GET /api/roles`, `GET /api/categories` → `200`/JSON.
4. `GET /api/auth/me` solo con sesión (advertencia: el login crea una fila en
   `sessions`; hacerlo **después** del verificador final y no usarlo para conteos).
5. **Nada** de `POST/PUT/PATCH/DELETE` institucionales durante la validación.

---

## 5. Checklist de entrega al equipo de infraestructura (Fase 5)

### 5.1 Variables de entorno requeridas (sin valores secretos)

Obligatorias en producción: `NODE_ENV=production`, `SESSION_SECRET` (32+
caracteres), `PUBLIC_URL`, `CORS_ORIGIN(S)`, `COOKIE_SECURE=true` (tras HTTPS).
Opcionales relevantes: `PORT`, `TRUST_PROXY` (IP/CIDR, nunca `true`),
`PUBLIC_HOSTS`, `DATA_DIR`, `UPLOAD_DIR`, `DB_FILE`, `PUBLIC_DIR`,
`MAX_UPLOAD_SIZE_MB`, `MAX_FILES_PER_TICKET`, `MAIL_*`/`SMTP_*`,
`JOBS_ENABLED`, `DIRECTORY_SYNC`/`DIRECTORY_SNAPSHOT_FILE`.
Para migración MSSQL: `DB_CLIENT`, `DB_SERVER`, `DB_PORT`, `DB_DATABASE`,
`DB_INSTANCE`, `DB_USER`, `DB_PASSWORD`, `DB_ENCRYPT`,
`DB_TRUST_SERVER_CERTIFICATE`, `MIGRATION_TARGET_DATABASE`, `MSSQL_RUNTIME`.
Referencia completa: `backend/.env.example`.

### 5.2 Requisitos de Node.js

- Node.js **>= 22.5** (usa `node:sqlite`); se recomienda **24 LTS** (el CI usa Node 24).
- `npm ci` (o `npm run setup`) para backend y frontend.

### 5.3 Requisitos de SQL Server

- SQL Server 2022, instancia `SIFHADEV` en `TI-DESK-01`.
- Base destino `SIFHA_Tickets_DEV`.
- Cuenta de ejecución con `db_owner`/`db_ddladmin` o `ALTER ON SCHEMA::dbo`, y
  `BACKUP DATABASE` para el respaldo.
- Rutas de respaldo **locales al servidor** accesibles por la cuenta del servicio.

### 5.4 Comandos de instalación y build

```bash
npm run setup            # backend + frontend
npm run build            # frontend -> frontend/dist
NODE_ENV=production npm start
```

### 5.5 Procedimiento de configuración

1. Copiar `backend/.env.example` a `backend/.env` y completar §5.1.
2. Definir `SEED_ADMIN_PASSWORD` **un solo arranque**; entrar y retirarla.
3. No versionar `.env` (ya cubierto por `.gitignore`).

### 5.6 Seguridad

- Autorización en backend por permiso y organización; el frontend solo oculta.
- bcrypt coste 12, cookies `httpOnly` + CSRF double-submit, Helmet, HSTS opcional.
- Adjuntos validados por contenido (magic bytes) y descarga autorizada.
- `npm audit`: **0 hallazgos** en backend y frontend.
- Repositorio recomendado **privado** (identificadores internos de infraestructura).

### 5.7 Logs

- Volcar cada ejecución de migración a su propio archivo (`run_B.log`,
  `verify-B.log`, …), con fecha y ejecutor identificado.
- Arranque del backend: `backend-start.log`.
- Sin secretos en los logs.

### 5.8 Respaldos

- Respaldo completo verificado antes de B (§3).
- Conservar el `.bak` original en el servidor **y** copia externa con SHA-256.
- No sobrescribir respaldos; nombre único por fecha/hora.

### 5.9 Verificación de salud

- `GET /api/health` → `200 {"ok":true,...}`.
- `schemaValidator` en arranque: 24 tablas y N columnas, sin diferencias.
- Verificador final `GO`.

### 5.10 Plan de reversión

- Pre-`COMMIT`: rollback automático (base intacta).
- Post-`COMMIT`: restaurar el `.bak` verificado desde ruta local del servidor
  (`RESTORE DATABASE ... WITH REPLACE, RECOVERY, CHECKSUM`), con el backend detenido.
- Medida de último recurso: restaurar desde la copia externa tras copiarla a una
  ruta local del servidor y revalidar el hash.

---

## 6. Restricciones de esta guía

- No se modificó SQL Server, no se ejecutaron migraciones, no se hicieron
  `BACKUP`/`RESTORE`/`DBCC`, no hubo push ni merge.
- Los comandos de escritura son **plantillas para la ventana autorizada**.
- Ante cualquier duda: **detener** y consultar al auditor.
