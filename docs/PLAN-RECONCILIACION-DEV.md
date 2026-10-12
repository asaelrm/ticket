# Plan técnico de reconciliación de esquema — SIFHA_Tickets_DEV

**Rama:** `integracion-casa-oficina-11oct`
**Fecha:** 2026-10-11
**Estado:** BORRADOR DE PLAN. No ejecutar nada todavía.
**Fuente de verdad del esquema:** `backend/src/db/mssql/schema.sql`
**Base destino:** `SIFHA_Tickets_DEV` (instancia `SIFHADEV`, servidor `TI-DESK-01\SIFHADEV`,
accesible por Tailscale en `100.100.4.60`).

> Este documento NO contiene contraseñas, cadenas de conexión ni identificadores de
> organización inventados. NO se ha ejecutado ninguna migración, seed, DDL ni consulta
> contra la base. Es un plan para revisión y autorización humana.

---

## 1. Objetivo

Llevar el esquema actual de `SIFHA_Tickets_DEV` al esquema que el runtime MSSQL exige
(`schema.sql`), **preservando todos los registros existentes** y sin copiar datos desde
ninguna base de integración ni desde SQLite.

La reconciliación se plantea en **fases incrementales e idempotentes**, donde cada fase
que escribe datos queda **bloqueada por una decisión humana explícita**.

---

## 2. Estado observado y estado requerido

Estado confirmado de `SIFHA_Tickets_DEV` (datos aportados por el equipo):

| Tabla | Estado | Filas |
|---|---|---|
| `roles` | existe | 3 |
| `permissions` | existe | 24 |
| `role_permissions` | existe | 41 |
| `users` | existe | 1 |
| `departments` | existe | 25 |
| `sessions` | existe | 2 |

- **6 tablas de 24 requeridas.**
- `users` y `departments` **no tienen** `organization_id`.
- No existe `organizations` (tabla raíz del modelo multiempresa).
- **96 registros totales** en las 6 tablas: 3 `roles` + 24 `permissions` + 41
  `role_permissions` + 1 `users` + 25 `departments` + 2 `sessions`.
- **Decisión confirmada (2026-10-11):** los 25 departamentos y la cuenta de usuario
  pertenecen al **Centro Médico UCE** (código `CMUCE`).
- **Rol de la cuenta confirmado (2026-10-11): ADMIN** (rol de organización, no
  SUPERADMIN global). La cuenta se asocia a CMUCE en la fase 7; el pre-chequeo de rol
  sigue imprimiendo el rol real para no asumir nada.

Tablas requeridas por `schema.sql` que **no existen** (18):
`organizations`, `categories`, `teams`, `team_members`, `tickets`,
`canned_responses`, `ticket_comments`, `ticket_attachments`, `ticket_history`,
`sequences`, `settings`, `org_settings`, `email_logs`, `notifications`,
`kb_categories`, `kb_articles`, `kb_ticket_articles`, `kb_article_history`.

Esto describe un **esquema MSSQL pre-multiempresa** (RBAC + usuarios + departamentos +
sesiones), anterior a las etapas de aislamiento por organización y de tickets/KB.

---

## 3. Diferencias estructurales identificadas

Se separan en **(A) confirmadas** y **(B) candidatas a confirmar con inventario**. Las
del grupo B no se pueden afirmar con certeza sin consultar el catálogo real (paso
`reconcile-dev-inventory.sql`), porque solo se conocen los conteos de filas, no las
definiciones de columna.

### A. Confirmadas

1. **Falta la tabla raíz `dbo.organizations`.** Bloquea cualquier FK de organización.
2. **Falta `organization_id` en `dbo.users`** (el esquema lo declara `INT NULL`, admite
   NULL para cuentas SUPERADMIN globales).
3. **Falta `organization_id` en `dbo.departments`** (el esquema lo declara `INT NOT
   NULL`, es decir exige organización en la versión final).
4. **Faltan 18 tablas completas** (lista de la sección 2), con sus restricciones e
   índices.

### B. Candidatas (verificar con inventario)

Sobre las 6 tablas existentes, el esquema espera además:

- `departments`: `UQ_departments_organization_name`, `UQ_departments_organization_id`,
  `FK_departments_organization`, `DF_departments_active`, `DF_departments_created_at`.
  La versión legacy probablemente tiene `UNIQUE(name)` global en vez de compuesta.
- `users`: `UQ_users_organization_id`, `FK_users_organization`,
  `FK_users_department_same_org` (FK **compuesta** `(organization_id, department_id)`),
  `FK_users_role`, `UQ_users_username`, `UQ_users_email`.
  La FK de `department_id` en legacy suele ser simple (`department_id → departments.id`),
  no compuesta.
- `roles`: `UQ_roles_code`, `DF_roles_active`, `DF_roles_created_at`, `PK_roles`.
- `permissions`: `UQ_permissions_code`, `DF_permissions_created_at`, `PK_permissions`.
- `role_permissions`: `FK_role_permissions_role`, `FK_role_permissions_permission`
  (con `ON DELETE CASCADE`), `PK_role_permissions`.
- `sessions`: `PK_sessions` y el índice `IX_sessions_expire`.
- **Tipos y longitudes**: el esquema usa `NVARCHAR(n)`/`NVARCHAR(MAX)`, `BIT`,
  `DATETIME2(3)`, `INT IDENTITY(1,1)`. El esquema legacy MSSQL pudo haberse creado con
  `VARCHAR`, `DATETIME` o sin `IDENTITY`, lo que `schemaValidator.js` marca como
  bloqueante.
- **Índices de rendimiento** en `users` (`IX_users_organization_active`,
  `IX_users_department`) que probablemente no existan.

### C. Confirmadas con el inventario (2026-10-11) — 9 diferencias de longitud

Longitudes en **caracteres** (columnas `NVARCHAR`; tipo, nulabilidad e IDENTITY de
estas columnas ya coinciden con `schema.sql`, el inventario no reportó
discrepancias en esos aspectos):

| Tabla | Columna | Esperado | Encontrado |
|---|---|---|---|
| `departments` | `name` | 150 | 100 |
| `roles` | `name` | 150 | 200 |
| `users` | `email` | 320 | 254 |
| `users` | `last_name` | 150 | 100 |
| `users` | `name` | 150 | 100 |
| `users` | `password_hash` | 500 | 255 |
| `users` | `password_reset_token` | 500 | 64 |
| `users` | `position` | 200 | 255 |
| `users` | `username` | 150 | 100 |

Nota: `roles.name` (200→150) y `users.position` (255→200) son **reducciones** de
longitud. El borrador **(fase 2b)** solo las aplica si `MAX(LEN) ≤ objetivo`, lista
los índices que referencian las columnas y conserva tipo/nulabilidad actuales.

> El inventario de la sección 6 produce el diff real (tipo, nulabilidad, identity,
> restricciones e índices) para cerrar el grupo B antes de autorizar la fase DDL.

---

## 4. Estrategia por fases

Orden pensado para respetar el grafo de dependencias de claves foráneas.

| Fase | Acción | Escribe | Gate |
|---|---|---|---|
| 0 | Respaldo verificado de la base | no | humano |
| 1 | Crear `organizations` (vacía) | DDL | backups OK |
| 2 | Añadir `organization_id NULL` a `users` y `departments`; añadir columnas faltantes (tipos/nulabilidad) | DDL | inventario revisado |
| 2b | Corregir las **9 longitudes `NVARCHAR`** (solo si `MAX(LEN)` lo permite; conserva tipo/nulabilidad) | DDL | fase 2 |
| 3 | Añadir unicidades compuestas requeridas por FKs (`UQ_users_organization_id`, `UQ_departments_organization_id`, `UQ_departments_organization_name`) y las de código/nombre de tablas existentes (`UQ_users_username`, `UQ_users_email`, `UQ_roles_code`, `UQ_permissions_code`) | DDL | fase 2 |
| 4 | Crear las **17** tablas faltantes restantes (categories…kb_article_history); junto con `organizations` (fase 1) completan las **18** faltantes | DDL | fase 3 |
| 5 | Añadir FKs compuestas de `users`/`departments` a `organizations` y entre sí | DDL | fase 4 |
| 6 | Crear índices faltantes (`IX_*`) | DDL | fase 5 |
| 7 | **Backfill de `organization_id` → CMUCE** (decisión confirmada: 25 deptos + cuenta). Pre-chequeo de rol solo-lectura antes de asignar la cuenta | DATOS | **autorización escrita** |
| 8 | **Endurecer `departments.organization_id` a NOT NULL** (solo si la fase 7 dejó 0 NULL) | DDL | fase 7 verificada |
| 9 | Verificación posterior (24 tablas + 96 registros + longitudes) y arranque en seco (solo lectura) | no | fin |

Las fases 1–6/b son **aditivas y no destructivas** (no borran ni reescriben filas).
Las fases 7–8 son las únicas que **modifican datos/dureza** y están tras un gate.

---

## 5. Dependencias y orden de claves foráneas

`organizations` es la raíz. Las FKs compuestas del esquema (`(organization_id, X_id)`)
exigen que existan previamente:

1. `UQ_departments_organization_id` en `departments` → la usa
   `FK_users_department_same_org` y `FK_tickets_department_same_org`.
2. `UQ_users_organization_id` en `users` → la usan todas las FK compuestas de `tickets`,
   `team_members`, `ticket_comments`, `ticket_attachments`, `ticket_history`,
   `notifications`, `canned_responses`, `kb_articles`, `kb_ticket_articles`,
   `kb_article_history`, `email_logs`.
3. `UQ_teams_organization_id` en `teams` → la usan `team_members`, `tickets`,
   `canned_responses`.
4. `UQ_categories_organization_id` / `UQ_kb_categories_organization_id` → las usan
   `tickets` / `kb_articles`.
5. `UQ_tickets_organization_id` → la usan `ticket_comments`, `ticket_attachments`,
   `ticket_history`, `email_logs`, `notifications`, `kb_ticket_articles`.
6. `UQ_kb_articles_organization_id` → la usan `kb_ticket_articles`, `kb_article_history`.

Nota de comportamiento SQL Server: una FK compuesta con alguna columna `NULL` **no se
evalúa** (MATCH SIMPLE). Por eso las fases aditivas pueden convivir con filas cuyo
`organization_id` aún es NULL, y por eso el endurecimiento (fase 8, `NOT NULL`) debe ir
después del backfill.

---

## 6. Validaciones de servidor, instancia y base

Todo script (inventario y reconciliación) valida **antes de tocar nada**:

- `DB_NAME()` = `SIFHA_Tickets_DEV`.
- `SERVERPROPERTY('InstanceName')` = `SIFHADEV`.
- `SERVERPROPERTY('ServerName')` o `@@SERVERNAME` = `TI-DESK-01\SIFHADEV`.
- Si cualquiera difiere → `RAISERROR` + `RETURN`, sin efectos.

Los scripts Node existentes (`assertTargetGuard`) **prohíben** `SIFHA_Tickets_DEV` a
propósito (eran para M5). Por eso estos borradores son **SQL de administración manual**
(SSMS/sqlcmd), no forman parte del runtime ni del migrador automático.

---

## 7. Respaldo previo y reversión

**Respaldo obligatorio antes de cualquier fase que escriba** — **COMPLETO el 2026-10-11**
(BACKUP `COPY_ONLY` correcto + `RESTORE VERIFYONLY` con conjunto válido, **copiado al
almacenamiento externo y verificado por SHA-256**):

| Dato | Valor |
|---|---|
| Nombre del `.bak` | `SIFHA_Tickets_DEV_PreReconciliacion_20261011.bak` |
| Ruta externa (copia de seguridad) | `C:\Respaldos-SIFHA\SIFHA_Tickets_DEV_PreReconciliacion_20261011.bak` en `DESKTOP-8MNIRCK` |
| SHA-256 | `C6057D038074070973F2D9D473C431F6D6B9823567D02484E9F0C35B6DFCB69A` |
| Verificación | `BACKUP ... WITH COPY_ONLY, CHECKSUM` + `RESTORE VERIFYONLY ... WITH CHECKSUM` (2026-10-11) |

**No modificar este respaldo**: es la red de recuperación principal (ver §19). La ruta del
`.bak` original en el servidor y su hash quedan registrados en el log de ejecución.

```sql
BACKUP DATABASE [SIFHA_Tickets_DEV]
  TO DISK = N'<ruta_local_del_servidor>\SIFHA_Tickets_DEV_FULL_<AAAAMMDD_HHMMSS>.bak'
  WITH COPY_ONLY, INIT, CHECKSUM, COMPRESSION, STATS = 5;
RESTORE VERIFYONLY FROM DISK = N'<ruta...>' WITH CHECKSUM;
```

> **Nota de rutas para `RESTORE` (crítica):** SQL Server **solo puede leer rutas locales
> al servidor** `TI-DESK-01\SIFHADEV` (o un UNC accesible por la cuenta del servicio SQL).
> La ruta `C:\Respaldos-SIFHA\…` corresponde a la **copia externa** en `DESKTOP-8MNIRCK` y
> **NO es accesible desde SQL Server**. Todo `RESTORE DATABASE ... FROM DISK` (§19) debe
> apuntar a la **ruta local del `.bak` original en el servidor** (la anotada al ejecutar el
> respaldo, junto a su SHA-256, en el log de ejecución). Para usar la copia externa como
> origen habría que **copiarla primero a una ruta local del servidor** (verificando el
> SHA-256 tras el copiado) y recién entonces restaurar; nunca escribir
> `C:\Respaldos-SIFHA\…` en un `FROM DISK` desde `TI-DESK-01`.

Reglas:
- Nombre único por fecha/hora; nunca sobrescribir.
- `COPY_ONLY` para no alterar la cadena de respaldos.
- Verificar con `RESTORE VERIFYONLY` (no restaura).
- El script exige una variable de confirmación (`@BackupVerified = 1`) que **solo** se
  activa tras verificar el `.bak`; si no, aborta.

**Operaciones que requieren permisos administrativos** (login de ejecución):

| Operación | Permiso mínimo requerido | Script |
|---|---|---|
| `BACKUP DATABASE` / `RESTORE VERIFYONLY` | `BACKUP DATABASE`, `db_backupoperator` o `sysadmin` | pre-fase 0 (manual) |
| `CREATE TABLE`, `ALTER TABLE`, `ALTER COLUMN`, `CREATE INDEX` | `db_ddladmin`, `db_owner` o `sysadmin` | fases 1–6, 8 |
| `INSERT`/`UPDATE` sobre `organizations`/`users`/`departments` | `db_datawriter`/`db_owner` | fase 7 |
| Lectura de metadatos `sys.*` y `VIEW DEFINITION` | `VIEW DEFINITION`/`db_datareader`/`db_owner` | inventario y fases 9 |

> El ejecutor debe ser **`db_owner`** (ideal) sobre `SIFHA_Tickets_DEV`, y el respaldo
> además requiere un login con `BACKUP DATABASE` o `sysadmin`. Documentar qué cuenta
> ejecuta y cómo se auditan los pasos.

**Reversión:**
- DDL aditivo (fases 1–6/b): se ejecuta dentro de `BEGIN TRAN` + `TRY/CATCH` con
  `XACT_ABORT ON`; ante error, `ROLLBACK` deja la base igual.
- Tras commit, la red de seguridad es **restaurar el `.bak`** (plan de recuperación
  principal). El script incluye el bloque inverso (`DROP` de objetos añadidos) como
  reversión de último recurso, claramente marcado y separado.
- Las longitudes (fase 2b) y el backfill (fase 7) NO se revierten por DROP manual: se
  restauran solo con el `.bak` previo.
- La fase 8 (`NOT NULL`) y fases de datos: reversión por restauración del respaldo.

---

## 8. Reglas de seguridad operativa

1. **No hay secretos**: ni contraseñas, ni cadenas de conexión, ni `DB_USER`/`DB_PASSWORD`.
2. **No SQLite** y **no copia de datos** desde la base de integración ni desde dumps.
3. **`organization_id` se resuelve por `code`**: la organización inicial está
   confirmada (**CMUCE** / Centro Médico UCE). El borrador resuelve el `id` por el
   código (o crea la organización con ese code/name); **nunca asume `1`**.
4. **No se modifican usuarios sin autorización**: la fase 7 requiere
   `@AuthorizeBackfill = 1`. El pre-chequeo de rol (solo lectura) imprime el rol real de
   cada cuenta antes de asignarla. **Rol confirmado: ADMIN** (de organización), por lo
   que la cuenta se asocia a CMUCE; el script nunca toca `password_hash`, `role_id` ni
   `role_permissions`, y no se asume el rol en el código.
5. **Idempotencia**: cada `CREATE`/`ALTER`/índice va tras `IF OBJECT_ID`/`IF COL_LENGTH`/
   `IF NOT EXISTS`, de modo que re-ejecutar no duplica objetos.
6. **Trazabilidad**: el script imprime cada fase y los conteos antes/después.
7. **Preservación de la cuenta**: no se tocan `password_hash`, `role_id`,
   `role_permissions` ni ninguna fila de `roles`/`permissions`; el backfill solo
   actualiza `organization_id`. La verificación posterior exige los 96 registros
   originales (fase 9).

---

## 9. Riesgos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R1 | El estado real difiere de lo supuesto (tipos, nullability, identity) | Alto | Ejecutar primero el inventario solo-lectura |
| R2 | `departments` legacy tiene `UNIQUE(name)` global | Medio | No se elimina; el validador lo reporta como aviso, no bloqueante |
| R3 | FKs existentes con nombres distintos a los canónicos | Medio | El script verifica por nombre y reporta duplicados/avisos |
| R4 | Backfill con organización equivocada | Alto | Gate humano + validación contra filas de `roles`/`users` |
| R5 | `organization_id NOT NULL` en `departments` con filas sin asignar | Alto | Fase 8 solo tras verificar 0 NULL; si no, no se ejecuta |
| R6 | El backend no arranca por diferencias no detectadas | Medio | `schemaValidator` en arranque lista el diff exacto |
| R7 | Ejecutar sobre servidor/base equivocados | Crítico | Guarda de identidad + respaldo + `COPY_ONLY` |
| R8 | `IDENTITY`/tipos en tablas nuevas chocan con nombres ya usados | Bajo | `IF OBJECT_ID IS NULL` y fase 4 antes de FKs |
| R9 | Cambios en `users` (única cuenta) rompen login | Alto | No se toca la fila; solo columnas/constraints aditivas |

---

## 10. Decisiones humanas y bloqueos (estado al 2026-10-11)

### Veredicto de autorización: **APTO CONDICIONADO**

El plan y el borrador están **aptos para la fase DDL (grupo B)**, pero **solo tras
cerrar los bloqueos pendientes** listados abajo y **ejecutar las consultas de solo
lectura de la sección 16**. Mientras exista un bloqueo abierto, la ejecución del grupo
B queda **no autorizada**.

**Archivo autoritativo único (confirmado):** `backend/scripts/migration/reconcile-dev-draft.sql`.
Los archivos `reconcile-dev-draft-corregido (1).sql` y `reconcile-dev-draft-corregido-v2.sql`
son **borradores históricos superados**: se compararon contra el oficial (sección 15) y su
única corrección válida pendiente (prechequeo de `departments` en SQL dinámico, fase 3) ya
fue **consolidada** en el oficial. No se eliminaron para no perder trazabilidad; no deben
editarse ni ejecutarse.

**Resueltas:**
- Organización inicial: **CMUCE / Centro Médico UCE**; los 25 departamentos y la cuenta
  de usuario pertenecen a ella (decisión confirmada). El id NO se inventa: se resuelve
  por `code` en fase 7.
- **Rol de la cuenta confirmado: ADMIN** (de organización). La cuenta se asociará a CMUCE
  activando `@BackfillUsers = 1` en la ejecución autorizada; el pre-chequeo lo verifica
  visualmente (ninguna cuenta SUPERADMIN/global).
- El usuario se conserva tal cual (contraseña, `role_id`, `role_permissions`):
  el backfill solo escribe `organization_id`.

### Verificaciones SQL cerradas (2026-10-11, ejecutadas por el equipo en SSMS)

| Verificación | Resultado en `SIFHA_Tickets_DEV` | Estado |
|---|---|---|
| **16.1** FK de `role_permissions` | `FK_role_permissions_role` y `FK_role_permissions_permission` **existen, habilitadas y confiables**, con `ON DELETE CASCADE` | **CERRADO** |
| **16.2** Permisos del ejecutor | `sa` con permisos suficientes (sysadmin) | **CERRADO** |
| **16.4** Respaldo | **dos** respaldos `COPY_ONLY` con checksums y sin `is_damaged`; `RESTORE VERIFYONLY` ejecutado correctamente sobre ellos | **CERRADO** |
| **16.5** Dependencias de longitud | **0** índices y **0** estadísticas de usuario sobre `roles.name` y `users.position` | **CERRADO** |
| Simulación del borrador | sin errores de compilación ni ejecución; **6 interruptores en 0** | **CERRADO** |
| **16.6** Valores máximos de datos | **PENDIENTE DE EJECUTAR** (condición nueva: `max_chars` no debe superar el objetivo) | **ABIERTO** |

### Bloqueos pendientes (los únicos que separan la autorización del grupo B)

1. **Registrar ruta y checksum del `.bak`** — **CERRADO el 2026-10-11**: el respaldo fue
   copiado al almacenamiento externo y **verificado por SHA-256**. Solo resta anotar la
   ruta y el hash en el log de ejecución como evidencia operativa.
2. ~~Confirmar que la base es la correcta~~ → **cerrado**: `sa` ejecutó inventario,
   simulación y las verificaciones en `SIFHA_Tickets_DEV`; la guarda de identidad del
   script revalida en cada arranque.
3. **Decidir el modelo para `departments.organization_id`**: backfill + `NOT NULL`
   (paridad total con `schema.sql`; grupo D/fase 8) **o** mantener NULL (diferencia
   residual para `schemaValidator`). **Decisión humana pendiente**; el plan recomienda
   la paridad total (fases B→C→D completas).
4. **Aprobar formalmente los scripts** (`inventory` ya ejecutado; `draft` auditado y
   corregido) y **designar quién ejecuta (con `sa`) y quién audita** cada grupo B/C/D,
   con la **ventana de mantenimiento** reservada (backend detenido). **Aprobación humana
   pendiente.**
5. ~~Ausencia de datos sensibles~~ → **cerrado**: los dos respaldos son limpios y
   `VERIFYONLY` pasó correctamente.
6. ~~Designar login de ejecución~~ → **cerrado con `sa`** (16.2); solo resta concretar la
   ventana de mantenimiento (ver bloqueo 4).
7. ~~Verificar las FK de `role_permissions`~~ → **cerrado** (16.1).
8. ~~Dependencias que bloquean la reducción de longitudes~~ → **cerrado** para
   índices/estadísticas (16.5); queda la **16.6** (valores máximos) como última condición
   de datos para las reducciones de la fase 2b.

**Estado de autorización:** todas las condiciones de SQL Server **y el respaldo externo
(SHA-256) están cerrados**. El grupo B es **APTO**; solo resta el cierre formal de los
bloqueos 3 (decisión del modelo de `departments.organization_id`) y 4 (aprobación + 
ejecutor/auditor/ventana). La 16.6 (valores máximos) es **recomendada como pre-flight**,
pero no bloquea: la fase 2b incluye su propio chequeo `MAX(LEN)` que **aborta y revierte**
si cualquier fila excede el objetivo.

---

## 11. Archivos preparados

- `docs/PLAN-RECONCILIACION-DEV.md` — este plan.
- `backend/scripts/migration/reconcile-dev-inventory.sql` — inventario **solo lectura**
  (SELECT) que produce el diff real contra `schema.sql`.
- `backend/scripts/migration/reconcile-dev-draft.sql` — **borrador** del DDL de
  reconciliación, con guardas, respaldo, gates de decisión y plan de reversión.
  **Archivo autoritativo único. No ejecutar.** Viene **configurado para el grupo B**
  (`@AuthorizeDdl=1`, `@BackupVerified=1`; resto en `0`).
- `backend/scripts/migration/verify-after-groupB.sql` — **verificador solo lectura**
  post-grupo B (24 tablas, 96 registros, 9 longitudes, UQ/FK/IX, org NULL 1/25;
  resumen automático `GO`/`NO-GO`). Uso en §17.
- `backend/scripts/migration/verify-final-reconciliation.sql` — **verificador final solo
  lectura** del estado reconciliado tras el grupo D (24 tablas, **97** registros, CMUCE=1,
  NULL 0/0, `departments.organization_id` NOT NULL, 9 longitudes, UQ/FK/IX, integridad
  referencial sin huérfanos, **usuario ADMIN `id 4` con `role_id 7`/`department_id 68` en
  CMUCE y conservación de roles/permisos (rol ADMIN único con permisos; 3/24/41 sin
  huérfanos)** y paridad canónica de columnas; resumen **`GO`**/NO-GO).
  Ejecutarlo **antes** del arranque del backend (ver §17.2 y §13.7).
- `backend/scripts/migration/fix-users-department-same-org.sql` — **fix puntual aislado**
  (creado en la corrección D4, §14) que crea **únicamente** la FK compuesta faltante
  `FK_users_department_same_org` (`users(organization_id, department_id)` →
  `departments(organization_id, id)`), con guardas de servidor/instancia/base, prechequeo
  de columnas + UQ referenciada + integridad (0 huérfanos), transacción + `WITH CHECK`,
  idempotente y confirmación de FK habilitada/confiable. Conserva la FK legacy
  `FK_users_department` y **no** modifica datos ni organizaciones. Uso descrito en §17.3.
- `backend/scripts/migration/backfill-organization-CMUCE.sql` — **script independiente del
  grupo C** (creado en la auditoría de la fase 7 y endurecido): crea/reutiliza CMUCE y asigna
  los 25 `departments` y el usuario heredado (`id 4`) en **una sola transacción** atómica, con
  guardas de servidor/instancia/base, doble interruptor de autorización
  (`@AuthorizeBackfill`/`@BackupVerified`), bloqueo de aplicación (`sp_getapplock`) +
  `UPDLOCK/HOLDLOCK`, **orden obligatorio `departments` → `users`** (por la FK compuesta),
  **revalidación intra-transacción** (conteos 25/1, identidad exacta `id=4/role_id=7/ADMIN/
  department_id=68`, sin duplicados de nombre, sin registros en otra organización, CMUCE con
  nombre/`active=1`) **antes de cualquier `INSERT`/`UPDATE`**, **validación de las FK críticas
  por su definición real** (padre/referenciada/columnas/`NO ACTION`/habilitada/confiable), y
  verificación de integridad/conteos **antes del `COMMIT`** (si falla, `ROLLBACK` completo).
  No restaura el respaldo automáticamente tras el `COMMIT`. Resumen `GO`/`NO-GO`. Alternativa
  autocontenida y más estricta que la fase 7 del borrador (esta actualiza todos los usuarios
  NULL).
- `backend/scripts/migration/verify-after-groupC.sql` — **verificador solo lectura** post-grupo
  C (24 tablas, **97** registros, CMUCE=1, 25 depts/1 user asignados, NULL 0/0, 0 huérfanos,
  usuario 4 con `role_id=7`/`department_id=68`, FKs (incluida la compuesta y la legacy) y
  UQ/IX; informa la nulabilidad de `departments.organization_id` sin exigirla; resumen
  `VERIFICADOR POST-C: GO`/`NO-GO`). Uso en §17.4.
- `backend/scripts/migration/apply-groupD-not-null.sql` — **script independiente del grupo D**
  (alternativa autocontenida a la fase 8 del borrador): convierte **solo**
  `dbo.departments.organization_id` a `INT NOT NULL` (no toca `users.organization_id`, que
  sigue NULL-able). Guardas de servidor/instancia/base, doble interruptor
  (`@AuthorizeDdl`/`@BackupVerified`), prechequeos de estructura (24 tablas, `UQ_departments_
  organization_id`, FK que referencian `departments(organization_id,id)`, estadísticas/columnas
  calculadas que bloquearían el `ALTER`), de datos (97 registros, CMUCE=1, 25 depts sin NULL
  ni ajenos, `users` sin NULL) y de tipo (INT), **revalidación intra-transacción** con
  `UPDLOCK/HOLDLOCK` antes del `ALTER`, verificación de nulabilidad **antes del `COMMIT`**,
  **idempotente** (si ya es NOT NULL, omite el `ALTER`) y resumen `GRUPO D: GO`/`NO-GO`.
  No usa `DROP/TRUNCATE/DELETE/NOCHECK` ni altera otras columnas. No revierte automáticamente
  tras el `COMMIT`. Uso en §17.5.
- `backend/scripts/migration/verify-after-groupD.sql` — **verificador solo lectura** post-grupo
  D (24 tablas, **97** registros, CMUCE=1, 25 depts/0 NULL/0 ajenos, `departments.organization_id`
  `INT NOT NULL`, `users.organization_id` NULL-able, UQ/FK/IX nucleares y 0 huérfanos); resumen
  `VERIFICADOR POST-D: GO`/`NO-GO`. Complementa (no sustituye) al verificador final. Uso en §17.5.

> **Duplicados históricos (superados, no usar):**
> `reconcile-dev-draft-corregido (1).sql` y `reconcile-dev-draft-corregido-v2.sql`.
> Se compararon con el oficial; su corrección válida (prechequeo de `departments` en
> SQL dinámico, fase 3) ya está consolidada en `reconcile-dev-draft.sql`. No editarlos
> ni ejecutarlos.

---

## 12. Siguiente paso propuesto (sin ejecutar hoy)

1. Revisar y aprobar este plan y el borrador auditado (bloqueo 4 de §10).
2. Ejecutar la **16.6** (valores máximos de datos) en SSMS y confirmar que `max_chars`
   no supera el objetivo en las 9 columnas.
3. Cerrar la decisión pendiente de §10 (bloqueo 3: modelo de `departments.organization_id`)
   y registrar ruta/checksum del `.bak` verificado (bloqueo 1).
4. Seguir el **procedimiento por fases de la sección 13**: simulación (hecha, sin errores)
   → B (§13.4) → C (§13.5) → D (§13.6) → E (§13.7), respetando los puntos de control, los
   criterios GO/NO-GO de §18, los verificadores de §17 y el checklist final de §20.

---

## 13. Procedimiento de ejecución por fases (puntos de control)

**Entorno:** `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b -i reconcile-dev-draft.sql`
(un login **`db_owner`**; `-b` detiene al primer error; volcar la salida a un archivo de
log firmado con fecha). Ejecutar con el **backend detenido** (ventana de mantenimiento):
los `ALTER`/`ALTER COLUMN` toman bloqueos `SCH-M` y los UPDATE de la fase 7 toman
bloqueos de fila; con la app viva se bloquearían lecturas.

| Grupo | Interruptores activos | Qué ejecuta | Punto de control | STOP si… |
|---|---|---|---|---|
| **A. Simulación** | **todos en 0** | fases 0–9 (solo imprime y lee) | A1: salida con identidad verificada, "MODO SIMULACION", fases 7/8 OMITIDAS y resumen "VERIFICACION POSTERIOR: INCOMPLETA — faltan 18 tablas" | aparece cualquier CREATE/ALTER/UPDATE/INSERT real en la salida |
| **B. DDL aditivo** | `@AuthorizeDdl=1`, `@BackupVerified=1`; **resto en 0** | fases 1–6/2b (una transacción) | B1: "DDL ADITIVO (fases 1-6 y 2b) confirmado"; verificación posterior con 24 tablas, 96 registros, `organization_id` NULL en users (1) y departments (25) **como esperado** (el backfill llega en C) y 9 longitudes OK | tablas_faltantes > 0, registros ≠ 96, o un RAISERROR (se revirtió todo) |
| **C. Backfill** | `@AuthorizeDdl=1`, `@BackupVerified=1`, `@AuthorizeBackfill=1`, `@BackfillDepartments=1`, `@BackfillUsers=1`; `@MakeDepartmentsNotNull=0` | re-ejecuta el DDL (idempotente, sin efecto) + fase 7 | C1: pre-chequeo imprime una cuenta con `rol_code = ADMIN` (ninguna SUPERADMIN); "departments asignados = 25" y "users asignados = 1" | alguna cuenta SUPERADMIN/global (→ `@BackfillUsers=0`) o conteos ≠ 25/1 |
| **D. Endurecimiento** | `@AuthorizeDdl=1`, `@BackupVerified=1`, `@MakeDepartmentsNotNull=1`; backfill ya aplicado (C) | fase 8 | D1: "Fase 8: departments.organization_id es NOT NULL." + "VERIFICACION POSTERIOR: OK -- 24 tablas presentes y 96 registros conservados." (las 6 tablas iniciales; el **total real con CMUCE es 97**, lo verifica el verificador final) | quedan departments con `organization_id NULL` (el script aborta solo con RAISERROR) |
| **E. Verificación final** | **todos en 0** | verificación posterior (solo lectura) + `verify-final-reconciliation.sql` + arranque en seco del backend | E1: "VERIFICACION POSTERIOR: OK -- 24 tablas presentes y 96 registros conservados." + longitudes OK + **verificador final `GO`** (**96→97** incluyendo CMUCE) + `schemaValidator` sin diferencias y servidor HTTP iniciado | el resumen dice INCOMPLETA, el verificador final dice `NO-GO`, o `schemaValidator`/arranque reportan diferencias |

**Aislamiento de las fases de datos (verificado en el código):**
- **Fase 8 NO puede dispararse en B**: su gate es `@AuthorizeDdl=1 AND @MakeDepartmentsNotNull=1`, y
  `@MakeDepartmentsNotNull` permanece en 0 hasta el grupo D.
- **Fase 7 tampoco**: su gate es `@AuthorizeDdl=1 AND @AuthorizeBackfill=1`, y
  `@AuthorizeBackfill` permanece en 0 hasta el grupo C.

---

### 13.1 Instrucciones exactas — solo MODO SIMULACIÓN desde SSMS

1. Abrir SSMS y conectar a **`TI-DESK-01\SIFHADEV`** (o `100.100.4.60,1433`). No cambiar la base por defecto del editor.
2. Abrir `backend/scripts/migration/reconcile-dev-draft.sql` **sin editarlo**.
3. **Importante:** el borrador viene ya **configurado para el grupo B** (`@AuthorizeDdl=1`,
   `@BackupVerified=1`; `@AuthorizeBackfill`, `@BackfillDepartments`, `@BackfillUsers`,
   `@MakeDepartmentsNotNull` en `0`). Para **simular** hay que poner **los 6 interruptores en `0`**
   temporalmente (ver §13 tabla, fila A). Comprobar visualmente en "PARAMETROS E INTERRUPTORES"
   que los 6 están en `0` antes de simular.
4. En la barra de estado de SSMS, confirmar la base de destino = `SIFHA_Tickets_DEV` (el script además valida `DB_NAME()`/instancia/servidor y aborta si no coincide).
5. Ejecutar con **F5** y leer la pestaña **Messages**.
6. Secuencia esperada (simulación): identidad verificada → "MODO SIMULACION: @AuthorizeDdl = 0…" → pre-chequeo de rol (solo lectura, muestra `ADMIN`) → "Fase 7 OMITIDA…" → "Fase 8 OMITIDA…" → reportes de verificación → **"VERIFICACION POSTERIOR: INCOMPLETA — faltan 18 tablas…"** (esperado en simulación).
7. **Criterio de aceptación de la simulación:** no aparece ni un mensaje de CREATE/ALTER/INSERT/UPDATE; el resumen es INCOMPLETA con 18 tablas faltantes y 96 registros conservados; todos los interruptores siguen en 0.
8. Alternativa por consola (misma ejecución, solo lectura): `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -i reconcile-dev-draft.sql -o sim.log`.
9. Si editaste algún interruptor para simular, **restaura la configuración del grupo B** (o los `0`) antes de continuar; la simulación nunca requiere activar DDL.

### 13.2 Independencia de fases (dependencias que impiden ejecutarlas sueltas)

| Fase | No puede ejecutarse sin… | Motivo |
|---|---|---|
| 2b (longitudes) | transacción DDL (`@AuthorizeDdl=1`) | Va dentro del mismo bloque aditivo |
| 3 (unicidades) | fase 2 (columnas org) | Las UQ compuestas usan `organization_id` |
| 4 (17 tablas) | fase 3 (`UQ_users_organization_id`, `UQ_departments_organization_id`) | Las FK compuestas de las tablas nuevas las referencian |
| 5 (FKs) | fase 2 (columnas) + fase 3 (UQs) | FK compuestas requieren columnas y UQ |
| 6 (índices) | fase 2/4 (columnas y tablas) | Los `IX_*` referencian columnas/tablas nuevas |
| 7 (backfill) | `@AuthorizeDdl=1` (fase 2) + `@AuthorizeBackfill=1` | Gate anidado; valida `COL_LENGTH` y no corre solo |
| 8 (NOT NULL) | fase 7 completada (0 NULL) + `@AuthorizeDdl=1` | Aborta si hay NULL |
| Verificación (E) | nada | Todas sus lecturas están guardadas |

Conclusión: **C y D no se pueden ejecutar sin B**, y B/A/E son repetibles (idempotentes) sin riesgo.

### 13.3 Detención segura ante error

- Ante `RAISERROR`/`THROW` en **B** o **2b**: el `TRY/CATCH` ya hizo `ROLLBACK`; la base queda como
  estaba. Detenerse, leer el mensaje, no reintentar cambiando interruptores.
- Tras el `COMMIT` de **C** o **D** no hay rollback automático: la recuperación es **restaurar el `.bak`**
  verificado (preferir `RESTORE DATABASE` con `MOVE` a la misma base, con el backend detenido).
- Mantener el **backend detenido** durante B/C/D hasta validar la verificación (E).
- Registrar el log (pestaña Messages o `sim.log`/`run.log`) de **cada** grupo como evidencia.
- Regla general: ante duda, **detenerse** y notificar; nunca elevar privilegios ni forzar interruptores.

### 13.4 Instrucciones exactas — grupo B (DDL aditivo autorizado)

**Precondiciones (todas verificadas al 2026-10-11 salvo las marcadas):**
16.1, 16.2, 16.4 y 16.5 **cerradas**; **16.6 ejecutada** con `max_chars <= objetivo` (y
`filas_sobre_objetivo = 0`); bloqueos 1 (ruta/checksum del `.bak`), 3 (modelo de
`departments.organization_id`) y 4 (aprobación + ejecutor/auditor) **cerrados**;
**backend detenido** (ventana de mantenimiento).

1. Conectar con **`sa`** a `TI-DESK-01\SIFHADEV`, base `SIFHA_Tickets_DEV` en SSMS
   (o por consola: `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b
   -i backend/scripts/migration/reconcile-dev-draft.sql -o run_B.log`).
2. El borrador **ya viene** con la configuración del grupo B: en `PARAMETROS E INTERRUPTORES`
   `@AuthorizeDdl = 1` y `@BackupVerified = 1`. **Verificar** que los otros cuatro
   (`@AuthorizeBackfill`, `@BackfillDepartments`, `@BackfillUsers`, `@MakeDepartmentsNotNull`)
   quedan **en 0** (nada de fase 7 ni fase 8 aún).
3. Confirmar en la barra de estado la base `SIFHA_Tickets_DEV` (el script valida
   `DB_NAME()`/servidor/instancia y aborta si no coincide).
4. Ejecutar con **F5** (o el comando sqlcmd). Las fases 1-6 y **2b** corren en **una sola
   transacción** (`BEGIN TRY`/`COMMIT`/`CATCH` con rollback automático).
5. Secuencia esperada en Messages: identidad verificada → comprobación
   `@BackupVerified` (en 1, pasa) → fases 1 (organizations), 2 (+columnas org),
   **2b** (prechequeo `MAX(LEN)` y los 9 `ALTER COLUMN NVARCHAR`), 3 (unicidades), 4
   (17 tablas), 5 (FKs), 6 (índices) → `COMMIT TRANSACTION` → **"DDL ADITIVO (fases 1-6
   y 2b) confirmado."** → "Fase 7 OMITIDA…" y "Fase 8 OMITIDA…" → verificación posterior:
   **24 tablas**, total **96** registros, `users.organization_id NULL: 1` y
   `departments.organization_id NULL: 25` (**esperado**; el backfill es el grupo C) y las
   9 longitudes en **OK** → **"VERIFICACION POSTERIOR: OK -- 24 tablas presentes y 96
   registros conservados."**
6. **Punto de control B1 alcanzado** con los tres hitos de la salida: (a) mensaje
   "DDL ADITIVO (fases 1-6 y 2b) confirmado", (b) "VERIFICACION POSTERIOR: OK", (c)
   longitudes 9/9 `OK`. Guardar el log como `run_B.log` firmado con fecha.
7. **STOP con rollback (base intacta):** si aparece un `RAISERROR` (p.ej. fase 2b por
   datos más largos que el objetivo, o fase 3 por duplicados) o un error de compilación,
   el `CATCH` ejecutó `ROLLBACK`. No reintentar cambiando interruptores; leer el mensaje
   y reportar.
8. **STOP sin rollback (commit ya consumado):** si tras "confirmado" la verificación sale
   INCOMPLETA, faltan tablas o los registros ≠ 96, **restaurar el `.bak`** verificado
   (backend detenido) antes de investigar.
9. **Tras B1**, el borrador queda con la configuración del grupo B (`@AuthorizeDdl=1`,
   `@BackupVerified=1`, resto 0); alternativamente, vuelve los 6 a `0` como pausa segura.
   Validar que el backend arranca en modo lectura y reservar la siguiente ventana para el
   **grupo C** (backfill): esta vez con `@AuthorizeDdl=1`, `@BackupVerified=1`,
   `@AuthorizeBackfill=1`, `@BackfillDepartments=1`, `@BackfillUsers=1` y
   `@MakeDepartmentsNotNull=0`.

---

### 13.5 Instrucciones exactas — grupo C (backfill de `organization_id` → CMUCE)

**Precondiciones:** grupo B **verificado** (§17, resumen `GO`); respaldo externo con su
SHA-256 registrado (§7); decisión del modelo (bloqueo 3) y aprobación (bloqueo 4)
cerradas; **backend detenido**.

**Interruptores (grupo C):** `@AuthorizeDdl=1`, `@BackupVerified=1`,
`@AuthorizeBackfill=1`, `@BackfillDepartments=1`, `@BackfillUsers=1` y
**`@MakeDepartmentsNotNull=0`**. Este último es lo que **aisla el grupo D**: la fase 8 solo
corre si `@AuthorizeDdl=1 AND @MakeDepartmentsNotNull=1` (`reconcile-dev-draft.sql:952`).

> **Alternativa autocontenida (recomendada tras la auditoría de la fase 7):** en lugar de la
> fase 7 del borrador, ejecutar
> `backend/scripts/migration/backfill-organization-CMUCE.sql` (§11): hace el mismo backfill
> en una transacción atómica, pero **solo** toca los 25 `departments` y el usuario autorizado
> `id 4` (aborta si hubiera otro usuario NULL), aplica el **orden obligatorio
> `departments` → `users`** y exige `@AuthorizeBackfill=1` **y** `@BackupVerified=1`. Después,
> el veredicto formal se obtiene con `verify-after-groupC.sql` (§17.4).

1. Conectar **`sa`** a `TI-DESK-01\SIFHADEV` / `SIFHA_Tickets_DEV` en SSMS (o
   `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b
   -i backend/scripts/migration/reconcile-dev-draft.sql -o run_C.log`).
2. Poner los 5 interruptores del grupo C en `1` y **`@MakeDepartmentsNotNull=0`** (ver
   tabla). **F5**.
3. Secuencia esperada en Messages: identidad verificada → bloque DDL fases 1-6/2b
   **re-ejecutado e idempotente** (todas las guardas `OBJECT_ID`/`NOT EXISTS`/
   `COL_LENGTH` lo hacen un **no-op**; no crea nada duplicado) → pre-chequeo de rol
   (solo lectura) mostrando **`rol_code = ADMIN`** → fase 7: "organizacion CMUCE ...
   reutilizada" o "creada" → **"departments asignados a CMUCE = 25"** →
   **"users asignados a CMUCE = 1"** → `COMMIT` → **"Fase 8 OMITIDA: @MakeDepartmentsNotNull = 0..."** →
   verificación posterior con `users.organization_id NULL: 0` y
   `departments.organization_id NULL: 0`.
4. **Independencia respecto de B:** la fase 7 se ejecuta en su **propia transacción**
   (TRY/CATCH) y **solo actualiza `organization_id`** (nunca `password_hash`, `role_id` ni
   `role_permissions`). Re-ejecutar C es seguro e idempotente: CMUCE se **reutiliza por
   `code`** (`UPDLOCK/HOLDLOCK`, nunca se duplica) y si ya está asignado, los
   `UPDATE ... WHERE organization_id IS NULL` afectan **0 filas**. Si se corriera C sin B,
   la fase 7 aborta con `RAISERROR` (falta `organization_id`) y **no deja efectos**.
5. **Punto de control C1 alcanzado** con: pre-chequeo sin cuentas SUPERADMIN/global,
   "departments asignados = 25", "users asignados = 1" y "Fase 8 OMITIDA". Guardar el log
   como `run_C.log`.
6. **STOP con rollback:** un `RAISERROR` en fase 7 revierte todo (CMUCE + backfill);
   base como quedó tras B. Leer el mensaje y reportar; no forzar interruptores.
7. **STOP sin rollback:** si los conteos no son 25/1 (p.ej. 0/0 por re-ejecución ya
   aplicada, o difieren de lo esperado), confirmar el estado real con
   `verify-after-groupB.sql` (§17.1) o restaurando el `.bak`.
8. **Tras C1**, deja los interruptores en pausa segura (los 6 en `0`, o la config B si vas a
   repetir B); las comprobaciones esperadas ahora serán
   `organizations = 1 fila` (CMUCE), NULL de org = **0/0** y el total de 24 tablas =
   97 (96 + 1 de `organizations`). Reservar ventana para el **grupo D** (fase 8) solo con
   la decisión del bloqueo 3 en modo "paridad total".

---

### 13.6 Instrucciones exactas — grupo D (endurecimiento `departments.organization_id` → NOT NULL)

**Precondiciones:** grupo C **verificado** (C1: NULL org = **0/0**); **decisión del bloqueo 3
tomada en modo "paridad total"**; aprobación del bloqueo 4 **cerrada**; **backend detenido**.

**Interruptores (grupo D):** `@AuthorizeDdl=1`, `@BackupVerified=1`,
**`@MakeDepartmentsNotNull=1`** y **`@AuthorizeBackfill=0`, `@BackfillDepartments=0`,
`@BackfillUsers=0`** (el backfill de la fase 7 ya se aplicó en C; si se dejara en 1 no habría
efecto porque no quedan filas con `organization_id NULL`, pero la aislación del grupo exige 0).

1. Conectar **`sa`** a `TI-DESK-01\SIFHADEV` / `SIFHA_Tickets_DEV` en SSMS (o
   `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b
   -i backend/scripts/migration/reconcile-dev-draft.sql -o run_D.log`).
2. Poner **en 1 SOLO** `@AuthorizeDdl`, `@BackupVerified` y `@MakeDepartmentsNotNull`; los
   tres interruptores de datos (`@AuthorizeBackfill`, `@BackfillDepartments`,
   `@BackfillUsers`) **en 0**. **F5**.
3. Secuencia esperada en Messages: identidad verificada → bloque DDL fases 1-6/2b
   **re-ejecutado e idempotente** (no-op) → "Fase 7 OMITIDA…" (por `@AuthorizeBackfill=0`) →
   fase 8: chequeo de NULLs (`0 departments sin organization_id`) → `ALTER TABLE
   dbo.departments ALTER COLUMN organization_id INT NOT NULL;` → **"Fase 8:
   departments.organization_id es NOT NULL."** → `COMMIT` → verificación posterior:
   `users.organization_id NULL: 0` y `departments.organization_id NULL: 0` →
   **"VERIFICACION POSTERIOR: OK -- 24 tablas presentes y 96 registros conservados."**
   (el borrador cuenta las 6 tablas iniciales; el **total real con CMUCE es 97**, que lo
   confirma el verificador final).
4. **Dependencia con C:** la fase 8 aborta con `RAISERROR` si quedara algún `departments`
   con `organization_id NULL` (`reconcile-dev-draft.sql:958`), así que no puede ejecutarse
   antes del backfill. La fase 8 **no toca datos**: solo `ALTER COLUMN` de nulabilidad.
   `users.organization_id` **permanece NULL-able** (idéntico a `schema.sql`).
5. **Punto de control D1 alcanzado** con: "Fase 8: departments.organization_id es NOT NULL."
   y NULL org 0/0 + verificación OK (96 de las 6 tablas; 97 reales con CMUCE). Guardar el
   log como `run_D.log`.
6. **Post-D1** (y post-C), el verificador final `verify-final-reconciliation.sql` (§17.2)
   debe devolver **`VERIFICADOR FINAL: GO`**; guardar su salida como `verify-final.log`.
7. **STOP (pre-commit):** si la fase 8 arroja `RAISERROR` (quedan NULL), el `CATCH` revirtió
   y la base queda como tras C. No forzar interruptores; reportar.
8. **STOP (post-commit):** si tras D el verificador final sale `NO-GO`, restaurar el `.bak`
   (ver §19) con el backend detenido antes de investigar.

---

### 13.7 Instrucciones exactas — grupo E (verificación final y arranque en seco)

**Precondiciones:** grupo D **verificado** (`verify-final.log` con **`VERIFICADOR FINAL: GO`**)
y decisión/aprobación cerradas. El grupo E es **solo lectura**: no escribirá datos
institucionales. El arranque del backend valida el esquema con `schemaValidator` (SELECT sobre
catálogo) y **no aplica DDL, migraciones ni seed**.

> **Orden crítico:** ejecutar el verificador final **antes** de arrancar el backend. El
> arranque (y un eventual login de prueba) **crea filas en `sessions`**; tras eso el conteo
> de 97 del verificador ya no es aplicable (es runtime operativo, no una regresión).

1. **Verificador final (solo lectura):** con `sa` en SSMS (o
   `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b
   -i backend/scripts/migration/verify-final-reconciliation.sql -o verify-final.log`).
   Esperado: 24/24 tablas, **97** registros, CMUCE=1, NULL org 0/0,
   `departments.organization_id` NOT NULL (1), `users.organization_id` NULL-able (0),
   9/9 longitudes, UQ 20/20, FK 30/30 habilitadas y confiables, IX 23/23, 0 huérfanos,
   0 desviaciones de paridad → **`VERIFICADOR FINAL: GO`**.
2. **Conexión (smoke de red/catálogo):** confirmar identidad y alcance con
   `sqlcmd -S TI-DESK-01\SIFHADEV -E -Q "SELECT CONVERT(NVARCHAR(128),@@SERVERNAME) AS srv, CONVERT(NVARCHAR(128),SERVERPROPERTY('InstanceName')) AS inst, DB_NAME() AS db;"`.
   Todo SELECT; sin efectos.
3. **Arranque controlado del backend en MSSQL (solo lectura en arranque):** usar las
   variables de entorno del runtime MSSQL (`DB_CLIENT=mssql`, `MSSQL_RUNTIME=true`,
   `DB_SERVER`/`DB_INSTANCE=SIFHADEV`/`DB_DATABASE=SIFHA_Tickets_DEV` y credenciales vía
   variables de entorno; **estas variables no se documentan aquí**). Arrancar con `npm start`
   (o `node src/server.js`) capturando la salida en `backend-start.log`.
   - **Esperado:** línea `[db] Esquema SQL Server verificado (solo lectura): 24 tablas y N
     columnas.` y `[ticket] API escuchando en http://localhost:<puerto> (...)`.
   - Si `schemaValidator` encontrara diferencias, `describeSchemaFailures` imprime el diff y
     el servidor **no inicia HTTP**: E queda en **NO-GO** (detener, documentar, corregir).
   - Alcance del validador: solo tablas/columnas (nulabilidad e IDENTITY)/restricciones por
     nombre (PK/UQ/FK/CHECK/DEFAULT). **No** revisa longitudes `NVARCHAR` ni índices `IX_*`:
     esos dos los cubre el verificador final del paso 1, que ya debe estar en `GO`.
   - Avisos (restricciones/columnas/tablas adicionales legacy) no bloquean: `schema.ok`
     solo exige `errors = 0`.
4. **Pruebas funcionales sin modificar datos institucionales (solo lectura):**
   - `GET /api/health` → `200 {"ok":true,…}` (no requiere autenticación).
   - Autenticado con `GET /api/auth/me`: requiere sesión; **advertencia:** el login crea una
     fila en `sessions` (dato operativo de runtime, no institucional). Mínimo indispensable,
     una sesión, y **no** usarlo para validar conteos (ver nota de orden crítico).
   - Lecturas institucionales: `GET /api/departments`, `GET /api/categories`, `GET /api/roles`,
     `GET /api/users`, etc. — todas deben responder `200`/JSON sin ejecutar escrituras.
   - **No ejecutar** `POST/PUT/PATCH/DELETE` sobre datos (crear tickets, usuarios,
     departamentos, KB…). Ninguna prueba destructiva.
5. **Punto de control E1 alcanzado** con: verificador final `GO`, `schemaValidator` OK,
   HTTP arriba y las lecturas `GET` en `200`. Guardar `backend-start.log` y las respuestas
   como evidencia de `run_E`.
6. **STOP:** ante `VERIFICADOR FINAL: NO-GO`, diff de `schemaValidator`, fallo de arranque o
   cualquier error `5xx` en las lecturas, detener, documentar y corregir **antes** de
   promocionar. Tras E, los 6 interruptores quedan en `0` (pausa segura) y el backend puede
   volver a operar sobre DEV solo con autorización.

---

## 14. Resumen de auditoría (2026-10-11)

Veredicto: **APTO CONDICIONADO** (las correcciones ya aplicadas se listan abajo; las
verificaciones previas 16.1-16.5 quedaron **cerradas** y la autorización del grupo B
depende solo de la 16.6, la decisión del bloqueo 3 y la aprobación del bloqueo 4).

Correcciones aplicadas en esta auditoría (documentadas):
1. **P1 (plan)**: la fase 4 decía "crear las 15 tablas faltantes restantes"; en realidad
   crea **17** (categories…kb_article_history) y, con `organizations` (fase 1), completan
   las **18** tablas faltantes confirmadas.
2. **P2 (plan)**: se registró la decisión confirmada del rol de la cuenta (**ADMIN**, de
   organización) y se quitaron las referencias a "si fuera SUPERADMIN" como decisión
   abierta; el pre-chequeo de rol se mantiene como verificación visual.
3. **P3 (plan)**: se registró que el respaldo `COPY_ONLY` + `RESTORE VERIFYONLY` ya se
   realizó (2026-10-11) y solo falta documentar ruta/checksum.
4. **P4 (plan)**: nueva sección 13 (procedimiento de ejecución por fases con puntos de
   control y condiciones de STOP) y sección 14 (resumen de esta auditoría).
5. **D1 (borrador)**: la fase 3 ahora también crea las unicidades canónicas
   `UQ_users_username`, `UQ_users_email`, `UQ_roles_code`, `UQ_permissions_code` (con
   pre-chequeo de duplicados que aborta la transacción), coincidiendo con `schema.sql`.
6. **D2 (borrador)**: comentarios actualizados a las por defecto 17 tablas de la fase 4
   y al rol confirmado (ADMIN) sin cambiar el comportamiento por defecto (interruptores
   en 0).
7. **D3 (borrador, 2026-10-11 — corrección crítica de condiciones invertidas)**: las
   guardas del oficial estaban **invertidas** respecto a su intención y a los mensajes.
   Corregidas a la lógica segura:
   - §0b respaldo: `IF @AuthorizeDdl = 1 AND @BackupVerified = 0` → **aborta** (antes
     abortaba con `= 1`, es decir exigía lo contrario de lo que anunciaba).
   - Fase 7 (gate): `IF @AuthorizeDdl = 1 AND @AuthorizeBackfill = 1` (antes `= 0`).
   - Fase 7 (UPDATE departments): `IF @BackfillDepartments = 1` (antes `= 0`).
   - Fase 7 (UPDATE users): `IF @BackfillUsers = 1` (antes `= 0`).
   - Fase 8 (gate): `IF @AuthorizeDdl = 1 AND @MakeDepartmentsNotNull = 1` (antes `= 0`).
   Mensajes `ELSE`/`RAISERROR` y banner de cabecera reescritos para reflejar la
   condición real. Con la configuración del grupo B (`@AuthorizeBackfill=0`,
   `@MakeDepartmentsNotNull=0`) las fases 7 y 8 quedan **correctamente omitidas**; en la
   versión invertida la fase 7 se habría **ejecutado por error** al correr el grupo B.
   Archivo oficial `reconcile-dev-draft.sql` actualizado; los duplicados históricos ya
   tenían esta lógica correcta.
8. **D4 (borrador + fix puntual, 2026-10-11 — FK compuesta)** — hallazgo **B1 NO-GO**:
   el verificador post-B reportó **1 FK faltante**: `FK_users_department_same_org`. Causa:
   la guarda de la fase 5 comprobaba "existe alguna FK sobre `users.department_id`"; como
   la FK legacy `FK_users_department` (`department_id` → `departments.id`) ya existía, la
   guarda consideraba la columna cubierta y **omitía** la FK compuesta. Correcciones:
   - `reconcile-dev-draft.sql` (fase 5): la guarda ahora detecta la **pareja de columnas**
     `(organization_id, department_id)` referenciando `dbo.departments` (independiente del
     nombre y de la FK legacy), y crea la FK con `WITH CHECK` (líneas ~778-803).
   - Nuevo `backend/scripts/migration/fix-users-department-same-org.sql`: fix **aislado**
     para el estado ya ejecutado, que crea **solo** esa FK (ver §17.3). Conserva
     `FK_users_department`, no modifica datos ni organizaciones.
   Estado B1 tras el fix: **pendiente de confirmar** con `verify-after-groupB.sql`; **los
   grupos C/D siguen bloqueados** hasta `VERIFICADOR POST-B: GO`.

Hallazgos sin corrección (decisiones de diseño documentadas, no bloqueantes):
- Las FK heredadas en tablas existentes con nombres distintos de los canónicos no se
  renombran (la fase 5 las detecta y omite duplicados; el validador las reporta como
  aviso). Verificar en la salida del inventario si `users`/`departments` tienen FK
  heredadas sobre `department_id`/`organization_id`.
- No se verifica programáticamente que el `.bak` corresponda a la fecha/hora exacta de
  ejecución: es un punto de confianza humano cubierto por `@BackupVerified`.
- La fase 8 deja `users.organization_id` NULLable (idéntico a `schema.sql`); solo
  `departments.organization_id` pasa a NOT NULL.
- El `schemaValidator` del runtime es el cierre final del diff; si reportara diferencias
  no previstas, se detiene el grupo E y se corrige antes de promocionar a datos.

---

## 15. Validación final de la simulación (2026-10-11)

**Veredicto: APTO CONDICIONADO.** La simulación es segura y el borrador está apto para
la fase DDL (grupo B) **solo si se cierran los bloqueos pendientes de §10 y se ejecutan
las consultas de solo lectura de §16**. Con un bloqueo abierto, la autorización queda
**suspendida** (no proceder al grupo B).

- **Interruptores por defecto (configuración del grupo B)**: el borrador oficial viene con
  `@AuthorizeDdl = 1` y `@BackupVerified = 1`, y los otros cuatro
  (`@AuthorizeBackfill`, `@BackfillDepartments`, `@BackfillUsers`, `@MakeDepartmentsNotNull`)
  en `0` (corregido el 2026-10-11, ver D3 en §14). Así, ejecutarlo sin editar ejecuta
  **solo** las fases 1-6 y 2b del grupo B; fases 7 y 8 no pueden dispararse.
- **Verificaciones previas cerradas**: 16.1 (FK de `role_permissions` existentes,
  habilitadas, confiables, CASCADE), 16.2 (ejecutor `sa`), 16.4 (dos `COPY_ONLY` con
  checksums y `VERIFYONLY` OK) y 16.5 (**0** índices/estadísticas sobre las columnas a
  reducir), todo ejecutado el 2026-10-11. La **16.6** (valores máximos) queda como
  última condición junto a los bloqueos 1, 3 y 4 de §10.
- **Sin DDL/DML en simulación**: todo CREATE/ALTER/INDEX está dentro de `IF @AuthorizeDdl=1`
  (bloque no alcanzado con 0), los UPDATE/INSERT de datos dentro de
  `IF @AuthorizeDdl=1 AND @AuthorizeBackfill=1`, y la fase 8 dentro de
  `IF @AuthorizeDdl=1 AND @MakeDepartmentsNotNull=1`. La única actividad con 0 es lectura
  (`sys.*`, `COL_LENGTH`, `OBJECT_ID`, conteos y el pre-chequeo de rol).
- **Funciona con 18 tablas ausentes y `organization_id` inexistente**: las referencias a
  `organization_id` que el lote compila en modo simulación van ya por **SQL dinámico**
  (incluido el prechequeo de `departments` de la fase 3, consolidado en esta auditoría);
  las 24 tablas se consultan con `OBJECT_ID`; las columnas nuevas no se referencian
  estáticamente fuera de sus gates (la compilación evita el error 207/208 en modo simulación).
- **Coherencia A/B/C/D/E**: verificada; los interruptores por grupo están explicitados en §13.
- **Dependencias**: C y D requieren B (§13.2); A/B/E son repetibles e idempotentes.
- **Fase 8 aislada de B**: confirmado por su gate doble (`@AuthorizeDdl=1 AND
  @MakeDepartmentsNotNull=1`); en B `@MakeDepartmentsNotNull` sigue en 0.
- **Anti-falso-éxito**: la verificación posterior ahora calcula y **imprime un resumen**
  (`OK` solo si hay 24 tablas y los 96 registros exactos); en simulación dirá
  INCOMPLETA — faltan 18 tablas.
- **Parada segura**: documentada en §13.3 (rollback automático en B/2b; restaurar `.bak`
  tras commit de C/D; backend detenido; no forzar interruptores).

### Consolidación de duplicados (hecha en esta auditoría)

Se comparó `reconcile-dev-draft.sql` (oficial) contra los dos borradores históricos:

- `reconcile-dev-draft-corregido (1).sql` — aporta: guardas THROW adicionales en fase 7
  (código inexistente, `organizations` ausente, ambos backfills apagados), ya cubiertas
  por el oficial con RAISERROR/guards equivalentes (el CATCH revierte la transacción).
  **No se importaron por duplicar protección ya existente.**
- `reconcile-dev-draft-corregido-v2.sql` — aporta la **corrección válida pendiente**:
  el prechequeo de duplicados `(organization_id, name)` de la fase 3 se ejecuta en
  **SQL dinámico** porque las columnas se resuelven en **compilación** y
  `organization_id` no existe en modo simulación. **CONSOLIDADA** en el oficial.
- El oficial, además, ya incluía `SET ANSI_WARNINGS ON`, cabecera de fase 7 atómica y
  mensajes de verificación actualizados que los duplicados no tenían.

Ambos duplicados quedan **superados**; no se eliminaron para conservar trazabilidad.

---

## 16. Consultas de solo lectura previas a la autorización DDL

Todas son **exclusivamente de lectura** (SELECT sobre catálogos `sys.*`, `msdb.dbo.*` y
conteos). No ejecutan migraciones, CREATE, ALTER, DROP, INSERT, UPDATE ni DELETE. Se
ejecutan en SSMS conectado a **`TI-DESK-01\SIFHADEV`** con base `SIFHA_Tickets_DEV`.

### 16.1 — Existencia y estado de las dos FK de `role_permissions`

```sql
-- 16.1 FK de dbo.role_permissions: existencia + habilitada + confiable (solo lectura)
SELECT
    v.fk_requerida,
    CASE WHEN fk.object_id IS NULL THEN N'FALTA' ELSE N'EXISTE' END AS existencia,
    CASE WHEN fk.object_id IS NULL THEN N'-'
         WHEN fk.is_disabled = 0 AND fk.is_not_trusted = 0 THEN N'HABILITADA Y CONFIABLE'
         WHEN fk.is_disabled = 1 THEN N'DESHABILITADA (is_disabled = 1)'
         ELSE N'NO CONFIABLE (is_not_trusted = 1)' END AS estado,
    COL_NAME(fkc.parent_object_id, fkc.parent_column_id)     AS columna_hija,
    OBJECT_SCHEMA_NAME(fk.referenced_object_id) + N'.' + OBJECT_NAME(fk.referenced_object_id) AS tabla_padre,
    COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS columna_padre,
    fk.delete_referential_action_desc AS accion_delete
FROM (VALUES
        (N'FK_role_permissions_role'),
        (N'FK_role_permissions_permission')
     ) AS v(fk_requerida)
LEFT JOIN sys.foreign_keys AS fk
       ON fk.name = v.fk_requerida AND fk.parent_object_id = OBJECT_ID(N'dbo.role_permissions')
LEFT JOIN sys.foreign_key_columns AS fkc
       ON fkc.constraint_object_id = fk.object_id AND fkc.constraint_column_id = 1
ORDER BY v.fk_requerida;

-- Detalle de TODAS las FK reales sobre role_permissions (columnas, CASCADE, estado)
SELECT
    fk.name AS fk,
    COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS columna_hija,
    OBJECT_SCHEMA_NAME(fk.referenced_object_id) + N'.' + OBJECT_NAME(fk.referenced_object_id) AS tabla_padre,
    COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS columna_padre,
    fk.delete_referential_action_desc AS accion_delete,
    fk.is_disabled AS deshabilitada,
    fk.is_not_trusted AS no_confiable
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
WHERE fk.parent_object_id = OBJECT_ID(N'dbo.role_permissions')
ORDER BY fk.name, fkc.constraint_column_id;
```

**Criterio APTO:** ambas filas con `existencia = EXISTE`, `estado = HABILITADA Y CONFIABLE`
y `accion_delete = CASCADE`.

### 16.2 — Permisos del login/usuario ejecutor (fases B/C/D y respaldo)

```sql
-- 16.2 Permisos efectivos del ejecutor (solo lectura)
SELECT
    DB_NAME() AS base_actual,
    SUSER_SNAME() AS login_actual,
    USER_NAME()   AS usuario_bd_real,
    IS_SRVROLEMEMBER(N'sysadmin')               AS es_sysadmin,
    IS_ROLEMEMBER(N'db_owner')                  AS es_db_owner,
    IS_ROLEMEMBER(N'db_ddladmin')               AS es_db_ddladmin,
    IS_ROLEMEMBER(N'db_datawriter')             AS es_db_datawriter,
    IS_ROLEMEMBER(N'db_datareader')             AS es_db_datareader,
    IS_ROLEMEMBER(N'db_backupoperator')         AS es_db_backupoperator,
    HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'ALTER')        AS puede_alter_db,
    HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CREATE TABLE') AS puede_create_table,
    HAS_PERMS_BY_NAME(N'dbo', N'SCHEMA', N'ALTER')             AS puede_alter_schema_dbo,
    HAS_PERMS_BY_NAME(N'dbo', N'SCHEMA', N'VIEW DEFINITION')   AS puede_ver_definicion,
    HAS_PERMS_BY_NAME(N'dbo.departments', N'OBJECT', N'ALTER') AS puede_alter_departments,
    HAS_PERMS_BY_NAME(N'dbo.organizations', N'OBJECT', N'INSERT') AS puede_insert_organizations,
    HAS_PERMS_BY_NAME(N'dbo.users', N'OBJECT', N'UPDATE')      AS puede_update_users,
    HAS_PERMS_BY_NAME(NULL, NULL, N'BACKUP DATABASE')          AS puede_backup_database;
```

**Criterio APTO para el grupo B/D:** `es_db_owner = 1` (o `es_sysadmin = 1`), y
`puede_alter_schema_dbo = 1`. Para el respaldo: `puede_backup_database = 1` (o
`es_db_backupoperator = 1` / `es_sysadmin = 1`). Para la fase C: `puede_insert_organizations`
y `puede_update_users = 1` (o `es_db_owner`).

### 16.3 — Miembros de rol / logins hábiles (referencia para designar ejecutor)

```sql
-- 16.3 Miembros del rol de base db_owner y de servidor sysadmin (solo lectura)
SELECT N'sysadmin' AS rol, member.name AS miembro
FROM sys.server_role_members
JOIN sys.server_principals AS member ON member.principal_id = sys.server_role_members.member_principal_id
JOIN sys.server_principals AS role  ON role.principal_id  = sys.server_role_members.role_principal_id
WHERE role.name = N'sysadmin'
UNION ALL
SELECT N'db_owner', usr.name
FROM sys.database_role_members
JOIN sys.database_principals AS usr ON usr.principal_id = sys.database_role_members.member_principal_id
JOIN sys.database_principals AS rol ON rol.principal_id = sys.database_role_members.role_principal_id
WHERE rol.name = N'db_owner'
ORDER BY rol, miembro;
```

### 16.4 — Respaldo existente y verificado (msdb, solo lectura)

```sql
-- 16.4 Historial de respaldos de SIFHA_Tickets_DEV (solo lectura; requiere lectura en msdb)
SELECT TOP (10)
    b.database_name,
    b.type AS tipo,
    b.backup_start_date,
    b.backup_finish_date,
    b.backup_size,
    b.compressed_backup_size,
    b.is_copy_only,
    b.has_backup_checksums AS usa_checksum,
    b.is_damaged AS danado,
    f.physical_device_name
FROM msdb.dbo.backupset AS b
LEFT JOIN msdb.dbo.backupmediafamily AS f ON f.media_set_id = b.media_set_id
WHERE b.database_name = N'SIFHA_Tickets_DEV'
ORDER BY b.backup_finish_date DESC;

-- Identidad confirmada (contexto actual)
SELECT
    DB_NAME() AS base_actual,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('ServerName'))   AS servidor,
    CONVERT(NVARCHAR(128), SERVERPROPERTY('InstanceName')) AS instancia,
    CONVERT(NVARCHAR(128), @@SERVERNAME)                   AS servidor_registrado;
```

**Criterio APTO:** existe una fila reciente del 2026-10-11 con `is_copy_only = 1`,
`usa_checksum = 1` y `danado = 0`; ese `.bak` fue validado con `RESTORE VERIFYONLY`
(acción humana previa) y su ruta/checksum quedó registrada en el log de ejecución.

### 16.5 — Objetos dependientes de las 9 longitudes (riesgo de `ALTER COLUMN`)

Regla operativa (docs `ALTER TABLE ... ALTER COLUMN`): **incrementar** longitud
`NVARCHAR` es seguro aunque existan índices/UNIQUE/CHECK/DEFAULT; **reducirla** se
bloquea si la columna tiene un **índice** (incluye el índice de un UNIQUE) o una
**estadística creada por el usuario** (`CREATE STATISTICS`). Las únicas reducciones del
plan son `roles.name` (200→150) y `users.position` (255→200).

```sql
-- 16.5.1 Indices/PK/UQ sobre las 9 columnas (bloquean REDUCCION; no bloquean incremento)
SELECT t.name AS tabla, c.name AS columna, i.name AS indice,
       CASE WHEN i.is_primary_key = 1 THEN N'PK'
            WHEN i.is_unique_constraint = 1 THEN N'UNIQUE CONSTRAINT'
            WHEN i.is_unique = 1 THEN N'UNIQUE INDEX'
            ELSE N'INDEX' END AS detalle,
       i.type_desc AS tipo_indice
FROM sys.indexes AS i
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.tables AS t ON t.object_id = i.object_id
JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND (t.name, c.name) IN (
        (N'departments', N'name'), (N'roles', N'name'),
        (N'users', N'email'), (N'users', N'last_name'), (N'users', N'name'),
        (N'users', N'password_hash'), (N'users', N'password_reset_token'),
        (N'users', N'position'), (N'users', N'username'))
ORDER BY t.name, c.name, i.name;

-- 16.5.2 Estadisticas de usuario sobre las 9 columnas (bloquean CUALQUIER alter)
SELECT t.name AS tabla, c.name AS columna, s.name AS estadistica
FROM sys.stats AS s
JOIN sys.stats_columns AS sc ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id
JOIN sys.tables AS t ON t.object_id = s.object_id
JOIN sys.columns AS c ON c.object_id = sc.object_id AND c.column_id = sc.column_id
WHERE s.user_created = 1
  AND t.schema_id = SCHEMA_ID(N'dbo')
  AND (t.name, c.name) IN (
        (N'departments', N'name'), (N'roles', N'name'),
        (N'users', N'email'), (N'users', N'last_name'), (N'users', N'name'),
        (N'users', N'password_hash'), (N'users', N'password_reset_token'),
        (N'users', N'position'), (N'users', N'username'))
ORDER BY t.name, c.name;

-- 16.5.3 Otros dependientes (DEFAULT / CHECK / columna calculada) - informativo, no bloquean longitud
SELECT t2.name AS tabla, c2.name AS columna,
       OBJECT_NAME(dep.referencing_id) AS objeto_dependiente,
       o.type_desc AS tipo_objeto
FROM sys.sql_expression_dependencies AS dep
JOIN sys.objects AS o ON o.object_id = dep.referencing_id
JOIN sys.columns AS c2 ON c2.object_id = dep.referenced_major_id AND c2.column_id = dep.referenced_minor_id
JOIN sys.tables AS t2 ON t2.object_id = c2.object_id
WHERE dep.referenced_minor_id <> 0
  AND t2.schema_id = SCHEMA_ID(N'dbo')
  AND (t2.name, c2.name) IN (
        (N'departments', N'name'), (N'roles', N'name'),
        (N'users', N'email'), (N'users', N'last_name'), (N'users', N'name'),
        (N'users', N'password_hash'), (N'users', N'password_reset_token'),
        (N'users', N'position'), (N'users', N'username'))
ORDER BY t2.name, c2.name, objeto_dependiente;
```

**Criterio APTO:** `16.5.1` no devuelve filas con `detalle LIKE '%UNIQUE%'` ni índices
sobre `roles.name`/`users.position`; `16.5.2` vacía. Si aparecen filas, hay que decidir
(§10, bloqueo 8) entre recrear el objeto en la fase 2b o mantener la longitud actual.
Los resultados de `16.5.3` son informativos (no bloquean un cambio de longitud con el
mismo tipo de datos).

### 16.6 — Valores máximos reales de las 9 columnas (headroom de datos)

Las columnas ya existen en la base (fase 2b solo les cambia la longitud), por lo que las
referencias estáticas son seguras. La fase 2b del borrador **ya replica este chequeo**
(`MAX(LEN)` → RAISERROR con rollback si supera el objetivo); esta consulta sirve para
confirmar el headroom **antes** de autorizar y documentar los números reales.

```sql
-- 16.6 Valores máximos vs longitud objetivo (solo lectura)
SELECT N'departments.name'                  AS columna, MAX(LEN(name)) AS max_chars, 150 AS objetivo FROM dbo.departments
UNION ALL SELECT N'roles.name',              MAX(LEN(name)), 150 FROM dbo.roles
UNION ALL SELECT N'users.email',             MAX(LEN(email)), 320 FROM dbo.users
UNION ALL SELECT N'users.last_name',         MAX(LEN(last_name)), 150 FROM dbo.users
UNION ALL SELECT N'users.name',              MAX(LEN(name)), 150 FROM dbo.users
UNION ALL SELECT N'users.password_hash',     MAX(LEN(password_hash)), 500 FROM dbo.users
UNION ALL SELECT N'users.password_reset_token', MAX(LEN(password_reset_token)), 500 FROM dbo.users
UNION ALL SELECT N'users.position',          MAX(LEN(position)), 200 FROM dbo.users
UNION ALL SELECT N'users.username',          MAX(LEN(username)), 150 FROM dbo.users;

-- Filas que EXCEDERÍAN los objetivos de las dos REDUCCIONES (debe devolver 0 en ambas)
SELECT N'roles.name' AS columna, COUNT(*) AS filas_sobre_objetivo
FROM dbo.roles WHERE LEN(name) > 150
UNION ALL
SELECT N'users.position', COUNT(*) FROM dbo.users WHERE LEN(position) > 200;
```

**Criterio APTO:** en la primera consulta `max_chars <= objetivo` para las 9 filas; en la
segunda, `filas_sobre_objetivo = 0` (0 y 0). Si `roles.name` o `users.position` tuvieran
datos más largos que el objetivo, el `ALTER COLUMN` de la fase 2b **abortaría la
transacción B** — en ese caso revisar datos u objetivo antes de ejecutar.

---

## 17. Verificadores de solo lectura (post-grupo B y final)

### 17.1 Verificador post-grupo B

**Script:** `backend/scripts/migration/verify-after-groupB.sql` (100 % SELECT / `sys.*` /
conteos; sin escrituras). Verifica en un solo paso los criterios del grupo B:

| Sección del guion | Qué comprueba | Esperado tras B |
|---|---|---|
| [0] Identidad | base/instancia/servidor | `OK` |
| [1] Tablas | las **24** requeridas presentes | 24/24 `PRESENTE` |
| [2] Registros | conteo real por tabla (SQL dinámico) | **96** en total (18 nuevas en 0; `organizations` 0) |
| [3] Longitudes | las **9** columnas `NVARCHAR` | 9/9 `OK` |
| [4] org NULL | `organization_id` NULL por SQL dinámico | `users = 1`, `departments = 25` (pendiente el backfill C) |
| [5] UQ_* | las 20 unicidades canónicas del grupo B | 20/20 `PRESENTE` |
| [6] FKs | 30 FKs clave, habilitadas y confiables | 30/30 `PRESENTE` |
| [7] IX_* | los 23 índices del grupo B | 23/23 `PRESENTE` |
| [8] Integridad | resumen por tabla (FKs/índices/checks) | sin huecos |
| [9] Resumen | suma automática de [1]-[8] | **`VERIFICADOR POST-B: GO`** |

**Uso en SSMS:** conectar **`sa`** a `TI-DESK-01\SIFHADEV` / `SIFHA_Tickets_DEV`, abrir
`verify-after-groupB.sql` **sin editarlo**, **F5**, leer Messages/Results.

- Se puede ejecutar **antes** del grupo B sin romper (cualquier lectura faltante se
  reporta como `FALTA`/`NO EXISTE`).
- **Tras el grupo C** cambian solo: `[2]` total 97 (organizations=1), `[4]` NULL 0/0 y
  `organizations` con 1 fila — la sección [9] lo marcará `NO-GO` porque ese script está
  calibrado para el estado **post-B** (0 filas org, 1/25 NULL); usarlo, por tanto,
  siempre **inmediatamente después de B**.

### 17.2 Verificador final (post-grupo D / estado reconciliado)

**Script:** `backend/scripts/migration/verify-final-reconciliation.sql` (100 % SELECT /
`sys.*` / conteos; sin escrituras). Calibrado al estado **post-D** (pre-arranque del
backend):

| Sección del guion | Qué comprueba | Esperado tras D |
|---|---|---|
| [0] Identidad | base/instancia/servidor | `OK` |
| [1] Tablas | las **24** requeridas presentes | 24/24 `PRESENTE` |
| [2] Registros | conteo real por tabla | **97** en total (organizations=1 CMUCE; las 17 nuevas de fase 4 en 0) |
| [3] CMUCE | 1 organización `code='CMUCE'`; users/departments pertenecen a su `id` | 1 fila; 0 fuera |
| [4] org NULL + nulabilidad | NULL de `organization_id` (0/0) y `is_nullable` canónico | users=0, departments=0; `departments.organization_id` NOT NULL (1); `users.organization_id` NULL-able (0) |
| [5] Longitudes | las **9** columnas `NVARCHAR` | 9/9 `OK` |
| [6] UQ_* | las 20 unicidades canónicas | 20/20 `PRESENTE` |
| [7] FKs | 30 FKs clave, habilitadas y confiables | 30/30 `PRESENTE` |
| [8] IX_* | los 23 índices del grupo B | 23/23 `PRESENTE` |
| [9] Integridad | huérfanos (org/rol/departamento same-org/role_permissions) y pertenencia a CMUCE | 0 huérfanos |
| [10] Paridad | nulabilidad + IDENTITY de columnas clave de las 7 tablas con datos | 0 desviaciones |
| [11] ADMIN | usuario `id 4` (rol 7, dept 68, en CMUCE), rol `ADMIN` único y con permisos | 1 / 1 / 1 |
| [12] Resumen | suma automática de [1]-[11] | **`VERIFICADOR FINAL: GO`** |

**Uso:** con `sa` en SSMS sobre `SIFHA_Tickets_DEV` (**F5**) o consola (`sqlcmd ... -o
verify-final.log`). Ejecutarlo **siempre antes del arranque del backend** (§13.7). Estado
esperado por grupo: post-C → `NO-GO` solo por el chequeo de nulabilidad de
`departments.organization_id` (falta D); post-D → **`GO`**. Cubre además lo que el
`schemaValidator` del runtime **no revisa** (longitudes `NVARCHAR` e índices `IX_*`).

### 17.3 Fix puntual de la FK compuesta (post-B, si `NO-GO` por `FK_users_department_same_org`)

**Script:** `backend/scripts/migration/fix-users-department-same-org.sql`. Crea **solo** la
FK compuesta faltante `FK_users_department_same_org` (`users(organization_id, department_id)`
→ `departments(organization_id, id)`). Idempotente y con guardas; no borra la FK legacy
`FK_users_department`, no modifica datos ni organizaciones.

| Sección del guion | Qué hace | Aborta si |
|---|---|---|
| [0] Identidad | base/instancia/servidor | no coincide con `SIFHA_Tickets_DEV` / `SIFHADEV` / `TI-DESK-01\SIFHADEV` |
| [1] Columnas | `users.organization_id/department_id`, `departments.organization_id/id` | falta alguna |
| [2] UQ referenciada | `UQ_departments_organization_id(organization_id, id)` | falta (ejecutar fase 3/B antes) |
| [3] Integridad | 0 huérfanos (MATCH SIMPLE: solo ambos NO nulos) | hay huérfanos |
| [4] Creación | `ALTER TABLE ... WITH CHECK ADD CONSTRAINT` en transacción | error (rollback) o ya existe (idempotente) |
| [5] Confirmación | FK habilitada/confiable + legacy conservada | — |
| [6] Resumen | `GO`/`NO-GO` del fix | — |

**Uso:** con `sa` en SSMS sobre `SIFHA_Tickets_DEV` (**F5**) o consola
(`sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b -i backend/scripts/migration/fix-users-department-same-org.sql -o fix-fk.log`).
Debe hacerse **antes** del grupo C. Tras el fix, re-ejecutar **`verify-after-groupB.sql`**
(§17.1); solo con **`VERIFICADOR POST-B: GO`** se desbloquean los grupos C y D.

### 17.4 Verificador post-grupo C

**Script:** `backend/scripts/migration/verify-after-groupC.sql`. Solo lectura, con guarda de
identidad. Comprueba y resume: 24/24 tablas; total **97** registros (organizations=1); CMUCE
por `code` = 1; `departments.organization_id = CMUCE` = 25; `users.organization_id = CMUCE`
= 1; NULL de `organization_id` = **0/0**; 0 huérfanos (org/departamento/rol/same-org); usuario
`id 4` con `organization_id = CMUCE`, `role_id = 7`, `department_id = 68`; UQ/FK (incluidas
`FK_users_department_same_org` y la legacy `FK_users_department`) e IX esperados. **No exige**
`departments.organization_id` NOT NULL (llega en D; solo informa). Veredicto
`VERIFICADOR POST-C: GO`/`NO-GO`.

**Uso:** `sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b
-i backend/scripts/migration/verify-after-groupC.sql -o verify-C.log`. Es el **punto de
control C1**. Con `GO`, el grupo C queda cerrado y se desbloquea el grupo D (§13.6).

### 17.5 Grupo D independiente y su verificador (alternativa autocontenida)

Además de la fase 8 del borrador, el grupo D puede ejecutarse con dos scripts propios,
aislados de B y C (recomendado si se prefiere no re-ejecutar el borrador completo):

- **`apply-groupD-not-null.sql`** — hace **solo** `ALTER TABLE dbo.departments ALTER COLUMN
  organization_id INT NOT NULL`. Doble interruptor (`@AuthorizeDdl`, `@BackupVerified`),
  guardas de identidad y abundantes prechequeos; revalida **dentro** de la transacción con
  `UPDLOCK/HOLDLOCK`, verifica la nulabilidad **antes del `COMMIT`** y es idempotente. Resumen
  `GRUPO D: GO`. **No** toca `users.organization_id`.
- **`verify-after-groupD.sql`** — verificador solo lectura post-D: 24 tablas, 97 registros,
  CMUCE única, 25 depts/0 NULL/0 ajenos, `departments.organization_id INT NOT NULL`,
  `users.organization_id` NULL-able, UQ/FK/IX nucleares, 0 huérfanos; resumen
  `VERIFICADOR POST-D: GO`.

**Uso:** con `sa` en SSMS sobre `SIFHA_Tickets_DEV` (o por consola:
`sqlcmd -S TI-DESK-01\SIFHADEV -d SIFHA_Tickets_DEV -E -b -i
backend/scripts/migration/apply-groupD-not-null.sql -o run_D.log`, y luego
`... -i backend/scripts/migration/verify-after-groupD.sql -o verify-D.log`). Con
`VERIFICADOR POST-D: GO`, ejecutar el **verificador final** (§17.2) y confirmar
`VERIFICADOR FINAL: GO` antes de arrancar el backend (§13.7).

## 18. Criterios GO/NO-GO por fase (operador y auditor)

| Fase | **GO** (criterios del operador antes de ejecutar) | **NO-GO** (criterios de auditoría) |
|---|---|---|
| **0 (respaldo)** | `.bak` `COPY_ONLY` + `VERIFYONLY` OK; copia externa verificada por SHA-256 `C6057D…B69A`; hash registrado | sin la copia externa, sin hash, `VERIFYONLY` no realizado |
| **B (DDL)** | veredicto APTO (§14); respaldo verificado; **solo** `@AuthorizeDdl=1` y `@BackupVerified=1`; backend detenido; ventana reservada | cualquier otro interruptor en 1; sin respaldo; backend vivo; log no firmado |
| **B1 (post-B)** | `COMMIT` + "DDL ADITIVO (fases 1-6 y 2b) confirmado." + "VERIFICACION POSTERIOR: OK" + `verify-after-groupB.sql` → **`GO`** | `RAISERROR`/rollback; registros ≠ 96; longitudes ≠ 9/9; verifier `NO-GO`; org NULL ≠ 1/25 |
| **C (backfill)** | B1 `GO`; pre-chequeo de rol muestra **`ADMIN`** (ninguna SUPERADMIN/global); 5 interruptores en 1 y `@MakeDepartmentsNotNull=0`; backend detenido | rol SUPERADMIN/global (→ `@BackfillUsers=0`); conteos ≠ 25/1; **fase 8 no OMITIDA** (interruptor mal puesto); no hay B1 |
| **C1 (post-C)** | `COMMIT` + "Fase 8 OMITIDA" + conteos 25/1 + `verify-after-groupC.sql` → **`GO`** | `RAISERROR`/rollback; registros ≠ 97; CMUCE ≠ 1; NULL org ≠ 0/0; huérfanos > 0; verifier `NO-GO` |
| **D (NOT NULL)** | C1 `GO` (NULL 0/0); decisión "paridad total" tomada; **solo** `@AuthorizeDdl=1`, `@BackupVerified=1`, `@MakeDepartmentsNotNull=1`; backend detenido | quedan NULL en `departments`; decisión no tomada; cualquier interruptor de datos en 1; verifier final `NO-GO` por nulabilidad |
| **D1 (post-D)** | "Fase 8: departments.organization_id es NOT NULL." + NULL org 0/0 + "VERIFICACION POSTERIOR: OK" (96 de las 6 tablas iniciales) + `verify-final-reconciliation.sql` → **`GO`** (97 con CMUCE) | verifier final `NO-GO`; `departments.organization_id` sigue NULL-able; total ≠ 97 en el verificador final |
| **E (verificación final + arranque)** | verificador final **`GO`** (ejecutado antes de arrancar); `schemaValidator` OK (24 tablas y N columnas); HTTP arriba; `GET` de solo lectura en 200 sin escrituras institucionales | verificador `NO-GO`; diff de `schemaValidator`; arranque sin HTTP; `GET` con `5xx`; escritura institucional detectada |

Regla permanente: **ante cualquier `NO-GO`, detener la secuencia** (no pasar a la fase
siguiente), notificar al auditor y aplicar el procedimiento de recuperación de §19.

## 19. Resultados esperados y recuperación tras fallo de validación

### Resultados esperados acumulados (por fase)

| Escenario | `organizations` | Registros (24 tablas) | `organization_id` NULL (users/departments) | Longitudes | Estado verificación |
|---|---|---|---|---|---|
| Pre-B (simulación) | no existe | 96 | columna inexistente | 9 difieren | INCOMPLETA (esperado) |
| **Post-B** | **0 filas** | **96** | **1 / 25** | **9 OK** | **OK + verifier GO** |
| Post-C | 1 fila (CMUCE) | 97 | **0 / 0** | 9 OK | OK (org ya asignados) |
| Post-D | 1 fila | 97 | 0 / 0 + `NOT NULL` | 9 OK | OK |

### Recuperación ante fallo

**Árbol de decisión pre-COMMIT vs post-COMMIT:**

- **Antes del `COMMIT`** (B/C/D fallan con `RAISERROR`/`THROW`): el `TRY/CATCH` con
  `XACT_ABORT ON` **ya revirtió** y la base quedó exactamente como al empezar ese grupo.
  **No hay nada que restaurar**: solo documentar el mensaje y reportar. Reintentar tras
  entender la causa, **sin** cambiar interruptores a ciegas.
- **Después del `COMMIT`** (B, C o D ya confirmados y la verificación del grupo salió
  `NO-GO`): **no hay rollback automático y NO se debe restaurar el respaldo automáticamente.**
  Restaurar el `.bak` es una **decisión explícita, separada y autorizada del auditor**, nunca
  una acción automática del script ni del operador: ante un `NO-GO` post-`COMMIT`, **DETENER,
  documentar y escalar**. Cuando el auditor lo autorice, restaurar el `.bak` previo es lo único
  que revierte de forma fiable el backfill (C) y la nulabilidad (D); la fase 8 no se revierte
  por `ALTER` manual.
- **Excepción — B1 `NO-GO` solo por `FK_users_department_same_org` faltante:** **no** es
  corrupción post-COMMIT; el DDL aditivo quedó íntegro y solo falta una FK. **No restaurar**:
  ejecutar `fix-users-department-same-org.sql` (§17.3) y **repetir B1**. Es aditivo,
  idempotente e ignora la FK legacy existente.

**Pasos de restauración (backend detenido):**

1. **Fallo durante B o C (antes del `COMMIT`):** no restaurar. Documentar el `RAISERROR` y
   reportar (la base no cambió).
2. **Fallo tras el `COMMIT` de B/C/D** (verifier `NO-GO`, registros ≠ 96/97, longitudes no
   OK, o `departments.organization_id` NULL-able cuando debía ser NOT NULL): restaurar el
   `.bak` **`SIFHA_Tickets_DEV_PreReconciliacion_20261011.bak`** desde **la ruta local del
   `.bak` original en `TI-DESK-01\SIFHADEV`** (la anotada en el log de ejecución junto a su
   SHA-256 `C6057D038074070973F2D9D473C431F6D6B9823567D02484E9F0C35B6DFCB69A`). **No usar la
   copia externa `C:\Respaldos-SIFHA\…` en un `FROM DISK`**: esa ruta es de `DESKTOP-8MNIRCK`
   y SQL Server no puede leerla. Con el backend detenido:
   ```sql
   RESTORE DATABASE [SIFHA_Tickets_DEV]
     FROM DISK = N'<ruta_local_del_.bak_original_en_TI_DESK_01>'
     WITH REPLACE, RECOVERY, CHECKSUM;
   ```
   Si la copia local del servidor no estuviera disponible y **debiera** recurrirse a la
   copia externa, copiar primero el archivo a una ruta local del servidor (por ejemplo
   `D:\Backups\SIFHA_Tickets_DEV_PreReconciliacion_20261011.bak`), verificar el **SHA-256**
   tras el copiado y solo entonces usarla en el `FROM DISK`, **sin modificar el `.bak`
   externo original**.
3. **Fallo tras el `COMMIT` de C:** misma restauración del paso 2. Alternativa manual (solo
   con autorización y si no hay dependencias nuevas): `UPDATE ... SET organization_id = NULL`
   en `users`/`departments` y borrar CMUCE — **no recomendado**; preferir restaurar el `.bak`.
4. **Fallo tras D:** restaurar el `.bak` (los cambios de nulabilidad no se revierten por
   `ALTER` manual de forma fiable).
5. **Validación posterior del respaldo:** tras restaurar, verificar con
   `RESTORE VERIFYONLY FROM DISK = N'<misma ruta local del servidor>' WITH CHECKSUM;` y
   re-ejecutar `verify-after-groupB.sql` (§17.1) para confirmar el estado de partida
   (funciona igual en pre-ejecución con 6 tablas si se restauró a antes de B).
6. **Regla de integridad:** nunca ejecutar B/C/D/E sin haber cerrado el resultado esperado
   de la fase anterior (veredicto §18 + la tabla de resultados esperados de esta sección).

---

## 20. Checklist final del operador (B → C → D → E, con evidencias)

Cada grupo requiere evidencias firmadas (log volcado a archivo, con **fecha y ejecutor
identificado**); el auditor revisa el cierre de cada fase **antes** de autorizar la
siguiente. Orden estricto; ante cualquier `NO-GO`, detenerse (§18) y aplicar §19.

| Paso | Interruptores en `reconcile-dev-draft.sql` | Comando/acción | Evidencia | Punto de control (`GO`) |
|---|---|---|---|---|
| 0. Pre-flight | config B (o todos en 0) | 16.6 (valores máximos), ruta/checksum del `.bak`, bloqueos 3 y 4 cerrados | `preflight.log` | `max_chars <= objetivo`, `filas_sobre_objetivo = 0`, `.bak` con SHA-256 |
| B. DDL aditivo | config B: `AuthorizeDdl=1`, `BackupVerified=1`; resto 0 (ya por defecto) | `sqlcmd ... -i reconcile-dev-draft.sql -o run_B.log` | `run_B.log` | "DDL ADITIVO (fases 1-6 y 2b) confirmado." + "VERIFICACION POSTERIOR: OK" (96) |
| B1. Verificación | no aplica | `sqlcmd ... -i verify-after-groupB.sql -o verify-B.log` | `verify-B.log` | `VERIFICADOR POST-B: GO` |
| B2. Fix FK compuesta (**solo** si B1 `NO-GO` por `FK_users_department_same_org`) | no aplica | `sqlcmd ... -i fix-users-department-same-org.sql -o fix-fk.log`; luego **repetir B1** | `fix-fk.log` + `verify-B.log` | `FIX: GO` y después `VERIFICADOR POST-B: GO` |
| C. Backfill | `AuthorizeDdl=1`, `BackupVerified=1`, `AuthorizeBackfill=1`, `BackfillDepartments=1`, `BackfillUsers=1`, `MakeDepartmentsNotNull=0` | `sqlcmd ... -i reconcile-dev-draft.sql -o run_C.log` **o** `sqlcmd ... -i backfill-organization-CMUCE.sql -o run_C.log` | `run_C.log` | rol `ADMIN`, "departments asignados = 25", "users asignados = 1", "Fase 8 OMITIDA" (o `GRUPO C: GO`) |
| C1. Verificación post-C | todos en 0 | `sqlcmd ... -i verify-after-groupC.sql -o verify-C.log` | `verify-C.log` | `VERIFICADOR POST-C: GO` (24/97/CMUCE=1/25/1/NULL 0-0/0 huérfanos) |
| D. Endurecimiento | `AuthorizeDdl=1`, `BackupVerified=1`, `MakeDepartmentsNotNull=1`; datos en 0 | `sqlcmd ... -i reconcile-dev-draft.sql -o run_D.log` **o** `sqlcmd ... -i apply-groupD-not-null.sql -o run_D.log` (independiente) | `run_D.log` | "Fase 8: departments.organization_id es NOT NULL." + "VERIFICACION POSTERIOR: OK" (96 de las 6 tablas; 97 con CMUCE) **o** `GRUPO D: GO` |
| D1. Verificador | todos en 0 | `sqlcmd ... -i verify-after-groupD.sql -o verify-D.log` **y** `sqlcmd ... -i verify-final-reconciliation.sql -o verify-final.log` | `verify-D.log` + `verify-final.log` | `VERIFICADOR POST-D: GO` y `VERIFICADOR FINAL: GO` (24/97/NOT NULL/longitudes/UQ/FK/IX/orfanos/paridad/ADMIN) |
| E. Conexión | no aplica | `sqlcmd ... -Q "SELECT @@SERVERNAME, SERVERPROPERTY('InstanceName'), DB_NAME();"` | `run_E.log` | identidad `TI-DESK-01\SIFHADEV / SIFHADEV / SIFHA_Tickets_DEV` |
| E. Arranque en seco | no aplica | `npm start` (MSSQL_RUNTIME=true, DB_DATABASE=SIFHA_Tickets_DEV) | `backend-start.log` | "Esquema SQL Server verificado (solo lectura): 24 tablas y N columnas." + API escuchando |
| E. Funcional (solo lectura) | no aplica | `GET /api/health`, `GET /api/auth/me`, `GET /api/departments`, etc. | `run_E.log` | `200` en todas; sin `POST/PUT/PATCH/DELETE` institucionales |

**Reglas del operador:**
- No editar nada más que los interruptores declarados en el encabezado
  "PARAMETROS E INTERRUPTORES". El borrador **ya viene en la configuración del grupo B**
  (`@AuthorizeDdl=1`, `@BackupVerified=1`, resto 0); para C/D cambia solo los interruptores
  al valor del grupo y, al terminar cada grupo, déjalos en `0` como pausa segura (o en la
  config B si vas a repetir B, que es idempotente).
- Backend **detenido** durante B/C/D; el grupo E lo revalida en arranque en seco.
- Cada log se archiva intacto; las evidencias se revisan por el auditor antes del siguiente grupo.
- Ante un fallo **pre-COMMIT**: no restaurar, documentar (§19).
- Ante un fallo **post-COMMIT**: restaurar el `.bak` desde la **ruta local del servidor** (§19),
  nunca desde `C:\Respaldos-SIFHA\`.
