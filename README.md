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

La primera vez que arranca, el backend aplica migraciones y crea el seed
automáticamente, pero **no crea ninguna cuenta**: no hay contraseñas por defecto
en el código. Para poder entrar, defina `SEED_ADMIN_PASSWORD` en
`backend/.env` con 12+ caracteres, arranque, entre y quítela. Si quiere las
cuentas de demostración, añada `SEED_DEMO_ACCOUNTS=true` junto con
`SEED_DEMO_PASSWORD` y `SEED_TECH_PASSWORD`. Ver
[Cuentas iniciales (seed)](#cuentas-iniciales-seed).


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

El seed **no inventa ninguna contraseña**. No existe ningún valor por defecto
escrito en el código: sin configuración, no se crea ninguna cuenta. Es
deliberado, porque el fallo que causa más daños es el despliegue que arranca
"sin querer" y nace con un `admin` de contraseña pública.

### Administrador (el procedimiento normal)

1. Defina `SEED_ADMIN_PASSWORD` con 12 caracteres o más
   (opcionalmente `SEED_ADMIN_USERNAME` y `SEED_ADMIN_EMAIL`).
2. Arranque una vez: se crea el administrador con esa contraseña.
3. Entre, cámbiela en *Mi perfil* y **quite `SEED_ADMIN_PASSWORD` del entorno**.

En producción, una `SEED_ADMIN_PASSWORD` de menos de 12 caracteres o con aspecto
de valor de ejemplo **impide el arranque**.

Si el administrador **ya existe**, `SEED_ADMIN_PASSWORD` **no hace nada**: el
arranque avisa por consola y respeta la contraseña que haya. Así, una variable
que se quedó en el entorno no puede devolver el sistema a una contraseña conocida
en cada reinicio. Si de verdad necesita restablecer el acceso del
administrador, defina además `SEED_ADMIN_FORCE_PASSWORD=true` **una sola vez**,
compruebe que puede entrar y quite las dos variables.

### Cuentas de demostración

`tecnico` y `empleado` solo se crean si usted lo pide **explícitamente** con
`SEED_DEMO_ACCOUNTS=true`. Que `NODE_ENV` no sea `production` **ya no basta**:
un despliegue con `NODE_ENV=staging`, o sin definir, también es una instalación
real. En producción la aplicación **rechaza** esa variable y no arranca.

Indique también `SEED_DEMO_PASSWORD` y `SEED_TECH_PASSWORD` si quiere poder
entrar con ellas. Si no lo hace, las cuentas se crean con una contraseña
aleatoria inusable y el arranque avisa de cuáles son, en lugar de darles una
contraseña que está escrita en el repositorio.


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
| `npm run migrate:departments` | B13-A: dry-run de la migración de `departments` a SQL Server. No escribe |
| `npm run migrate:departments:execute` | B13-A: ejecuta la Fase 1 (cargar las 25 filas). Hoy **aborta**: el destino quedó en `RECUPERACION_MANUAL` |
| `npm run verify:departments` | B13-A: clasifica el destino, solo lectura |

Los tres de B13-A se ejecutan **dentro del contenedor** (`ticket-dev-backend`),
porque la SQLite de origen es la del volumen `ticket_dev_data`, no la del host.
Ver [`backend/src/scripts/B13-A.md`](backend/src/scripts/B13-A.md).

B13-A está partido en **dos fases**: la Fase 1 carga las 25 filas y es
transaccional; la Fase 2 ajusta la identidad a 480 y no lo es, porque el
`ROLLBACK` no la restaura. Eso está medido, no supuesto: un `INSERT` explícito
con `id = 478` dejó el contador en 478 después de deshacer, y el destino está
ahora en `0` filas / `last_value 478`. El migrador reconoce cuatro estados
(`CARGA_PENDIENTE`, `CARGA_CONFIRMADA_RESEED_PENDIENTE`, `COMPLETADO`,
`RECUPERACION_MANUAL`) y solo escribe en el primero. Volver a
`CARGA_PENDIENTE` exige una restauración administrativa aprobada que este
código no hace.

`migrate:departments:execute` **no** se ejecuta con `sifha_ticket_dev`: usa una
identidad **exclusiva de migración** con permisos temporales `SELECT`, `INSERT` y
`ALTER` solo sobre `SIFHA_Tickets_DEV.dbo.departments`, que un administrador
concede antes de la ventana y revoca después. El nombre de esa identidad se
declara en `B13A_MIGRATION_LOGIN`, que es una allowlist de un solo nombre
**sin contraseña**; el migrador solo verifica esos permisos, no los otorga. El
dry-run no necesita esa variable.

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
2. Configurar `.env` con `NODE_ENV=production`, `PUBLIC_URL`, `SESSION_SECRET`
   aleatorio de 32+ caracteres, `COOKIE_SECURE=true` y dominio HTTPS. Con la
   configuración incompleta el proceso **no arranca** (ver
   [Qué impide el arranque en producción](#qué-impide-el-arranque-en-producción)).
3. Para correos reales, definir `MAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM`.
4. `npm start` — el backend sirve la API y el frontend compilado.

### Variables de entorno relevantes

| Variable               | Descripción                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `production` activa las validaciones estrictas de arranque (sección siguiente).                                                       |
| `SESSION_SECRET`       | **Obligatoria en producción**: 32+ caracteres aleatorios. El arranque falla si falta, si es corta, si se parece a un valor de ejemplo o si repite un patrón corto. |
| `PUBLIC_URL`           | **Obligatoria en producción** (URL sin slash final): sin ella el proceso no arranca, porque los enlaces de los correos quedarían mal construidos. |
| `CORS_ORIGIN`          | Origen permitido por CORS. En producción con la SPA servida por el propio backend, use el mismo valor que `PUBLIC_URL`.                |
| `CORS_ORIGINS`         | Alternativa a `CORS_ORIGIN`: lista de orígenes separados por comas. Tiene prioridad sobre `CORS_ORIGIN`.                               |
| `COOKIE_SECURE`        | `true` cuando se sirve por HTTPS para que la cookie de sesión solo viaje por canales seguros. Si está apagado en producción, el arranque **avisa**. |
| `SEED_ADMIN_PASSWORD`  | Contraseña del administrador inicial (12+ caracteres en producción). Solo se usa **al crearlo**: si la cuenta ya existe, no se aplica y el arranque avisa. |
| `SEED_ADMIN_FORCE_PASSWORD` | `true` vuelve a aplicar `SEED_ADMIN_PASSWORD` aunque el administrador ya exista. Es la única vía de recuperación: úsela una vez y quítela. |
| `SEED_ADMIN_USERNAME`  | Usuario del administrador inicial (por defecto `admin`).                                                                               |
| `SEED_ADMIN_EMAIL`     | Correo del administrador inicial (por defecto `admin@empresa.com`).                                                                    |
| `SEED_DEMO_ACCOUNTS`   | `true` crea `empleado` y `tecnico`. **Rechazado en producción**, donde además impide el arranque. Por defecto `false`.              |
| `SEED_DEMO_PASSWORD`   | Contraseña de la cuenta `empleado`. Si falta, la cuenta nace con una contraseña aleatoria inusable.                                  |
| `SEED_TECH_PASSWORD`   | Contraseña de la cuenta `tecnico`. Si falta, la cuenta nace con una contraseña aleatoria inusable.                                    |
| `DIRECTORY_SYNC`       | `false` desactiva por completo el archivo `directory.json` (por defecto `true`).                                                      |
| `DIRECTORY_SNAPSHOT_FILE` | Ruta del archivo del directorio (por defecto `backend/directory.json`). Ya no lleva contraseñas.                                   |

### Qué impide el arranque en producción

`NODE_ENV=production` no es una etiqueta: activa una comprobación al importar la
configuración, es decir **antes** de crear directorios, migrar o insertar
usuarios. Si algo de esto falla, el proceso muere con el motivo en pantalla en
lugar de seguir adelante con un valor por defecto:

- `SESSION_SECRET` ausente, más corto de 32 caracteres, o con aspecto de valor de
  ejemplo (`cambie-esto`, `change-me`, un patrón corto repetido, el secreto de
  desarrollo del repositorio...).
- `SEED_ADMIN_PASSWORD` con menos de 12 caracteres o con aspecto de ejemplo.
- `SEED_DEMO_ACCOUNTS=true`, que en producción es un error de configuración.
- `PUBLIC_URL` ausente o mal formada.

Además avisa —sin impedir el arranque— si `COOKIE_SECURE` está apagado o si
`PUBLIC_URL`/`CORS_ORIGIN` siguen apuntando a `localhost`.

> En producción las cuentas demo con contraseña conocida **no se crean ni se
> pueden pedir**. Defina `SEED_ADMIN_PASSWORD` para crear el administrador
> inicial y cambie la contraseña tras el primer inicio de sesión.

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

`SESSION_SECRET` es la única variable que el compose **exige** (`${SESSION_SECRET:?…}`):
si falta, `docker compose up` no arranca en lugar de inventar un secreto.
`SEED_ADMIN_PASSWORD` no tiene valor por defecto, y `PUBLIC_URL` se deja vacía a
propósito para que la aplicación decida: definiéndola se evita el fallo de
arranque. `COOKIE_SECURE` y `PUBLIC_URL` no tienen valor por defecto en el compose
base porque el override de HTTPS los fija; fijar aquí un valor por defecto rompería
esa combinación.

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
