# Pruebas — SIFHA Ticket

Cómo ejecutar y qué cubre la automatización. Nunca se usan bases con datos
reales para pruebas destructivas: la suite por defecto usa una base SQLite
temporal que se crea, se migra, se siembra y se borra al terminar.

## Backend (motor SQLite)

```bash
cd backend
npm test            # node --test --import ./test/setup.js "test/*.test.js"
```

- Crea una base **temporal** (setup en `backend/test/setup.js`); no escribe en
  `backend/data/tickets.db`.
- Última ejecución registrada: **859 pruebas, 857 aprobadas, 0 fallos,
  2 omitidas** (omitidas por depender de entorno real SMTP/adjuntos).

## Backend — integración contra SQL Server

Las suites que requieren un servidor SQL real viven en `backend/test/mssql/` y
**no** forman parte de `npm test`.

```bash
cd backend
cp .env.mssql-test.example .env.mssql-test   # editar credenciales de PRUEBA
npm run test:mssql                            # node --test --import ./test/setup-mssql.js "test/mssql/*.test.js"
```

- Requiere un SQL Server autorizado y que `MSSQL_TEST_DATABASE` sea
  **exactamente** `SIFHA_Tickets_M5_Integration_Test` (validación estricta
  antes de cualquier escritura, `test/setup-mssql.js`).
- Suites: `mssql-integration` (auth, tickets, flujo, export),
  `mssql-reports-dashboard` (dashboard, reportes, configuración, aislamiento),
  `mssql-jobs` (SLA, escalaciones, poda).
- Estado: **PENDIENTE** de certificación en un entorno con SQL Server autorizado
  (no bloquea el código; requiere infraestructura).

## Frontend

```bash
cd frontend
npx vitest run       # 44 archivos, 1080 pruebas (0 fallos)
npm run build        # compila el bundle de producción a dist/
```

## Otras verificaciones oportunas

| Comando | Qué comprueba |
|---------|---------------|
| `node --test test/mssql-sql-translation.test.js` | Traducción SQLite→T-SQL (249 sentencias, 0 incompatibles) |
| `cd backend && npm run db:migrate` | Migraciones SQLite idempotentes (no aplica a MSSQL) |
| `cd backend && npm start` (rama MSSQL) | Validación de esquema MSSQL en solo lectura al arrancar |
| `DIAGNOSE_SELFCHECK=1 node scripts/migration/diagnose-m5-validation.js` | Autodiagnóstico M5 sin red (24 tablas, 23 índices) |

## Qué cubren las pruebas (checklist funcional)

- Login/cierre/expiración de sesión; recuperación con token y caducidad.
- Roles, permisos, departamentos, equipos y administración de usuarios.
- Creación/edición/asignación de tickets y flujo de estados
  OPEN→ASSIGNED→IN_PROGRESS→PENDING→RESOLVED→CLOSED/CANCELLED; cierre y
  reapertura; reinicio de CSAT.
- Comentarios públicos/internos, historial y autoría; adjuntos validados por
  contenido y con autorización de descarga.
- Notificaciones (in-app + correo) y SLA/escalaciones.
- Aislamiento multi-empresa (filtros por `organization_id` + FK compuestas).
- Auditoría, reportes y exportaciones (CSV/XLSX/PDF).
- HTTP 400/401/403/404/500, transporte (HSTS/CSRF/HTTPS), política de proxy y
  sesión segura.

## Resultados registrados (2026-10-12)

| Suite | Resultado |
|-------|-----------|
| Backend `npm test` | 859 pruebas, 0 fallos, 2 omitidas |
| Frontend `npx vitest run` | 44 archivos, 1080/1080 |
| Build `npm run build` | OK |
| Integración MSSQL `npm run test:mssql` | PENDIENTE (requiere entorno autorizado) |

## Reglas

- No se declara una prueba aprobada si no se ejecutó correctamente.
- No se debilitan validaciones para conseguir verde.
- Las suites MSSQL se reorganizaron a `test/mssql/` para que el `npm test`
  por defecto (SQLite) no dependa de un SQL Server para terminar.