# SIFHA — Lista de verificación de entrega

Documento de aceptación para la entrega institucional. Acompaña a
`ENTREGA-INFRAESTRUCTURA.md` (infraestructura) y `M5-PROCEDIMIENTO-WINDOWS.md`
(corrección de SQL Server). Última revisión automática de la sesión descrita
abajo.

## 1. Estado de pruebas (local, entorno de desarrollo)

| Suite | Comando | Resultado |
| --- | --- | --- |
| Backend | `cd backend; npm test` | 823 tests, 821 pass, 2 skipped, 0 fail |
| Frontend | `docker exec -w /app/frontend ticket-dev-frontend npx vitest run` | 44 archivos, 1078 pass |
| Build producción frontend | `npx vite build` (contenedor frontend) | OK |
| Traducción SQLite→T-SQL | `node --test test/mssql-sql-translation.test.js` | 249 sentencias, 0 incompatibles |
| Autodiagnóstico M5 (sin red) | `DIAGNOSE_SELFCHECK=1 node scripts/migration/diagnose-m5-validation.js` | pass (24 tablas, 23 índices) |

## 2. Checklist funcional (probado por pruebas automatizadas)

- [x] Inicio de sesión, cierre y expiración de sesión.
- [x] Recuperación de contraseña con token y caducidad (24 h).
- [x] Creación, edición y asignación de tickets.
- [x] Flujo de estados: OPEN → ASSIGNED → IN_PROGRESS → PENDING → RESOLVED → CLOSED / CANCELLED.
- [x] Comentarios y notas internas; historial y línea de tiempo.
- [x] Adjuntos: validación de tipo por contenido, límites y autorización de descarga.
- [x] Notificaciones internas y correo (con `MAIL_ENABLED`).
- [x] SLA: cálculo, vencimiento y tareas programadas de aviso.
- [x] Roles, permisos, departamentos, equipos y administración de usuarios.
- [x] Aislamiento multiempresa (filtros por `organization_id` y FK compuestas).
- [x] Auditoría, reportes y exportaciones (CSV/XLSX/PDF) por organización.
- [x] Dashboard y configuración general (global y por organización).
- [x] Manejo de errores HTTP 400/401/403/404/500 en API y frontend.
- [x] Ruta raíz `/` redirige a `/app` (sin 404 espurio).

## 3. Checklist técnico

- [x] SQLite por defecto; mismo código sirve ambos motores por la fachada `db/runtime.js`.
- [x] Traductor de dialecto cubre todas las sentencias estáticas de `backend/src`.
- [x] Validación de esquema MSSQL antes de arrancar (solo lectura).
- [x] Docker de producción con healthcheck (`/api/health`).
- [x] Docker de desarrollo con healthchecks de backend y frontend.
- [x] Sin secretos ni cadenas de conexión en el repositorio.
- [x] `.gitignore` cubre `.env`, `*.db`, `*.bak`, `*.log`, `dist/`, `uploads/`.
- [x] Arranque de producción exige `SESSION_SECRET` y `PUBLIC_URL`.

## 4. Bloqueos conocidos (P0 antes de usar MSSQL real)

- [ ] **M5**: `dbo.notifications.organization_id` sigue `NOT NULL` y falta
      `CK_notifications_ticket_requires_org`. Script y procedimiento listos;
      **pendiente de autorización** para ejecutar.
- [ ] `MSSQL_RUNTIME=true` **no** debe activarse hasta que el diagnóstico M5
      termine con código 0 y exista autorización explícita.

## 5. Clasificación de pendientes

- **P0** — Corregir las dos diferencias de `dbo.notifications` en M5 y validar.
- **P1** — Prueba de instalación desde cero (ver §7) antes de la entrega.
- **P2** — Proxy de Vite parametrizable por entorno (hoy fijo a `http://backend:4000`).
- **P2** — Desconexión automática del frontend ante sesión caducada en una petición ya abierta.

## 6. Cómo ejecutar todas las pruebas

```powershell
# Backend
cd D:\ticket\backend
npm test

# Frontend (el contenedor tiene node_modules en un volumen)
docker exec -w /app/frontend ticket-dev-frontend npx vitest run

# Build de producción del frontend
docker exec -w /app/frontend ticket-dev-frontend npx vite build
```

## 7. Prueba de instalación desde cero (entorno aislado)

1. `docker compose -f docker-compose.yml up -d` con un `.env` nuevo que defina
   `SESSION_SECRET` (32+ caracteres) y `PUBLIC_URL`.
2. Sin `SEED_ADMIN_PASSWORD` no se crea ninguna cuenta: definirla una vez,
   entrar, y quitarla.
3. Verificar `GET /api/health` → `{ "ok": true }`.
4. Confirmar que `data/` y `uploads/` persisten en sus volúmenes.
5. Repetir con `DB_CLIENT=mssql` **solo** sobre una base de validación
   autorizada y con `MSSQL_RUNTIME=true`.

## 8. Firma de aceptación

| Área | Responsable | Fecha | Estado |
| --- | --- | --- | --- |
| Backend / API | | | |
| Frontend / UX | | | |
| Base de datos (SQLite/MSSQL) | | | |
| Seguridad | | | |
| Infraestructura / Docker | | | |
