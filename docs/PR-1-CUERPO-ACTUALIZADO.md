# PR #1 — Cuerpo actualizado (listo para pegar)

> `gh` no está instalado en este equipo; copiar el contenido de abajo en
> **GitHub → PR #1 → Edit** y guardar. No se ejecutó ningún push ni merge.

---

## Título sugerido

`Integración casa-oficina: certificación MSSQL, corrección de inmutabilidad y preparación final de entrega`

## Cuerpo

### Qué incluye

Integración del trabajo de oficina y casa sobre la rama
`integracion-casa-oficina-11oct` (`847c86e` → `main` `f7cebed`).

- Migración SQLite → SQL Server por fases (grupos B/C/D/E) con scripts
  idempotentes, verificadores de solo lectura y preflight de permisos.
- Certificación de la integración MSSQL **37/37** y Grupo D sobre la base scratch
  `SIFHA_GroupD_ScratchTest` (**POST-D GO / FINAL GO**).
- Endurecimiento de seguridad (tercera ronda): `npm audit` **0 hallazgos** en
  backend y frontend; `Vary: Origin` en CORS; `/api/health` sin `NODE_ENV`.
- CI GitHub Actions (`.github/workflows/ci.yml`): *Backend (SQLite temporal)* y
  *Frontend (vitest + build)*, Node 24, en verde.
- **Correcciones de esta sesión (2026-10-14, tercera tanda):**
  - `POST /api/tickets/:id/assign` esquivaba la inmutabilidad de tickets
    terminales → ahora rechaza con 400 (regresión «I4»).
  - `grant-app-account-minimal.sql` **no compilaba** por un comentario T-SQL
    anidado (`Msg 113`) → corregido, con regresión que escanea
    `scripts/migration/`.
  - `grant-app-account-minimal.sql` producía un **conflicto de collation**
    (`Msg 468`) en la revocación → corregido con `COLLATE DATABASE_DEFAULT`.
  - Nuevo `create-groupE-readonly-account.sql` (cuenta de solo lectura para
    Grupo E); permisos por tabla/operación de mínimo privilegio y revocación
    opt-in (`@revoke_extra`).
- Documentación de entrega e infraestructura actualizada
  (`docs/GRUPO-E-VALIDACION.md` nueva).

### Alcance

- **Publicado en `origin`:** **71 commits**, **208 archivos** (`+34142 / −3100`).
- Base: `main` (`f7cebed`). Head publicado: `integracion-casa-oficina-11oct`
  (`a990bb0`, sincronizado con `origin`; sin commits locales pendientes).
- CI GitHub Actions sobre `a990bb0`: **4/4 success**; `mergeable_state: clean`.

### Verificación

| Prueba | Resultado |
|---|---|
| Backend `npm test` (SQLite) | 906 pruebas: **904 pass, 0 fallos, 2 omitidas**, 150 suites |
| Frontend `vitest run` | **1080/1080** |
| Frontend `vite build` | **OK** |
| `npm audit` backend / frontend | **0 / 0** |
| CI GitHub Actions (`847c86e`) | **success** (`push` y `pull_request`) |

### Estado de la conexión MSSQL y grupos de migración

- **ELOGIN resuelto:** login `sifha_ticket_dev` habilitado y mapeado a
  `SIFHA_Tickets_DEV`; verificado en SSMS y desde Node.js (`mssql@12.2.0`).
- **Grupo D:** certificado en `SIFHA_GroupD_ScratchTest` y **ejecutado/verificado
  en `SIFHA_Tickets_DEV`** (POST-D y FINAL `GO`).
- **Grupo E (arranque en seco):** objetivo **demostrado en base aislada**
  (`SIFHA_Tickets_M5_Validation`: `schemaValidator` ok, `/api/health` 200,
  `/api/auth/me` 401 con `MSSQL_RUNTIME=true` + `JOBS_ENABLED=false`); en
  `SIFHA_Tickets_DEV` queda **pendiente de permisos** (ver
  `docs/GRUPO-E-VALIDACION.md`).
- **M5:** objetivo cumplido (diagnóstico solo lectura `pass`: 24 tablas, 0
  diferencias bloqueantes, 0 notificaciones con organización NULL); `VERIFYONLY`
  del respaldo pendiente de una cuenta con `CREATE DATABASE`.

### Seguridad

- Sin secretos reales versionados (solo `.env.example` y
  `.env.mssql-test.example`, saneados).
- `.gitignore` cubre `.env*`, certificados/claves, respaldos, `dist` y logs.
- Auditoría: sin hallazgos Altos/Medios; 1 defecto Bajo corregido (inmutabilidad
  de `/assign`).
- Recomendado: repositorio **privado** (identificadores internos de infraestructura).

### Pendientes antes de mergear

- **Permisos de la cuenta de aplicación:** `sifha_ticket_dev` solo tiene permisos
  directos sobre 6 tablas y **carece de SELECT en `dbo.tickets`** y el resto del
  esquema. Aplicar el script idempotente por tabla
  `grant-app-account-minimal.sql` (preparado, **no ejecutado** sin autorización).
- **Grupo E:** habilitar la cuenta de solo lectura
  (`create-groupE-readonly-account.sql`) o aplicar los permisos de la app y
  ejecutar el arranque en seco contra `SIFHA_Tickets_DEV`.
- **Verificación M5 en `SIFHA_Tickets_DEV`** (solo lectura) y `VERIFYONLY` del
  respaldo M5 (requiere cuenta con `CREATE DATABASE`).
- **No mergear** hasta cerrar los pendientes de permisos/DEV/M5.

### Documentación de referencia

- `docs/GRUPO-E-VALIDACION.md` — validación de Grupo E.
- `docs/ESTADO-ENTREGA.md` §17–§18 — estado vigente.
- `docs/GUIA-MIGRACION-DEV.md` — guía operativa de migración.
- `docs/PLAN-RECONCILIACION-DEV.md` — plan técnico B→C→D→E.
- `docs/M5-REVISION-FINAL.md`, `docs/INFORME-CIERRE-DESARROLLO-2026-10-13.md`.
- `ENTREGA-FINAL.md`, `ENTREGA-INFRAESTRUCTURA.md`, `ENTREGA-CHECKLIST.md`,
  `M5-PROCEDIMIENTO-WINDOWS.md`.
