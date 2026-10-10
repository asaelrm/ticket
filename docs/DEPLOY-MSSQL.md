# Guía de Despliegue y Certificación MSSQL — SIFHA Ticket M5

## Resumen

SIFHA Ticket está certificado para Microsoft SQL Server. Esta guía permite al equipo de infraestructura configurar el entorno de producción sin modificar el código.

---

## 1. Requisitos Previos

- **SQL Server 2019+** (compatibilidad probada con 2022)
- **Instancia nombrada** (ej. `SIFHADEV`) o instancia por defecto
- **Base de datos vacía** creada previamente
- **Usuario SQL** con permisos `db_owner` sobre la base
- **TLS 1.2+** habilitado en el servidor
- **Puerto 1433** accesible (o puerto configurado)

---

## 2. Esquema de Base de Datos

El esquema canónico está en `backend/src/db/mssql/schema.sql` (24 tablas, 204 columnas).

**No ejecutar manualmente**: El backend valida el esquema al arrancar (`src/db/mssql/schemaValidator.js`). Si falta algo, el servidor **no inicia** y muestra el detalle exacto.

### Tablas principales
- `organizations`, `roles`, `permissions`, `role_permissions`
- `departments`, `categories`, `users`, `teams`, `team_members`
- `tickets`, `canned_responses`, `ticket_comments`, `ticket_attachments`, `ticket_history`
- `sessions`, `sequences`, `settings`, `org_settings`, `email_logs`, `notifications`
- `kb_categories`, `kb_articles`, `kb_ticket_articles`, `kb_article_history`

### Claves de aislamiento multiempresa
- Todas las tablas tenant llevan `organization_id NOT NULL`
- FK compuestas: `(organization_id, id)` → tabla padre `(organization_id, id)`
- `tickets`: `UQ_tickets_organization_ticket_number` → numeración por organización
- `notifications`: `organization_id` nullable solo para avisos globales a SUPERADMIN

---

## 3. Variables de Entorno (Backend)

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `DB_CLIENT` | Sí | `mssql` |
| `MSSQL_RUNTIME` | Sí | `true` (activa pool MSSQL) |
| `DB_SERVER` | Sí | Host/IP del SQL Server |
| `DB_PORT` | No | Puerto (default 1433) |
| `DB_DATABASE` | Sí | Nombre de la base |
| `DB_USER` | Sí | Usuario SQL |
| `DB_PASSWORD` | Sí | Contraseña |
| `DB_ENCRYPT` | No | `true` (default) |
| `DB_TRUST_SERVER_CERTIFICATE` | No | `true` si certificado autofirmado |
| `DB_INSTANCE` | No | Nombre de instancia (ej. `SIFHADEV`) |
| `SESSION_SECRET` | Sí | 32+ chars aleatorios (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) |
| `PUBLIC_URL` | Sí (prod) | URL pública HTTPS (ej. `https://tickets.empresa.com`) |
| `CORS_ORIGIN` | Sí | Origen del frontend (ej. `https://tickets.empresa.com`) |
| `COOKIE_SECURE` | Sí (prod) | `true` |
| `TRUST_PROXY` | No | IP/CIDR del proxy/TLS terminator (ej. `10.0.0.0/8`) |
| `PUBLIC_HOSTS` | No | Hosts públicos para HSTS (ej. `tickets.empresa.com`) |
| `JOBS_ENABLED` | No | `true` para activar mantenimiento SLA/escalaciones |
| `MAIL_ENABLED` | No | `true` para enviar correos reales |
| `SMTP_*` | No | Configuración SMTP si `MAIL_ENABLED=true` |

### Ejemplo `.env` producción

```env
NODE_ENV=production
PORT=4000
DB_CLIENT=mssql
MSSQL_RUNTIME=true
DB_SERVER=sql.empresa.local
DB_PORT=1433
DB_DATABASE=SIFHA_Tickets_PROD
DB_USER=sifha_prod_user
DB_PASSWORD=***NO_COMMIT***
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=false
SESSION_SECRET=***GENERAR_32+_CHARS***
PUBLIC_URL=https://tickets.empresa.com
CORS_ORIGIN=https://tickets.empresa.com
COOKIE_SECURE=true
TRUST_PROXY=10.0.0.0/8,172.16.0.0/12
PUBLIC_HOSTS=tickets.empresa.com
JOBS_ENABLED=true
MAIL_ENABLED=true
SMTP_HOST=smtp.empresa.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=sifha@empresa.com
SMTP_PASS=***
SMTP_FROM=sifha@empresa.com
SMTP_FROM_NAME=SIFHA Tickets
```

---

## 4. Arranque y Validación

```bash
# Instalar dependencias
cd backend && npm ci

# Verificar configuración (dry-run)
npm run db:migrate  # Solo valida, no escribe si esquema existe

# Arrancar
npm start
```

**Comportamiento al arrancar:**
1. Valida `SESSION_SECRET`, `PUBLIC_URL`, etc.
2. Conecta a SQL Server y **valida esquema completo** (solo lectura)
3. Si el esquema no coincide → **error y salida** (no inicia HTTP)
4. Si coincide → abre puerto HTTP y sirve API

**Endpoint de salud:** `GET /api/health` → `{ "ok": true, "env": "production", "time": "..." }`

---

## 5. Migración de Datos (SQLite → MSSQL)

**Solo para migración inicial**, no para producción continua.

```bash
# 1. Backup SQLite actual
cp backend/data/tickets.db tickets_backup_$(date +%F).db

# 2. Configurar variables de migración
export DB_CLIENT=mssql
export MSSQL_RUNTIME=true
export DB_SERVER=...
export DB_DATABASE=SIFHA_Tickets_M5_Validation  # Base destino VACÍA
export DB_USER=...
export DB_PASSWORD=...
export MIGRATION_TARGET_DATABASE=SIFHA_Tickets_M5_Validation  # Debe coincidir
export DB_INSTANCE=SIFHADEV  # Si aplica

# 3. Ejecutar migración (dry-run primero)
node backend/scripts/migration/sqlite-to-mssql.js --dry-run
node backend/scripts/migration/mssql-apply.js

# 4. Verificar
node backend/scripts/migration/verify-m5-validation.js
```

**Reglas de migración:**
- La base destino **debe estar vacía** (24 tablas, 0 filas)
- `APPLY` usa `sp_getapplock` para serializar
- `IDENTITY_INSERT` preserva IDs existentes
- Organización legacy → se crea en destino y se resuelve ID real
- Secuencias reconciliadas al máximo real de tickets

---

## 6. Frontend (Build y Despliegue)

```bash
cd frontend
npm ci
npm run build
```

- Output: `frontend/dist/`
- Servir estáticos desde backend (`config.publicDir`) o CDN/NGINX
- `PUBLIC_URL` debe coincidir con el origen servido

### NGINX (ejemplo)

```nginx
server {
    listen 443 ssl http2;
    server_name tickets.empresa.com;
    
    ssl_certificate /etc/ssl/certs/tickets.pem;
    ssl_certificate_key /etc/ssl/private/tickets.key;
    
    location / {
        root /opt/sifha/frontend/dist;
        try_files $uri $uri/ /index.html;
    }
    
    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 7. Mantenimiento Programado (Jobs)

Con `JOBS_ENABLED=true`, cada 10 minutos se ejecuta:

1. **SLA vencido** → notifica a admins de la organización del ticket
2. **Escalación sin asignar** → sube prioridad según reglas por organización
3. **Alerta crítica** → notifica admins si ticket CRITICAL abierto > X horas
4. **Poda notificaciones** → leídas > 90 días, no leídas > 365 días

**Configuración por organización** (Settings → Reglas):
- `rule_unassigned_hours` (0 = desactivado)
- `rule_unassigned_priority` (LOW/MEDIUM/HIGH/CRITICAL)
- `rule_critical_hours` (0 = desactivado)

---

## 8. Respaldos y Recuperación

### Backup M5 (solo validación)

```sql
-- Script: backend/scripts/migration/backup-m5.sql
-- Ejecutar SOLO en SIFHA_Tickets_M5_Validation en TI-DESK-01\SIFHADEV
-- COPY_ONLY, CHECKSUM, COMPRESSION, INIT
-- NO toca SIFHA_Tickets_DEV
-- NO restaura (solo RESTORE VERIFYONLY)
```

### Backup producción (recomendado)

```bash
# Backup completo diario
sqlcmd -S sql.empresa.local -d SIFHA_Tickets_PROD -Q "BACKUP DATABASE SIFHA_Tickets_PROD TO DISK='...' WITH COMPRESSION, CHECKSUM"

# Backup diferencial cada 6h
# Log cada 15min
```

### Recuperación punto-en-el-tiempo (PITR)

```sql
RESTORE DATABASE SIFHA_Tickets_PROD FROM DISK='...' WITH NORECOVERY;
RESTORE LOG SIFHA_Tickets_PROD FROM DISK='...' WITH RECOVERY, STOPAT='2026-10-10 14:30:00';
```

---

## 9. Verificación Post-Despliegue

| Check | Comando/Endpoint | Esperado |
|-------|------------------|----------|
| API salud | `GET /api/health` | `{"ok":true}` |
| Login admin | `POST /api/auth/login` | 200 + cookie `tf_sid` |
| Crear ticket | `POST /api/tickets` | 201 + `ticket_number` |
| Listar tickets | `GET /api/tickets` | 200 + array |
| Dashboard | `GET /api/dashboard/summary` | 200 + contadores |
| Reportes | `GET /api/reports/summary` | 200 + métricas |
| Export CSV | `GET /api/tickets/export` | 200 + `text/csv` |
| WebSocket/SSE | `GET /api/tickets/:id/stream` | Conexión keep-alive |

---

## 10. Problemas Comunes y Soluciones

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Servidor no arranca, error esquema | Faltan tablas/columnas/FK | Ejecutar migración completa o comparar con `schema.sql` |
| Login falla 401 | `SESSION_SECRET` inválido | Generar 32+ chars aleatorios |
| Cookies no llegan | `COOKIE_SECURE=true` sin HTTPS | Proxy debe terminar TLS y enviar `X-Forwarded-Proto: https` |
| CORS error | `CORS_ORIGIN` no coincide | Poner origen exacto del frontend (sin trailing slash) |
| Jobs no corren | `JOBS_ENABLED=false` | Poner `true` en producción |
| Correos no salen | `MAIL_ENABLED=false` o SMTP mal | Configurar SMTP y `MAIL_ENABLED=true` |
| Error `sp_getapplock` | Migración concurrente | Solo un `APPLY` a la vez |
| `DB_TRUST_SERVER_CERTIFICATE` | Certificado autofirmado | Solo permitido para `SIFHA_Tickets_M5_Validation` |

---

## 11. Pruebas de Certificación (Ejecución Local)

### Pruebas SQLite (siempre)
```bash
cd backend && npm test
# 857 tests, 0 fallos
```

### Pruebas MSSQL (requiere base aislada)
```bash
# 1. Configurar .env.mssql-test (ver .env.mssql-test.example)
# 2. Base de pruebas DEBE llamarse *_test_*
cp .env.mssql-test.example .env.mssql-test
# Editar con credenciales de base de pruebas

# 3. Ejecutar
npm run test:mssql
```

**Pruebas MSSQL incluidas:**
- `mssql-integration.test.js` — Auth, tickets, flujo, export
- `mssql-reports-dashboard.test.js` — Dashboard, reportes, settings, notificaciones
- `mssql-jobs.test.js` — Mantenimiento SLA, escalaciones, poda
- Suites estáticas: dialect, schema, contract, startup (112 tests)

---

## 12. Seguridad y Buenas Prácticas

- **Nunca** commitear `.env` con credenciales reales
- **Rotar** `SESSION_SECRET` en cada despliegue nuevo
- **Limitar** `TRUST_PROXY` a IPs conocidas del proxy/TLS terminator
- **Usar** `COOKIE_SECURE=true` + HTTPS en producción
- **Auditar** `email_logs` y `notifications` periódicamente
- **Monitorear** `ticket_number` por organización (detectar gaps)
- **Backup** diario verificado + PITR testado trimestralmente

---

## 13. Contacto y Escalación

- **Desarrollo**: Equipo SIFHA (repositorio interno)
- **Infraestructura**: Equipo de sistemas / DBA SQL Server
- **Issues**: Registrar en tracker interno con logs de `/api/health` y arranque

---

*Documento generado para entrega M5. Versión correspondiente al commit `aa3bf6f` (rama `trabajo-etapa3-pendiente`).*