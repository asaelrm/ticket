# Ticket Flow

Sistema empresarial de gestión de tickets e incidencias. Backend `Node.js (Express)` + `SQLite`, frontend `React (Vite) + Tailwind`.

## Características

- **Autenticación** por sesión con cookies `httpOnly`, hash de contraseñas con bcrypt, protección CSRF (double-submit) y rate limiting.
- **RBAC** con roles iniciales **Empleado** y **Administrador**, y estructura lista para **Técnico / Soporte**.
- **Tickets**: creación con adjuntos (imágenes y documentos), categorías, prioridades, estados, historial completo y auditoría.
- **Adjuntos**: validación por contenido (magic bytes), nombres internos únicos, descarga protegida por permisos.
- **Dashboard** administrativo con métricas y gráficos en SQL.
- **Filtros combinados** (fecha, período, categoría, departamento, usuario, prioridad, estado, búsqueda).
- **Exportación CSV** de tickets.
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

| Rol        | Usuario  | Contraseña      |
| ---------- | -------- | --------------- |
| Admin      | `admin`  | `Admin1234!`    |
| Empleado   | `empleado`| `Empleado1234!` |

> Cambie estas contraseñas tras el primer inicio.

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
3. `npm start` — el backend sirve la API y el frontend compilado.

## Arquitectura

```
ticket/
├── backend/
│   ├── src/
│   │   ├── app.js            # Configuración de Express, sesiones, CSRF, rate limit
│   │   ├── server.js         # Bootstrap: migraciones + seed + listener
│   │   ├── config.js         # Variables de entorno
│   │   ├── db.js             # SQLite (node:sqlite), migraciones, transacciones
│   │   ├── schema.sql        # Esquema de base de datos
│   │   ├── seed.js           # Roles, permisos, categorías, departamentos, usuarios
│   │   ├── middleware/       # auth (RBAC), csrf, upload, errors
│   │   ├── routes/           # auth, users, roles, tickets, categories,
│   │   │                     # departments, files, dashboard, reports, settings
│   │   └── utils/            # password, validation, rateLimit, sessionStore,
│   │                         # fileType (magic bytes), ticketNumber
│   └── test/                 # Tests con node:test + supertest
└── frontend/
    └── src/
        ├── context/AuthContext.jsx   # Sesión y permisos
        ├── lib/api.js                # Cliente fetch + CSRF
        ├── components/               # Layout, UI, filtros, tabla tickets
        └── pages/                    # Login, Dashboard, Tickets, TicketDetail,
                                      # NewTicket, Users, Categorías, Roles, etc.
```

## Base de datos

Relaciones principales:

- `users` → `roles` (N:1), `users` → `departments` (N:1)
- `roles` ↔ `permissions` vía `role_permissions`
- `tickets` → `reporter_id` (users), `assigned_to_id` (users), `category_id`, `department_id`
- `ticket_comments`, `ticket_attachments`, `ticket_history` → `tickets` (N:1)
- `sessions` y `sequences` (numeración `TCK-000001`)

Los usuarios no se borran físicamente; se desactivan para preservar el historial (integridad referencial).

## Seguridad

- Contraseñas con **bcrypt** (costo 12). Nunca en texto plano.
- Sesiones con `httpOnly` + `sameSite=lax` + protección CSRF.
- **Autorización en backend** por permiso en cada ruta; el frontend solo oculta opciones.
- Validación de entrada y archivos por contenido en el backend.
- Rate limiting en login y rutas `/api`.
- Errores de servidor sin exponer detalles al cliente.

## Extensibilidad

La arquitectura queda lista para: tercer rol **Técnico**, SLA, notificaciones por correo, asignación automática, encuestas, exportación Excel/PDF, inventario, integración LDAP/AD y multiempresa sin rehacer el núcleo.