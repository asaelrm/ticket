# Instalación — SIFHA Ticket

Guía de instalación para desarrollo y producción. La infraestructura y el
despliegue definitivo son responsabilidad del equipo de infraestructura: este
documento cubre lo necesario para levantar el sistema desde el código.

## Requisitos

- Node.js **>= 22.5** (usa `node:sqlite`; se recomienda la versión 24+).
- NPM incluido con Node.
- SQL Server 2022 **solo** si se usa el motor MSSQL (opcional; el sistema funciona
  por defecto sobre SQLite).

## 1. Instalación para desarrollo

```bash
npm run setup          # instala dependencias de backend y frontend
```

Crear variables de entorno (no hay contraseñas por defecto):

```bash
# Windows
copy backend\.env.example backend\.env
# Linux/macOS
cp backend/.env.example backend/.env
```

Iniciar backend y frontend en dos terminales:

```bash
npm run dev:backend   # API en http://localhost:4000
npm run dev:frontend  # frontend Vite en http://localhost:5173
```

### Primera cuenta

El seed **no inventa contraseñas**. Para poder entrar:

1. Defina `SEED_ADMIN_PASSWORD` en `backend/.env` (12+ caracteres).
2. Arranque una vez (se crea el administrador).
3. Entre y **quite la variable** del entorno.

Opcional, cuentas de demostración: `SEED_DEMO_ACCOUNTS=true` junto con
`SEED_DEMO_PASSWORD` y `SEED_TECH_PASSWORD` (ver `backend/.env.example`).

## 2. Instalación para producción

```bash
# 1. Compilar el frontend
npm run build           # genera frontend/dist

# 2. Configurar backend/.env (ver docs/CONFIGURACION.md)
#    NODE_ENV=production, PUBLIC_URL, SESSION_SECRET (32+ car., aleatorio),
#    COOKIE_SECURE=true, origen HTTPS.

# 3. Arrancar: el backend sirve la API y el frontend compilado
npm start
```

Con configuración incompleta o secretos de ejemplo, el proceso **no arranca**
(ver `backend/src/config.js` → `assertStartupConfig`).

## 3. Despliegue con Docker (opcional)

- `docker-compose.yml` — stack de producción con healthcheck (`/api/health`).
- `docker-compose.dev.yml` — desarrollo con volumenes para `node_modules`.
- `docker-compose.mssql-proof.yml` — arranque/proof de MS SQL Server aislado.

Variables obligatorias para el contenedor: `SESSION_SECRET` (32+ car.) y
`PUBLIC_URL`. Sin `SEED_ADMIN_PASSWORD` no se crean cuentas.

## 4. Motor de base de datos

- **Por defecto:** SQLite (`backend/data/tickets.db`); migraciones y seed
  automáticos en el primer arranque.
- **SQL Server 2022:** opcional y **no activo por defecto**. Se requiere
  `DB_CLIENT=mssql` **y** `MSSQL_RUNTIME=true`, aplicar el esquema canónico
  (`backend/src/db/mssql/schema.sql`) y respetar la secuencia de migración por
  fases. Ver `docs/BASE-DE-DATOS.md` y `docs/DEPLOY-MSSQL.md`.

## 5. Siguiente paso

- Variables de entorno: `docs/CONFIGURACION.md`.
- Base de datos y migraciones: `docs/BASE-DE-DATOS.md`.
- Pruebas: `docs/PRUEBAS.md`.
- Lista de comprobación de entrega: `ENTREGA-CHECKLIST.md`.