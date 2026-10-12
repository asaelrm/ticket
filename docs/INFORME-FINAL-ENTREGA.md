# SIFHA Ticket — Informe final de entrega

**Fecha:** 2026-10-12
**Rama:** `integracion-casa-oficina-11oct` (sincronizada con `origin`, sin commits por delante ni por detrás)
**Commit base:** `784cdc1 chore: proteger configuraciones privadas MSSQL`
**Alcance:** grupo D (endurecimiento NOT NULL), verificación final de la reconciliación,
pruebas, auditoría de seguridad, documentación y preparación de commits.
**Restricciones respetadas:** no se ejecutó SQL contra la base real, no se activó
`MSSQL_RUNTIME`, no se arrancó el backend contra SQL Server, no se modificó
`SIFHA_Tickets_DEV`, no se hizo commit/push ni cambio de rama.

---

## 1. Alcance y restricciones respetadas

Toda la actividad fue **estática y local**: escritura/revisión de scripts, pruebas
aisladas sobre SQLite y vitest, compilación del frontend y auditoría de seguridad.
No se ejecutó DDL ni DML contra `SIFHA_Tickets_DEV`, no se activó el runtime MSSQL,
no se restauraron respaldos y no se tocó Git (fuera de lecturas). No se inventaron
resultados: cada cifra proviene de una ejecución local o de una revisión de solo
lectura.

## 2. Entregables creados/actualizados

| Archivo | Tipo | Estado |
|---|---|---|
| `backend/scripts/migration/apply-groupD-not-null.sql` | Script DDL (Grupo D) | Nuevo |
| `backend/scripts/migration/verify-after-groupD.sql` | Verificador solo lectura | Nuevo |
| `backend/scripts/migration/verify-final-reconciliation.sql` | Verificador solo lectura | Mejorado (ADMIN + roles/permisos) |
| `docs/PLAN-RECONCILIACION-DEV.md` | Plan técnico | Actualizado (§11, §17.5, §18, §20) |
| `docs/SEGURIDAD-AUDITORIA.md` | Informe de seguridad | Nuevo |
| `docs/INFORME-FINAL-ENTREGA.md` | Informe de entrega | Nuevo (este documento) |

## 3. Grupo D — `apply-groupD-not-null.sql`

Convierte **únicamente** `dbo.departments.organization_id` a `INT NOT NULL`
(paridad con `backend/src/db/mssql/schema.sql`). No modifica el tipo, no borra
datos, no elimina/deshabilita restricciones y **no** toca `users.organization_id`
(que sigue NULL-able, como el canónico).

- Doble interruptor de autorización `@AuthorizeDdl` / `@BackupVerified` (ambos en `0`).
- Guarda de identidad (servidor `TI-DESK-01\SIFHADEV`, instancia `SIFHADEV`, base `SIFHA_Tickets_DEV`).
- Prechequeos: 24 tablas; `UQ_departments_organization_id`; FK que referencian
  `departments(organization_id, id)`; estadísticas manuales/columnas calculadas que
  bloquearían el `ALTER`; 97 registros; CMUCE única; 25 depts sin NULL ni ajenos;
  `users` sin NULL; tipo `INT`.
- **Transacción única** con `TRY/CATCH` + `XACT_ABORT ON`, revalidación interna con
  `UPDLOCK/HOLDLOCK`, verificación de nulabilidad **antes del `COMMIT`**.
- **Idempotente**: si ya es NOT NULL, omite el `ALTER` e informa.
- No usa `DROP/TRUNCATE/DELETE/NOCHECK`; no hay reversión automática post-COMMIT.
- Resumen propio `GRUPO D: GO` / `NO-GO`.

## 4. Grupo D — `verify-after-groupD.sql`

Verificador **100 % solo lectura** (sin `CREATE/ALTER/DROP/INSERT/UPDATE/DELETE`).
Comprueba y resume: 24/24 tablas; total 97 registros; CMUCE única (id resuelto);
25 departamentos, 0 NULL, 0 ajenos; `departments.organization_id` `INT NOT NULL`;
`users.organization_id` NULL-able; `UQ_departments_organization_id`; FK nucleares
habilitadas y confiables; `IX_*`; 0 huérfanos. Cierra con
`VERIFICADOR POST-D: GO` / `NO-GO`.

## 5. Verificador final mejorado

`verify-final-reconciliation.sql` (solo lectura) incorpora ahora la **sección [11]**:

- Rol `code = ADMIN` único (esperado `id = 7`), con permisos asignados.
- Usuario `id = 4` con `role_id = 7`, `department_id = 68` y `organization_id = CMUCE`.
- Conservación de roles/permisos verificada de forma agregada en [2]
  (roles=3, permissions=24, role_permissions=41) y sin huérfanos en [9].

El resumen pasa a `[12]` y el `GO` exige también los tres chequeos ADMIN. La
salida sigue siendo `VERIFICADOR FINAL: GO` / `NO-GO`.

## 6. Validación estática de los scripts SQL

- `apply-groupD`: 0 caracteres no-ASCII; sin `DROP/TRUNCATE/DELETE/NOCHECK`
  reales (solo en comentarios); estructura `BEGIN/END` coherente; 1 `BEGIN TRY` /
  1 `BEGIN CATCH`; 1 `BEGIN TRANSACTION`; `ALTER COLUMN` referido solo a la columna diana.
- `verify-after-groupD` y `verify-final-reconciliation`: 0 no-ASCII; **sin
  sentencias de escritura** (verificado por búsqueda de patrones).

## 7. Pruebas backend

- Comando: `npm test` (setup SQLite aislado en directorio temporal; no toca la base real).
- Resultado: **860 pruebas, 855 aprobadas, 3 fallidas, 2 omitidas**.
- Los 3 fallos son las suites de integración MSSQL reales
  (`mssql-integration.test.js`, `mssql-jobs.test.js`, `mssql-reports-dashboard.test.js`)
  que requieren `MSSQL_TEST_SERVER`/`MSSQL_TEST_*` y una instancia autorizada:
  **PENDIENTES** (no bloquean el artefacto; requieren entorno MSSQL desechable).

## 8. Pruebas frontend

- Comando: `npm test -- --run` (vitest) en `frontend/`.
- Resultado: **44 archivos, 1080 pruebas aprobadas, 0 fallidas** (~109 s).

## 9. Build de producción

- Comando: `vite build` en `frontend/`.
- Resultado: **OK**, 138 módulos, `dist/` generado.

## 10. Lint / typecheck

- **No existe script de `lint` ni configuración ESLint/Prettier** en la raíz,
  `backend/` ni `frontend/` (`package.json` solo declara `dev/build/test/start`).
  No se ejecutó lint por no estar configurado; el typecheck no aplica (proyecto JS).
  Recomendación de mejora (no bloqueante): añadir ESLint + script `lint`.

## 11. Auditoría de seguridad

Informe completo en `docs/SEGURIDAD-AUDITORIA.md`. Resumen:

| Severidad | N.º |
|---|---|
| Alta | 0 |
| Media | 3 |
| Baja | 7 |
| Informativo | 2 |
| **Total** | **12** |

- **3 Media** (endurecimiento de configuración/despliegue, sin bloqueantes):
  1. Credenciales de prueba versionadas en `backend/.env.mssql-test.example`.
  2. `SESSION_SECRET` por defecto fuera de `production` (`backend/src/config.js`).
  3. Token de reseteo devuelto en HTTP fuera de `production` (`backend/src/routes/auth.js`).
- **0 Alta**, sin inyección SQL (parametrización uniforme y listas blancas),
  aislamiento multi-tenant resuelto en servidor, bcrypt coste 12, Helmet/CSP,
  validación de adjuntos por magic bytes y errores 5xx sin traza.
- **Conclusión: APTO**, sin bloqueantes; los Media se corrigen antes de exponer la instancia.

## 12. Documentación de entrega

- `docs/PLAN-RECONCILIACION-DEV.md`: §11 registra los scripts nuevos del Grupo D
  y el refuerzo del verificador final; §17.5 describe la ruta independiente D +
  su verificador; §18 y §20 incluyen D y D1 con la alternativa autocontenida.
- `docs/SEGURIDAD-AUDITORIA.md`: informe de auditoría (12 hallazgos).
- Este informe (`docs/INFORME-FINAL-ENTREGA.md`).

## 13. Estado Git y propuesta de commits (sin ejecutar)

Rama `integracion-casa-oficina-11oct` en `784cdc1`. Archivos **sin rastrear**:

```text
?? backend/scripts/migration/apply-groupD-not-null.sql
?? backend/scripts/migration/backfill-organization-CMUCE.sql
?? backend/scripts/migration/fix-users-department-same-org.sql
?? backend/scripts/migration/reconcile-dev-draft.sql
?? backend/scripts/migration/reconcile-dev-inventory.sql
?? backend/scripts/migration/verify-after-groupB.sql
?? backend/scripts/migration/verify-after-groupC.sql
?? backend/scripts/migration/verify-after-groupD.sql
?? backend/scripts/migration/verify-final-reconciliation.sql
?? docs/PLAN-RECONCILIACION-DEV.md
?? docs/SEGURIDAD-AUDITORIA.md
?? docs/INFORME-FINAL-ENTREGA.md
```

(Además, `reconcile-dev-draft-corregido (1).sql` y `reconcile-dev-draft-corregido-v2.sql`
son duplicados históricos: **no commitear**.)

**Propuesta de commits** (atómicos, agrupados por tema — **no se ejecutó ninguno**):

```text
1) chore(migracion): scripts de reconciliacion y verificadores de solo lectura
   backend/scripts/migration/reconcile-dev-inventory.sql
   backend/scripts/migration/reconcile-dev-draft.sql
   backend/scripts/migration/verify-after-groupB.sql
   backend/scripts/migration/verify-after-groupC.sql
   backend/scripts/migration/verify-final-reconciliation.sql

2) feat(migracion): backfill CMUCE y fix de FK compuesta (grupo C)
   backend/scripts/migration/backfill-organization-CMUCE.sql
   backend/scripts/migration/fix-users-department-same-org.sql

3) feat(migracion): grupo D (departments.organization_id NOT NULL) y verificador post-D
   backend/scripts/migration/apply-groupD-not-null.sql
   backend/scripts/migration/verify-after-groupD.sql

4) docs(entrega): plan de reconciliacion, auditoria de seguridad e informe final
   docs/PLAN-RECONCILIACION-DEV.md
   docs/SEGURIDAD-AUDITORIA.md
   docs/INFORME-FINAL-ENTREGA.md
```

## 14. Riesgos y pendientes

- **P0 (operativo, requiere autorización):** ejecutar B → C → D → E en `SIFHA_Tickets_DEV`
  con respaldo verificado y backend detenido, siguiendo `docs/PLAN-RECONCILIACION-DEV.md`.
  Nada se ha ejecutado todavía.
- **P1:** cerrar los 3 fallos de integración MSSQL en un entorno autorizado
  (`npm run test:mssql` contra `SIFHA_Tickets_M5_Integration_Test`).
- **P1:** corregir los 3 hallazgos Medios de seguridad antes de exponer la instancia.
- **P2:** añadir lint (ESLint) y `npm audit fix` en backend y frontend.
- **P2:** no commitear `reconcile-dev-draft-corregido*.sql` (duplicados históricos).

---

## Veredictos

| # | Área | Veredicto |
|---|---|---|
| 1 | Grupo D — scripts (`apply-groupD-not-null.sql`, `verify-after-groupD.sql`) | **APTO** |
| 2 | Verificación de reconciliación (verificador final + verificadores por fase) | **APTO** (diseño y validación estática); **PENDIENTE** de ejecución real en DEV |
| 3 | Pruebas backend | **APTO** en SQLite local; **PENDIENTE** las 3 suites de integración MSSQL |
| 4 | Pruebas frontend | **APTO** (1080/1080) |
| 5 | Auditoría de seguridad | **APTO** (0 Alta; 3 Medios de endurecimiento, sin bloqueantes) |

**Conclusión general:** el código y la documentación están **listos para revisión y
subida a GitHub**. La certificación sobre SQL Server queda **PENDIENTE** de ejecutar
la secuencia B→C→D→E en la instancia autorizada con respaldo verificado.
