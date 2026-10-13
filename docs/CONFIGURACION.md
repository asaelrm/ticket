# Configuración — SIFHA Ticket

Todas las variables se definen en `backend/.env` (copia de
`backend/.env.example`). Solo se listan aquí, sin secretos.

## Obligatorias en producción

| Variable | Valor | Efecto |
|----------|-------|--------|
| `NODE_ENV` | `production` | Activa la validación estricta de arranque |
| `SESSION_SECRET` | cadena aleatoria de 32+ caracteres | Firma cookies de sesión. Valores de ejemplo/`change-me` **impiden el arranque** en producción |
| `PUBLIC_URL` | `https://<dominio>` | Origen de los enlaces de correo (reset de contraseña) |

> Generar el secreto: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`

## HTTP, cookies y TLS

| Variable | Valores | Efecto |
|----------|---------|--------|
| `PORT` | 4000 | Puerto HTTP de la API |
| `CORS_ORIGIN` | origen del frontend | Origen permitido de CORS |
| `COOKIE_SECURE=true` | — | Cookie de sesión solo por HTTPS |
| `TRUST_PROXY` | IP/CIDR o lista | IPs del proxy que termina TLS. **No** usar `true` |
| `PUBLIC_HOSTS` | lista separada por comas | Hosts que reciben HSTS |

## Cuentas iniciales (seed)

| Variable | Efecto |
|----------|--------|
| `SEED_ADMIN_PASSWORD` | Contraseña inicial del administrador (12+ car.); se crea solo la primera vez |
| `SEED_ADMIN_FORCE_PASSWORD=true` | Restablecer de verdad la contraseña (usar una sola vez) |
| `SEED_ADMIN_USERNAME`, `SEED_ADMIN_EMAIL` | Datos del administrador (opcional) |
| `SEED_DEMO_ACCOUNTS` | Cuentas de demostración; **rechazada en producción** |
| `SEED_DEMO_PASSWORD`, `SEED_TECH_PASSWORD` | Contraseñas de `empleado`/`tecnico` de demo |

## Base de datos

| Variable | Valores | Efecto |
|----------|---------|--------|
| `DB_CLIENT` | `sqlite` (defecto) \| `mssql` | Motor pedido (para migración) |
| `MSSQL_RUNTIME=true` | — | **Activa** el runtime MSSQL; sin ella el motor real sigue siendo SQLite |
| `DATA_DIR` | `data` | Directorio de datos SQLite/sesiones |
| `DB_SERVER`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD` | — | Conexión SQL Server (solo migración) |
| `DB_ENCRYPT`, `DB_TRUST_SERVER_CERTIFICATE`, `DB_INSTANCE` | — | TLS e instancia de SQL Server |
| `JOBS_ENABLED=false` | — | Desactiva jobs de SLA/escalaciones (útli en validaciones MSSQL) |

## Correo (SMTP)

| Variable | Efecto |
|----------|--------|
| `MAIL_ENABLED=true` | Envía correos reales; sin ella se registran en `email_logs`/consola |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_FROM_NAME` | Configuración del transporte |

## Adjuntos y directorio

| Variable | Efecto |
|----------|--------|
| `MAX_UPLOAD_SIZE_MB` | Límite de tamaño por adjunto (5 MB) |
| `MAX_FILES_PER_TICKET` | Máximo de archivos por ticket (5) |
| `DIRECTORY_SYNC=false` | Desactiva sincronización de `directory.json` |
| `DIRECTORY_SNAPSHOT_FILE` | Ruta del snapshot de usuarios/departamentos |

## Pruebas contra SQL Server

Copiar `backend/.env.mssql-test.example` → `backend/.env.mssql-test` y definir:
`MSSQL_TEST_SERVER`, `MSSQL_TEST_PORT`, `MSSQL_TEST_DATABASE` (debe ser
exactamente `SIFHA_Tickets_M5_Integration_Test`), `MSSQL_TEST_USER`,
`MSSQL_TEST_PASSWORD` y las contraseñas de los usuarios de prueba
(`MSSQL_TEST_ADMIN_PASS`, `MSSQL_TEST_EMPLEADO_PASS`, `MSSQL_TEST_TECNICO_PASS`).
Nunca versionar credenciales reales; el `.example` solo lleva marcadores.

## Regla de oro

Ningún `.env` ni credencial real se versiona (`.gitignore`). Los `.example` solo
contienen nombres de variables y marcadores (`su-*-aqui`, `cambie-*`).