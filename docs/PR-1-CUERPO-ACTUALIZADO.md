# PR #1 — Cuerpo actualizado (listo para pegar)

> `gh` no está instalado en este equipo; copiar el contenido de abajo en
> **GitHub → PR #1 → Edit** y guardar. No se ejecutó ningún push ni merge.

---

## Título sugerido

`Integración casa-oficina: certificación MSSQL 37/37 y preparación final de entrega`

## Cuerpo

### Qué incluye

Integración del trabajo de oficina y casa sobre la rama
`integracion-casa-oficina-11oct` (`21cf9cc` → `main` `f7cebed`).

- Migración SQLite → SQL Server por fases (grupos B/C/D/E) con scripts
  idempotentes, verificadores de solo lectura y preflight de permisos.
- Certificación de la integración MSSQL **37/37** y Grupo D sobre la base scratch
  `SIFHA_GroupD_ScratchTest` (**POST-D GO / FINAL GO**).
- Endurecimiento de seguridad (tercera ronda): `npm audit` **0 hallazgos** en
  backend y frontend; `Vary: Origin` en CORS; `/api/health` sin `NODE_ENV`.
- CI GitHub Actions nuevo (`.github/workflows/ci.yml`): jobs *Backend (SQLite
  temporal)* y *Frontend (vitest + build)*, Node 24, en verde.
- Documentación de entrega e infraestructura actualizada.

### Alcance

- **64 commits**, **204 archivos** (`+33002 / −3100`).
- Base: `main` (`f7cebed`). Head: `integracion-casa-oficina-11oct` (`21cf9cc`,
  sincronizado con `origin`).

### Verificación

| Prueba | Resultado |
|---|---|
| Backend `npm test` (SQLite) | 895 pruebas: **893 pass, 0 fallos, 2 omitidas** |
| Frontend `vitest run` | **1080/1080** |
| Frontend `vite build` | **OK** |
| `npm audit` backend / frontend | **0 / 0** |
| CI GitHub Actions (`21cf9cc`) | **success** |

### Estado de la conexión MSSQL y grupos de migración

- **ELOGIN resuelto:** autenticación SQL corregida por rotación autorizada de
  contraseña; login `sifha_ticket_dev` habilitado y mapeado a `SIFHA_Tickets_DEV`.
  Verificado en SSMS y desde Node.js con `mssql@12.2.0` (probe `SELECT` de
  identidad: **PASS** — `TI-DESK-01\SIFHADEV` / `SIFHA_Tickets_DEV` /
  `sifha_ticket_dev`).
- **Grupo D:** certificado en `SIFHA_GroupD_ScratchTest` y **ejecutado/verificado
  en `SIFHA_Tickets_DEV`** (POST-D y FINAL `GO`).
- **Grupo E (arranque en seco):** pendiente de cuenta de solo lectura verificable;
  ver `docs/ESTADO-ENTREGA.md` §17 (hallazgos de no-escritura).
- **M5:** objetivo cumplido en `SIFHA_Tickets_M5_Validation` (solo lectura);
  verificación del respaldo pendiente de cuenta con `CREATE DATABASE`.

### Seguridad

- Sin secretos reales versionados (solo `.env.example`).
- `.gitignore` cubre `.env*`, certificados/claves, respaldos, `dist` y logs.
- Recomendado: repositorio **privado** (identificadores internos de infraestructura).

### Pendientes antes de mergear

- **Permisos de la cuenta de aplicación:** `sifha_ticket_dev` solo tiene permisos
  directos sobre 6 tablas y **carece de SELECT en `dbo.tickets`** y en el resto del
  esquema. Corregir con un script idempotente de mínimo privilegio (preparado, no
  ejecutado sin autorización).
- **Grupo E (arranque en seco de solo lectura):** ejecutar con `MSSQL_RUNTIME=true`
  y `JOBS_ENABLED=false` una vez exista cuenta de solo lectura; ver los hallazgos de
  no-escritura en `docs/ESTADO-ENTREGA.md` §17.
- **Verificación M5 en `SIFHA_Tickets_DEV`** (solo lectura) y `VERIFYONLY` del
  respaldo M5 (requiere cuenta con `CREATE DATABASE`).
- **No mergear** hasta cerrar los pendientes de permisos/DEV/M5.

### Documentación de referencia

- `docs/GUIA-MIGRACION-DEV.md` — guía operativa de migración.
- `docs/PLAN-RECONCILIACION-DEV.md` — plan técnico B→C→D→E.
- `docs/ESTADO-ENTREGA.md` §12–§13 — estado vigente.
- `docs/INFORME-CIERRE-DESARROLLO-2026-10-13.md` — informe de cierre.
- `ENTREGA-INFRAESTRUCTURA.md`, `ENTREGA-CHECKLIST.md`, `M5-PROCEDIMIENTO-WINDOWS.md`.
