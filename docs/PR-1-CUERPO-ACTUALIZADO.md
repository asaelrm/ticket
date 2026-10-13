# PR #1 — Cuerpo actualizado (listo para pegar)

> `gh` no está instalado en este equipo; copiar el contenido de abajo en
> **GitHub → PR #1 → Edit** y guardar. No se ejecutó ningún push ni merge.

---

## Título sugerido

`Integración casa-oficina: certificación MSSQL 37/37 y preparación final de entrega`

## Cuerpo

### Qué incluye

Integración del trabajo de oficina y casa sobre la rama
`integracion-casa-oficina-11oct` (`7723d87` → `main` `f7cebed`).

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

- **56 commits**, **200 archivos** (`+31916 / −3099`).
- Base: `main` (`f7cebed`). Head: `integracion-casa-oficina-11oct` (`7723d87` +
  commits locales de cierre).

### Verificación

| Prueba | Resultado |
|---|---|
| Backend `npm test` (SQLite) | 890 pruebas: **888 pass, 0 fallos, 2 omitidas** |
| Frontend `vitest run` | **1080/1080** |
| Frontend `vite build` | **OK** |
| `npm audit` backend / frontend | **0 / 0** |
| CI GitHub Actions (`7723d87`) | **success** |

### Seguridad

- Sin secretos reales versionados (solo `.env.example`).
- `.gitignore` cubre `.env*`, certificados/claves, respaldos, `dist` y logs.
- Recomendado: repositorio **privado** (identificadores internos de infraestructura).

### Pendientes antes de mergear

- Respaldo verificado y ejecución **autorizada** de B→C→D→E en
  `SIFHA_Tickets_DEV` (ventana de mantenimiento; ver `docs/GUIA-MIGRACION-DEV.md`).
- Verificación M5 en DEV (solo lectura).
- **No mergear** hasta cerrar los pendientes de DEV/M5.

### Documentación de referencia

- `docs/GUIA-MIGRACION-DEV.md` — guía operativa de migración.
- `docs/PLAN-RECONCILIACION-DEV.md` — plan técnico B→C→D→E.
- `docs/ESTADO-ENTREGA.md` §12–§13 — estado vigente.
- `docs/INFORME-CIERRE-DESARROLLO-2026-10-13.md` — informe de cierre.
- `ENTREGA-INFRAESTRUCTURA.md`, `ENTREGA-CHECKLIST.md`, `M5-PROCEDIMIENTO-WINDOWS.md`.
