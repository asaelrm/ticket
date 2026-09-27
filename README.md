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

## Directorio de usuarios y departamentos

`backend/directory.json` guarda el **perfil** de las cuentas (nombre, correo,
departamento, puesto, rol, si está activa) y de los departamentos. Se regenera
solo al crear, editar o desactivar un usuario o departamento.

Dos reglas que no se negocian:

- **El archivo no lleva contraseñas.** Ni hashes, ni nada. La contraseña de cada
  cuenta vive únicamente en la tabla `users`.
- **El archivo no está en Git.** Es estado de cada instalación, igual que la base
  de datos. Está en `.gitignore`.

Consecuencia práctica: restaurar el directorio **nunca cambia una contraseña**.
Si alguien cambia una contraseña y reinicia, sigue siendo la nueva. Y un
archivo `directory.json` antiguo que traiga hashes de una versión previa se
ignora: el backend avisa por consola y no los aplica.

> Si la versión antigua de este repositorio publicó `directory.json` con hashes,
> ese hashes se considera comprometido. Consulte
> [Retirar el archivo del historial](#retirar-el-archivo-del-historial).

### Llevar el directorio a otra instalación

Al no estar versionado, `git pull` ya no lo trae. Copie el archivo a la otra
máquina por el canal que prefiera (una carpeta de red, un pendrive, un gestor de
secretos) y déjelo en `backend/directory.json`, o indique otra ruta con
`DIRECTORY_SNAPSHOT_FILE`. Si el destino ya tiene esas cuentas, solo se actualiza
el perfil; las contraseñas se quedan como estén.

Las cuentas que solo existan en el archivo se crean con una contraseña
aleatoria e inutilizable, y el backend avisa de cuáles son: un administrador
debe restablecerlas antes de que puedan entrar.

## Cuentas iniciales (seed)

En **desarrollo** se crean automáticamente tres cuentas de demostración —`admin`,
`tecnico` y `empleado`— con una contraseña de ejemplo definida en
[`backend/src/seed.js`](backend/src/seed.js). **No se documentan aquí a
propósito**: una contraseña de ejemplo escrita en el README acaba en
producción, en una captura de pantalla o en un ticket, y con ella cualquiera que
lea el repositorio entra como administrador.

> **Cámbielas en el primer inicio**, antes de usar el sistema con datos de
> verdad. La contraseña se cambia en *Mi perfil* y desde *Usuarios* para las
> cuentas de los demás.

En **producción** las cuentas demo con contraseña conocida **no se crean**. El
administrador inicial se crea al arrancar solo si define `SEED_ADMIN_PASSWORD`
(opcionalmente `SEED_ADMIN_USERNAME` y `SEED_ADMIN_EMAIL`).

Si el administrador **ya existe**, `SEED_ADMIN_PASSWORD` **no hace nada**: el
arranque avisa por consola y respeta la contraseña que haya. Así, una variable
que se quedó en el entorno no puede devolver el sistema a una contraseña conocida
en cada reinicio. Si de verdad necesita restablecer el acceso del
administrador, defina además `SEED_ADMIN_FORCE_PASSWORD=true` **una sola vez**,
compruebe que puede entrar y quite las dos variables.


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

### Tests del backend

`npm test` carga [`backend/test/setup.js`](backend/test/setup.js), que crea una
base de datos **temporal**, la migra, la siembra y la borra al terminar. Por eso
la suite nunca escribe en `backend/data/tickets.db`, aunque se ejecute desde
cualquier carpeta.

Lance siempre los tests con `npm test`. Si los arranca a mano con
`node --test test/loquesea.test.js` **sin** el `--import`, los archivos que no
usan `test/helpers.js` se conectan con la base de datos real.

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
| `PUBLIC_URL`           | URL pública (sin slash final) usada para construir los enlaces absolutos de los correos, p. ej. el de recuperación de contraseña. Si no se define, se toma el origen del frontend (`CORS_ORIGIN`), no el puerto de la API. |
| `CORS_ORIGIN`          | Origen permitido por CORS. En producción con la SPA servida por el propio backend, use el mismo valor que `PUBLIC_URL`.                |
| `CORS_ORIGINS`         | Alternativa a `CORS_ORIGIN`: lista de orígenes separados por comas. Tiene prioridad sobre `CORS_ORIGIN`.                               |
| `COOKIE_SECURE`        | `true` cuando se sirve por HTTPS para que la cookie de sesión solo viaje por canales seguros.                                          |
| `SEED_ADMIN_PASSWORD`  | Contraseña del administrador inicial. Solo se usa **al crearlo**: si la cuenta ya existe, no se aplica y el arranque avisa. Las cuentas demo no se crean en producción. |
| `SEED_ADMIN_FORCE_PASSWORD` | `true` vuelve a aplicar `SEED_ADMIN_PASSWORD` aunque el administrador ya exista. Es la única vía de recuperación: úsela una vez y quítela. |
| `SEED_ADMIN_USERNAME`  | Usuario del administrador inicial (por defecto `admin`).                                                                               |
| `SEED_ADMIN_EMAIL`     | Correo del administrador inicial (por defecto `admin@empresa.com`).                                                                    |
| `DIRECTORY_SYNC`       | `false` desactiva por completo el archivo `directory.json` (por defecto `true`).                                                      |
| `DIRECTORY_SNAPSHOT_FILE` | Ruta del archivo del directorio (por defecto `backend/directory.json`). Ya no lleva contraseñas.                                   |

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

## Retirar el archivo del historial

`backend/directory.json` estuvo versionado en este repositorio y sus primeras
versiones llevaban `password_hash` de las cuentas. El archivo ya no se versiona,
pero **los commits antiguos siguen ahí** y, si el repositorio fue público, esos
hashes se consideran comprometidos: quitar el archivo del historial no los
arregla.

El orden importa, y no es negociable:

1. **Cambie las contraseñas primero.** De las cuentas del directorio y del
   administrador. Es el paso que neutraliza los hashes; el siguiente solo limpia
   el historial. Recuperar el acceso con `SEED_ADMIN_FORCE_PASSWORD=true` una
   sola vez, y quitar la variable después.
2. **Clonar el repositorio en una copia de trabajo** y reescribir el historial
   con [`git filter-repo`](https://github.com/newren/git-filter-repo), quitando
   `backend/directory.json` de todos los commits:
   `git filter-repo --path backend/directory.json --invert-paths`
3. Verificar con `git log --all -- backend/directory.json` (no debe dar nada) y
   con `git grep password_hash $(git rev-list --all)` (tampoco).
4. **Solo entonces** publicar el historial reescrito. Reescribir el historial
   cambia todos los identificadores de commit: obliga a coordinarse con quien
   tenga el repositorio y a un `push --force-with-lease` deliberado. Todo el
   mundo que tenga el repositorio debe volver a clonarlo.

No haga el paso 4 sin el paso 1 hecho y comprobado. Y si el repositorio nunca
salió de su red, el paso 1 sigue siendo necesario: los hashes de bcrypt tienen
meses de vida, y un hash robado se crackea sin dificultad con un equipo modesto.

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
<!-- Prueba auto-push 09/20/2026 23:18:30 -->
