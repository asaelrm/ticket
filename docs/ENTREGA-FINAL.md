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
| Errores bloqueantes conocidos | **0**; integración MSSQL certificada 37/37 (2026-10-12) |
| `npm test` (backend SQLite) | 895 pruebas, 893 pass, 0 fallos, 2 omitidas |
| `npm run test:mssql` (integración MSSQL) | **37/37 pass** contra `SIFHA_Tickets_M5_Integration_Test` |
| Frontend (vitest + build) | 1080/1080; build OK |
| Migraciones Grupo D | **CERTIFICADO** en `SIFHA_GroupD_ScratchTest` (2026-10-13: POST-D GO / FINAL GO); `SIFHA_Tickets_DEV` **NO** migrada ni certificada |
| Grupo E y M5 en DEV | **NO-GO/PARCIAL**: transporte SQL alcanzable, pero el login local fue rechazado; faltan credenciales autorizadas de solo lectura para completar las consultas |
| Documentación | Completa (README + `docs/`) |
| Seguridad crítica | Sin hallazgos Altos |

**Veredicto final: LISTO PARA ENTREGA DEL CÓDIGO**, con el cierre operativo de
Grupo E en `SIFHA_Tickets_DEV` pendiente de corregir/confirmar permisos de la
cuenta de aplicación (no bloquea el artefacto de código; ELOGIN está resuelto y
el Grupo D ya está certificado tanto en el scratch como en DEV). Ver
`docs/ESTADO-ENTREGA.md` §17.

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
   guarda DEV; solo `db_datareader` + `db_datawriter`), con regresión estática
   `backend/test/dev-permissions-scripts.test.js`. Corrige el hallazgo de que la
   cuenta `sifha_ticket_dev` carece de `SELECT` en `tickets` y el resto del
   esquema.

## 4. Pendientes que requieren intervención del responsable

| # | Pendiente | Prioridad |
|---|-----------|-----------|
| 1 | ~~Ejecutar Grupo D sobre `SIFHA_GroupD_ScratchTest`~~ **COMPLETADO** (2026-10-13: POST-D GO / FINAL GO; `docs/ESTADO-ENTREGA.md` §5.4) | P0 |
| 2 | ~~Secuencia B→C→D→E en `SIFHA_Tickets_DEV`~~ **Grupo D ya ejecutado/verificado en DEV** (2026-10-13, §14); queda Grupo E (arranque en seco) | P0 |
| 3 | **Permisos de la cuenta `sifha_ticket_dev`**: sin `SELECT` en `tickets` ni el resto del esquema (solo 6 tablas con permisos directos). Preparar/ejecutar script idempotente de mínimo privilegio (no ejecutado) | P0 |
| 4 | Certificar **M5 en `SIFHA_Tickets_DEV`** (solo lectura) y `VERIFYONLY` del respaldo M5 (cuenta con `CREATE DATABASE`); en `M5_Validation` el objetivo está cumplido | P1 |
| 5 | Re-ejecutar `npm run test:mssql` solo bajo nueva autorización (la suite escribe datos) | P1 |
| 6 | Prueba de instalación desde cero (`ENTREGA-CHECKLIST.md` §7) | P1 |
| 7 | ~~Push a GitHub~~ **COMPLETADO** (`origin` en `21cf9cc`; CI en verde) | — |

## 5. Referencias

- Código: `backend/`, `frontend/`.
- Migraciones: `backend/scripts/migration/`.
- Pruebas: `docs/PRUEBAS.md`, `ENTREGA-CHECKLIST.md`.
- Seguridad: `docs/SEGURIDAD.md`, `docs/SEGURIDAD-AUDITORIA.md`.
- Infraestructura: `ENTREGA-INFRAESTRUCTURA.md`.
