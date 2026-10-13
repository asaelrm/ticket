# Estado de entrega — SIFHA Ticket

**Fecha:** 2026-10-12
**Rama:** `integracion-casa-oficina-11oct`
**Último commit rastreado:** `9f64117 Corregir Grupo D y validar dependencias SQL Server`
**Alcance:** auditoría de entrega, corrección del bloqueo SQL del Grupo D,
limpieza de la suite de pruebas, verificación de secretos y preparación de commits.

---

## 1. Tabla de estado por tarea

| # | Tarea | Prioridad | Estado | Evidencia |
|---|-------|-----------|--------|-----------|
| 1 | Auditoría del repositorio (rama, módulos, pruebas, migraciones, docs) | P0 | COMPLETADO | Este documento |
| 2 | Corregir falso positivo del guard UNIQUE del Grupo D (`ROWS_FILEGROUP`) | P0 | COMPLETADO | `backend/scripts/migration/apply-groupD-not-null*.sql`, `diagnose-groupD-unique-blocker.sql` |
| 3 | Preparar comandos SQL del Grupo D para ejecución autorizada | P0 | PENDIENTE (BLOQUEADO) | Requiere ejecución sobre `SIFHA_GroupD_ScratchTest`; ver §5 |
| 4 | Ejecutar `npm test` (backend SQLite) sin fallos | P1 | COMPLETADO | 859 pruebas, 0 fallos, 2 omitidas |
| 5 | Ejecutar pruebas frontend + build de producción | P1 | COMPLETADO | 1080/1080; `vite build` OK |
| 6 | Reorganizar suites MSSQL de integración (`test/mssql/`) | P1 | COMPLETADO | `backend/package.json`, `backend/test/mssql/` |
| 7 | Auditar secretos y `.env` versionados | P0 | COMPLETADO | `git ls-files`; `.gitignore` cubre `.env*`; `.env.mssql-test.example` saneado |
| 8 | Revisar funcionamiento de módulos críticos | P1 | COMPLETADO | Cobertura de la suite (login, tickets, adjuntos, estados, permisos, aislamiento multi-org, SLA, auditoría, reportes) |
| 9 | Revisar seguridad básica (inyección SQL, attach, CORS, CSRF, HSTS) | P1 | COMPLETADO | Suite + `docs/SEGURIDAD-AUDITORIA.md` (0 Alta; 3 Medios de endurecimiento) |
| 10 | Documentación de entrega | P2 | EN PROCESO | README, ENTREGA-CHECKLIST, ENTREGA-INFRAESTRUCTURA, DEPLOY-MSSQL actualizados; falta revisar el resto |
| 11 | Commits locales descriptivos | P2 | PENDIENTE | Preparado en §8; no ejecutado hasta autorización |
| 12 | Push a GitHub | — | PENDIENTE (BLOQUEADO) | Requiere autorización explícita |

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
| Backend (SQLite temporal) | `npm test` | **859 pruebas, 857 pass, 0 fail, 2 skip** (~105 s) |
| Integración MSSQL (requiere entorno) | `npm run test:mssql` | **NO EJECUTADA** (requiere `.env.mssql-test` + SQL Server autorizado) |
| Frontend | `npx vitest run` | **44 archivos, 1080/1080 pass** (0 fail, ~138 s) |
| Build producción frontend | `npm run build` | **OK** (`dist/` generado) |

Cifras anteriores («860 pruebas, 3 fallos») quedaron obsoletas: las suites de
integración MSSQL ahora viven en `backend/test/mssql/` y **no** forman parte de
`npm test`, de modo que la suite por defecto termina sin falsos fallos. No se
perdió cobertura: las 3 suites se ejecutan con `npm run test:mssql`.

## 4. Migraciones SQL

| Grupo | Estado | Detalle |
|-------|--------|---------|
| B (reconciliación base) | VALIDADO (no ejecutado en DEV) | Verificadores solo lectura |
| C (backfill CMUCE + FK compuestas) | VALIDADO (no ejecutado en DEV) | `backfill-organization-CMUCE.sql`, `fix-users-department-same-org.sql` |
| D (departments.organization_id NOT NULL) | SCRIPT CORREGIDO, ejecución PENDIENTE | Ver §5 |
| M5 (notifications nullable) | PENDIENTE de autorización | `notifications-organization-nullable.sql` |
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
  credenciales reales.

## 7. Cambios pendientes de revisar (origen)

No se descartó nada. Los archivos modificados son los del propio trabajo SQL de
los últimos días (scripts Grupo D y scratch) y los del nuevo ajuste de pruebas.
Los artefactos `inventario-grupoD.txt` y `resultado-verificacion-D.txt` de la
raíz son salidas de diagnóstico y **no** se incluyen en los commits.

## 8. Plan de commits propuesto (sin ejecutar)

1. `fix(migracion): corregir falso positivo ROWS_FILEGROUP en guard UNIQUE del grupo D` —
   `apply-groupD-not-null.sql` y `diagnose-groupD-unique-blocker.sql`.
2. `feat(migracion): scripts scratch autorizados del grupo D y verificadores (base SIFHA_GroupD_ScratchTest)` —
   los `*-scratch-test*.sql`, `check-*`, `configure-*`, `inventory-*`, `prepare-*`, `verify-*` sin rastrear.
3. `test(backend): separar suites de integracion MSSQL en test/mssql y dejar npm test verde` —
   `backend/package.json`, `backend/test/mssql/` (3 archivos movidos).
4. `chore(security): sanear .env.mssql-test.example` —
   `backend/.env.mssql-test.example`.
5. `docs(entrega): estado de entrega y actualizacion de cifras de pruebas` —
   `docs/ESTADO-ENTREGA.md`, `README.md`, `ENTREGA-CHECKLIST.md`,
   `ENTREGA-INFRAESTRUCTURA.md`, `docs/DEPLOY-MSSQL.md`.

## 9. Bloqueos que requieren intervención

- **P0** — Ejecutar el Grupo D contra `SIFHA_GroupD_ScratchTest` (§5) y, con
  respaldo verificado, la secuencia B→C→D→E en `SIFHA_Tickets_DEV`. Requiere
  autorización y ventana de mantenimiento.
- **P0** — Cerrar M5 (`notifications.organization_id` NULL-able) en la base de
  validación con el script `notifications-organization-nullable.sql`.
- **P1** — Correr `npm run test:mssql` en un entorno con SQL Server autorizado
  (base `SIFHA_Tickets_M5_Integration_Test`) para certificar las 3 suites.
- **P2** — Añadir ESLint/`lint` (recomendación no bloqueante).