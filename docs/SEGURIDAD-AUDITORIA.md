# Auditoría de Seguridad Estática — Proyecto Ticket

- **Alcance:** `backend/` (Node.js + Express, ESM) y `frontend/` (React + Vite).
- **Tipo:** revisión estática de solo lectura (no se modificó código, no se arrancó el servidor, no se accedió a la base de datos).
- **Fecha:** 2026-10-12
- **Rama:** `integracion-casa-oficina-11oct`
- **Total de hallazgos:** 12 (0 Alta · 3 Media · 7 Baja · 2 Informativo)

---

## 1. [Media] Credenciales de prueba versionadas en git

- **Ubicación:** `backend/.env.mssql-test.example:16,28,32,36,43,45,46`
- **Descripción:** el archivo de ejemplo de pruebas de integración MSSQL está **rastreado en git** y contiene contraseñas con aspecto real de las cuentas que crea el seed: `MSSQL_TEST_ADMIN_PASS=TestAdmin123!`, `MSSQL_TEST_EMPLEADO_PASS=Empleado1234!`, `MSSQL_TEST_TECNICO_PASS=Tecnico1234!`, además de `SEED_ADMIN_PASSWORD=TestAdmin123!`, `SEED_DEMO_PASSWORD=Empleado1234!` y `SEED_TECH_PASSWORD=Tecnico1234!`. Solo `MSSQL_TEST_PASSWORD` es un marcador (`su_password_seguro_aqui`). Cualquier persona con acceso al repositorio conoce estas credenciales; si el servidor de pruebas declarado (`MSSQL_TEST_SERVER=100.100.4.60`) es alcanzable y está sembrado, permiten iniciar sesión directamente.
- **Recomendación:** sustituir por marcadores genéricos (`cambie-esta-clave`), eliminar las contraseñas reales del repositorio y rotar esas credenciales en la base de datos de pruebas si el host es accesible desde la red de trabajo.

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

1. Retirar y rotar las credenciales de prueba del archivo `.env.mssql-test.example` (hallazgo 1).
2. Extender la validación de arranque para exigir un `SESSION_SECRET` real en entornos distintos de `development` (hallazgo 2).
3. Limitar la devolución del token de reseteo a un flag explícito de desarrollo (hallazgo 3).

Se recomienda, además, actualizar las dependencias (`npm audit fix`) y cerrar los hallazgos **Baja** como parte del plan de mantenimiento.
