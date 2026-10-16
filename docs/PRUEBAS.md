# Pruebas — SIFHA Ticket

Cómo ejecutar y qué cubre la automatización. Nunca se usan bases con datos
reales para pruebas destructivas: la suite por defecto no requiere una base de datos
temporal que se crea, se migra, se siembra y se borra al terminar.

## Backend (pruebas unitarias, sin base de datos)

```bash
cd backend
npm test            # node --test --import ./test/setup.js "test/*.test.js"
```

- Ejecuta `npm run test:unit`; no abre ni crea SQL Server o SQLite.
- Resultado local de esta fase: **263 aprobadas, 0 fallos y 2 omitidas**.

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
- Estado: **certificado 37/37** contra `SIFHA_Tickets_M5_Integration_Test`
  (2026-10-12). Re-ejecutarla **escribe** filas de prueba y exige nueva
  autorización del responsable.

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
| `cd backend && npm run test:mssql` | Integración contra una instancia MSSQL de pruebas autorizada (`.env.mssql-test`) |
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
| Backend `npm test` | 890 pruebas, 888 pass, 0 fallos, 2 omitidas |
| Frontend `npx vitest run` | 44 archivos, 1080/1080 |
| Build `npm run build` | OK |
| Integración MSSQL `npm run test:mssql` | **37/37 pass** (2026-10-12; re-ejecutar escribe datos y requiere autorización) |

## Reglas

- No se declara una prueba aprobada si no se ejecutó correctamente.
- No se debilitan validaciones para conseguir verde.
- Las suites MSSQL se ejecutan solo con `npm run test:mssql` y una instancia de
  pruebas autorizada; `npm test` no depende de una base para terminar.
