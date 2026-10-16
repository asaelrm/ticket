# Auditoría de Seguridad Estática — Proyecto Ticket

- **Alcance:** `backend/` (Node.js + Express, ESM) y `frontend/` (React + Vite).
- **Tipo:** revisión estática de solo lectura (no se modificó código, no se arrancó el servidor, no se accedió a la base de datos).
- **Fecha:** 2026-10-12
- **Rama:** `integracion-casa-oficina-11oct`
- **Total de hallazgos:** 12 (0 Alta · 3 Media · 7 Baja · 2 Informativo)

---

## 1. [Media] Credenciales de prueba versionadas en git — REMEDIADO (2026-10-12)

- **Ubicación (histórica):** `backend/.env.mssql-test.example` (revisión previa al saneo).
- **Hallazgo:** el `.example` llegó a contener contraseñas con aspecto real de las cuentas que crea el seed: `MSSQL_TEST_ADMIN_PASS=TestAdmin123!`, `MSSQL_TEST_EMPLEADO_PASS=Empleado1234!`, `MSSQL_TEST_TECNICO_PASS=Tecnico1234!`, además de `SEED_ADMIN_PASSWORD=TestAdmin123!`, `SEED_DEMO_PASSWORD=Empleado1234!` y `SEED_TECH_PASSWORD=Tecnico1234!`, con `MSSQL_TEST_SERVER=100.100.4.60`. Quien tuviera acceso al repositorio conocía esas credenciales.
- **Remediación aplicada (commit `dd3001e`):** el archivo actual solo usa marcadores (`MSSQL_TEST_USER=usuario_migracion`, `MSSQL_TEST_PASSWORD=su_password_seguro_aqui`, `su_password_admin/empleado/tecnico_aqui`). No hay contraseñas reales en el archivo `.example` al día de hoy.
- **Riesgo residual (documentado):** las cadenas históricas permanecen en el historial publicado (`2be6b53`, `033021a`, `e7c7d1e`). Corresponden a las cuentas demo del runtime SQLite de desarrollo/pruebas (también documentadas en `presentacion_proyecto_tickets.txt`) y **no** coinciden con las contraseñas vigentes de `SIFHA_Tickets_M5_Integration_Test` (regeneradas al preparar la ejecución). Se recomienda rotarlas y, antes de una publicación pública amplia, decidir si sanear el historial.
- **Recomendación original:** sustituir por marcadores genéricos (aplicado) y rotar esas credenciales en la base de datos de pruebas si el host es accesible desde la red de trabajo.

## 2. [Media] `SESSION_SECRET` por defecto público fuera de `production`

- **Ubicación:** `backend/src/config.js:157` y `backend/src/config.js:254` (valor por defecto en `config.js:86`)
- **Descripción:** `collectStartupProblems()` retorna de inmediato cuando `NODE_ENV !== 'production'` (línea 157), por lo que la validación de arranque solo actúa en producción. En un despliegue con `NODE_ENV=staging` —o con la variable sin definir— el proceso arranca **sin error** usando el secreto de desarrollo `'ticket-dev-secret-change-me'` (línea 254), que es público y está en el repositorio. Un secreto de firma público permite forjar cookies de sesión.
- **Recomendación:** exigir un `SESSION_SECRET` real en cualquier entorno que no sea explícitamente `development`/`test` (y no solo en `production`), o fallar el arranque cuando el entorno no sea `development`.

## 3. [Media] Token de recuperación devuelto en la respuesta HTTP fuera de `production`

- **Ubicación:** `backend/src/routes/auth.js:127-130`
- **Descripción:** en `POST /api/auth/forgot-password`, si `config.env !== 'production'` la respuesta incluye `payload.token` y `payload.resetUrl`. En un despliegue tipo `staging` (o con `NODE_ENV` sin definir) cualquiera que conozca un nombre de usuario o correo obtiene el token de reseteo por la propia respuesta HTTP, lo que equivale a una toma de control de la cuenta.
- **Recomendación:** condicionar la devolución del token a un indicador explícito de desarrollo (`config.env === 'development'`), nunca a `!== 'production'`.

## 4. [Baja] Cookie de sesión sin flag `Secure` por defecto

- **Ubicación:** `backend/src/config.js:255` (aviso en `backend/src/app.js:48-53`)
- **Descripción:** `COOKIE_SECURE` tiene valor por defecto `false`, de modo que un despliegue de producción sin esa variable emite la cookie de sesión (`tf_sid`) sin el flag `Secure`, exponiéndola a intercepción en HTTP. La aplicación solo emite un **aviso**, no bloquea el arranque.
- **Recomendación:** forzar `COOKIE_SECURE=true` cuando `NODE_ENV=production` (o convertirlo en error de arranque configurable). El diseño actual se justifica por la doble vía LAN/HTTPS, pero debe quedar garantizado en el despliegue público.

## 5. [Baja] CORS sin cabecera `Vary: Origin`

- **Ubicación:** `backend/src/app.js:103-113`
- **Descripción:** el middleware refleja el `Origin` permitido y añade `Access-Control-Allow-Credentials: true`, pero no emite la cabecera `Vary: Origin`. Esto puede provocar envenenamiento de cachés intermedias si se sirve tras un proxy/CDN que cachee respuestas con `Access-Control-Allow-Origin`.
- **Recomendación:** añadir `res.vary('Origin')` en el middleware CORS.

## 6. [Baja] Token CSRF de doble envío sin vínculo con la sesión

- **Ubicación:** `backend/src/middleware/csrf.js:20-38`
- **Descripción:** la protección CSRF usa el patrón *double-submit* clásico (cookie `tf_csrf` de 48 hex + cabecera `x-csrf-token`), sin firmar el token ni ligarlo a la sesión. Mitigado por `sameSite: 'lax'` y `credentials: same-origin`, pero un atacante capaz de fijar cookies (subdominio comprometido o HTTP sin TLS) podría forjar el par cookie/cabecera.
- **Recomendación:** derivar el token CSRF de la sesión (p. ej. HMAC con `SESSION_SECRET` del `sessionID`) para que no pueda generarse sin conocer la sesión.

## 7. [Baja] Rate limiting en memoria basado en `req.ip` y dependiente de `TRUST_PROXY`

- **Ubicación:** `backend/src/utils/rateLimit.js:5-42` y `backend/src/transportSecurity.js:39-78`
- **Descripción:** el limitador vive en memoria del proceso y usa `req.ip` como clave. Detrás de Cloudflare, si `TRUST_PROXY` no está bien configurado, todas las peticiones comparten la IP del proxy y el límite se vuelve global (DoS de un solo cliente afecta a todos); si se configura `TRUST_PROXY=true`/`all`, un cliente puede falsificar `X-Forwarded-Proto`/`X-Forwarded-For`. El código documenta y valida el valor, pero la eficacia depende de la configuración de despliegue.
- **Recomendación:** fijar `TRUST_PROXY` a la IP o CIDR concreto del proxy y emplear un almacén compartido (Redis) si se despliegan varias réplicas.

## 8. [Baja] `/api/health` expone el entorno

- **Ubicación:** `backend/src/app.js:132`
- **Descripción:** el endpoint público `GET /api/health` devuelve `{ ok, env, time }` sin autenticación, revelando si la instancia corre en producción o desarrollo. Es información de reconocimiento útil para un atacante.
- **Recomendación:** omitir el campo `env` de la respuesta (o restringir el endpoint a un chequeo autenticado).

## 9. [Baja] Dependencias del backend con vulnerabilidades moderadas

- **Ubicación:** `backend/package.json` (resultado de `npm audit`: 5 moderadas, 0 altas, 0 críticas)
- **Descripción:** `exceljs` → `uuid` (GHSA-w5hq-g745-h8pq), `mssql` → `tedious` → `sprintf-js` (GHSA-hp3w-g68c-fv3c, DoS por precisión). Todas con corrección disponible.
- **Recomendación:** ejecutar `npm audit fix` y planificar la actualización de `mssql`/`tedious`/`sprintf-js`; para `exceljs`/`uuid` evaluar el salto de versión mayor.

## 10. [Baja] Dependencias del frontend vulnerables (toolchain de desarrollo)

- **Ubicación:** `frontend/package.json` (resultado de `npm audit`: 2 críticas, 2 altas, 5 moderadas)
- **Descripción:** `vitest` y `tinypool` (críticas), `vite` y `source-map-js` (altas), más moderadas (`react-router`, `react-router-dom`, `esbuild`, `@vitest/mocker`, `vite-node`). Están en `devDependencies`, por lo que no se empaquetan en el bundle de producción; el riesgo real afecta a la máquina de desarrollo y a la CI.
- **Recomendación:** actualizar `vite`/`vitest` a versiones parcheadas y aplicarlas en el entorno de desarrollo/CI. No bloqueante para la entrega del artefacto de producción.

## 11. [Informativo] Interpolación interna de identificadores en DDL

- **Ubicación:** `backend/src/db.js:17,34,51,53,157,215`
- **Descripción:** `db.js` interpola nombres de tabla, columna e índice en sentencias `PRAGMA`/`ALTER`/`DROP INDEX`. En todos los casos los valores son constantes internas del código o metadatos devueltos por `PRAGMA`, nunca datos de la petición, por lo que no existe inyección explotable. Se documenta como recordatorio de superficie.
- **Recomendación:** mantener la regla de que estos identificadores jamás se deriven de `req.*`; si en el futuro se parametrizaran, aplicar una lista blanca estricta.

## 12. [Informativo] Copias de `.env` con credenciales en el árbol y comparación de token no constante

- **Ubicación:** `backend/.env.backup-local`, `backend/directory.json` (ambos ignorados por git, presentes en disco) y `backend/src/routes/auth.js:186`
- **Descripción:** existen copias locales con credenciales (`backend/.env.backup-local`, con `DB_PASSWORD`) y un directorio de perfiles (`directory.json`). Están correctamente ignoradas por git, pero conviene no dejarlas dentro del árbol del repositorio. Además, la búsqueda del token de reseteo se hace por igualdad en SQL (no en tiempo constante); con 256 bits de entropía el ataque de temporización es inviable, por lo que es solo informativo.
- **Recomendación:** almacenar backups y `directory.json` fuera del repositorio; si se desea, comparar el hash del token en tiempo constante.

---

## Resumen

| Severidad | N.º | Hallazgos |
|---|---|---|
| **Alta** | 0 | — |
| **Media** | 3 | 1 · 2 · 3 |
| **Baja** | 7 | 4 · 5 · 6 · 7 · 8 · 9 · 10 |
| **Informativo** | 2 | 11 · 12 |
| **Total** | **12** | |

### Controles correctamente implementados

- **Cero secretos hardcodeados en el código fuente** y ningún `.env` real versionado: verificado con `git ls-files` y sobre todo el historial (`git rev-list --all --objects`). Solo se versionan los archivos `.example`.
- **Sin inyección SQL:** parametrización uniforme con placeholders (fachada `backend/src/db/runtime.js`); los fragmentos dinámicos usan listas blancas con `Object.hasOwn` (ORDER BY), generación de `?` para listas `IN` y escapado de `LIKE` (`backend/src/routes/tickets.js`, `cannedResponses.js`, `kbArticles.js`, `notifications.js`).
- **Aislamiento multi-tenant estricto:** la organización siempre se resuelve en el servidor y nunca se acepta desde el cliente (`backend/src/middleware/org.js`); todas las consultas filtran por `organization_id`.
- **Contraseñas y sesiones:** bcrypt con coste 12 (`backend/src/utils/password.js:4-6`), anti-enumeración por temporización con hash señuelo (`backend/src/routes/auth.js:24-47`), rotación de sesión en el login (`auth.js:63-75`), tokens de reseteo de 32 bytes hasheados con SHA-256 y caducidad de 24 h (`auth.js:107-117`), cuentas seed con contraseña inutilizable.
- **Cabeceras y subidas:** Helmet con CSP y `x-powered-by` deshabilitado (`backend/src/app.js:34,69-92`), HSTS condicional por host verificado (`transportSecurity.js:100-103`), validación de adjuntos por *magic bytes* con coherencia extensión-contenido (`backend/src/utils/fileType.js:23-85`), protección anti path traversal (`fileType.js:115-121`) y `Content-Disposition` saneado (`files.js:40-42`).
- **Errores:** el manejador solo expone detalles en errores 4xx y oculta la traza en 5xx, registrándola únicamente en consola (`backend/src/middleware/errors.js:8-13`).

## Conclusión

**APTO para entrega, sin bloqueantes.** No se identificó ningún hallazgo de severidad **Alta** ni vulnerabilidad crítica explotable en el código de producción.

Los tres hallazgos **Media** son riesgos de **endurecimiento de configuración/despliegue**, no fallos de la lógica de la aplicación, y se resuelven con cambios acotados antes de exponer la instancia públicamente:

1. Rotar las credenciales demo y decidir si sanear el historial que ya las publica (hallazgo 1 **remediado**: el `.example` actual está saneado; queda la rotación).
2. Extender la validación de arranque para exigir un `SESSION_SECRET` real en entornos distintos de `development` (hallazgo 2).
3. Limitar la devolución del token de reseteo a un flag explícito de desarrollo (hallazgo 3).

Se recomienda, además, actualizar las dependencias (`npm audit fix`) y cerrar los hallazgos **Baja** como parte del plan de mantenimiento.

---

## Segunda ronda (2026-10-13) — hallazgos puntuales y remediación aplicada

- **Tipo:** auditorías dirigidas sobre `backend/` y `frontend/` (análisis estático asistido, sin arrancar servidor ni tocar la base de datos).
- **Resultado:** posturas globales sólidas (SQL parametrizado, tenancy en servidor, CSRF, magic bytes, doble validación de permisos). Se corrigieron hallazgos puntuales, todos verificados con pruebas de regresión.
- **Validación:** backend 874/872 (2 skip), con 9 regresiones nuevas; frontend 1080/1080 + `vite build` OK.

### Backend — corregido

1. **[Alta] Inyección de fórmulas en exportaciones CSV/XLSX** (reports.js ~482, tickets.js ~733). Las celdas iniciadas con `=`, `+`, `-`, `@`, tab o CR eran interpretadas como fórmula al abrir en Excel/Sheets. Remediado con `csvSafe` (prefijo `'`) unificado para CSV y XLSX. Cubierto con **9 regresiones nuevas** en `backend/test/security-regressions.test.js` (`=2+2`, `+41`, `-1+2`, `@SUM(A1)`, `='+1+1'`, `=HOLA()`, `-42`…).
2. **[Media] Wildcard de `LIKE` sin escapar** (`users.js` search, `audit.js` search). `%`/`_`/`\` de la búsqueda se trataban como comodines. Remediado con `escapeLike` + cláusula `ESCAPE '\'`.
3. **[Media] `GET /users/:id/tickets` sin filtro de organización en la consulta** (`users.js`). El objetivo se validaba por org, pero las consultas de tickets no filtraban → posible fuga entre organizaciones. Remediado añadiendo `AND t.organization_id = ?` a COUNT, byStatus y listado.
4. **[Media] Token de reset devuelto en claro en `POST /users/:id/reset-password`** (`users.js`). Remediado siguiendo la política de `auth.js`: `notifyPasswordReset` envía el token por correo y este solo se devuelve en la respuesta cuando `config.env === 'development'`.
5. **[Baja] Filtrado de CR/LF en nombres de archivo** (`fileType.js`) y **[Baja] salto de línea en el asunto del correo** (`mailer.js`, `sendMail`): saneado de `[\r\n\t]` para prevenir cabeceras/adjuntos malformados.

### Frontend — corregido

1. **[Alta] `MyTickets` ignoraba `?search=`** (búsqueda global de la cabecera). Remediado con `useSearchParams`: inicializa el filtro desde la URL, se realinea si la URL cambia desde fuera y refleja el término en la URL con `replace: true`.
2. **[Media] Sin manejo global de sesión caducada (401).** Remediado en `lib/api.js` con un bus `onUnauthorized`/`emitUnauthorized` que excluye los endpoints públicos y `/api/auth/me`; `AuthContext` se suscribe y al recibir el aviso hace `queryClient.clear()` + `setUser(null)` para que `Protected` redirija a `/login`.
3. **[Media] Filtro de usuarios de auditoría limitado a 15.** Remediado solicitando `perPage=100`. Además, si el rol tiene `settings.manage` pero no `user.view` (403 del directorio), el filtro se **oculta** en vez de fallar en silencio.
4. **[Baja] `JSON.parse` del SSE sin protección** (`Notifications.jsx`): un mensaje malformado no tumba el panel.
5. **[Baja] Decremento optimista de no leídas sin rollback**: si `POST /api/notifications/read` falla, se invalida `notifications-unread` para volver a leer el contador.
6. **[Baja] Escape cerraba toasts y panel a la vez**: el diálogo del panel ahora declara `aria-modal="true"`, que el manejador de `Toast` ya respeta para no robar el Escape.
7. **[Baja] `TextField` de `Users` sin asociación label-input**: `useId` + `htmlFor`/`id` + `aria-describedby` del texto de ayuda.

### Dependencias — decisión y bloqueos documentados

- `react-router-dom` 6.28.1 → **7.18.4**: upgrade aplicado y verificado (1080/1080, build OK). Sin cambios de código: la API usada (BrowserRouter, MemoryRouter, useSearchParams, Routes/Route, Link) es compatible. Se mantiene.
- `vite` 5.4.x / `vitest` 2.1.x / `esbuild` / `tinypool` (`npm audit`: 6 hallazgos, 2 críticos, todos de la **toolchain de desarrollo**): **RESUELTO en la tercera ronda** actualizando a `vite@7.3.7` + `vitest@4.1.11` + `@vitejs/plugin-react@4.7.0` (`@tailwindcss/vite` 4.3.3 ya admite Vite 7). Verificado con 1080/1080 y `vite build` OK; `npm audit` pasa a **0 hallazgos**. No cambia el bundle de producción.
- Backend `uuid <11.1.1` (2 moderadas vía `exceljs`): **RESUELTO en la tercera ronda** con un `overrides` de npm a `uuid@11.1.1`. `exceljs` solo usa `uuid.v4()` (sin `buf`), por lo que el cambio no altera su comportamiento; verificado con la suite backend completa. `npm audit` pasa a **0 hallazgos**.
- Debounce en búsquedas de `Users`/`KnowledgeAdmin`: **no implementado** (cambio de comportamiento con riesgo para los tests existentes con timers; valor bajo). Pendiente solo documental.

---

## Tercera ronda (2026-10-13) — dependencias y endurecimiento de respuestas

- **Tipo:** auditoría final de seguridad orientada a publicación (análisis estático + `npm audit` + pruebas locales). No se modificó ninguna base de datos ni se ejecutó nada contra SQL Server.
- **Validación:** backend **888/890 (2 omitidas)**, frontend **1080/1080**, `vite build` OK, `npm audit` **0 hallazgos** en backend y frontend.

### Resuelto

1. **[Baja] Backend `uuid@8.3.2` (vía `exceljs`) → `uuid@11.1.1`.** Advisory GHSA-w5hq-g745-h8pq (CVSS 7.5) sobre `v3/v5/v6` con `buf` provisto. Se añadió `"overrides": { "uuid": "^11.1.1" }` en `backend/package.json`. `exceljs` únicamente invoca `uuid.v4()` (`node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`), por lo que no hay cambio de comportamiento; lo confirma la suite backend (exportaciones incluidas).
2. **[Crítica/Media] Frontend toolchain `vite` 5.4.x · `vitest` 2.1.x · `esbuild` · `tinypool` · `@vitest/mocker` · `vite-node`.** 6 hallazgos (`tinypool` crítico por RCE, `vitest` crítico por lectura/ejecución de ficheros con el UI server escuchando). Actualizado a `vite@^7.3.7`, `vitest@^4.1.11` y `@vitejs/plugin-react@^4.7.0`. Son dependencias de desarrollo (no entran en el bundle), pero la build y las 1080 pruebas siguen verdes. `npm audit` pasa a 0.
3. **[Baja] CORS sin `Vary: Origin`** (`app.js`). Se añadió `res.vary('Origin')` cuando la petición trae `Origin`, para que un proxy/CDN no reutilice una respuesta CORS de un origen para otro. Regresión en `backend/test/security-regressions.test.js`.
4. **[Baja] `/api/health` exponía `env`** (`app.js`). El endpoint anónimo devolvía `NODE_ENV`, útil para reconocimiento. Se eliminó el campo; la respuesta queda en `{ ok, time }`. Regresión en `security-regressions.test.js`.

### Verificado sin cambios (postura correcta)

- **Sin secretos ni credenciales reales versionadas:** `git grep` sobre todo el árbol (patrones `PASSWORD=`, `SECRET=`, `api_key`, claves AWS/GitHub/Azure, `BEGIN PRIVATE KEY`, `Authorization: Basic`) no devuelve valores reales; solo marcadores, credenciales de fixtures de test y variables de entorno sin asignar. Los `.example` están saneados.
- **XSS frontend:** `lib/markdown.js` escapa el HTML antes de aplicar el subconjunto de Markdown y **nunca** genera `href/src/style/on*` desde el texto del usuario; `lib/print.js` escapa cada interpolación con `esc()`. No hay tokens de sesión en `localStorage` (sesión por cookie `httpOnly`); el token de reseteo usa `sessionStorage` por pestaña y se borra de la URL.
- **Adjuntos:** `routes/files.js` exige sesión, `canViewTicket`, permiso `ticket.note` para notas internas, `attachmentPath` bloquea path traversal y los nombres se sanean al persistir (`fileType.persistUpload`), evitando inyección de cabeceras en `Content-Disposition`.
- **Acciones administrativas y aislamiento multiempresa:** sin cambios; el canal `/api/organizations` sigue reservado a `SUPERADMIN` y las consultas filtran por `organization_id`.

### Riesgo residual (no corregible sin romper el proyecto)

- **Identificadores de infraestructura interna en el repositorio público:** `100.100.4.60` (IP de la red Tailscale), `TI-DESK-01\SIFHADEV` (host/instancia SQL) y el hostname interno `tickets.lan` aparecen en documentación y, sobre todo, en los **scripts de migración como guardas de identidad** (p. ej. `apply-groupD-not-null*.sql`, `backup-m5.sql`, `m5-preflight.js`). Son funcionales: pruebas de regresión exigen su presencia. Eliminarlos rompería la seguridad de las migraciones (evitan ejecutar sobre el servidor equivocado) y las suites. La IP `100.100.4.60` está en el rango CGNAT de Tailscale y **no es enrutable desde Internet**; aun así, se recomienda mantener el repositorio **privado** o aceptar su exposición como información de baja sensibilidad. No se reescribió historial ni se hizo force push (por restricción expresa).
- **Exposición histórica de credenciales demo** (hallazgo 1, primera ronda): sigue presente en el historial publicado; el `.example` actual está saneado y las credenciales de la base de pruebas fueron regeneradas. Se recomienda rotarlas si el host fuera accesible, y decidir si se saneaba el historial antes de una publicación pública amplia.
- **Duplicados de borrador versionados** (`backend/scripts/migration/reconcile-dev-draft-corregido (1).sql`, `…-corregido-v2.sql`): copias de trabajo del `.sql` de referencia. Se dejan intactos por la restricción de no descartar trabajo; se recomienda eliminarlos en una limpieza aparte.
