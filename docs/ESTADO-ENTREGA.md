# Estado de entrega — SIFHA Ticket

**Fecha:** 2026-10-13
**Rama:** `integracion-casa-oficina-11oct`
**Último commit publicado:** `7723d87` (en `origin/integracion-casa-oficina-11oct`; rama sincronizada, árbol limpio).
**Commits locales pendientes de push:** ninguno hasta `7723d87` (todo publicado). La sesión de finalización del 2026-10-13 añade commits locales nuevos (ver §12).
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

- Cifras de pruebas alineadas a la ejecución vigente (**890/888/0/2** backend;
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
- **Pruebas locales reconfirmadas:** backend **890/888 pass, 0 fallos,
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
| Grupo E (arranque en seco) | **PREPARADO** (no ejecutado) |

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

- `backend/scripts/migration/apply-groupD-not-null-scratch-test.sql` (variante **no
  autorizada**, no usada) conserva el defecto `EXEC (N'ALTER TABLE ...')`. No se
  tocó por la restricción “no tocar Scratch”; se recomienda corregirlo o retirarlo
  en una tarea aparte.
- El Grupo E (arranque en seco con `MSSQL_RUNTIME=true`, `GET` de solo lectura) y la
  verificación M5 en DEV **siguen pendientes** (requieren ventana y autorización).

### 14.4 Estado final de DEV

`SIFHA_Tickets_DEV` queda **reconciliada y certificada post-D** (`VERIFICADOR FINAL:
GO`), lista para el Grupo E. No se arrancó el backend contra DEV en esta sesión.