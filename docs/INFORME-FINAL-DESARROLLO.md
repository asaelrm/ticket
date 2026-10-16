# SIFHA Ticket — Informe final de desarrollo y entrega (continuación)

**Fecha:** 2026-10-13
**Rama:** `integracion-casa-oficina-11oct`
**Punto de reanudación:** `ab1815f` (working tree limpio)
**Documentos de referencia:** `docs/ESTADO-ENTREGA.md`, `docs/SEGURIDAD-AUDITORIA.md`,
`docs/PRUEBAS.md`, `docs/PLAN-RECONCILIACION-DEV.md`.

---

## 1. Contexto de la continuación

La ejecución del prompt maestro se interrumpió por un apagón. La recuperación
confirmó el estado real: último commit `ab1815f`, árbol limpio, y cuatro commits
locales por delante de `origin/integracion-casa-oficina-11oct` (`a4ef5b9`):

| Commit | Tema |
|--------|------|
| `28f29a2` | fix `FILLFACTOR=0` + certificación de Grupo D en el scratch |
| `279f756` | remedia hallazgos de auditoría en backend (fórmulas CSV/XLSX, LIKE, fuga org, reset token, CRLF) |
| `c33367b` | frontend: búsqueda global, sesión caducada, auditoría, a11y, `react-router-dom@7` |
| `ab1815f` | segunda ronda de auditoría y decisiones de dependencias |

No se repitió ninguna tarea ya certificada (Grupo D en `SIFHA_GroupD_ScratchTest`
y la integración MSSQL 37/37). No se tocó ninguna base SQL Server, ni se
ejecutaron migraciones ni pruebas MSSQL con escritura. No hubo push ni merge.

## 2. Fases completadas en esta sesión

| Fase | Estado | Evidencia |
|------|--------|-----------|
| Revisión de los commits nuevos | COMPLETADO | diffs de `279f756`/`c33367b`/`ab1815f` revisados |
| Pruebas locales de validación | COMPLETADO | §3 |
| CI (GitHub Actions) | COMPLETADO | `.github/workflows/ci.yml` |
| Migraciones DEV en modo solo lectura | COMPLETADO | `diagnose-dev-account-readonly.sql` + regresión |
| Documentación | COMPLETADO | cifras e informes alineados (§5) |
| Revisión del PR #1 | COMPLETADO | §6 |
| Corrección de problemas reales | COMPLETADO | cierre del comentario SQL `sys.*/`; cifras obsoletas |
| Commits locales | COMPLETADO | §4 |
| Informe final | COMPLETADO | este documento |

## 3. Pruebas ejecutadas (2026-10-13)

| Suite | Comando | Resultado |
|-------|---------|-----------|
| Backend (SQLite temporal) | `npm test` (en `backend/`) | **890 pruebas, 888 pass, 0 fail, 2 omitidas** (~130 s) |
| Regresión nueva DEV | `node --test test/dev-readonly-scripts.test.js` | **13/13 pass** |
| Frontend | `npx vitest run` (en `frontend/`) | **44 archivos, 1080/1080 pass** (~132 s) |
| Build de producción | `npm run build` (en `frontend/`) | **OK** (`dist/` generado) |
| `npm audit` backend/frontend | `npm audit` | **0 hallazgos** (antes 2 / 6) |
| Integración MSSQL | `npm run test:mssql` | **NO ejecutada** (requiere autorización y escribe) |

El commit de seguridad `279f756` anunciaba 874/872 (con 9 regresiones nuevas);
la continuación añade 13 pruebas (`test/dev-readonly-scripts.test.js`) y la
tercera ronda de seguridad 3 más (`security-regressions.test.js`), de modo que
la suite vigente queda en **890/888**.

## 4. Cambios y commits locales de esta sesión

1. **CI** — `.github/workflows/ci.yml`: jobs `backend` (`npm ci` + `npm test`) y
   `frontend` (`npm ci` + `npx vitest run` + `npm run build`) sobre Node 24;
   disparadores `push`/`pull_request`/`workflow_dispatch`, cancelación de
   ejecuciones obsoletas y permisos mínimos. Era el hueco que dejaba la pestaña
   *Checks* del PR #1 sin contenido.
2. **Preflight DEV solo lectura** —
   `backend/scripts/migration/diagnose-dev-account-readonly.sql`: diagnóstico de
   permisos de la cuenta y veredicto `GO`/`NO-GO` para B→C→D→E, sin `EXEC` ni SQL
   dinámico, con guarda de identidad.
3. **Regresión** — `backend/test/dev-readonly-scripts.test.js`: 13 pruebas que
   exigen guarda de identidad y ausencia de escrituras persistentes en los 6
   scripts DEV de solo lectura.
4. **Documentación** — cifras y pendientes alineados; sección de continuación en
   `docs/ESTADO-ENTREGA.md`; este informe.
5. **Dependencias (tercera ronda)** — `npm audit` a **0 hallazgos**: backend con
   `overrides` a `uuid@11.1.1` (vía `exceljs`, que solo usa `uuid.v4()`); frontend
   con `vite@7.3.7` + `vitest@4.1.11` + `@vitejs/plugin-react@4.7.0` (toolchain
   dev), verificado con 1080/1080 y build OK.
6. **Endurecimiento de respuestas (tercera ronda)** — `res.vary('Origin')` en el
   middleware CORS y `/api/health` deja de exponer `NODE_ENV`; 3 regresiones
   nuevas en `backend/test/security-regressions.test.js`.

## 5. Problemas reales corregidos

- **`*/` accidental que rompía el comentario SQL.** La primera versión de
  `diagnose-dev-account-readonly.sql` contenía `sys.*/funciones`; la secuencia
  `*/` cerraba el comentario `/* ... */` antes de tiempo y el resto del
  encabezado se habría interpretado como SQL inválido. Lo detectó la regresión
  estática nueva. Corregido a `(sys.*), funciones`.
- **2 vulnerabilidades moderadas en backend** (`uuid` transitivo) y **6 en la
  toolchain de frontend** (2 críticas): resueltas sin `--force` (ver §4).
- **CORS sin `Vary: Origin`** y **`/api/health` exponiendo `NODE_ENV`**:
  corregidos con regresión estática/HTTP.
- **Cifras de pruebas obsoletas** (865/863) en README, `ENTREGA-CHECKLIST`,
  `ENTREGA-INFRAESTRUCTURA`, `docs/DEPLOY-MSSQL`, `docs/ENTREGA-FINAL` y
  `docs/PRUEBAS`, ahora 890/888.
- **Pendiente ya resuelto marcado como abierto:** el P2 «sesión caducada» del
  `ENTREGA-CHECKLIST` ya lo corrigió `c33367b`; la integración MSSQL figuraba
  como PENDIENTE en `docs/PRUEBAS.md` cuando está certificada 37/37.

## 6. Revisión del PR #1

- **Título:** «Integracion casa-oficina: certificacion MSSQL 37/37 y preparacion
  final de entrega».
- **Estado:** abierto, `integracion-casa-oficina-11oct` → `main`, 44 commits, 1
  participante, **sin revisiones** y **sin checks**.
- **Contenido:** README del PR correcto en lo funcional; sin secretos; alcance
  acotado a test MSSQL + documentación en el momento de su creación.
- **Desajustes:** el cuerpo cita 4 archivos y 863 pass y no refleja los 4 commits
  locales posteriores. `gh` no está instalado, así que actualizar el cuerpo y
  recabar checks requiere acción manual tras el push.
- **Recomendación:** no mergear hasta cerrar los pendientes de certificación
  DEV/M5, y dejar que el CI nuevo ejecute backend+frontend al publicar.

## 7. Pendientes reales

- **Requieren autorización** (fuera del alcance local): `push` de los commits;
  secuencia B→C→D→E y M5 sobre `SIFHA_Tickets_DEV` con cuenta privilegiada,
  respaldo verificado y ventana; `VERIFYONLY` del respaldo M5.
- **Mejora no bloqueante:** ESLint + script `lint`.

## 8. Restricciones respetadas

- No se modificó ninguna base SQL Server; no se ejecutaron migraciones ni pruebas
  MSSQL con escritura; no se repitió el Grupo D ya certificado; no se descartó
  trabajo; no hubo push ni merge.
- `npm test` siguió usando su base temporal aislada; el frontend no tocó datos.
- No se usó `npm audit fix --force`; los saltos de versión mayor se validaron con
  las suites completas y la build antes de fijarlos.

**Conclusión:** el código y la documentación quedan listos para publicación. El
CI y el preflight DEV de solo lectura cierran los huecos de proceso; la
certificación sobre `SIFHA_Tickets_DEV` sigue pendiente de una ventana
autorizada.
