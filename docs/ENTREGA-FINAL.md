# Entrega final — SIFHA Ticket

Documento de cierre para la entrega institucional. Complementa a
`ENTREGA-CHECKLIST.md`, `ENTREGA-INFRAESTRUCTURA.md`, `docs/ESTADO-ENTREGA.md`
(seguimiento por tarea) y `docs/INFORME-FINAL-ENTREGA.md` (fase previa).

## 1. Estado general

- **Rama:** `integracion-casa-oficina-11oct`.
- Backend Express + SQLite (con motor MSSQL opcional y no activo por defecto).
- Frontend React/Vite/Tailwind.
- Base de desarrollo: SIFHA_Tickets_DEV (SQL Server 2022). Base aislada de
  pruebas SQL: `SIFHA_GroupD_ScratchTest`.

## 2. Veredicto

| Área | Estado |
|------|--------|
| Código de funcionalidades críticas | **LISTO** |
| Errores bloqueantes conocidos | **0**; 2 defectos reales corregidos con regresión (`/assign` terminal; comentario SQL anidado) |
| `npm test` (backend SQLite) | 906 pruebas, 904 pass, 0 fallos, 2 omitidas, 150 suites |
| `npm run test:mssql` (integración MSSQL) | **37/37 pass** contra `SIFHA_Tickets_M5_Integration_Test` (no re-ejecutada: escribe; requiere autorización) |
| Frontend (vitest + build) | 1080/1080; build OK |
| Migraciones Grupo D | **CERTIFICADO** en `SIFHA_GroupD_ScratchTest` (2026-10-13: POST-D GO / FINAL GO) y **ejecutado/verificado en `SIFHA_Tickets_DEV`** |
| Grupo E (arranque en seco) | **DEMOSTRADO en base aislada** (`M5_Validation`) con `MSSQL_RUNTIME=true`+`JOBS_ENABLED=false`; en `SIFHA_Tickets_DEV` **pendiente de permisos autorizados** |
| M5 | **Objetivo cumplido** (diagnóstico solo lectura `pass`, 24 tablas, 0 diferencias); `VERIFYONLY` del respaldo pendiente de cuenta con `CREATE DATABASE` |
| Documentación | Completa (README + `docs/` + `docs/GRUPO-E-VALIDACION.md`) |
| Seguridad crítica | Sin hallazgos Altos; 1 defecto Bajo corregido |

**Veredicto final: LISTO PARA ENTREGA DEL CÓDIGO**, con dos cierres operativos
**pendientes de intervención autorizada del responsable** (no bloquean el artefacto
de código): (a) aplicar permisos de la cuenta de aplicación o habilitar la cuenta
de solo lectura para cerrar Grupo E en `SIFHA_Tickets_DEV`; (b) cuenta con
`CREATE DATABASE` para el `VERIFYONLY` del respaldo M5. Ver
`docs/ESTADO-ENTREGA.md` §18 y `docs/GRUPO-E-VALIDACION.md`.

## 3. Qué se entregó en esta fase

1. **Corrección del bloqueo SQL del Grupo D** (falso positivo `ROWS_FILEGROUP`)
   en `apply-groupD-not-null*.sql` y `diagnose-groupD-unique-blocker.sql`.
2. **Suite de pruebas saneada**: integración MSSQL movida a
   `backend/test/mssql/`; `npm test` termina sin falsos fallos; `npm run
   test:mssql` las sigue ejecutando contra la base autorizada.
3. **Limpieza de secretos**: `.env.mssql-test.example` sin servidor/usuario
   reales. Confirmado que ningún `.env`/certificado está versionado.
4. **Documentación**: `docs/ESTADO-ENTREGA.md`, `INSTALACION.md`,
   `CONFIGURACION.md`, `BASE-DE-DATOS.md`, `PRUEBAS.md`, `SEGURIDAD.md`,
   `ENTREGA-FINAL.md`; README/checklists/cifras actualizados.
5. **Commits publicados** hasta `21cf9cc` (rama `integracion-casa-oficina-11oct`
   sincronizada con `origin`, árbol limpio). CI de GitHub Actions en verde y
   PR #1 limpio (`mergeable: clean`; 64 commits, 204 archivos, `+33002/−3100`).
   Ver `docs/ESTADO-ENTREGA.md` §17.
6. **Certificación MSSQL**: `npm run test:mssql` **37/37** contra
   `SIFHA_Tickets_M5_Integration_Test`; aserciones alineadas al modelo
   multiempresa (claves globales solo SUPERADMIN; permisos anidados por rol).
7. **Grupo D certificado en el scratch (2026-10-13)**: `GRUPO D: GO`,
   `VERIFICADOR POST-D: GO` y `VERIFICADOR FINAL: GO` sobre
   `SIFHA_GroupD_ScratchTest` ejecutado con cuenta privilegiada; incluye el fix
   `FILLFACTOR=0` en `apply-groupD-not-null*.sql` y la evidencia documentada en
   `docs/ESTADO-ENTREGA.md` §5.4.
8. **ELOGIN resuelto (2026-10-14)**: autenticación SQL corregida por rotación
   autorizada; verificado en SSMS y desde Node.js (`mssql@12.2.0`, probe `SELECT`
   identidad **PASS**). Grupo D **ejecutado y verificado en `SIFHA_Tickets_DEV`**
   (POST-D y FINAL `GO`, §14). Ver `docs/ESTADO-ENTREGA.md` §17.
9. **Script de permisos de mínimo privilegio (preparado, no ejecutado)**:
   `backend/scripts/migration/grant-app-account-minimal.sql` (idempotente, con
   guarda DEV; permisos **por tabla y operación** según el uso real del backend;
   **sin** `db_datareader`/`db_datawriter`, sin `db_owner`/`db_ddladmin`), con
   regresión estática `backend/test/dev-permissions-scripts.test.js`. Corrige el
   hallazgo de que la cuenta `sifha_ticket_dev` carece de `SELECT` en `tickets` y
   el resto del esquema.
10. **Cierre autónomo (2026-10-14, tercera tanda)**: dos **defectos reales**
    corregidos con regresión — (a) el script de permisos **no compilaba** por un
    comentario T-SQL anidado (`Msg 113`), ahora compila y tiene regresión que
    escanea todo `scripts/migration/`; (b) `POST /api/tickets/:id/assign`
    esquivaba la inmutabilidad de tickets terminales, ahora rechaza con 400
    (regresión «I4»). Además: Grupo E demostrado en base aislada
    (`docs/GRUPO-E-VALIDACION.md`), diagnóstico M5 `pass` (24 tablas, 0
    diferencias), pruebas backend 906/904/0/2 y frontend 1080/1080, `npm audit`
    0/0. Sin push ni merge.

## 4. Pendientes que requieren intervención del responsable

| # | Pendiente | Prioridad |
|---|-----------|-----------|
| 1 | ~~Ejecutar Grupo D sobre `SIFHA_GroupD_ScratchTest`~~ **COMPLETADO** (2026-10-13: POST-D GO / FINAL GO; `docs/ESTADO-ENTREGA.md` §5.4) | P0 |
| 2 | ~~Secuencia B→C→D→E en `SIFHA_Tickets_DEV`~~ **Grupo D ya ejecutado/verificado en DEV** (2026-10-13, §14); **Grupo E**: objetivo demostrado en base aislada, cierre en DEV pendiente de permisos (ver `docs/GRUPO-E-VALIDACION.md`) | P0 |
| 3 | **Permisos de la cuenta `sifha_ticket_dev`**: preparar/ejecutar el script idempotente por tabla `grant-app-account-minimal.sql` (no ejecutado; requiere autorización) | P0 |
| 4 | Certificar **M5 en `SIFHA_Tickets_DEV`** (solo lectura) y `VERIFYONLY` del respaldo M5 (cuenta con `CREATE DATABASE`); en `M5_Validation` el objetivo está cumplido (diagnóstico `pass`) y en DEV el objetivo M5 ya se leyó | P1 |
| 5 | Re-ejecutar `npm run test:mssql` solo bajo nueva autorización (la suite escribe datos) | P1 |
| 6 | Prueba de instalación desde cero (`ENTREGA-CHECKLIST.md` §7) | P1 |
| 7 | ~~Push a GitHub~~ **COMPLETADO** (`origin` en `21cf9cc`; CI en verde) | — |

## 5. Referencias

- Código: `backend/`, `frontend/`.
- Migraciones: `backend/scripts/migration/`.
- Pruebas: `docs/PRUEBAS.md`, `ENTREGA-CHECKLIST.md`.
- Grupo E: `docs/GRUPO-E-VALIDACION.md`.
- Seguridad: `docs/SEGURIDAD.md`, `docs/SEGURIDAD-AUDITORIA.md`.
- Infraestructura: `ENTREGA-INFRAESTRUCTURA.md`.
