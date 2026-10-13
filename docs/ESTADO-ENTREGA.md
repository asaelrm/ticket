# Estado de entrega — SIFHA Ticket

**Fecha:** 2026-10-13
**Rama:** `integracion-casa-oficina-11oct`
**Último commit publicado:** `a4ef5b9` (en `origin/integracion-casa-oficina-11oct`).
**Commits locales pendientes de push:** el de esta actualización (fix `FILLFACTOR=0` del Grupo D + certificación del scratch).
**Alcance:** auditoría de entrega, corrección del bloqueo SQL del Grupo D, fix
`FILLFACTOR=0`, **certificación de Grupo D en el scratch (POST-D GO / FINAL GO)**,
limpieza de la suite de pruebas, verificación de secretos y preparación de commits.

---

## 1. Tabla de estado por tarea

| # | Tarea | Prioridad | Estado | Evidencia |
|---|-------|-----------|--------|-----------|
| 1 | Auditoría del repositorio (rama, módulos, pruebas, migraciones, docs) | P0 | COMPLETADO | Este documento |
| 2 | Corregir falso positivo del guard UNIQUE del Grupo D (`ROWS_FILEGROUP`) | P0 | COMPLETADO | `backend/scripts/migration/apply-groupD-not-null*.sql`, `diagnose-groupD-unique-blocker.sql` |
| 3 | Preparar comandos SQL del Grupo D para ejecución autorizada | P0 | COMPLETADO | Ejecutado sobre `SIFHA_GroupD_ScratchTest`; ver §5 |
| 4 | Ejecutar `npm test` (backend SQLite) sin fallos | P1 | COMPLETADO | 890 pruebas, 888 pass, 0 fallos, 2 omitidas |
| 5 | Ejecutar pruebas frontend + build de producción | P1 | COMPLETADO | 1080/1080; `vite build` OK |
| 6 | Reorganizar suites MSSQL de integración (`test/mssql/`) | P1 | COMPLETADO | `backend/package.json`, `backend/test/mssql/` |
| 7 | Auditar secretos y `.env` versionados | P0 | COMPLETADO | `git ls-files`; `.gitignore` cubre `.env*`; `.env.mssql-test.example` saneado |
| 8 | Revisar funcionamiento de módulos críticos | P1 | COMPLETADO | Cobertura de la suite (login, tickets, adjuntos, estados, permisos, aislamiento multi-org, SLA, auditoría, reportes) |
| 9 | Revisar seguridad básica (inyección SQL, attach, CORS, CSRF, HSTS) | P1 | COMPLETADO | Suite + `docs/SEGURIDAD-AUDITORIA.md` (0 Alta; 3 Medios de endurecimiento) |
| 10 | Documentación de entrega | P2 | EN PROCESO | README, ENTREGA-CHECKLIST, ENTREGA-INFRAESTRUCTURA, DEPLOY-MSSQL actualizados; falta revisar el resto |
| 11 | Commits locales descriptivos | P2 | COMPLETADO | 14 commits (`7c748c2`…`5c5a9ea`); ver §8 |
| 12 | Push a GitHub | — | COMPLETADO | `origin/integracion-casa-oficina-11oct` en `5c5a9ea` |
| 13 | Corregir arranque y login en Docker (conflicto de capitalización de username) | P0 | COMPLETADO | `directorySync.js` (COLLATE NOCASE), `docker-compose.dev.yml` (healthcheck IPv4); login real verificado |
| 14 | Corregir guarda de identidad de los verificadores scratch del Grupo D | P0 | COMPLETADO | `verify-after-groupD-scratch-test.sql`, `verify-final-reconciliation-scratch-test.sql`, `test/groupD-scratch-verifiers.test.js` |
| 15 | Comprobaciones de SOLO LECTURA contra SQL Server (`SIFHA_GroupD_ScratchTest`) | P0 | COMPLETADO | Conexión OK; inventario + verificador; ver §5 |
| 16 | Ejecutar `npm run test:mssql` (integración MSSQL) | P1 | COMPLETADO | **37/37 pass** contra `SIFHA_Tickets_M5_Integration_Test`; ver §3.2 |
| 17 | Alinear aserciones MSSQL al contrato multiempresa M5 | P1 | COMPLETADO | Commit `bf6b317` |
| 18 | Corregir `FILLFACTOR=0` al recrear los UNIQUE del Grupo D | P0 | COMPLETADO | `apply-groupD-not-null*.sql` (1 línea por archivo); ver §5.4 |
| 19 | Certificar Grupo D en `SIFHA_GroupD_ScratchTest` (POST-D GO / FINAL GO) | P0 | COMPLETADO | 2026-10-13, verificadores con cuenta privilegiada; ver §5.4 |

## 2. Estado de módulos funcionales

| Módulo | Estado | Evidencia |
|--------|--------|-----------|
| Inicio de sesión, sesión y recuperación | COMPLETADO | Suites `auth*.test.js`, pruebas de transporte/CSRF/HSTS |
| Usuarios y roles/permisos | COMPLETADO | Suites de roles, permisos y administración |
| Tickets (crear, asignar, estados, cierre/reapertura) | COMPLETADO | Flujo OPEN→…→CLOSED/CANCELLED cubierto |
| Comentarios y adjuntos | COMPLETADO | Validación por contenido, límites y autorización de descarga |
| Notificaciones y correos | COMPLETADO | `MAIL_ENABLED`, transporte dev |
| SLA y alertas | COMPLETADO | Jobs de SLA/escalaciones/poda (test sobre SQLite) |
| Auditoría e historial | COMPLETADO | `ticket_history`, autoría real de eventos |
| Búsqueda, filtros y reportes/exportación | COMPLETADO | CSV/XLSX/PDF por organización |
| Configuración del sistema | COMPLETADO | Global y por organización |
| Aislamiento multi-empresa | COMPLETADO | Filtros por `organization_id` + FK compuestas, validado por pruebas |

## 3. Pruebas ejecutadas (2026-10-12)

| Suite | Comando | Resultado |
|-------|---------|-----------|
| Backend (SQLite temporal) | `npm test` | **890 pruebas, 888 pass, 0 fail, 2 skip** (~130 s) |
| Integración MSSQL (requiere entorno) | `npm run test:mssql` | **EJECUTADA: 37/37 pass** contra `SIFHA_Tickets_M5_Integration_Test` (ver §3.2) |
| Frontend | `npx vitest run` | **44 archivos, 1080/1080 pass** (0 fail, ~93 s) |
| Build producción frontend | `npm run build` | **OK** (`dist/` generado) |

Cifras anteriores («860 pruebas, 3 fallos») quedaron obsoletas: las suites de
integración MSSQL ahora viven en `backend/test/mssql/` y **no** forman parte de
`npm test`, de modo que la suite por defecto termina sin falsos fallos. No se
perdió cobertura: las 3 suites se ejecutan con `npm run test:mssql`.

### 3.1 Arranque y login en Docker (corregido y verificado en vivo)

El backend no arrancaba por un conflicto de unicidad de `username`: el snapshot
`directory.json` traía `yfrancisco` y la base persistente tenía `YFRANCISCO`
(misma persona, distinta capitalización). Se corrigió `directorySync.js` para
buscar por `COLLATE NOCASE` y tratar como misma persona el username con otra
capitalización, sin crear duplicados ni tocar la contraseña; un email de una
cuenta con username genuinamente distinto sigue abortando el restore.

Verificación E2E real (backend en Docker, base SQLite temporal, `SEED_ADMIN_*`
de un solo uso): login **200** con permisos, `/api/auth/me` 200, alta de ticket
201 con SLA, comentario 201, logout 200 → `/me` 401, credenciales inválidas 401,
cuerpo incompleto 400, CORS `http://localhost:5173` honrado. El healthcheck del
frontend se corrigió a `127.0.0.1` (Vite escucha solo IPv4; `localhost`→`::1`
en Alpine fallaba): ambos contenedores quedan `healthy`.

### 3.2 Integración MSSQL certificada (2026-10-12)

`npm run test:mssql` quedó **37/37 aprobadas** contra
`SIFHA_Tickets_M5_Integration_Test` (`TI-DESK-01\SIFHADEV`). Preparación:

- El administrador concedió al login `sifha_ticket_dev` `db_datareader` +
  `db_datawriter` + `VIEW DEFINITION` **solo en la base de pruebas** (no se tocó
  `SIFHA_Tickets_DEV`). Verificado: login habilitado, base ONLINE, esquema de 24
  tablas, 0 vistas/procs.
- Seed idempotente (`scripts/mssql-seed-test-users.js`): organización UCE y
  departamentos existentes; 25 permisos, 4 roles y sus vínculos sin cambios. Los
  hashes de los 3 usuarios de prueba (admin/empleado/tecnico, ids 1/2/3) se
  sincronizaron con `backend/.env.mssql-test` (gitignored); el seed **no**
  actualiza contraseñas por diseño.
- Las 2 aserciones que no cuadraban con el modelo multiempresa M5 se alinearon en
  el commit `bf6b317`: `PATCH /api/settings` con `app_name` (clave GLOBAL) →
  **403** para ADMIN (solo SUPERADMIN; `settings.js:195`) y `GET /api/roles` con
  permisos **anidados por rol** (`roles.js:36`), más cobertura de
  `GET /api/roles/permissions`.

Cobertura verde: autenticación/sesiones, tickets CRUD con adjuntos y filtros,
historial, resolución/cierre/reapertura, autorizaciones por rol, comentarios y
notas internas, exportación, jobs de mantenimiento (SLA/escalación/poda),
dashboard, reportes, settings (contrato 403), notificaciones y usuarios.

> Re-ejecutar la suite **escribe** filas nuevas (sufijo `mssql_*`) y muta
> `org_settings`/notificaciones leídas del org 1; requiere autorización expresa.
> `backend/.env.mssql-test` se conserva local (gitignored; sin secretos en el
> repositorio).

## 4. Migraciones SQL

| Grupo | Estado | Detalle |
|-------|--------|---------|
| B (reconciliación base) | VALIDADO (no ejecutado en DEV) | Verificadores solo lectura |
| C (backfill CMUCE + FK compuestas) | VALIDADO (no ejecutado en DEV) | `backfill-organization-CMUCE.sql`, `fix-users-department-same-org.sql` |
| D (departments.organization_id NOT NULL) | **CERTIFICADO en `SIFHA_GroupD_ScratchTest`** (2026-10-13, POST-D GO / FINAL GO); **DEV NO ejecutado** | Script corregido (fix FILLFACTOR) en `apply-groupD-not-null*.sql`; ver §5.4 |
| M5 (notifications nullable) | CUMPLIDO en `SIFHA_Tickets_M5_Validation`; **certificación en `SIFHA_Tickets_DEV` pendiente** | Columna `organization_id` INT NULL + `CK_notifications_ticket_requires_org` presentes y confiables; ver §5.3 |
| Secuencia B→C→D→E en `SIFHA_Tickets_DEV` | NO EJECUTADA | Requiere ventana de mantenimiento + respaldo |

### 5. Grupo D — diagnóstico y corrección del bloqueo SQL

**Causa del último aborto (falso positivo):** el guard preventivo comparaba el
tipo de *data space* de los índices UNIQUE contra `N'ROWS_FILEGROUPS'`, pero
`sys.data_spaces.type_desc` devuelve `ROWS_FILEGROUP` (singular). Todos los
índices de `dbo.departments` viven en el filegroup `PRIMARY`, sin
particionamiento, sin filtro y sin compresión; la comparación era siempre
verdadera y abortaba antes del `ALTER`.

**Corrección aplicada** en los 4 archivos (dev + scratch + authorized + diagnose):
`N'ROWS_FILEGROUPS'` → `N'ROWS_FILEGROUP'`. La protección real se conserva: un
índice particionado (`PARTITION_SCHEME`), con filtro (`has_filter = 1`) o con
compresión (`data_compression_desc <> NONE`) sigue abortando.

**Revisión preventiva adicional:** columnas clave ascendentes, opciones del índice
(`PAD_INDEX`, `FILLFACTOR`, `IGNORE_DUP_KEY`, `ALLOW_ROW/PAGE_LOCKS`,
`OPTIMIZE_FOR_SEQUENTIAL_KEY`) y data space se capturan antes y se comparan
después del DDL dentro de la transacción (el script revierte si algo difiere).
FK con acciones `ON DELETE/UPDATE` y `NOT FOR REPLICATION` se recrean idénticas.
La creación de un UNIQUE con claves descendentes es rechazada por SQL Server y
provocaría rollback (el esquema canónico usa ASC, así que no aplica).

**Comandos para el operador (ejecutar bajo su cuenta autorizada):**

1. Inventario (solo lectura):
   `sqlcmd -S 100.100.4.60,1433 -d SIFHA_GroupD_ScratchTest -i backend\scripts\migration\inventory-groupD-scratch-test.sql`
2. Diagnóstico del bloqueo (solo lectura):
   `sqlcmd -S 100.100.4.60,1433 -d SIFHA_GroupD_ScratchTest -i backend\scripts\migration\diagnose-groupD-unique-blocker.sql`
3. Verificar que las 2 filas de `diagnose-*` muestran `data_space_type_desc = ROWS_FILEGROUP`, `0` en `triggers_filter_guard` y `triggers_compression_guard`, y `NULL` en `partition_scheme_name`.
4. Aplicar D sobre la base scratch (autorizada):
   `sqlcmd -S 100.100.4.60,1433 -d SIFHA_GroupD_ScratchTest -b -i backend\scripts\migration\apply-groupD-not-null-scratch-test-authorized.sql`
5. Verificación post-D (solo lectura):
   `sqlcmd -S 100.100.4.60,1433 -d SIFHA_GroupD_ScratchTest -i backend\scripts\migration\verify-after-groupD-scratch-test.sql`

`sqlcmd -b` detiene con código de error si `RAISERROR(...,16,1)` dispara. Los
scripts solo actúan sobre `SIFHA_GroupD_ScratchTest` (guarda `DB_NAME()` +
instancia + servidor). NO ejecutar el `apply-groupD-not-null.sql` (DEV): esa es
la versión para `SIFHA_Tickets_DEV` y queda pendiente de ventana autorizada.

### 5.1 Verificadores scratch del Grupo D (defecto real corregido)

`verify-after-groupD-scratch-test.sql` y `verify-final-reconciliation-scratch-test.sql`
son copias de sus versiones de DEV y conservaban la guarda de identidad
`DB_NAME() = SIFHA_Tickets_DEV`, mientras su título, su mensaje de aborto y los
comandos de §5 los destinan a `SIFHA_GroupD_ScratchTest`. Efecto: abortaban
contra el destino documentado y solo corrían en DEV (son de solo lectura, sin
riesgo de datos). **Corregido**: la guarda ahora exige
`SIFHA_GroupD_ScratchTest` + instancia `SIFHADEV`. Regresión estática en
`backend/test/groupD-scratch-verifiers.test.js` (4 pruebas).

### 5.2 Comprobaciones de solo lectura contra SQL Server (2026-10-12)

Ejecutadas con la cuenta de migración existente (`sqlcmd`, autenticación SQL,
`-C`), **sin DDL y sin modificar datos**:

- Conexión verificada: `TI-DESK-01\SIFHADEV`,
  `TcpTestSucceeded 100.100.4.60:1433 = True`.
- **Visibilidad de metadatos (hallazgo clave):** con `sifha_ticket_dev`
  `sys.tables` solo devuelve **6 tablas** porque esa cuenta tiene GRANT a nivel de
  objeto únicamente sobre `departments`, `permissions`, `role_permissions`,
  `roles`, `sessions` y `users`. **No es la estructura real.** La lectura con el
  login `SIFHA_GroupD_ScratchTestRunner` (VIEW DEFINITION + `ALTER ON SCHEMA::dbo`)
  muestra el inventario verdadero.
- `SIFHA_GroupD_ScratchTest`: recreado desde el respaldo
  `SIFHA_Tickets_DEV_PreGrupoD_20261012.bak` (estado **post-C**): **24 tablas**,
  **97 filas**, organización `CMUCE` presente y 25 departamentos dentro de ella.
  `departments.organization_id` sigue **NULL-able** (D aún no aplicado); las FK
  compuestas `FK_users_department_same_org` y `FK_tickets_department_same_org`
  están presentes.
- `SIFHA_Tickets_M5_Validation`: **24 tablas** y datos de validación (ver §5.3).
- `SIFHA_Tickets_M5_Integration_Test`: la cuenta de migración **no** tiene acceso
  (`Login failed` / `Cannot open database`).
- `SIFHA_Tickets_DEV`: con `sifha_ticket_dev` también devuelve 6 tablas por el
  artefacto de visibilidad; su estado real **no es verificable** con esta cuenta.

**Corrección respecto a la lectura previa:** la afirmación «scratch/DEV en estado
legacy de 6 tablas» era el artefacto de visibilidad, no la estructura real. El
scratch ya está **post-C**, de modo que las precondiciones de
`apply-groupD-not-null-scratch-test-authorized.sql` (24 tablas, 97 filas, CMUCE
única, 25 departamentos, 0 NULL en `departments.organization_id`) sí pueden
cumplirse y §5 puede alcanzar GO bajo una cuenta con `ALTER ON SCHEMA::dbo`.

### 5.3 Estado M5 en `SIFHA_Tickets_M5_Validation` (solo lectura)

Verificado: 24 tablas `dbo`; `notifications.organization_id` **INT NULL**
(nullable=1); `CK_notifications_ticket_requires_org` **existe, habilitada y
confiable**, con 0 notificaciones de organización NULL; `departments.organization_id`
**NOT NULL** con 0 nulos. Datos de validación presentes (1 organización `CMUCE`,
25 departamentos, 9 tickets, 5 usuarios, 26 notificaciones…). Es decir, el objetivo
de M5 **ya está cumplido** en esa base y el P0 «M5 pendiente» queda obsoleto.

> Nota: `m5-preflight.js` y `verify-m5-validation.js` esperan un destino con 24
> tablas y **0 filas**; como M5_Validation ya tiene datos, esos scripts fallarían
> hoy. Son aplicables solo a un destino de migración vacío.

**Respaldo autorizado (SQL-M5, 2026-10-12 22:11):** se creó
`SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak` en el directorio por
defecto de la instancia (`C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\`),
782 KB en disco, 1178 páginas, `COPY_ONLY + CHECKSUM + COMPRESSION`, registrado en
`msdb` (`is_copy_only=1`). La verificación `RESTORE VERIFYONLY/HEADERONLY/FILELISTONLY`
**no** es posible con `sifha_ticket_dev` (exigen permiso `CREATE DATABASE`), así
que la comprobación del archivo queda pendiente de una cuenta privilegiada.

### 5.4 Certificación de Grupo D en el scratch (2026-10-13)

**Fix `FILLFACTOR=0` (Msg 129).** Al recrear los UNIQUE del Grupo D, la cláusula
`WITH (...)` emitía siempre `FILLFACTOR = <fill_factor>`; con `fill_factor = 0`
(default) SQL Server rechaza `FILLFACTOR = 0` y la transacción abortaba. La
primera ejecución autorizada falló en ese punto; el rollback automático dejó la
base intacta (verificado solo lectura: `departments.organization_id` NULL-able,
25 filas, 0 NULL, UNIQUE y FK restaurados sin duplicados). La corrección en los
**3** scripts (`apply-groupD-not-null*.sql`, authorized/scratch/dev) es **mínima:
1 línea por archivo**, y emite `FILLFACTOR` solo cuando `@d_fill BETWEEN 1 AND
100` (con 0 se omite y se usa el default del servidor); no cambia valores ni
otros atributos. Sintaxis validada sin DDL para los 2 UNIQUE reales (fill 0) y
regresión `test/groupD-scratch-verifiers.test.js` + suites de migración en verde.

**Resultado oficial (SSMS, cuenta con permisos administrativos, 13/10/2026):**

- `SIFHA_GroupD_ScratchTest` — aplicación de Grupo D: **GRUPO D: GO** (COMMIT).
- Verificador post-D: **`VERIFICADOR POST-D: GO`** — `departments.organization_id`
  INT **NOT NULL**, 25 departamentos, 0 NULL.
- Verificador final: **`VERIFICADOR FINAL: GO`** — reconciliación completa.

Evidencia verificada: **24/24 tablas**, **97 registros**, 1 organización `CMUCE`,
25 departamentos, `users.organization_id` NULL-able (canónico), **9/9**
longitudes NVARCHAR correctas, **0** UQ/FK/índices faltantes (FK habilitadas y
confiables), **0** registros huérfanos, **0** desviaciones de paridad canónica,
usuario ADMIN y permisos conservados, respaldo previo verificado.

> Alcance: **solo el scratch**. `SIFHA_Tickets_DEV` **NO** ha sido migrada ni
> certificada (secuencia B→C→D→E pendiente: cuenta privilegiada, respaldo
> verificado y ventana de mantenimiento). No se ejecutó DDL ni DML fuera del
> scratch; no hubo push ni merge.

## 6. Seguridad

- **0 hallazgos Altos.** Sin inyección SQL (parametrización uniforme y listas
  blancas), isolación multi-tenant en servidor, bcrypt coste 12, Helmet/CSP,
  validación de adjuntos por *magic bytes*, error 5xx sin traza.
- **3 Medios** de endurecimiento (semáforo de la auditoría, no bloqueantes):
  `SESSION_SECRET` con valor por defecto de desarrollo fuera de producción (ya
  mitigado: `assertStartupConfig` impide arrancar en producción sin secreto
  válido), token de reseteo devuelto solo en `NODE_ENV=development` (ya
  mitigado) y credenciales de ejemplo con servidor/usuario reales en
  `.env.mssql-test.example` (**corregido hoy**: `servidor-ejemplo` /
  `usuario_migracion`).
- **Secretos:** ningún `.env`, `.env.local`, `.env.mssql-test`, certificado o
  clave está versionado (`.gitignore` §17-42, §89-93). `git ls-files` no muestra
  contraseñas, claves ni tokens. **Hallazgo (riesgo medio):** `origin`
  (`9f64117`) ya publica `backend/.env.mssql-test.example` con
  `MSSQL_TEST_SERVER=100.100.4.60` y `MSSQL_TEST_USER=sifha_migration_dev` (IP
  Tailscale interna + login, **sin contraseña**). El saneo está en el commit
  local `dd3001e`, pero el historial ya publicado lo expone; la IP interna y
  `TI-DESK-01` aparecen además en varios documentos/scripts M5.
- **Validación de entrada en login/recuperación:** un cuerpo malformado
  (p. ej. sin `account`) devolvía 500; ahora devuelve **400 `Datos inválidos`**
  con `fields` (`backend/src/routes/auth.js`; regresión en
  `test/security-regressions.test.js`).
- **Dependencias (`npm audit`, 2026-10-13, sin `--force`):** **0 hallazgos** en
  backend y frontend.
  - Backend producción: ~~2 moderadas (`uuid` vía `exceljs`)~~ **RESUELTA**
    (tercera ronda) con `overrides: { "uuid": "^11.1.1" }`; `exceljs` solo usa
    `uuid.v4()` (sin `buf`), verificado con la suite backend completa.
  - Frontend producción: **RESUELTA** en `c33367b` (`react-router-dom` 6.28.1 →
    **7.18.4**, verificado con 1080/1080 y `vite build` OK).
  - Frontend solo-*dev* (`vite`/`vitest`/`tinypool`/`esbuild`): ~~críticas y
    altas en la cadena de pruebas/compilación~~ **RESUELTA** (tercera ronda) con
    `vite@7.3.7` + `vitest@4.1.11` + `@vitejs/plugin-react@4.7.0`; 1080/1080 y
    build OK; no afecta al bundle distribuido.
  - Ninguna vulnerabilidad afecta ya al artefacto de producción ni a la
    toolchain de desarrollo.

## 7. Cambios pendientes de revisar (origen)

No se descartó nada. La serie `7c748c2`…`03cc40a` (14 commits) está publicada.
En este ciclo se añadieron 2 commits locales pendientes de push: `bf6b317`
(aserciones MSSQL al contrato multiempresa) y la actualización de esta
documentación. Los artefactos de diagnóstico de la raíz (`inventario-grupoD.txt`,
`resultado-verificacion-D.txt`, respaldos `*.bak`) **no** se versionan
(gitignored).

## 8. Plan de commits

`origin/integracion-casa-oficina-11oct` está en `a4ef5b9`. Por delante quedan
**commits locales pendientes de publicación** (no se hace push sin autorización):

- `28f29a2` fix(migracion): corregir `FILLFACTOR=0` al recrear UNIQUE y certificar Grupo D en scratch.
- `279f756` fix(seguridad): remediar hallazgos de auditoría en backend.
- `c33367b` fix(frontend): búsqueda global, sesión caducada, auditoría y a11y.
- `ab1815f` docs(seguridad): segunda ronda de auditoría y decisiones de dependencias.
- Continuación (CI, scripts DEV solo lectura, documentación e informe): los
  commits de esta sesión.

Comando de publicación (cuando el dueño autorice):
`git push origin integracion-casa-oficina-11oct`.

## 9. Bloqueos que requieren intervención

- **P0 — COMPLETADO (2026-10-13):** Grupo D aplicado y certificado en
  `SIFHA_GroupD_ScratchTest` (`GRUPO D: GO`, `VERIFICADOR POST-D: GO`,
  `VERIFICADOR FINAL: GO`; §5.4). Ejecutado con cuenta privilegiada
  (`ALTER ON SCHEMA::dbo`, respaldo previo).
- **P0** — Secuencia B→C→D→E en `SIFHA_Tickets_DEV`: la cuenta de migración tiene
  `db_owner=0` en DEV, por lo que **no puede** ejecutar el DDL; requiere cuenta
  privilegiada, respaldo verificado y ventana de mantenimiento. El estado real de
  DEV no es verificable con la cuenta actual (artefacto de visibilidad).
- **P1** — ~~Correr `npm run test:mssql`~~ **completado (37/37**, §3.2) contra
  `SIFHA_Tickets_M5_Integration_Test`. Re-ejecutar **escribe** datos y exige nueva
  autorización del responsable.
- **P1** — M5: objetivo cumplido (§5.3) y respaldo
  `SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak` creado (2026-10-12);
  su verificación queda pendiente de una cuenta con `CREATE DATABASE`.
- **P1** — ~~Decidir los arreglos *breaking* de `npm audit` (exceljs, react-router,
  vitest). No se aplican sin autorización.~~ **RESUELTO (2026-10-13):** `npm audit`
  a **0 hallazgos** en backend y frontend (§10.5). `react-router-dom@7` en
  `c33367b`; `uuid@11.1.1` (override) y `vite@7.3.7`/`vitest@4.1.11` en la
  tercera ronda, verificados con las suites y la build.
- **P2** — ~~Publicar los commits locales~~ **completado** (`9f64117..5c5a9ea`).
- **P2** — Añadir ESLint/`lint` (recomendación no bloqueante).

## 10. Continuación tras el apagón (2026-10-13)

Sesión de recuperación desde `ab1815f`. Working tree limpio al inicio; no se
repitió ninguna tarea ya certificada (Grupo D en scratch; integración MSSQL
37/37). Se completaron las fases pendientes: CI, documentación, preparación de
migraciones DEV en modo solo lectura y revisión del PR #1.

### 10.1 Integración continua (nueva)

- Añadido `.github/workflows/ci.yml` (no existía ningún workflow): dos jobs
  independientes en Node 24 —
  - **Backend**: `npm ci` + `npm test` (SQLite temporal; las suites MSSQL no se
    ejecutan en CI).
  - **Frontend**: `npm ci` + `npx vitest run` + `npm run build`.
- Disparadores: `push` a `main`/`integracion-casa-oficina-11oct`,
  `pull_request` y `workflow_dispatch`, con `concurrency` para cancelar
  ejecuciones obsoletas y `permissions: contents: read`.
- Pendiente real: el workflow no puede ejercitarse en GitHub hasta que el dueño
  haga `push` (no se hace push sin autorización); la sintaxis y los comandos se
  validaron localmente.

### 10.2 Migraciones DEV en modo solo lectura (nueva)

- Nuevo `backend/scripts/migration/diagnose-dev-account-readonly.sql`: preflight
  **100% de solo lectura** (sin `EXEC`/SQL dinámico) que, con guarda de identidad
  `SIFHA_Tickets_DEV` + `SIFHADEV`, informa los permisos de la cuenta
  (`db_owner`, `db_ddladmin`, `ALTER` en `SCHEMA::dbo`, `VIEW DEFINITION`), un
  veredicto `GO`/`NO-GO` para ejecutar B→C→D→E y el artefacto de visibilidad de
  metadatos (tablas visibles vs 24). No se ejecutó contra SQL Server.
- Nueva regresión estática `backend/test/dev-readonly-scripts.test.js` (13
  pruebas): exige guarda de identidad y ausencia de escrituras persistentes en
  los 6 scripts DEV de solo lectura, y prohíbe SQL dinámico en el diagnóstico.
  **Hallazgo real corregido por esta prueba:** el encabezado del nuevo script
  contenía `sys.*/funciones`, cuyo `*/` cerraba el comentario SQL antes de
  tiempo; corregido a `(sys.*), funciones`.

### 10.3 Documentación

- Cifras de pruebas alineadas a la ejecución vigente (**890/888/0/2** backend;
  1080/1080 frontend) en README, `ENTREGA-CHECKLIST`, `ENTREGA-INFRAESTRUCTURA`,
  `docs/DEPLOY-MSSQL`, `docs/ENTREGA-FINAL` y `docs/PRUEBAS`.
- `docs/PRUEBAS.md` deja de marcar la integración MSSQL como pendiente (está
  certificada 37/37; re-ejecutar escribe y exige autorización).
- `ENTREGA-CHECKLIST.md`: el P2 «sesión caducada» pasa a corregido (`c33367b`).

### 10.4 Revisión del PR #1

- PR #1 «Integracion casa-oficina: certificacion MSSQL 37/37 y preparacion final
  de entrega» (head `integracion-casa-oficina-11oct` → base `main`): **abierto**,
  1 participante, **sin revisiones**, **sin checks** (no existía workflow; el CI
  nuevo los generará al publicar).
- El cuerpo del PR describe 4 archivos y 863 pass; el historial actual incluye
  los 4 commits locales posteriores. `gh` **no está instalado** en este equipo,
  por lo que actualizar cuerpo/estado del PR requiere acción manual del dueño
  tras el push.
- Sin secretos añadidos; no debe mergearse hasta cerrar los pendientes de
  certificación DEV/M5 (ventana autorizada).

### 10.5 Tercera ronda de seguridad (dependencias y endurecimiento)

- **`npm audit`: 0 hallazgos** en backend y frontend (antes: 2 moderadas
  backend, 6 dev frontend con 2 críticas).
- Backend: `overrides` a `uuid@11.1.1` (vía `exceljs`), verificado con la suite.
- Frontend: `vite@7.3.7`, `vitest@4.1.11`, `@vitejs/plugin-react@4.7.0`
  (toolchain dev); 1080/1080 y build OK.
- Endurecimiento: `Vary: Origin` en CORS y `/api/health` deja de exponer
  `NODE_ENV`; 3 regresiones nuevas en `security-regressions.test.js`.
- Sin secretos reales versionados; se documentan como riesgo residual los
  identificadores de infraestructura interna (funcionales a las guardas de
  migración) y la exposición histórica de credenciales demo. Detalle en
  `docs/SEGURIDAD-AUDITORIA.md` (tercera ronda).

## 11. Pendientes reales tras esta sesión

- **Requiere autorización (no ejecutable aquí):** secuencia B→C→D→E y M5 en
  `SIFHA_Tickets_DEV` (cuenta privilegiada + respaldo verificado + ventana);
  verificación `VERIFYONLY` del respaldo M5; `push` de los commits locales.
- **Mejora no bloqueante:** añadir ESLint/script `lint`.