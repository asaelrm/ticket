# SIFHA Ticket — Pendientes de entrega (oficina)

**Fecha:** 2026-10-10
**Rama:** `trabajo-oficina-10oct`
**Commit base:** `ec0ae32 fix(frontend): corregir cancelacion de tickets y permisos de usuarios`
**Rama de integración prevista:** `trabajo-etapa3-pendiente` (`e7c7d1e`)

> Este documento complementa a `docs/M5-REVISION-FINAL.md` y a
> `ENTREGA-CHECKLIST.md`. Registra los hallazgos de la revisión final de la etapa
> de oficina, lo que quedó **verificado**, lo que es **revisión estática** y lo
> que **no se ejecutó** por restricción de alcance. No se marca como validado en
> SQL Server nada que solo se haya revisado en código.

## Alcance y restricciones de esta revisión

No se modificaron `backend/src/routes/tickets.js` ni
`backend/src/utils/ticketNumber.js`; tampoco las pruebas, helpers ni la
configuración MSSQL reservados, ni archivos `.env`/credenciales. No se ejecutaron
migraciones, seed ni operaciones contra bases de datos. No se ejecutaron pruebas
SQLite. No se hizo merge/rebase/reset/force push, no se cambió de rama y no se
crearon commits ni push nuevos.

---

## 1. Estado git y Pull Request

- Rama actual `trabajo-oficina-10oct`, en `ec0ae32`, sincronizada con `origin`
  (sin commits por delante ni por detrás).
- `git status --short`: limpio.
- **`gh` no está instalado** en este equipo, por lo que el PR Draft **no** puede
  crearse automáticamente. Creación manual (base, cabeza y título solicitados):

  ```text
  https://github.com/asaelrm/ticket/compare/trabajo-etapa3-pendiente...trabajo-oficina-10oct?expand=1
  Título: fix(frontend): correcciones funcionales y pruebas de regresión
  Estado: Draft
  ```

- El diff entre `trabajo-etapa3-pendiente` y `trabajo-oficina-10oct` es
  exactamente **1 commit** (`ec0ae32`) con **5 archivos**.

---

## 2. Diagnóstico del error `IMG_PNG` (FASE 2)

**Clasificación:** revisión estática; **no** se ejecutó la suite.

- `backend/test/mssql-integration.test.js:7` importa `IMG_PNG` desde
  `./helpers-mssql.js`, pero ese helper **no exporta** `IMG_PNG` (exporta
  `app`, `uniqueSuffix`, `createClient`, `createAdminClient`,
  `createEmpleadoClient`, `createTecnicoClient`). Es un `SyntaxError` de ESM al
  cargar el módulo.
- Segundo defecto en el mismo archivo: usa `TEST_ADMIN_USER` (líneas 36, 45, 55)
  sin importarlo ni definirlo; si se corrigiera lo anterior, fallaría con
  `ReferenceError`.
- El propio test define `IMG_PNG_LOCAL` y lo usa (líneas 73, 164, 181); el import
  de `IMG_PNG` parece residual.
- El import de `IMG_PNG` solo aparece en `mssql-integration.test.js`. Ningún
  archivo de `backend/src` importa `IMG_PNG`, `helpers-mssql` ni
  `mssql-integration`: el defecto afecta **solo** a la suite de integración MSSQL,
  **no** a la aplicación.

**Estado:** pendiente. La corrección exige editar archivos MSSQL reservados; se
deja documentada, sin modificar, a la espera de integrar las correcciones que se
recuperen desde el equipo de casa.

Error observado (evidencia de `npm test`):

```text
SyntaxError: The requested module './helpers-mssql.js' does not provide an export named 'IMG_PNG'
```

---

## 3. Auditoría de la entrega MSSQL (FASE 3)

### 3.1 Selección de motor

- `backend/src/db/runtime.js` es la fachada: elige el motor según
  `config.dbClient` y solo carga las dependencias de SQLite cuando el motor es
  SQLite.
- `backend/src/config.js`: `DB_CLIENT=mssql` **no** activa SQL Server; requiere
  además `MSSQL_RUNTIME=true`. Si se pide MSSQL sin activarlo, el motor efectivo
  sigue siendo SQLite.
- `backend/src/startup.js`: la rama MSSQL **no** importa `db.js`/`seed.js`, no
  migra, no siembra y no restaura instantáneas; solo **valida el esquema en solo
  lectura** (`validateMssqlSchema` / `describeSchemaFailures`). Si la validación
  falla, el servidor HTTP **no arranca**.
- `backend/src/server.js`: avisa si se pidió MSSQL sin activarlo y termina con
  código distinto de cero ante fallo de arranque.

### 3.2 Dependencias de SQLite restantes

`node:sqlite`/`DatabaseSync` solo aparece en `db.js`, `db/sqlite.js`,
`db/runtime.js` y `config.js` (rama SQLite). Los scripts que importan `db.js`
son exclusivamente las utilidades SQLite:

```text
backend/src/seed.js                       -> './db.js'
backend/src/scripts/migrate.js            -> '../db.js'
backend/src/scripts/seed.js               -> '../db.js'
backend/src/scripts/bootstrap-superadmin.js -> '../db.js'
backend/src/scripts/audit-orgs.js         -> '../db.js'
```

Conclusión: no hay dependencias de SQLite en el camino de peticiones cuando se
opera con MSSQL activado.

### 3.3 Bloqueo M5 de `dbo.notifications` (estado de base, no de código)

- `ENTREGA-CHECKLIST.md` §4 registra como **P0** que
  `dbo.notifications.organization_id` sigue `NOT NULL` y falta
  `CK_notifications_ticket_requires_org` en la base de validación.
- El **esquema canónico del repositorio ya está corregido**:
  `backend/src/db/mssql/schema.sql:327` declara `organization_id INT NULL` y
  `:337` define `CK_notifications_ticket_requires_org`. Es decir, el pendiente es
  el **estado de la base desplegada**, no un defecto de código.
- El script idempotente y transaccional
  `backend/scripts/migration/notifications-organization-nullable.sql` está listo
  y se autoprotege (aborta salvo en `SIFHA_Tickets_M5_Validation` sobre
  `TI-DESK-01\SIFHADEV`).
- **No se ejecutó**: sigue **pendiente de autorización explícita** y de backup
  previo. No activar `MSSQL_RUNTIME=true` hasta cerrar este P0.

### 3.4 Trampas de documentación detectadas

| Ubicación | Observación |
|---|---|
| `docs/DEPLOY-MSSQL.md:105` | El paso `npm run db:migrate  # Solo valida, no escribe si esquema existe` es engañoso en MSSQL: `db:migrate` ejecuta `src/scripts/migrate.js`, que importa `runMigrations` de `db.js` (**SQLite**). No valida el esquema MSSQL; esa validación ocurre automáticamente en `npm start` (`startup.js`). |
| `docs/DEPLOY-MSSQL.md:277` | Cifra de pruebas desactualizada (`857 tests, 0 fallos`). En esta rama el backend reporta `860 pruebas, 3 fallos` (los tres pendientes MSSQL del §5). |
| `docs/DEPLOY-MSSQL.md:319` | El pie referencia el commit `aa3bf6f`, que no corresponde al estado actual. |
| `backend/package.json:13` | El script `test` usa el glob `test/*.test.js`, que también recoge las suites `mssql-*.test.js` (orientadas a SQL Server). Por eso `npm test` intenta cargarlas y produce los 3 fallos del §5. |

Estas correcciones son de documentación; **no se aplicaron** en esta etapa para
no colisionar con el trabajo MSSQL pendiente de integrar desde el otro equipo.

### 3.5 Pendientes de prioridad menor (P2)

- `frontend/vite.config.js:37`: proxy de desarrollo fijo a `http://backend:4000`
  (P2 del checklist: parametrizar por entorno).
- Manejo global de sesión caducada en el frontend ante peticiones ya abiertas
  (P2 del checklist).
- `AuthContext.jsx:31-42` consulta `/api/settings` para todo usuario autenticado,
  aunque el endpoint exige `settings.manage` (`backend/src/routes/settings.js:15`);
  para un usuario sin ese permiso el 403 se captura sin efectos. **No se cambió**
  porque el contrato actual (prueba `AuthContext.test.jsx:98-108`) espera que un
  rol sin `settings.manage` reciba igualmente `app_name`, y gatearlo alteraría el
  branding. Queda como observación, no como defecto.

---

## 4. Correcciones seguras (FASE 4)

**No se aplicó ninguna corrección de código ni de documentación en esta etapa.**

Motivo: los únicos defectos concretos localizados están en archivos MSSQL
**reservados** (`mssql-integration.test.js` y, si aplica, `helpers-mssql.js`) y no
pueden corregirse sin autorización e integración con el otro equipo. El resto de
hallazgos son de documentación o de prioridad P2, y se evita editarlos para no
generar conflictos con el trabajo MSSQL en curso. No se encontró un defecto real,
de alcance limitado y verificable, corregible sin tocar archivos reservados.

---

## 5. Clasificación de pendientes

- **P0** — Cerrar M5 en la base de validación: aplicar
  `notifications-organization-nullable.sql` (con backup previo y autorización) y
  reejecutar el diagnóstico M5 hasta salir con código 0. Requiere autorización.
- **P1** — Reintegrar desde el equipo de casa la corrección de
  `mssql-integration.test.js` (`IMG_PNG` + `TEST_ADMIN_USER`).
- **P1** — Prueba de instalación desde cero (`ENTREGA-CHECKLIST.md` §7).
- **P2** — Corregir la documentación MSSQL (§3.4): paso `db:migrate`, cifras de
  pruebas y pie de commit.
- **P2** — Parametrizar el proxy de Vite y manejo global de sesión caducada
  (§3.5).
- **P2** — Evaluar si `npm test` debe excluir las suites `mssql-*` (o si las
  suites deben omitirse con limpieza cuando falta el entorno MSSQL).

---

## 6. Backend — tres fallos pendientes de validación MSSQL

`npm test` (glob `test/*.test.js`) recoge también `mssql-*.test.js`. Resultado
observado: **860 pruebas, 3 fallos**. Los tres quedan **pendientes de validación
MSSQL**; no se marcan como solucionados ni se les atribuye causa definitiva. El
detalle y la evidencia están en `docs/M5-REVISION-FINAL.md` (§ *Backend — tres
fallos pendientes de validación MSSQL*). No se ejecutó `npm run test:mssql`
porque requiere `test/setup-mssql.js` y `.env.mssql-test` contra un SQL Server
real, prohibido por el alcance.

---

## 7. Validaciones de esta etapa

- `git status --short`: limpio antes de crear este documento.
- `git diff --check`: sin errores de espacios ni conflictos (comprobado en la
  etapa previa sobre `ec0ae32`).
- No se añadieron credenciales ni secretos a este documento ni al repositorio.
- No se ejecutaron migraciones, seed, operaciones de base de datos, pruebas
  SQLite, ni `git add`, commit, push o cambio de rama.
