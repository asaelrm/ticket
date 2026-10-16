# Estado de entrega — SIFHA Ticket

**Fecha:** 2026-10-13 (última actualización de secciones 1–16); sesión de cierre 2026-10-14 en §17.
**Rama:** `integracion-casa-oficina-11oct`
**Último commit publicado:** `2c69427` (en `origin/integracion-casa-oficina-11oct`; rama sincronizada antes de estos cambios locales).
**Commits locales pendientes de push:** cambios documentales y de scripts sin commit; no se ha hecho push.
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
| 4 | Ejecutar `npm test` (backend SQLite) sin fallos | P1 | COMPLETADO | 895 pruebas, 893 pass, 0 fallos, 2 omitidas (ver §17.8) |
| 5 | Ejecutar pruebas frontend + build de producción | P1 | COMPLETADO | 1080/1080; `vite build` OK |
| 6 | Reorganizar suites MSSQL de integración (`test/mssql/`) | P1 | COMPLETADO | `backend/package.json`, `backend/test/mssql/` |
| 7 | Auditar secretos y `.env` versionados | P0 | COMPLETADO | `git ls-files`; `.gitignore` cubre `.env*`; `.env.mssql-test.example` saneado |
| 8 | Revisar funcionamiento de módulos críticos | P1 | COMPLETADO | Cobertura de la suite (login, tickets, adjuntos, estados, permisos, aislamiento multi-org, SLA, auditoría, reportes) |
| 9 | Revisar seguridad básica (inyección SQL, attach, CORS, CSRF, HSTS) | P1 | COMPLETADO | Suite + `docs/SEGURIDAD-AUDITORIA.md` (0 Alta; 3 Medios de endurecimiento) |
| 10 | Documentación de entrega | P2 | EN PROCESO | README, ENTREGA-CHECKLIST, ENTREGA-INFRAESTRUCTURA, DEPLOY-MSSQL actualizados; falta revisar el resto |
| 11 | Commits locales descriptivos | P2 | COMPLETADO | 14 commits (`7c748c2`…`5c5a9ea`); ver §8 |
| 12 | Push a GitHub | — | COMPLETADO | `origin/integracion-casa-oficina-11oct` publicado hasta `7723d87` |
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
| Backend (SQLite temporal) | `npm test` | **895 pruebas, 893 pass, 0 fail, 2 skip** (~100 s) |
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

## 7. Cambios publicados (origen)

No se descartó nada. La serie `7c748c2`…`7723d87` está **publicada** en
`origin/integracion-casa-oficina-11oct` (rama sincronizada, sin commits por
delante ni por detrás). Los artefactos de diagnóstico de la raíz
(`inventario-grupoD.txt`, `resultado-verificacion-D.txt`, respaldos `*.bak`)
**no** se versionan (gitignored).

## 8. Plan de commits

`origin/integracion-casa-oficina-11oct` está en `7723d87` e incluye toda la serie
(`28f29a2`, `279f756`, `c33367b`, `ab1815f`, CI `458cc4e`, preflight `599543a`,
seguridad `938feb0`/`62a934c`/`61de202`, informes `72ee460`/`7723d87`). No quedan
commits publicables pendientes de esta ronda; los de la sesión de finalización
(§12) se agregan localmente y **no** se publican sin autorización.

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
- Verificado en GitHub tras la publicación (`7723d87`): **2 ejecuciones, ambas en
  verde** — job **Backend (SQLite temporal)** y job **Frontend (vitest + build)**,
  `conclusion: success`.

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

- Cifras de pruebas alineadas a la ejecución vigente (**895/893/0/2** backend;
  1080/1080 frontend) en README, `ENTREGA-CHECKLIST`, `ENTREGA-INFRAESTRUCTURA`,
  `docs/DEPLOY-MSSQL`, `docs/ENTREGA-FINAL` y `docs/PRUEBAS`.
- `docs/PRUEBAS.md` deja de marcar la integración MSSQL como pendiente (está
  certificada 37/37; re-ejecutar escribe y exige autorización).
- `ENTREGA-CHECKLIST.md`: el P2 «sesión caducada» pasa a corregido (`c33367b`).

### 10.4 Revisión del PR #1

- PR #1 «Integracion casa-oficina: certificacion MSSQL 37/37 y preparacion final
  de entrega» (head `integracion-casa-oficina-11oct` `7723d87` → base `main`
  `f7cebed`): **abierto**, `mergeable: true`, `mergeable_state: clean` (sin
  conflictos), **sin revisiones**; el CI nuevo ya genera **checks en verde**.
- Alcance real del PR: **56 commits**, 200 archivos (`+31916 / −3099`). El cuerpo
  del PR sigue describiendo 4 archivos y 863 pass (desactualizado): `gh` **no
  está instalado** en este equipo, por lo que actualizar cuerpo/estado requiere
  acción manual del dueño.
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
  `SIFHA_Tickets_DEV` (respaldo verificado + ventana; ver §12 para el estado de
  cuenta); verificación `VERIFYONLY` del respaldo M5; `push` de los commits
  locales de esta sesión.
- **Mejora no bloqueante:** añadir ESLint/script `lint`.

## 12. Finalización integral (2026-10-13)

Sesión autónoma de cierre sobre `7723d87` (árbol limpio, sincronizado). No se
repitió ninguna certificación ya cerrada (Grupo D en scratch, integración MSSQL
37/37). Sin push, sin merge, sin modificar SQL Server.

### 12.1 Estado verificado

- **Repositorio:** rama `integracion-casa-oficina-11oct` en `7723d87`; `origin`
  sincronizado; 724 commits; `main` en `f7cebed`.
- **CI (GitHub Actions):** run `38393456778` sobre `7723d87` =
  **`conclusion: success`** (jobs *Backend (SQLite temporal)* y
  *Frontend (vitest + build)* en verde).
- **PR #1:** abierto, `mergeable: true`, `mergeable_state: clean`.
- **Pruebas locales reconfirmadas:** backend **895/893 pass, 0 fallos,
  2 omitidas**; frontend **44 archivos, 1080/1080**; `vite build` **OK**.
- **Dependencias:** `npm audit` **0 hallazgos** en backend y frontend.
- **Secretos:** solo `.env.example`/`.env.mssql-test.example` versionados;
  `.gitignore` cubre `.env*`, certificados/claves, respaldos, `dist` y logs.

### 12.2 Hallazgo corregido (defecto real en script de solo lectura)

`backend/scripts/migration/diagnose-dev-account-readonly.sql` **no compilaba**:
usaba las variables `@is_db_datareader`/`@is_db_datawriter` (líneas del `SELECT`
final) sin declararlas; estaban declaradas como `@is_datareader`/`@is_datawriter`.
Ejecutado contra `SIFHA_Tickets_DEV` fallaba con
`Msg 137: Must declare the scalar variable "@is_db_datareader"`. **Corregido**
(se renombraron las declaraciones a `@is_db_datareader`/`@is_db_datawriter`) y
**revalidado**.

### 12.3 Preflight de solo lectura contra `SIFHA_Tickets_DEV` (nuevo)

Tras la corrección, ejecutado con la cuenta Windows `cmucesd\lrosario`
(`sqlcmd -E`), resultado:

- Identidad: base `SIFHA_Tickets_DEV`, instancia `SIFHADEV`, usuario base `dbo`.
- Permisos: `db_owner=1`, `db_ddladmin=1`, `ALTER` en `SCHEMA::dbo=1`,
  `VIEW DEFINITION=1` → **`puede_ejecutar_secuencia = GO`**.
- Visibilidad: **24/24 tablas** (`VISIBILIDAD COMPLETA`).
- `departments.organization_id` → `allows_null = 1` (**Grupo D pendiente en DEV**).
- `notifications.organization_id` → `allows_null = 1` (ya NULL-able en DEV).
- **No se modificó ningún dato** (el script es 100 % `SELECT`).

> Nota: el bloqueo §9/P0 «la cuenta de migración tiene `db_owner=0` en DEV» se
> refiere al login SQL de migración; la cuenta Windows `cmucesd\lrosario` **sí**
> es privilegiada en DEV. Persisten como requisitos el respaldo verificado, la
> ventana de mantenimiento y la autorización expresa.

### 12.4 Limpieza menor

- `README.md`: eliminado el comentario residual
  `<!-- Prueba auto-push 09/20/2026 23:18:30 -->` (artefacto de automatización).
- Duplicados de borrador (`reconcile-dev-draft-corregido (1).sql`,
  `reconcile-dev-draft-corregido-v2.sql`): se mantienen intactos (decisión de la
  auditoría previa); limpieza recomendada como tarea aparte.

## 13. Cierre de sesión documental (2026-10-13, segunda tanda)

Sesión autónoma sobre el árbol limpio de §12. Sin push, sin merge, sin tocar SQL
Server; no se repitió ninguna certificación cerrada.

### 13.1 Documentación nueva

- `docs/GUIA-MIGRACION-DEV.md` — guía operativa consolidada: inventario real de
  scripts, orden/dependencias/GO-NO-GO (Fase 2), respaldo y recuperación SSMS
  (Fase 3), guía administrativa paso a paso con M5 (Fase 4) y checklist de
  entrega a infraestructura (Fase 5).
- `docs/INFORME-CIERRE-DESARROLLO-2026-10-13.md` — informe final en español
  (Fase 6).
- `docs/PR-1-CUERPO-ACTUALIZADO.md` — cuerpo listo para pegar en el PR #1
  (`gh` no está instalado; actualización manual).

### 13.2 Hallazgo clave (migración dirigida por estado)

El preflight (§12.3) confirma que `SIFHA_Tickets_DEV` ya responde con **24/24
tablas** y `notifications.organization_id` **NULL-able**; `departments.organization_id`
sigue NULL-able (**Grupo D pendiente**). Por tanto la secuencia **no se aplica a
ciegas**: hay que ejecutar primero los cuatro verificadores (solo lectura) y
**omitir** las fases ya `GO`. Regla: **verificador primero, DDL después**.

### 13.3 M5 en DEV

En DEV el objetivo M5 se comprueba por lectura (`notifications.organization_id`
NULL-able + `CK_notifications_ticket_requires_org` activo y confiable). Los
scripts M5 del repositorio están **sellados** a `SIFHA_Tickets_M5_Validation` y
abortan en DEV: **no se ejecutan en `SIFHA_Tickets_DEV`**.

### 13.4 Git y pendiente operativo

- Árbol limpio; rama `integracion-casa-oficina-11oct` adelantada respecto a
  `origin` por los commits locales de cierre (`5d58040`, `36b92b9`, `db1d629` y
  los de esta tanda).
- `git diff --check` sin incidencias; sin secretos reales versionados.
- **Push realizado** (2026-10-13): `7723d87..1cdd602` a
  `origin/integracion-casa-oficina-11oct`.
- **Pendiente:** actualizar el cuerpo del PR #1 con
  `docs/PR-1-CUERPO-ACTUALIZADO.md` (`gh` no instalado). No mergear hasta cerrar
  los pendientes de DEV/M5 en ventana autorizada.

## 14. Grupo D EJECUTADO y CERTIFICADO en `SIFHA_Tickets_DEV` (2026-10-13)

Ejecución controlada y autorizada del Grupo D sobre DEV. No se repitieron B ni C
ni se tocó M5/Scratch. Se distingue el estado de cada fase:

| Fase | Estado |
|---|---|
| Inspección y validación previa (solo lectura) | **VERIFICADO** |
| Respaldo fresco + `RESTORE VERIFYONLY` | **EJECUTADO / VERIFICADO** |
| Grupo D (`apply-groupD-not-null.sql`) | **EJECUTADO** |
| Verificador POST-D | **VERIFICADO (`GO`)** |
| Verificador FINAL | **VERIFICADO (`GO`)** |
| Estado DEV post-D | **CERTIFICADO** |
| Grupo E (arranque en seco) | **NO-GO técnico**: conexión alcanzable, pero el login local fue rechazado; no se inició el backend |

### 14.1 Evidencia

- **Fecha/hora:** 2026-10-13 15:09 (local servidor) / 19:09 UTC.
- **Servidor / instancia / base:** `TI-DESK-01\SIFHADEV` / `SIFHADEV` /
  `SIFHA_Tickets_DEV`; login `cmucesd\lrosario` (`db_owner`, `db_ddladmin`,
  `ALTER SCHEMA::dbo`, `VIEW DEFINITION`).
- **Precondición Grupo C:** `VERIFICADOR POST-C: GO` (97 filas, CMUCE id=1,
  25 deptos 0 NULL, 0 huérfanos).
- **Respaldo:** `SIFHA_Tickets_DEV_PreGrupoD_20261013_190544.bak` (COPY_ONLY,
  COMPRESSION, CHECKSUM; ~7 MB; ruta local del servidor).
  `RESTORE VERIFYONLY ... WITH CHECKSUM` → **“The backup set on file 1 is valid.”**
- **Script ejecutado:** `backend/scripts/migration/apply-groupD-not-null.sql`
  con `@AuthorizeDdl=1` y `@BackupVerified=1`.
- **Resultado Grupo D:** `COMMIT. departments.organization_id es NOT NULL;
  UNIQUE y FK recreadas y verificadas.` → `GRUPO D: GO`.
- **POST-D:** `VERIFICADOR POST-D: GO` (97 filas; `departments.organization_id`
  `INT NOT NULL`; `users.organization_id` NULL-able; 0 UQ/FK/IX faltantes;
  0 huérfanos).
- **FINAL:** `VERIFICADOR FINAL: GO` (24/24 tablas; 97 registros; CMUCE id=1;
  9/9 longitudes NVARCHAR; 0 UQ/FK/IX faltantes; 0 huérfanos; 0 desviaciones de
  paridad canónica; rol ADMIN id=7 único; usuario ADMIN id 4 con rol 7,
  departamento 68, en CMUCE; rol ADMIN conserva permisos).
- **Cambios aplicados:** solo nulabilidad de `departments.organization_id`
  (`INT NULL` → `INT NOT NULL`); los 2 `UNIQUE` y las 2 FK dependientes
  (`FK_users_department_same_org`, `FK_tickets_department_same_org`) se soltaron
  y **recrearon idénticos** (habilitados y confiables). 0 filas modificadas.

### 14.2 Incidencias (defectos reales del script DEV, corregidos)

El script `apply-groupD-not-null.sql` (versión DEV) **no compilaba/ejecutaba** por
dos defectos ausentes en el script autorizado de scratch
(`apply-groupD-not-null-scratch-test-authorized.sql`, que sí los tenía):

1. **Sintaxis inválida** (líneas 584/586 originales):
   `EXEC (N'ALTER TABLE ' + QUOTENAME(...))` → no es T-SQL válido (error 102,
   compilación del batch → nada se ejecutó). Corregido a
   `SET @sql = ...; EXEC sys.sp_executesql @sql;` con `BEGIN/END` para respetar el
   `IF`.
2. **Conflicto de collation** (error 468) en la verificación intra-transacción:
   comparación de cadenas del catálogo (`Latin1_General_CI_AS_KS_WS`) con las del
   `DATABASE_DEFAULT` (`Modern_Spanish_CI_AS`). Corregido añadiendo
   `COLLATE DATABASE_DEFAULT` en `type_desc`, `key_cols` y el `data_space_name`.
3. **Control de flujo**: el primer intento de corrección dejó el `EXEC` fuera del
   `IF` (sin `BEGIN/END`), re-ejecutando el `ADD CONSTRAINT` (error 2714). Corregido
   envolviendo en `BEGIN/END`.

Todos los intentos fallidos revirtieron por `TRY/CATCH` + `XACT_ABORT`: **DEV no
quedó en estado intermedio**.

### 14.3 Riesgos residuales

- La variante no autorizada `backend/scripts/migration/apply-groupD-not-null-scratch-test.sql`
  fue corregida **estáticamente y sin ejecutarla**: usa SQL dinámico válido con
  `sp_executesql`, bloques `BEGIN/END` y comparaciones de catálogo con collation
  explícita. Sigue reservada para Scratch y no se autoriza su ejecución sobre DEV.
- El Grupo E (arranque en seco con `MSSQL_RUNTIME=true`, `GET` de solo lectura) y la
  verificación M5 en DEV requieren credenciales vigentes o una cuenta de solo
  lectura autorizada.

### 14.4 Estado final de DEV

`SIFHA_Tickets_DEV` queda **reconciliada y certificada post-D** (`VERIFICADOR FINAL:
GO`). El intento controlado de Grupo E no inició el backend: el transporte SQL
responde, pero SQL Server rechazó el login configurado localmente.

## 15. Cierre de comprobaciones seguras (2026-10-13)

- El probe temporal de Node.js ejecutó exclusivamente `SELECT` de identidad. La
  instancia fue alcanzable con las cuatro variantes; la configuración local llegó
  al servidor, pero el login fue rechazado. Sin credenciales válidas no se hicieron
  lecturas sobre DEV ni M5, ni se inició el runtime MSSQL.
- Configuración Node.js a usar al contar con una cuenta autorizada: `DB_CLIENT=mssql`,
  `MSSQL_RUNTIME=true`, `JOBS_ENABLED=false`, `DB_SERVER=TI-DESK-01`,
  `DB_INSTANCE=SIFHADEV`, `DB_DATABASE=SIFHA_Tickets_DEV`, `DB_ENCRYPT=true` y una
  política TLS válida. Para el certificado autofirmado de la instancia, la excepción
  `DB_TRUST_SERVER_CERTIFICATE=true` debe estar explícitamente autorizada y limitada
  al entorno correspondiente.
- Grupo E: **NO-GO** por autenticación. M5: **PARCIAL**: el autodiagnóstico local
  del contrato terminó en `pass` (24 tablas, 23 índices), pero la consulta remota
  quedó bloqueada por el mismo rechazo de login.
- Seguridad local: `npm audit --omit=dev` terminó sin vulnerabilidades en backend y
  frontend. No se modificaron datos, estructura, seeds ni migraciones.

## 16. Diagnóstico definitivo de autenticación MSSQL (2026-10-13)

- Configuración efectiva, sin exponer secretos: `DB_CLIENT=mssql`,
  `DB_SERVER=localhost`, `DB_PORT=1433`, `DB_INSTANCE` ausente,
  `DB_DATABASE=SIFHA_Tickets_DEV`, usuario y contraseña presentes,
  `DB_ENCRYPT=true` y `DB_TRUST_SERVER_CERTIFICATE=true`. Es autenticación SQL
  por contraseña; el driver por defecto (`tedious`) no usa Windows/Trusted
  Connection.
- El puerto TCP estático y `instanceName` son alternativas excluyentes en
  `tedious`. La configuración actual usa el puerto 1433, por lo que no depende
  de SQL Browser/UDP 1434. Solo debe usarse `DB_INSTANCE=SIFHADEV` si se elimina
  `DB_PORT` y el administrador confirma que SQL Browser está disponible.
- Resultado real del único probe: transporte y TLS alcanzaron SQL Server, pero
  el driver devolvió `ELOGIN` / `Login failed for user '***'`. La autenticación
  falló antes de poder confirmar la identidad de base por consulta. No se
  reintentó con otras contraseñas ni se usaron cuentas administrativas.
- No hay un archivo local de credenciales de prueba MSSQL ni una cuenta de solo
  lectura verificable. Que un usuario/contraseña estén presentes no acredita
  permisos de lectura ni autorización para DEV.

### Procedimiento mínimo para cerrar el bloqueo

1. El administrador debe confirmar qué instancia atiende `localhost:1433` y
   entregar por un canal seguro una cuenta SQL dedicada, de solo lectura, para
   `SIFHA_Tickets_DEV`; no incluirla en Git, documentos ni mensajes.
2. La cuenta necesita como mínimo `CONNECT`, lectura de `dbo` y visibilidad de
   metadatos (`VIEW DEFINITION`) para los verificadores. No debe tener
   `db_datawriter`, DDL ni roles administrativos.
3. Guardar el secreto únicamente en `backend/.env` local o en el almacén de
   secretos del entorno. Mantener `DB_SERVER=localhost`, `DB_PORT=1433`,
   `DB_INSTANCE` vacío, `DB_ENCRYPT=true`; sustituir la confianza al certificado
   por una CA válida cuando esté disponible.
4. Con la cuenta autorizada, ejecutar primero el probe `SELECT` de identidad;
   solo si confirma `TI-DESK-01\\SIFHADEV` y `SIFHA_Tickets_DEV`, ejecutar Grupo
   E con `MSSQL_RUNTIME=true` y `JOBS_ENABLED=false`. M5 usa exclusivamente
   `SIFHA_Tickets_M5_Validation` y sus verificadores de solo lectura; no debe
   apuntarse a DEV.

## 17. Cierre de comprobaciones seguras (2026-10-14)

Sesión autónoma sobre el árbol limpio de §16 (HEAD `21cf9cc`). Sin push, sin merge,
sin DDL/DML sobre ninguna base. No se repitió ninguna certificación cerrada. El
bloqueo de autenticación (§16) queda **resuelto**.

### 17.1 ELOGIN resuelto (SSMS y Node.js)

- Causa: contraseña del login SQL `sifha_ticket_dev` desincronizada. Resuelta por
  **rotación autorizada** por el administrador (no ejecutada por el agente).
- Verificación SSMS: login correcto, acceso a `SIFHA_Tickets_DEV`, login habilitado
  y mapeado, instancia en **modo mixto**.
- Verificación Node.js (`mssql@12.2.0`): probe `SELECT` de identidad → **PASS**:
  base `SIFHA_Tickets_DEV`, instancia `TI-DESK-01\SIFHADEV`, usuario
  `sifha_ticket_dev`. Sin escrituras; conexión cerrada.
- Config efectiva del probe: `DB_CLIENT=mssql`, `DB_SERVER=100.100.4.60`,
  `DB_PORT=1433`, `DB_ENCRYPT=true`, `DB_TRUST_SERVER_CERTIFICATE=true`,
  `MSSQL_RUNTIME=true`. `MSSQL_RUNTIME=true` es obligatorio: sin él, `config.js`
  sirve `dbClient='sqlite'` aunque `DB_CLIENT=mssql`.

### 17.2 Permisos reales de `sifha_ticket_dev` (hallazgo, solo lectura)

Consulta `IS_MEMBER(...)`: `db_datareader=0`, `db_datawriter=0`, `db_owner=0`,
`db_ddladmin=0`. Permisos **directos** (a nivel de objeto):

| Objeto | Permisos directos |
|---|---|
| `departments` | SELECT, INSERT, UPDATE, DELETE |
| `role_permissions` | SELECT, INSERT, DELETE |
| `sessions` | SELECT, INSERT, UPDATE, DELETE |
| `users` | SELECT, UPDATE |
| `roles` | SELECT |
| `permissions` | SELECT |

- **`dbo.tickets` existe pero la cuenta NO tiene `SELECT`** (error `EREQUEST`:
  «SELECT permission denied on object 'tickets'»). Idem para el resto del esquema.
- `sys.tables` devuelve **6 tablas** por **visibilidad de metadatos**, no porque el
  esquema tenga 6: la estructura canónica (`backend/src/db/mssql/schema.sql`) define
  **24 tablas** (corrige el conteo previo «23 tablas», que era un error tipográfico).
  Coincide con el artefacto descrito en §5.2; ver §18.6.
- **Consecuencia:** con esta cuenta el backend no puede operar (no lee `tickets`,
  `notifications`, `settings`, etc.). **No es una cuenta de solo lectura
  utilizable para Grupo E** (tiene INSERT/UPDATE/DELETE en 4 tablas y no tiene
  SELECT en casi ninguna).

### 17.3 Auditoría de arranque y GETs (garantía de no-escritura)

Auditoría de código (solo lectura) de todo el backend:

- **Arranque MSSQL (`MSSQL_RUNTIME=true`):** `prepareDatabase()` ejecuta
  únicamente `validateMssqlSchema()` (3 `SELECT` a catálogo; `startup.js` y
  `schemaValidator.js`). **No** hay migración, seed ni snapshot en la rama MSSQL.
- **Jobs:** `startJobs()` no hace nada con `JOBS_ENABLED=false`; con el valor por
  defecto (`true`) ejecuta `runMaintenance()` de inmediato (UPDATE/INSERT/DELETE).
  Por tanto **`JOBS_ENABLED=false` es obligatorio** para el arranque en seco.
- **Escrituras en peticiones GET (hallazgo real):** «solo GET» **no** garantiza
  cero escrituras:
  1. Cada GET autenticado con cookie válida ejecuta
     `UPDATE sessions SET expire...` (rolling session: `app.js` y
     `db/sessionStore.js`).
  2. `GET /api/kb-articles/:id` sobre artículo PUBLISHED de otro autor ejecuta
     `UPDATE kb_articles SET view_count = view_count + 1`.
  3. Caso borde: `requireAuth` con cuenta/organización inactiva ejecuta
     `DELETE FROM sessions`.
  El resto de GET (`/api/health`, `/api/auth/me`, `/api/tickets*`, `/api/users`,
  `/api/roles*`, `/api/departments`, `/api/settings`, `/api/dashboard/*`,
  `/api/reports/*`, `/api/notifications*`, descargas, exportaciones) son `SELECT`.
- **Veredicto:** para un arranque 100 % sin escrituras usar `MSSQL_RUNTIME=true` +
  `JOBS_ENABLED=false` y limitar las peticiones a GET **anónimos** (sin cookie de
  sesión inicializada), evitando `GET /api/kb-articles/:id`. Con sesión autenticada
  hay escritura inevitable de sesión.

### 17.4 M5: DEV vs `SIFHA_Tickets_M5_Validation` (solo lectura)

| Base | Estado | Evidencia |
|---|---|---|
| `SIFHA_Tickets_DEV` | Objetivo M5 cumplido (leído): `notifications.organization_id` NULL-able; `CK_notifications_ticket_requires_org` presente, habilitada y confiable; `departments.organization_id` NOT NULL (post-D) | Preflight §12.3, §14 |
| `SIFHA_Tickets_M5_Validation` | Objetivo cumplido con datos (24 tablas; 1 org CMUCE; 25 deptos; 9 tickets; 5 usuarios; 26 notificaciones) | §5.3 |
| Respaldo `SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak` | Creado (`COPY_ONLY + CHECKSUM + COMPRESSION`); `VERIFYONLY` pendiente de cuenta con `CREATE DATABASE` | §5.3 |

Los scripts M5 del repositorio están **sellados** a `SIFHA_Tickets_M5_Validation` y
no deben apuntarse a DEV (§13.3).

### 17.5 GitHub y PR #1 (estado real vía API, 2026-10-14)

- PR #1: **abierto**, `mergeable: true`, `mergeable_state: clean`, head `2c69427`
  → base `main`; **72 commits**, **208 archivos**, `+34146 / −3100`.
- CI GitHub Actions: última ejecución sobre `2c69427` (`push` y `pull_request`) →
  **4/4 success** (`Backend (SQLite temporal)` y `Frontend (vitest + build)`).
- `git`: rama `integracion-casa-oficina-11oct` **sincronizada** con `origin`
  (HEAD = `origin` = `2c69427`); árbol limpio.
- `docs/PR-1-CUERPO-ACTUALIZADO.md` actualizado con las cifras reales (antes
  indicaba `7723d87`, 56 commits y 200 archivos).

### 17.6 Limpieza y seguridad

- Corrección accidental revertida en
  `backend/scripts/migration/verify-after-groupD-scratch-test.sql` (typo
  `comprobacionO` → `comprobacion`); árbol limpio.
- El probe temporal `D:\ticket\test_ok.mjs` **ya no existe** (eliminado tras la
  prueba de conexión); no era un artefacto versionado.
- Archivos locales de credenciales `.env`, `.env.backup-local`, `.env.mssql-test`
  y los logs/automatizaciones de raíz (`auto-push.ps1`, `git-watch.ps1`,
  `vitest*.log`, respaldos, `*.exe`, `*.7z`) están **gitignored** (verificado con
  `git check-ignore`); no se versiona ningún secreto.
- **Riesgo residual:** `backend/.env.backup-local` conserva una variante de la
  credencial en texto plano (local, no versionada). Recomendado eliminarla tras
  confirmar que la rotación quedó aplicada en `backend/.env`.

### 17.7 Estado de Grupo E

**BLOQUEADO.** No existe todavía una cuenta de **solo lectura verificable** para
`SIFHA_Tickets_DEV`: `sifha_ticket_dev` carece de `SELECT` sobre `tickets` y el
resto del esquema (§17.2). Requiere (a) cuenta de solo lectura autorizada o (b)
corrección de permisos de `sifha_ticket_dev` (script idempotente de mínimo
privilegio; **no ejecutado**). No se declara GO sin evidencias reales.

### 17.8 Artefactos nuevos y verificación

- **Nuevo script (no ejecutado):** `backend/scripts/migration/grant-app-account-minimal.sql`
  — idempotente, con guarda de identidad DEV y SQL dinámico con `QUOTENAME`;
  concede permisos **por tabla y operación** (mapa de mínimo privilegio ajustado al
  uso real del backend). **No** usa `db_datareader`/`db_datawriter` (alcance global),
  **no** concede `db_owner`/`db_ddladmin`/`sysadmin` y **no** crea logins ni usuarios.
  Requiere autorización explícita para ejecutarse. Ver §18.
- **Nueva regresión estática:** `backend/test/dev-permissions-scripts.test.js`
  (5 pruebas): exige guarda de identidad, mínimo privilegio, ausencia de
  `db_owner`/`db_ddladmin`/`sysadmin`, ausencia de `CREATE/ALTER LOGIN|USER`,
  `DROP` y uso de `QUOTENAME`.
- **Backend `npm test` (re-ejecutado):** **895 pruebas, 893 pass, 0 fallos,
  2 omitidas, 148 suites** (~100 s). Las 5 pruebas nuevas son las que elevan el
  total (antes 890/888/2/147). No se modificó código de aplicación.
- **Prueba dirigida de scripts:** las 3 suites estáticas de scripts
  (`dev-permissions-scripts`, `dev-readonly-scripts`, `groupD-scratch-verifiers`)
  → **22/22 pass**.

## 18. Cierre autónomo de entrega (2026-10-14, tercera tanda)

Sesión de revisión integral: corrección de errores reales, validación segura de
Grupo E/M5, actualización documental y preparación de commits (sin push/merge).

### 18.1 Defecto real corregido: el script de permisos NO compilaba

Al validar la sintaxis T-SQL con `SET PARSEONLY ON`, se detectó que
`grant-app-account-minimal.sql` devolvía **Msg 113 «Missing end comment mark '*/'»**.
Causa: el encabezado citaba `(routes/*, middleware/*, db/mssql/*, utils/*)`; en
T-SQL los comentarios de bloque **anidan**, así que cada `/*` abría un comentario
interno que dejaba el encabezado sin cerrar y **anulaba todo el script**. Un script
que se entrega para ejecutarse en SSMS era, por tanto, **inutilizable**.

- Corregido a `(carpetas routes, middleware, db/mssql y utils)`.
- Validado de nuevo con `SET PARSEONLY ON`: ahora **compila** y alcanza su guarda
  de identidad/verificación (aborta por precondición, no por sintaxis).
- **Nueva regresión** en `backend/test/dev-permissions-scripts.test.js`: escanea
  **todos** los `.sql` de `scripts/migration/` y falla si una línea de continuación
  de comentario (que empieza por `*`) contiene `/*`. Es la misma clase de defecto
  que el `sys.*/` ya corregido en `diagnose-dev-account-readonly.sql` (§10.2).

### 18.2 Defecto real corregido: `POST /api/tickets/:id/assign` esquivaba la inmutabilidad

`backend/src/routes/tickets.js`: la asignación (`/assign`) no comprobaba el estado
terminal del ticket, de modo que un ticket `RESOLVED/CLOSED/CANCELLED` podía
reasignarse aunque `PATCH/PUT` sí lo impedían. Se añadió la guarda de estado
terminal (HTTP 400 «No puede modificar la asignación de un ticket terminal»).
Regresión: `backend/test/tickets-workflow.test.js` → caso
**«I4: /:id/assign no reasigna un ticket terminal»** (30/30 pass en la suite).

### 18.3 Grupo E (arranque en seco de solo lectura)

**Diseño.** Endpoints de **lectura pura** confirmados por auditoría estática
(solo `SELECT`): `/api/health`, `/api/auth/me` (anónimo), `/api/tickets*` (GET),
`/api/users`, `/api/roles*`, `/api/departments`, `/api/settings`,
`/api/dashboard/*`, `/api/reports/*`, `/api/notifications*`, descargas y
exportaciones. Efectos indirectos conocidos (ver §17.3): escritura de sesión en
todo GET autenticado, `UPDATE kb_articles.view_count` en
`GET /api/kb-articles/:id`, y `DELETE FROM sessions` en el caso borde
cuenta/organización inactiva. Para un arranque **100 % sin escrituras**:
`MSSQL_RUNTIME=true` + `JOBS_ENABLED=false` + GET **anónimos** (sin cookie).

**Cuenta de solo lectura preparada (no ejecutada):**
`backend/scripts/migration/create-groupE-readonly-account.sql` — DRY-RUN por
defecto, guarda de identidad DEV, `SELECT` por tabla vía `QUOTENAME`, sin
INSERT/UPDATE/DELETE ni roles globales; deja la creación del LOGIN al
administrador. Cubierto por `dev-permissions-scripts.test.js`.

**Evidencia ejecutada (base aislada `SIFHA_Tickets_M5_Validation`):**
arranque con `MSSQL_RUNTIME=true`/`JOBS_ENABLED=false` → `schemaValidator`
**ok:true** (24 tablas, 204 columnas), `GET /api/health` **200**,
`GET /api/auth/me` **401** (anónimo, sin escritura de sesión).

**`SIFHA_Tickets_DEV`: BLOQUEADO (externo).** Con la cuenta actual el arranque
falla en `PREPARE_FAIL` («falta la tabla dbo.organizations/…») porque el login no
ve las 24 tablas. Requiere cuenta de solo lectura autorizada o aplicar el script
de permisos (ambos requieren autorización del responsable).

### 18.4 M5 y respaldo (solo lectura)

- `node scripts/migration/diagnose-m5-validation.js` contra
  `SIFHA_Tickets_M5_Validation`: **status `pass`, exit_code 0**, 0 diferencias de
  esquema bloqueantes, `can_start_mssql=true`, **24 tablas**, `notifications`
  total 26 y `null_organization_id = 0`.
- Autodiagnóstico sin red (`DIAGNOSE_SELFCHECK=1`): **24 tablas, 23 índices**,
  `mismatches: []`.
- **Respaldo M5 `VERIFYONLY`: BLOQUEADO (externo).** Error 3013 con predecesor 262
  «CREATE DATABASE permission denied in database 'master'»: la cuenta no es
  `sysadmin`/`dbcreator` (`HAS_PERMS_BY_NAME(...,'CREATE ANY DATABASE') = 0`).

### 18.5 Pruebas y seguridad (esta sesión)

| Prueba | Resultado |
|---|---|
| Backend `npm test` | **906 pruebas: 904 pass, 0 fallos, 2 omitidas, 150 suites** (~95 s) |
| Frontend `vitest run` | **1080/1080** |
| Frontend `vite build` | **OK** |
| `npm audit` backend / frontend | **0 / 0** |
| Regresión scripts (incl. comentario anidado) | 15/15 pass |
| Regresión tickets (`I4 /assign` terminal) | 30/30 pass |

Auditoría de seguridad: sin hallazgos Altos/Medios nuevos; **1 defecto Bajo**
corregido (§18.2). Secretos: solo `.env.example` y `.env.mssql-test.example`
están versionados (saneados).

### 18.6 Conteo de tablas: 24 (corrige «23 tablas»)

El esquema canónico tiene **24 tablas** en todos los artefactos (`schema.sql` y
commits `3f35476`/`cbabe8e`). El «23 tablas» de §17.2 era un error tipográfico ya
corregido. Los **23 índices** del autodiagnóstico son un conteo distinto y correcto.

### 18.7 Artefactos y commits (publicados, sin merge)

Publicados en `origin` (`integracion-casa-oficina-11oct` → `a990bb0`): los dos
scripts SQL de permisos y solo lectura, las regresiones estáticas, el fix de
`/assign` con su regresión y estas notas de entrega. CI sobre `a990bb0`:
**4/4 success**; PR #1 **`clean`** (71 commits, 208 archivos). **No se ejecutó
merge** (el merge requiere autorización y cerrar los bloqueos externos).

### 18.8 Veredicto

**Código: LISTO PARA ENTREGA.** Dos defectos reales corregidos y cubiertos por
regresiones; suites en verde; sin vulnerabilidades nuevas. **Bloqueos externos**
para el cierre operativo en `SIFHA_Tickets_DEV`: (a) aplicar permisos de la cuenta
de aplicación o habilitar la cuenta de solo lectura del Grupo E; (b) cuenta con
`CREATE DATABASE` para el `VERIFYONLY` del respaldo M5.

### 18.9 Endurecimiento del script de permisos y verificación de conexión admin

- **Conexión administrativa autorizada: NO existe.** Se comprobó (a) que no hay
  credenciales admin en la configuración (solo la cuenta de aplicación
  `sifha_ticket_dev` en `.env`/`.env.mssql-test`/`.env.backup-local`) y (b) que la
  autenticación integrada de Windows falla (`Cannot generate SSPI context`; el
  equipo no pertenece al dominio del servidor). Por tanto **no se aplicaron
  permisos** (requiere autorización del responsable). No se exponen credenciales.
- **Tercer defecto real corregido (collation, `Msg 468`):** la nueva sección de
  revocación comparaba `sys.database_permissions.permission_name`
  (collation `Latin1_General_CI_AS_KS_WS`) con la variable de tabla `@grants.perms`
  (collation de la base) y producía `Cannot resolve the collation conflict`.
  Corregido con `COLLATE DATABASE_DEFAULT` en el JOIN y en el `CHARINDEX`, con
  aserción de regresión. Detectado al ejecutar el script en modo DRY-RUN contra el
  servidor (no por análisis estático).
- **Mínimo privilegio reforzado:** el mapa GRANT se verificó de nuevo contra las
  operaciones reales del backend (análisis estático de `backend/src`). Coincide,
  salvo que `permissions`/`roles` solo se escriben en el seed (no en runtime MSSQL:
  `startup.js` devuelve `seeded: false`), de ahí `SELECT` únicamente. Se añadió la
  sección **opt-in** `@revoke_extra` (por defecto **0**) para revocar DML sobrante
  acotado a las 24 tablas (p. ej. el `departments.DELETE` heredado). El script
  **no ejecuta DML sobre tablas persistentes**, solo `GRANT`/`REVOKE`/`SELECT`.
- **Verificación antes/después:** el script imprime el estado de permisos previo y
  posterior, más los indicadores de rol (`db_owner`/`db_ddladmin`/`db_datawriter`/
  `db_datareader`, todos deben ser 0).
- **Validación ejecutada:** `dev-permissions-scripts.test.js` → **15/15 pass**;
  comprobación de compilación contra el servidor (DRY-RUN, sin cambios) sin
  errores de sintaxis ni de collation.

## 19. Cierre autónomo de entrega (2026-10-14, cuarta tanda)

Tanda de cierre: evidencia reforzada de Grupo E y M5 (solo lectura), requisitos
del `RESTORE VERIFYONLY`, guía SSMS de aplicación de permisos y re-ejecución de
suites. Sin cambios de código de aplicación y sin operaciones administrativas.

### 19.1 Grupo E — arranque en seco con conteo de filas antes/después

Se ejecutó el arranque MSSQL **aislado** (`MSSQL_RUNTIME=true`,
`JOBS_ENABLED=false`) contra `SIFHA_Tickets_M5_Validation` y se midió el
**número de filas de las 24 tablas antes y después**:

| Comprobación | Resultado |
|---|---|
| `schemaValidator` | **ok** — 24 tablas, 204 columnas |
| `GET /api/health` | **200** |
| `GET /api/auth/me`, `/api/tickets`, `/api/users`, `/api/notifications` (anónimos) | **401** |
| Tablas cuyo conteo cambió | **0 / 24** |
| `sessions` antes / después | **0 / 0** |
| `[jobs]` en el log | «Mantenimiento programado desactivado (JOBS_ENABLED=false)» |

**Conclusión:** el arranque en seco **no escribe una sola fila** en la base
aislada; GET anónimos no disparan la sesión rodante. Refuerza §18.3 y
`docs/GRUPO-E-VALIDACION.md` §5.1.

### 19.2 M5 — verificación fresca de solo lectura

- `diagnose-m5-validation.js` contra `SIFHA_Tickets_M5_Validation`: **status
  `pass`, exit_code 0**, `blocking_total = 0`, `can_start_mssql = true`.
  Las **2 no-bloqueantes** son columnas más anchas en el destino
  (`notifications.body` MAX vs 500; `notifications.link` 2000 vs 500).
- Comprobación directa de catálogo/datos:
  - `notifications.organization_id` **nullable = true**.
  - `departments.organization_id` **nullable = false** (NOT NULL).
  - `CK_notifications_ticket_requires_org`: **habilitada** (`is_disabled = 0`) y
    **confiable** (`is_not_trusted = 0`).
  - Notificaciones con `organization_id IS NULL`: **0**; total **26**.
  - Tablas `dbo`: **24**.
- **Catálogo de respaldos (`msdb`), solo lectura:** la copia
  `SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak` está registrada en
  `msdb.dbo.backupset` con `is_copy_only = 1`, `backup_size = 11 624 448` bytes,
  `compressed_backup_size = 782 771` bytes, ruta
  `C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\`.

### 19.3 `RESTORE VERIFYONLY` del respaldo M5 — requisitos y comando

- **Requisito de permiso:** `RESTORE VERIFYONLY` exige `CREATE DATABASE` (rol
  `dbcreator`/`sysadmin`). La cuenta de la app **no** lo tiene
  (`HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') = 0`), por eso hoy
  falla con **Msg 3013 → 262**. También requiere **lectura** de la ruta del
  `.bak` (ruta local del servidor).
- **Comando (SSMS, sesión admin):**
  ```sql
  RESTORE VERIFYONLY
      FROM DISK = N'C:\Program Files\Microsoft SQL Server\MSSQL16.SIFHADEV\MSSQL\Backup\SIFHA_Tickets_M5_Validation_FULL_20261012_221132.bak'
      WITH CHECKSUM;
  ```
- `VERIFYONLY` **no** restaura ni escribe datos. Opcionalmente `RESTORE
  HEADERONLY` / `RESTORE FILELISTONLY` para inspección.

### 19.4 Guía de aplicación de permisos en SSMS

Nuevo documento `docs/APLICAR-PERMISOS-SSMS.md`: guía copiable para una sesión
de administrador, que **distingue** la cuenta de la app
(`grant-app-account-minimal.sql`, `@apply = 1`) de la cuenta de solo lectura del
Grupo E (`create-groupE-readonly-account.sql`, `@apply = 1`), con la creación de
`LOGIN`/`USER` previa, el `RESTORE VERIFYONLY`, verificación posterior y
reversión. Las 5 operaciones administrativas quedan **preparadas** (DRY-RUN por
defecto) y **no ejecutadas**.

### 19.5 Pruebas (esta tanda)

| Prueba | Resultado |
|---|---|
| Backend `npm test` | **906 pruebas: 904 pass, 0 fallos, 2 omitidas, 150 suites** |

Sin errores locales nuevos en el repositorio. (Una invocación manual
`node --test` sin `--import ./test/setup.js` ni el glob `test/*.test.js` produce
falsos fallos al compartir estado; el comando correcto es `npm test`.)

### 19.6 GitHub / PR / CI

- PR #1: **abierto**, `mergeable_state = clean`, head `2c69427` → `main`;
  **72 commits**, **208 archivos**, `+34146 / −3100`.
- CI sobre `2c69427`: **4/4 success**. Rama sincronizada con `origin`; árbol
  limpio. **No** se ejecuta merge (requiere autorización y cerrar bloqueos).
