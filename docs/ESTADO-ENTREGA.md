# Estado de entrega — SIFHA Ticket

**Fecha:** 2026-10-12
**Rama:** `integracion-casa-oficina-11oct`
**Último commit rastreado:** `cea3488` (13 commits locales por delante de `9f64117`, sin push). El árbol de trabajo está limpio: las correcciones de runtime/login (`directorySync.js`), la validación 400 de `auth.js`, las guardas de los verificadores scratch y los `package-lock` de `npm audit fix` ya están commiteadas.
**Alcance:** auditoría de entrega, corrección del bloqueo SQL del Grupo D,
limpieza de la suite de pruebas, verificación de secretos y preparación de commits.

---

## 1. Tabla de estado por tarea

| # | Tarea | Prioridad | Estado | Evidencia |
|---|-------|-----------|--------|-----------|
| 1 | Auditoría del repositorio (rama, módulos, pruebas, migraciones, docs) | P0 | COMPLETADO | Este documento |
| 2 | Corregir falso positivo del guard UNIQUE del Grupo D (`ROWS_FILEGROUP`) | P0 | COMPLETADO | `backend/scripts/migration/apply-groupD-not-null*.sql`, `diagnose-groupD-unique-blocker.sql` |
| 3 | Preparar comandos SQL del Grupo D para ejecución autorizada | P0 | PENDIENTE (BLOQUEADO) | Requiere ejecución sobre `SIFHA_GroupD_ScratchTest`; ver §5 |
| 4 | Ejecutar `npm test` (backend SQLite) sin fallos | P1 | COMPLETADO | 865 pruebas, 863 pass, 0 fallos, 2 omitidas |
| 5 | Ejecutar pruebas frontend + build de producción | P1 | COMPLETADO | 1080/1080; `vite build` OK |
| 6 | Reorganizar suites MSSQL de integración (`test/mssql/`) | P1 | COMPLETADO | `backend/package.json`, `backend/test/mssql/` |
| 7 | Auditar secretos y `.env` versionados | P0 | COMPLETADO | `git ls-files`; `.gitignore` cubre `.env*`; `.env.mssql-test.example` saneado |
| 8 | Revisar funcionamiento de módulos críticos | P1 | COMPLETADO | Cobertura de la suite (login, tickets, adjuntos, estados, permisos, aislamiento multi-org, SLA, auditoría, reportes) |
| 9 | Revisar seguridad básica (inyección SQL, attach, CORS, CSRF, HSTS) | P1 | COMPLETADO | Suite + `docs/SEGURIDAD-AUDITORIA.md` (0 Alta; 3 Medios de endurecimiento) |
| 10 | Documentación de entrega | P2 | EN PROCESO | README, ENTREGA-CHECKLIST, ENTREGA-INFRAESTRUCTURA, DEPLOY-MSSQL actualizados; falta revisar el resto |
| 11 | Commits locales descriptivos | P2 | PENDIENTE | Preparado en §8; no ejecutado hasta autorización |
| 12 | Push a GitHub | — | PENDIENTE (BLOQUEADO) | Requiere autorización explícita |
| 13 | Corregir arranque y login en Docker (conflicto de capitalización de username) | P0 | COMPLETADO | `directorySync.js` (COLLATE NOCASE), `docker-compose.dev.yml` (healthcheck IPv4); login real verificado |
| 14 | Corregir guarda de identidad de los verificadores scratch del Grupo D | P0 | COMPLETADO | `verify-after-groupD-scratch-test.sql`, `verify-final-reconciliation-scratch-test.sql`, `test/groupD-scratch-verifiers.test.js` |
| 15 | Comprobaciones de SOLO LECTURA contra SQL Server (`SIFHA_GroupD_ScratchTest`) | P0 | COMPLETADO | Conexión OK; inventario + verificador; ver §5 |

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
| Backend (SQLite temporal) | `npm test` | **865 pruebas, 863 pass, 0 fail, 2 skip** (~110 s) |
| Integración MSSQL (requiere entorno) | `npm run test:mssql` | **NO EJECUTADA** (requiere `.env.mssql-test` + SQL Server autorizado) |
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

## 4. Migraciones SQL

| Grupo | Estado | Detalle |
|-------|--------|---------|
| B (reconciliación base) | VALIDADO (no ejecutado en DEV) | Verificadores solo lectura |
| C (backfill CMUCE + FK compuestas) | VALIDADO (no ejecutado en DEV) | `backfill-organization-CMUCE.sql`, `fix-users-department-same-org.sql` |
| D (departments.organization_id NOT NULL) | SCRIPT CORREGIDO, ejecución PENDIENTE | Scratch ya en estado post-C; ver §5 |
| M5 (notifications nullable) | CUMPLIDO en `SIFHA_Tickets_M5_Validation` | Columna `organization_id` INT NULL + `CK_notifications_ticket_requires_org` presentes y confiables; ver §5.3 |
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
- **Dependencias (`npm audit`, 2026-10-12, sin `--force`):**
  - Backend producción: **2 moderadas** (`uuid` vía `exceljs`). Arreglo
    propuesto (`exceljs@3.4.0`) es *breaking*; **pendiente de decisión**.
  - Frontend producción: **1 moderada** (`react-router`/`react-router-dom`,
    redirección abierta). Arreglo propuesto (`react-router-dom@7`) es salto de
    mayor (6→7); **pendiente de decisión**.
  - Frontend solo-*dev*: `vite` (alta) y `tinypool`/`vitest` (críticas) en la
    cadena de pruebas/compilación; **no** afectan al bundle distribuido. Arreglo
    `vitest@5` es *breaking*; **pendiente de decisión**.
  - Ninguna vulnerabilidad crítica o alta afecta al artefacto de producción.

## 7. Cambios pendientes de revisar (origen)

No se descartó nada y **no queda trabajo sin commitear**: los 13 commits locales
(`7c748c2`…`cea3488`) ya incluyen las correcciones SQL/entrega, el arranque/login
(`directorySync.js`), la validación 400 de `auth.js` y sus pruebas, el healthcheck
IPv4 de `docker-compose.dev.yml`, la guarda de los verificadores scratch del Grupo
D con su prueba, los `package-lock.json` de `npm audit fix` y las actualizaciones
de documentación. Los artefactos `inventario-grupoD.txt` y
`resultado-verificacion-D.txt` de la raíz son salidas de diagnóstico y **no** se
versionan (gitignored).

## 8. Plan de commits

Ejecutado. Los 13 commits locales (`7c748c2`…`cea3488`) están creados, sin push;
`origin/integracion-casa-oficina-11oct` sigue en `9f64117`. La publicación
(`git push`) queda pendiente de la autorización de push.

## 9. Bloqueos que requieren intervención

- **P0** — Aplicar el Grupo D contra `SIFHA_GroupD_ScratchTest` (§5): el scratch ya
  está post-C, pero `sifha_ticket_dev` **no** tiene `ALTER`, así que se requiere el
  login `SIFHA_GroupD_ScratchTestRunner` (u otra cuenta con `ALTER ON SCHEMA::dbo`)
  y respaldo previo.
- **P0** — Secuencia B→C→D→E en `SIFHA_Tickets_DEV`: la cuenta de migración tiene
  `db_owner=0` en DEV, por lo que **no puede** ejecutar el DDL; requiere cuenta
  privilegiada, respaldo verificado y ventana de mantenimiento. El estado real de
  DEV no es verificable con la cuenta actual (artefacto de visibilidad).
- **P1** — Correr `npm run test:mssql`: falta `backend/.env.mssql-test`; la cuenta
  de migración **no** accede a `SIFHA_Tickets_M5_Integration_Test`; faltan las
  contraseñas de los usuarios de prueba sembrados. Las suites **escriben** datos.
- **P1** — M5: el objetivo ya está cumplido en `SIFHA_Tickets_M5_Validation`
  (§5.3); queda solo decidir si se respalda con `backup-m5.sql`.
- **P1** — Decidir los arreglos *breaking* de `npm audit` (exceljs, react-router,
  vitest). No se aplican sin autorización.
- **P2** — Publicar los 13 commits locales (`git push`), pendiente de autorización.
- **P2** — Añadir ESLint/`lint` (recomendación no bloqueante).