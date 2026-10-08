# Guía de entrega a infraestructura

Documento de entrega para el equipo de infraestructura. Cubre requisitos,
instalación, configuración, migración, seguridad, verificación y limitaciones
conocidas. No contiene secretos: todas las variables se declaran sin valores.

Rama de entrega: `trabajo-etapa3-pendiente`.

---

## 1. Requisitos

- Node.js **>= 22.5** (usa `node:sqlite`; se recomienda 24 LTS).
- npm (va con Node) o `npm ci` en CI.
- Disco para `backend/data` (base SQLite) y `backend/uploads` (adjuntos).
- SQL Server **solo** si se ejecuta la migración SQLite → MSSQL (sección 9).
  El runtime no necesita SQL Server (ver sección 15).

## 2. Instalación

```bash
npm run setup                 # instala backend y frontend
cp backend/.env.example backend/.env     # Windows: copy backend\.env.example backend\.env
```

Editar `backend/.env` según la sección 6. No versionar `.env`.

## 3. Comandos de desarrollo

```bash
npm run dev:backend           # http://localhost:4000
npm run dev:frontend          # http://localhost:5173 (proxy a /api)
```

Arranque inicial: aplica migraciones y seed. **No crea cuentas** salvo que se
defina `SEED_ADMIN_PASSWORD` (sección 6). Resto de scripts útiles:

| Comando (raíz / backend)      | Descripción                                        |
| ----------------------------- | -------------------------------------------------- |
| `npm run db:migrate`          | Migraciones SQLite (idempotente)                   |
| `npm run db:seed`             | Roles, permisos, catálogos                         |
| `npm run db:bootstrap`        | Crea superadministrador (`BOOTSTRAP_SUPERADMIN_*`) |
| `npm run db:audit-orgs`       | Auditoría de organizaciones y aislamiento          |

## 4. Build y arranque en producción

```bash
npm run build                  # frontend a frontend/dist
NODE_ENV=production npm start  # API + SPA servidos en el mismo puerto
```

La aplicación **no arranca** en producción con `SESSION_SECRET`, `PUBLIC_URL`
o `SEED_ADMIN_PASSWORD` ausentes/débiles, o con `SEED_DEMO_ACCOUNTS=true`.
Detalle en el README (*"Qué impide el arranque en producción"*).

## 5. Pruebas

```bash
# Backend (usa base temporal, nunca escribe en data/tickets.db)
npm test                       # = node --test --import ./test/setup.js "test/*.test.js"

# Frontend
npx vitest run
npm run build                  # comprueba el bundle
```

Resultado de la entrega (ejecutados en esta sesión):

- Backend: **672 tests, 670 pass, 0 fail, 2 omitidos**.
- Frontend: **1074 tests, 44 archivos, 0 fallos**; `npm run build` sin errores.

Los 2 omitidos son pruebas condicionales a un entorno real (SMTP/adjuntos).
Repita ambas suites antes de cualquier despliegue.

## 6. Variables de entorno (sin secretos)

Completas en `backend/.env.example`. Obligatorias en producción:

| Variable             | Descripción                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `NODE_ENV`           | `production` activa validaciones estrictas de arranque             |
| `SESSION_SECRET`     | 32+ caracteres aleatorios (generar con `crypto.randomBytes(32)`)   |
| `PUBLIC_URL`         | URL pública sin slash final (enlaces de correo)                    |
| `CORS_ORIGIN(S)`     | Origen permitido (en prod, igual a `PUBLIC_URL`)                   |
| `COOKIE_SECURE`      | `true` tras HTTPS (ver aviso LAN en `.env.example`)                |

Opcionales relevantes:

| Variable                     | Descripción                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `PORT`                       | Puerto API (4000)                                               |
| `TRUST_PROXY`                | IP/CIDR del proxy TLS (nunca `true`)                            |
| `PUBLIC_HOSTS`               | Hosts con HSTS                                                   |
| `DATA_DIR` / `UPLOAD_DIR`    | BD y adjuntos, relativos a `backend/`                            |
| `DB_FILE`                    | Ruta SQLite alternativa                                          |
| `PUBLIC_DIR`                 | SPA compilada (defecto `frontend/dist`)                          |
| `MAX_UPLOAD_SIZE_MB` / `MAX_FILES_PER_TICKET` | Límites de adjuntos (5 / 5)                    |
| `MAIL_ENABLED`, `MAIL_TRANSPORT`, `SMTP_HOST/PORT/SECURE/USER/PASS/FROM/FROM_NAME` | Correo |
| `SEED_ADMIN_*`, `SEED_DEMO_*` | Cuentas iniciales (nunca commit de valores)                     |
| `DIRECTORY_SYNC`, `DIRECTORY_SNAPSHOT_FILE` | Directorio de usuarios en disco               |

Variables solo para la migración (sección 9): `DB_CLIENT`, `DB_SERVER`,
`DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_ENCRYPT`,
`DB_TRUST_SERVER_CERTIFICATE`, `DB_INSTANCE`, `MIGRATION_TARGET_DATABASE`.

## 7. Conexión a SQL Server

Usada **exclusivamente** por los scripts de migración
(`backend/scripts/migration/*`), nunca por el proceso en ejecución:

```
DB_CLIENT=mssql
DB_SERVER=host\INSTANCIA          # o host,puerto
DB_PORT=1433
DB_DATABASE=<base destino>        # debe coincidir con MIGRATION_TARGET_DATABASE
DB_USER=<usuario de migración>    # permisos DDL sobre la base destino
DB_PASSWORD=<clave>
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=false # true solo si el certificado es auto-firmado
DB_INSTANCE=SIFHADEV              # validación fijada en APPLY
```

El usuario de migración necesita: crear tablas/índices/FKs, `INSERT` con
`IDENTITY_INSERT`, y `EXEC sp_getapplock` en el servidor.

## 8. Esquema MSSQL requerido

- Definición canónica: `backend/src/db/mssql/schema.sql` (24 tablas, 36 FKs).
- Debe aplicarse **antes** del `--apply` (esquema creado vacío por el migrador
  o gestionado como migración de infraestructura).
- Puntos a respetar: `organization_id` en todas las tablas tenant; FKs
  compuestas `(organization_id, id)`; unicidad de catálogos por organización;
  flags `BIT`; timestamps a `DATETIME2(3)` UTC; `email_logs.organization_id`
  nullable con FK `NO ACTION`.
- Paridad SQLite ↔ MSSQL (`org_settings` incluida) verificada por tests.

## 9. Procedimiento de migración (documentado, NO ejecutado aquí)

La migración M5 **ya se ejecutó en el entorno de validación** (sección 15) y
**no debe re-ejecutarse**. Procedimiento para un cutover real, en este orden:

1. Snapshot SQLite (el migrador lo abre en `readOnly`).
2. `node backend/scripts/migration/sqlite-to-mssql.js --dry-run`
   → salida esperada: exit 0, 0 errores de precheck, sin tocar la red.
3. `--apply` exige: `DB_CLIENT=mssql`, `DB_INSTANCE` correcto,
   `MIGRATION_TARGET_DATABASE === DB_DATABASE`, destino **vacío**, `sessions`
   en 0 filas; adquiere `sp_getapplock` y hace rollback ante cualquier fila.
   Con `--legacy-org-code` crea la organización legacy y resuelve su ID real.
4. Verificación posterior (`verify-m5-validation.js`): conteos, FKs,
   duplicados, NULL, aislamiento por org y settings.
5. **Copiar físicamente** los adjuntos (sección 10) y validar descargas.
6. Invalidar sesiones (`sessions` es SKIP en M4: se recomienda no migrarlas).

Detalle completo: `backend/docs/M4-SQLITE-TO-MSSQL-MIGRATOR.md`.
El destino debe revisar antes de APPLY: política de tokens de recuperación y
checksums de catálogos.

## 10. Almacenamiento de adjuntos

- Ruta `UPLOAD_DIR` (defecto `backend/uploads`), creado automáticamente.
- Validación por **contenido** (magic bytes), nombres internos únicos,
  descarga autorizada por permisos y organización.
- Límites: `MAX_UPLOAD_SIZE_MB`, `MAX_FILES_PER_TICKET`.
- **La migración no mueve archivos**: `ticket_attachments` sólo migra
  metadata. En cutover, copiar el árbol de `uploads` y contrastar `stored_name`
  contra el origen (decisión humana pendiente 3 de M4).
- Backup: `uploads/` es estado de instalación, igual que `data/` y
  `directory.json` (nunca versionados).

## 11. Correo

- `MAIL_ENABLED=true` + `SMTP_*` para envío real; `MAIL_TRANSPORT=auto`
  usa SMTP si hay host.
- Sin SMTP: nada se pierde, los correos quedan en `email_logs` y en consola
  (dev); visibles en **Configuración → Notificaciones**.
- Verificación: crear un ticket, asignarlo y revisar `email_logs` (estado,
  destinatario, org) sin exponer cuerpos o tokens en logs.
- `PUBLIC_URL` debe ser correcta: los enlaces absolutos (reset de contraseña,
  CSAT) se construyen con ella.

## 12. Tareas programadas

- Job **en proceso**, cada **10 minutos** (`backend/src/utils/jobs.js`),
  arranca con el servidor: SLA vencido, escalación de no asignados, alerta de
  críticos, poda de notificaciones.
- No requiere cron externo. **Ejecutar una sola instancia** por base de datos:
  varias instancias ejecutarían el job a la vez (los avisos tienen dedupe, las
  escalaciones no son idempotentes por diseño).
- Reproducir una pasada manualmente: `runMaintenance()` desde un REPL.
- Las reglas se configuran por organización en **Configuración → Escalación
  automática** (0 horas = regla desactivada).

## 13. Seguridad multiempresa

- Autorización **siempre** en backend por permiso (`requirePermission`) y
  alcance de organización (`orgScope`, `requireOrg`, `currentOrgId`);
  el frontend sólo oculta opciones.
- `organization.manage` es exclusivo de **SUPERADMIN** (`GET/POST/PATCH
  /api/organizations`, sin DELETE: las orgs se desactivan con `active=false`).
- Organización desactivada = login rechazado (403) y sesiones vivas bloqueadas
  al recargar el usuario.
- Notificaciones y jobs: destinatarios filtrados por la organización **del
  ticket**; tickets legados sin organización no generan notificaciones ni
  escalaciones (evita broadcast global).
- El runtime MSSQL está implementado pero **desactivado por defecto**:
  `DB_CLIENT=mssql` solo pide el motor, y el proceso solo lo usa con
  `MSSQL_RUNTIME=true`. Sin ese flag la única base activa es SQLite (una sola
  fuente de verdad): el aislamiento depende de las filas `organization_id`, no
  de esquemas separados por cliente.
- Medidas generales: bcrypt coste 12, cookies `httpOnly` + CSRF double-submit,
  rate limiting en `/api` y login, validación de entrada y de archivos por
  contenido, Helmet, HSTS opcional (`PUBLIC_HOSTS`), errores internos sin
  detalle al cliente, `directory.json` sin hashes y fuera de Git.

## 14. Health check

- Endpoint: **`GET /api/health`** → `200 {"ok":true,"env":"...","time":"..."}`.
  `docker-compose.yml` ya lo usa como healthcheck.
- No toca la base de datos: para una comprobación completa añada sondeo de
  inicio de sesión y una consulta de lectura tras el healthcheck.

## 15. Limitaciones conocidas

1. **Runtime MSSQL activable, SQLite por defecto.** `config.dbClient` resuelve a
   `'sqlite'` salvo que se defina `MSSQL_RUNTIME=true`; `DB_CLIENT=mssql` por sí
   solo no cambia la base en ejecución (queda como motor "pedido" para los
   scripts de migración) y el arranque avisa por consola si detecta ese caso.
   SQL Server solo es destino operativo cuando el runtime está activado y el
   esquema (`src/db/mssql/schema.sql`, 24 tablas) está aplicado; sin él, forzar
   el motor rompe el login porque `sessions` no existe en destino.
2. **M5 migró metadatos, no archivos.** Resultado previo (no re-ejecutar):
   servidor `TI-DESK-01\SIFHADEV`, base `SIFHA_Tickets_M5_Validation`,
   organización `CMUCE` (id 3). Los adjuntos requieren copia manual.
3. **Tickets legados con `organization_id = NULL`**: se conservan pero no
   notifican ni escalan (por seguridad).
4. **`sessions` no se migra** (SKIP / REQUIRES_DECISION en M4): el cutover
   invalida sesiones existentes.
5. Job de mantenimiento pensado para **una sola instancia** por base.
6. Pruebas de compatibilidad MSSQL **esquemáticas** (paridad de tablas, FKs e
   IDENTITY) más una validación en servidor real de M5; no existe suite que
   ejecute el runtime sobre SQL Server.
7. El escritorio de entrega no re-ejecutó M5 ni toca infraestructura real
   (restricción de la fase).

## 16. Checklist para infraestructura

- [ ] Node >= 22.5 instalado; `npm run setup` ejecutado.
- [ ] `backend/.env` creado desde `.env.example`, con `SESSION_SECRET`,
      `PUBLIC_URL`, `CORS_ORIGIN`, `COOKIE_SECURE` y sin `SEED_DEMO_*`.
- [ ] Permisos de escritura sobre `backend/data` y `backend/uploads`; backup
      agendado para ambos (y para `directory.json`).
- [ ] `SEED_ADMIN_PASSWORD` definido un solo arranque; cuenta creada y
      variable retirada del entorno.
- [ ] `npm test` (backend) y `npx vitest run` (frontend) en verde en su CI.
- [ ] `npm run build` + arranque con `NODE_ENV=production` y verificación de
      `GET /api/health`.
- [ ] SMTP probado de extremo a extremo con `MAIL_ENABLED=true` (o aceptado el
      modo `email_logs`).
- [ ] Reverse proxy con HTTPS, `TRUST_PROXY` con la IP/CIDR real (nunca
      `true`), `PUBLIC_HOSTS` sólo con nombres públicos.
- [ ] **Una sola instancia** del servicio (jobs en proceso).
- [ ] Si se migra a MSSQL: dry-run → apply → copia de `uploads` →
      `verify-m5-validation` → invalidación de sesiones (sección 9).
- [ ] Revisión de limitaciones de la sección 15 con el dueño del servicio.
