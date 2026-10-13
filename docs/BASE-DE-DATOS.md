# Base de datos — SIFHA Ticket

El sistema soporta dos motores con la misma fachada (`backend/src/db/runtime.js`):

- **SQLite** (`node:sqlite`) — motor por defecto; migraciones y seed automáticos
  en el primer arranque. Base en `backend/data/tickets.db`.
- **SQL Server 2022** — motor objetivo del despliegue; opcional y **no activo**
  por defecto. Requiere `DB_CLIENT=mssql` + `MSSQL_RUNTIME=true` y el esquema
  aplicado previamente.

## Esquema canónico MSSQL

- Archivo: `backend/src/db/mssql/schema.sql`.
- **24 tablas**: `organizations, roles, permissions, role_permissions,
  departments, categories, users, teams, team_members, tickets,
  canned_responses, ticket_comments, ticket_attachments, ticket_history,
  sessions, sequences, settings, org_settings, email_logs, notifications,
  kb_categories, kb_articles, kb_ticket_articles, kb_article_history`.
- Garantías clave: aislamiento multi-empresa mediante columnas
  `organization_id` + FK compuestas `…_same_org`, `NOT NULL`/`NULL` según tabla
  (p. ej. `departments.organization_id NOT NULL`, `users.organization_id NULL`),
  y auditoría en `ticket_history`.
- La validación de esquema en **solo lectura** se ejecuta automáticamente en
  `npm start` (rama MSSQL): si no coincide, el backend no arranca.

## Fachada y traducción de dialecto

- `backend/src/db/dialect.js` convierte las sentencias estáticas SQLite → T-SQL
  (249 sentencias cubiertas, 0 incompatibles en la prueba de traducción).
- `backend/src/db/runtime.js` elige motor solo con `MSSQL_RUNTIME=true`.

## Migración por fases

La conversión de la base de desarrollo se organiza en grupos. Todos los scripts
viven en `backend/scripts/migration/` y se **autoprotegen** (guarda de
`DB_NAME()` + instancia + servidor; interrupción con `RAISERROR(...,16,1)`).

| Grupo | Objetivo | Estado |
|-------|----------|--------|
| B | Reconciliación de la base (`verify-after-groupB.sql`, verificación) | VALIDADO (no ejecutado en DEV) |
| C | Backfill de la organización `CMUCE` y FK compuestas `same_org` (`backfill-organization-CMUCE.sql`, `fix-users-department-same-org.sql`) | VALIDADO (no ejecutado en DEV) |
| D | `departments.organization_id` → `INT NOT NULL` (`apply-groupD-not-null.sql`) | **CERTIFICADO en `SIFHA_GroupD_ScratchTest`** (2026-10-13, POST-D GO / FINAL GO); en `SIFHA_Tickets_DEV` NO ejecutado |
| M5 | `notifications.organization_id` → NULL-able + `CK_notifications_ticket_requires_org` (`notifications-organization-nullable.sql`) | CUMPLIDO en `SIFHA_Tickets_M5_Validation` (verificado solo lectura) |
| E | Verificación final (`verify-final-reconciliation.sql`) | PENDIENTE de ejecución |

## Grupo D (detalle)

- Convierte **solo** la nulabilidad de `dbo.departments.organization_id`. No
  cambia el tipo, no borra datos y no toca `users.organization_id`.
- Una transacción única revalida, suelta y recrea los UNIQUE y FK dependientes
  (idénticos), aplica `ALTER COLUMN`, verifica antes de `COMMIT` y revierte con
  `TRY/CATCH` + `XACT_ABORT`.
- **Bloqueo corregido (falso positivo):** el guard comparaba el tipo de *data
  space* contra `N'ROWS_FILEGROUPS'`; el valor real de `sys.data_spaces` es
  `ROWS_FILEGROUP` (singular). Los índices viven en el filegroup `PRIMARY`, sin
  particionamiento/filtro/compresión. La comparación era siempre verdadera y
  abortaba. La protección real se conserva (aborta ante un índice particionado,
  filtrado o comprimido).
- Los scripts de prueba para la base aislada `SIFHA_GroupD_ScratchTest` son
  `apply-groupD-not-null-scratch-test(-authorized).sql` y
  `verify-after-groupD-scratch-test.sql`.
- **Fix de recreación de UNIQUE (`Msg 129 — FILLFACTOR=0`):** la recreación de
  los UNIQUE emitía siempre `FILLFACTOR = <fill_factor>`; con `fill_factor = 0`
  (default) SQL Server rechaza `FILLFACTOR = 0` y la transacción abortaba.
  Corregido en los 3 scripts (`apply-groupD-not-null*.sql`) para emitir la
  cláusula solo cuando `@d_fill BETWEEN 1 AND 100`; con 0 se omite (default del
  servidor). Cambio mínimo: 1 línea por archivo.

## Reglas operativas

- No ejecutar DDL/DML sobre `SIFHA_Tickets_DEV` sin autorización y respaldo
  verificado.
- El estado de la base aislada de pruebas es `SIFHA_GroupD_ScratchTest` en
  `TI-DESK-01\SIFHADEV`. Restaurarla (respaldo `COPY_ONLY`) es prerrequisito
  para probar el Grupo D.
- Comandos listos para el operador: `docs/ESTADO-ENTREGA.md` §5.
- Documento de referencia del plan completo: `docs/PLAN-RECONCILIACION-DEV.md`.