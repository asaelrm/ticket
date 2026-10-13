# Auditoría final de seguridad y preparación para GitHub

**Fecha:** 2026-10-13
**Rama:** `integracion-casa-oficina-11oct`
**Base publicada:** `origin/integracion-casa-oficina-11oct` = `a4ef5b9`
**Punto de partida de esta auditoría:** `9ef0105` (árbol limpio)
**Commits nuevos (locales, sin push):** `938feb0`, `62a934c`, `61de202`
**Referencias:** `docs/SEGURIDAD-AUDITORIA.md` (tercera ronda), `docs/ESTADO-ENTREGA.md` §10.5, `docs/INFORME-FINAL-DESARROLLO.md`.

---

## Veredicto

> **LISTO PARA PUSH.** No quedan vulnerabilidades abiertas en dependencias ni
> hallazgos de seguridad corregibles sin romper el proyecto. Persiste un riesgo
> residual **documentado y no bloqueante** (identificadores de infraestructura
> interna y exposición histórica de credenciales demo).

El push de los 10 commits locales **no se ha ejecutado** (requiere autorización
expresa). Comando propuesto:

```bash
git push origin integracion-casa-oficina-11oct
```

---

## Resumen por fases

| Fase | Contenido | Estado | Evidencia |
|------|-----------|--------|-----------|
| 1 | Estado Git | COMPLETADO | árbol limpio, 7 commits locales al inicio, `git diff --check` limpio |
| 2 | Dependencias (`npm audit`) | COMPLETADO | backend 0 / frontend 0 (antes 2 / 6) |
| 3 | Seguridad backend | COMPLETADO | `Vary: Origin`, `/api/health` sin `env`, +3 regresiones |
| 4 | Seguridad frontend | COMPLETADO | sin hallazgos nuevos; XSS/sesión verificados |
| 5 | Repo público / secretos | COMPLETADO | sin secretos reales; riesgo residual documentado |
| 6 | Validación CI | COMPLETADO | `.github/workflows/ci.yml` (YAML válido, permisos mínimos) |
| 7 | Pruebas completas | COMPLETADO | backend 890/888/0/2; frontend 1080/1080; build OK; audit 0 |
| 8 | Documentación | COMPLETADO | cifras y estado de dependencias alineados |
| 9 | Commits locales | COMPLETADO | 3 commits atómicos (`938feb0`, `62a934c`, `61de202`) |
| 10 | Veredicto | COMPLETADO | este documento |

---

## Vulnerabilidades de dependencias

| Ámbito | Antes | Después | Cómo |
|--------|-------|---------|------|
| Backend producción | 2 moderadas (`uuid` vía `exceljs`) | **0** | `overrides: { "uuid": "^11.1.1" }`; `exceljs` solo usa `uuid.v4()` |
| Frontend producción | resuelta antes (`react-router-dom@7`) | **0** | `c33367b` |
| Frontend toolchain dev | 6 (2 críticas: `tinypool`, `vitest`) | **0** | `vite@7.3.7`, `vitest@4.1.11`, `@vitejs/plugin-react@4.7.0` |

No se utilizó `npm audit fix --force`. Todos los saltos de versión mayor se
validaron con las suites completas y el build antes de fijarlos.

## Endurecimiento aplicado

- **CORS:** `res.vary('Origin')` cuando la petición trae `Origin` (evita
  envenenamiento de caché entre orígenes detrás de proxy/CDN).
- **`/api/health`:** deja de exponer `NODE_ENV`; respuesta `{ ok, time }`.
- **3 regresiones** nuevas en `backend/test/security-regressions.test.js`.

## Secretos e infraestructura

- **Sin secretos reales versionados:** patrones de credenciales (`sk-`, `ghp_`,
  `AKIA`, `BEGIN PRIVATE KEY`, `AccountKey`, `SAS`, contraseñas) no aparecen con
  valores reales; solo marcadores, fixtures de test y ejemplos de documentación.
- **`.gitignore`** cubre `.env*`, certificados/claves, respaldos, `dist` y logs.
- **Riesgo residual (no corregible sin romper el proyecto):**
  - Identificadores de infraestructura interna (`100.100.4.60` — CGNAT de
    Tailscale, no enrutable desde Internet; `TI-DESK-01\SIFHADEV`; `tickets.lan`)
    usados como **guardas de identidad** en scripts de migración y exigidos por
    pruebas de regresión. Recomendación: mantener el repo **privado**.
  - Exposición **histórica** de credenciales demo (documentada en la primera
    ronda); el `.example` actual está saneado. No se reescribió historial (por
    restricción expresa).
- **Duplicados de trabajo** versionados
  (`reconcile-dev-draft-corregido*.sql`): se dejan intactos; recomendada limpieza
  aparte.

## Estado de publicación

- **Commits locales pendientes:** 10 (incluidos los 3 nuevos de esta auditoría).
- **Árbol de trabajo:** limpio.
- **PR #1:** abierto (`integracion-casa-oficina-11oct` → `main`); `gh` no está
  instalado, por lo que actualizar cuerpo/checks requiere acción manual tras el
  push. El CI nuevo generará checks.
- **Pendientes que requieren autorización:** push; secuencia B→C→D→E y M5 sobre
  `SIFHA_Tickets_DEV`; `VERIFYONLY` del respaldo M5.

## Tras el push (acciones del responsable)

1. Verificar en GitHub que el workflow `CI` ejecuta *backend* y *frontend* en verde.
2. Actualizar el cuerpo del PR #1 (cifras 890/888 y 1080/1080; alcance de los 3
   commits nuevos).
3. Rotar las credenciales demo históricas si el host de pruebas fuera accesible.
4. Decidir visibilidad del repositorio (privado recomendado) y limpieza de
   duplicados de borrador.
