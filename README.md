# Ticket

Sistema empresarial de gestión de tickets e incidencias. Backend `Node.js (Express)` + `SQLite`, frontend `React (Vite) + Tailwind`.

## Características

- **Autenticación** por sesión con cookies `httpOnly`, hash de contraseñas con bcrypt, protección CSRF (double-submit) y rate limiting.
- **RBAC** con roles iniciales **Empleado** y **Administrador**, y estructura lista para **Técnico / Soporte**.
- **Tickets**: creación con adjuntos (imágenes y documentos), categorías, prioridades, estados, historial completo y auditoría.
- **Adjuntos**: validación por contenido (magic bytes), nombres internos únicos, descarga protegida por permisos.
- **Notificaciones por correo** (SMTP): asignación, comentarios nuevos, cancelación y resolución; con bitácora de envíos en `email_logs` y toggles en Configuración.
- **Notificaciones in-app**: campana en el header con alertas de asignación, comentarios, resolución, cierre, cancelación, CSAT y SLA (marcar como leídas / limpiar).
- **Bandeja de soporte** (Técnicos/Admin): vistas *asignados a mí*, *mi equipo*, *abiertos* y *sin asignar*, con autoasignación.
- **Cancelación con motivo obligatorio**, con notificación por correo y auditoría del flujo.
- **Encuesta de satisfacción (CSAT)**: el reportante califica (1–5 ☆) un ticket resuelto o cerrado; configurable desde Configuración.
- **Escalación automática**: jobs periódicos que detectan tickets sin asignar y críticos sin resolver según reglas configurables (horas y prioridad).
- **Auditoría global** (`/api/audit`): historial de cambios sobre tickets con búsqueda, filtros por usuario/acción/fecha y paginación.
- **Dashboard** administrativo con métricas y gráficos en SQL.
- **Filtros combinados** (fecha, período, categoría, departamento, usuario, prioridad, estado, búsqueda).
- **Exportación CSV, Excel (XLSX) y PDF** de tickets y reportes CSV.
- Recuperación de contraseña por token (en modo desarrollo se muestra el token en pantalla).

## Requisitos

- Node.js **>= 22.5** (usa `node:sqlite`, se recomienda 24+)

## Instalación (desarrollo)

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

Crear variables de entorno:

```bash
cp backend/.env.example backend/.env
```

(En Windows: `copy backend\.env.example backend\.env`)

Iniciar backend y frontend (dos terminales):

```bash
npm run dev:backend   # http://localhost:4000
npm run dev:frontend  # http://localhost:5173
```

La primera vez que arranca, el backend aplica migraciones y crea el seed automáticamente.

## Cuentas iniciales (seed)

En **desarrollo** se crean automáticamente estas cuentas de demostración:

| Rol        | Usuario  | Contraseña      |
| ---------- | -------- | --------------- |
| Admin      | `admin`  | `123456`        |
| Técnico    | `tecnico`| `Tecnico1234!`  |
| Empleado   | `empleado`| `Empleado1234!` |

> Cambie estas contraseñas tras el primer inicio.

En **producción** las cuentas demo con contraseña conocida **no se crean**. El
administrador inicial se crea al arrancar solo si define `SEED_ADMIN_PASSWORD`
(opcionalmente `SEED_ADMIN_USERNAME` y `SEED_ADMIN_EMAIL`). Si el administrador
ya existe y `SEED_ADMIN_PASSWORD` está definido, en cada arranque se fuerza esa
contraseña (útil para recuperar el acceso).

## Scripts

### Raíz
| Comando              | Descripción                                |
| -------------------- | ------------------------------------------ |
| `npm run setup`      | Instala dependencias de backend y frontend |
| `npm run dev:backend`| Backend con recarga en caliente            |
| `npm run dev:frontend`| Frontend Vite con proxy a `/api`          |
| `npm run build`      | Compila el frontend a `frontend/dist`      |
| `npm start`          | Sirve API + `frontend/dist` en producción  |
| `npm test`           | Ejecuta los tests del backend              |

### Backend
| Comando                  | Descripción                       |
| ------------------------ | --------------------------------- |
| `npm run db:migrate`     | Aplica migraciones (idempotente)  |
| `npm run db:seed`        | Siembra roles, permisos y datos   |

## Producción

1. `npm run build` (frontend a `frontend/dist`).
2. Configurar `.env` con `NODE_ENV=production`, `SESSION_SECRET` fuerte, `COOKIE_SECURE=true` y dominio HTTPS.
3. Para correos reales, definir `MAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM`.
4. `npm start` — el backend sirve la API y el frontend compilado.

### Variables de entorno relevantes

| Variable               | Descripción                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `production` activa validaciones estrictas (exige `SESSION_SECRET`).                                                                   |
| `SESSION_SECRET`       | **Obligatoria en producción.** El arranque falla si `NODE_ENV=production` y no está definida.                                          |
| `PUBLIC_URL`           | URL pública (sin slash final) usada para construir los enlaces absolutos de los correos, p. ej. el de recuperación de contraseña.      |
| `CORS_ORIGIN`          | Origen permitido por CORS. En producción con la SPA servida por el propio backend, use el mismo valor que `PUBLIC_URL`.                |
| `CORS_ORIGINS`         | Alternativa a `CORS_ORIGIN`: lista de orígenes separados por comas. Tiene prioridad sobre `CORS_ORIGIN`.                               |
| `COOKIE_SECURE`        | `true` cuando se sirve por HTTPS para que la cookie de sesión solo viaje por canales seguros.                                          |
| `SEED_ADMIN_PASSWORD`  | Contraseña del administrador. Si se define, al arrancar se crea (o se actualiza) la cuenta administrador; las cuentas demo no se crean en producción. |
| `SEED_ADMIN_USERNAME`  | Usuario del administrador inicial (por defecto `admin`).                                                                               |
| `SEED_ADMIN_EMAIL`     | Correo del administrador inicial (por defecto `admin@empresa.com`).                                                                    |

> En producción las cuentas demo con contraseña conocida **no se crean**. Defina
> `SEED_ADMIN_PASSWORD` para crear el administrador inicial y cambie la contraseña
> tras el primer inicio de sesión.

### Docker Compose

```bash
SESSION_SECRET="$(openssl rand -hex 32)" \
PUBLIC_URL="https://tickets.tuempresa.com" \
SEED_ADMIN_PASSWORD="una-contraseña-fuerte" \
docker compose up -d --build
```

`docker-compose.yml` expone el servicio en `:4000`, usa los volúmenes
`ticket_data` (base de datos) y `ticket_uploads` (adjuntos), y define un
healthcheck contra `/api/health`. Las variables anteriores se pueden colocar en
un archivo `.env` junto a `docker-compose.yml` en lugar de pasarlas en línea.

> Sin SMTP configurado (`MAIL_ENABLED=false`), los correos no se envían: se registran en la tabla `email_logs` y en consola (modo desarrollo), y el admin puede verlos desde **Configuración → Notificaciones**.

## Arquitectura

```
ticket/
├── backend/
│   ├── src/
│   │   ├── app.js            # Configuración de Express, sesiones, CSRF, rate limit
│   │   ├── server.js         # Bootstrap: migraciones + seed + jobs + listener
│   │   ├── config.js         # Variables de entorno
│   │   ├── db.js             # SQLite (node:sqlite), migraciones, transacciones
│   │   ├── schema.sql        # Esquema de base de datos (sinónimo de db.js)
│   │   ├── seed.js           # Roles, permisos, categorías, departamentos, usuarios
│   │   ├── middleware/       # auth (RBAC), csrf, upload, errors
│   │   ├── routes/           # auth, users, roles, tickets, categories,
│   │   │                     # departments, files, dashboard, reports, settings,
│   │   │                     # notifications (in-app), audit (historial global)
│   │   └── utils/            # password, validation, rateLimit, sessionStore,
│   │                         # fileType (magic bytes), ticketNumber, sla, mailer,
│   │                         # notifications (in-app), jobs (escalación/SLA)
│   └── test/                 # Tests con node:test + supertest
└── frontend/
    └── src/
        ├── context/AuthContext.jsx   # Sesión y permisos
        ├── lib/api.js                # Cliente fetch + CSRF
        ├── components/               # Layout, UI, filtros, tabla tickets,
        │                             # Notifications (campana)
        └── pages/                    # Login, Dashboard, Tickets, TicketDetail,
                                      # NewTicket, Inbox, Audit, Users, Categorías,
                                      # Roles, Configuración, etc.
```

## Base de datos

Relaciones principales:

- `users` → `roles` (N:1), `users` → `departments` (N:1)
- `roles` ↔ `permissions` vía `role_permissions`
- `tickets` → `reporter_id` (users), `assigned_to_id` (users), `assigned_team_id` (teams), `category_id`, `department_id`
  - Flujo de trabajo: `resolution*`, `root_cause`, `time_spent_minutes`, `resolved_by`, `closed_by`, `reopened_by`, `pending_reason`, `resolution_notified`
  - Cancelación: `cancel_reason`, `cancelled_by`, `cancelled_at`
  - Encuesta CSAT: `csat_rating`, `csat_comment`, `csat_answered_at`
- `ticket_comments`, `ticket_attachments`, `ticket_history` → `tickets` (N:1)
- `notifications` → `users` (N:1, campana in-app) y `tickets` (opcional)
- `sessions` y `sequences` (numeración `TCK-000001`)

Los usuarios no se borran físicamente; se desactivan para preservar el historial (integridad referencial).

## Automatización y escalación

El servidor ejecuta un job cada **10 minutos** (`src/utils/jobs.js`) que:

- Detecta tickets **vencidos en SLA** y notifica al responsable.
- **Escala tickets sin asignar**: si llevan más de `rule_unassigned_hours` sin asignación, sube su prioridad a `rule_unassigned_priority` (solo si la tienen inferior) y alerta a los administradores.
- **Alerta críticos sin resolver** llevan más de `rule_critical_hours` abiertos.

Los valores se configuran en **Configuración → Escalación automática** (`0` horas desactiva la regla). Para probar la escalación en desarrollo se puede invocar `runMaintenance()` manualmente.

## Seguridad

- Contraseñas con **bcrypt** (costo 12). Nunca en texto plano.
- Sesiones con `httpOnly` + `sameSite=lax` + protección CSRF.
- **Autorización en backend** por permiso en cada ruta; el frontend solo oculta opciones.
- Validación de entrada y archivos por contenido en el backend.
- Rate limiting en login y rutas `/api`.
- Errores de servidor sin exponer detalles al cliente.

## Extensibilidad

La arquitectura queda lista para: flujos de aprobación, encuestas avanzadas, inventario, integración LDAP/AD y multiempresa sin rehacer el núcleo.