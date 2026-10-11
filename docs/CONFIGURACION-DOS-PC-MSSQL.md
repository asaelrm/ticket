# Configuracion permanente de dos PC contra un SQL Server central (SIFHA Ticket + Tailscale)

**Fecha:** 2026-10-11
**Rama de trabajo de casa:** `respaldo-casa-mssql-11oct`
**Servidor SQL Server central:** instancia `SIFHADEV` (oficina), alcanzable por Tailscale
en `100.100.4.60` (IP de la red privada Tailscale, no la de la LAN).
**Base de trabajo:** `SIFHA_Tickets_DEV` (confirmar con el equipo antes de fijarla).

> Documento de operacion. **No contiene contrasenas ni cadenas de conexion reales.**
> Nunca escriba secretos en este archivo, en commits ni en el chat.

---

## 1. Objetivo

Dejar el proyecto funcionando **de forma permanente** desde dos computadoras (casa y
oficina) apuntando al **mismo SQL Server central** a traves de Tailscale, sin volver a
configurar nada cada dia y sin duplicar ni sincronizar bases de datos.

Reglas de fondo:

- **Una sola copia de los datos, un solo escritor:** el SQL Server central.
- Las dos PC son **clientes finos** de ese SQL Server.
- **Nunca** compartir el volumen/base por SMB ni copiar ficheros `.mdf`/`.db` entre PC.
- La configuracion privada de cada PC (`.env`) es **local y no versionada**.

---

## 2. Arquitectura

```
        CASA                                     OFICINA
  +------------------+                     +----------------------------+
  | PC casa          |                     | PC oficina (TI-DESK-01)    |
  |  backend (.env)  |                     |  backend (.env)            |
  |  frontend        |                     |  frontend                  |
  +---------+--------+                     +-------------+--------------+
            |                                            |
            |      Tailscale (red privada 100.x)         |
            +--------------------+-----------------------+
                                 |
                       +---------v----------+
                       | SQL Server central |
                       |  TI-DESK-01\SIFHADEV|
                       |  IP Tailscale:     |
                       |  100.100.4.60      |
                       |  Base:SIFHA_Tickets_DEV |
                       +--------------------+
```

- El **backend** de cada PC abre su propio pool contra `100.100.4.60`.
- El **frontend** de cada PC habla con su backend local (mismo equipo).
- Tailscale solo transporta; **no monta carpetas ni replica ficheros**.

---

## 3. Resumen del trabajo de la sesion (sin secretos)

Trabajo ya realizado y **conservado como cambios locales** en la rama
`respaldo-casa-mssql-11oct`. No debe perderse.

### 3.1 Cambios preparados (staged) en la rama de casa

| Archivo | Tipo |
|---|---|
| `backend/scripts/mssql-seed-test-users.js` | nuevo |
| `backend/scripts/mssql-update-test-user-passwords.js` | nuevo |
| `backend/src/routes/tickets.js` | modificado |
| `backend/src/utils/ticketNumber.js` | modificado |
| `backend/test/helpers-mssql.js` | modificado |
| `backend/test/mssql-integration.test.js` | modificado |
| `backend/test/setup-mssql.js` | modificado |
| `docs/REPORTE_ESTABILIZACION_MSSQL.md` | nuevo |

### 3.2 Correcciones de produccion aplicadas (resumen)

- `backend/src/utils/ticketNumber.js`: conversion explicita a `Number()` antes de
  incrementar la secuencia (evita concatenacion de cadenas en `sequences.value`).
- `backend/src/routes/tickets.js`: en la consulta de adjuntos, `OR ?` pasa a `OR ? = 1`
  (SQL Server no admite un parametro suelto como expresion booleana).

Detalle completo en `docs/REPORTE_ESTABILIZACION_MSSQL.md` (14/14 pruebas MSSQL de
integracion en verde, sin regresiones locales).

### 3.3 Ramas de respaldo existentes en el repositorio

```
respaldo-casa-mssql
respaldo-casa-mssql-11oct   <- rama actual (trabajo de casa)
respaldo-main-antes-de-volver-sqlite
respaldo-mssql
trabajo-etapa3-pendiente
main
```

---

## 4. Requisitos previos en CADA computadora

Instalar una sola vez por PC:

1. **Node.js 24 LTS** (`node -v` debe responder `v24.x`).
2. **Git** para Windows.
3. **Tailscale** para Windows (version 1.102.4 o superior).
4. (Opcional, solo si se usa Docker) **Docker Desktop** con integracion WSL2.

Comprobar en PowerShell:

```powershell
node -v
git --version
tailscale version
```

> **Dato clave**: al ejecutarse el backend **nativamente** en Windows, usa el adaptador
> Tailscale del sistema y llega a `100.100.4.60` directamente. Si se ejecuta dentro de
> Docker, el contenedor puede no ver Tailscale; por eso el arranque diario recomendado
> (seccion 7) es **nativo**.

---

## 5. Conectar ambas PC al SQL Server central

### 5.1 Tailscale (una vez por PC)

```powershell
# Iniciar sesion con la misma cuenta/organizacion de Tailscale
tailscale up

# Ver la IP de esta PC
tailscale ip -4

# Ver estado y companeros de la red
tailscale status
```

Comprobar que el servidor central responde por la red privada:

```powershell
tailscale ping 100.100.4.60
```

### 5.2 Puertos del SQL Server (configurar en la PC oficina / servidor)

En el equipo donde corre SQL Server debe estar habilitado:

- **TCP 1433** (o el puerto estatico configurado para `SIFHADEV`).
- **UDP 1434** = SQL Server Browser (necesario para resolver **instancias nombradas**).
- Firewall de Windows permitiendo esas entradas **desde la interfaz Tailscale**.

### 5.3 Prueba de conectividad desde cada PC (sin secretos)

```powershell
# Comprobar el puerto TCP
Test-NetConnection -ComputerName 100.100.4.60 -Port 1433

# Si el resultado es TcpTestSucceeded : True, hay ruta hacia SQL Server.
```

### 5.4 Instancia nombrada `SIFHADEV`: dos formas de conectar

El runtime usa el driver `mssql` (paquete Node `mssql`), configurado en
`backend/src/config.js`. Para una instancia nombrada hay dos variantes validas:

- **Variante A — instancia nombrada (con SQL Browser):**
  en `.env` se deja `DB_INSTANCE=SIFHADEV` y **no** se fija `DB_PORT`. El driver
  pregunta al SQL Browser (UDP 1434) en que puerto escucha la instancia. Requiere que
  el UDP 1434 llegue por Tailscale.

- **Variante B — puerto estatico (recomendada sobre Tailscale):**
  en `.env` se fija `DB_PORT=1433` (o el puerto estatico de `SIFHADEV`) y **no** se
  usa `DB_INSTANCE`. Evita depender del UDP 1434, que es mas fragil a traves de VPN.

> Use **una sola** de las dos variantes. Mezclar `DB_PORT` con `DB_INSTANCE` puede
> provocar resoluciones inesperadas.

Comprobacion manual (pide la contrasena de forma interactiva; no la escriba en el repo):

```powershell
sqlcmd -S 100.100.4.60,1433 -U <usuario_sql> -d SIFHA_Tickets_DEV -Q "SELECT DB_NAME()"
# o, con instancia nombrada:
sqlcmd -S 100.100.4.60\SIFHADEV -U <usuario_sql> -d SIFHA_Tickets_DEV -Q "SELECT DB_NAME()"
```

---

## 6. La configuracion privada permanente: `backend/.env`

Cada PC guarda su propia configuracion en **`backend/.env`**. Ese archivo:

- Esta **ignorado por Git** (`.gitignore` incluye `.env`), por lo que **no se sube**.
- **Nunca** se copia a GitHub, ni se comparte por chat, ni se pega en documentos.
- Es **por PC**: casa y oficina tienen cada una su copia local con la contrasena.

### 6.1 Plantilla (placeholders, SIN contrasenas reales)

Contenido orientativo de `backend/.env` en **cada** PC:

```env
# --- Motor ---
DB_CLIENT=mssql
MSSQL_RUNTIME=true

# --- Servidor central por Tailscale ---
DB_SERVER=100.100.4.60
DB_DATABASE=SIFHA_Tickets_DEV

# Instancia nombrada (Variante A) o puerto estatico (Variante B). Elija UNA.
DB_INSTANCE=SIFHADEV
# DB_PORT=1433

# --- Credenciales SQL (valores reales SOLO en el .env local) ---
DB_USER=<usuario_sql>
DB_PASSWORD=<contrasena_en_el_env_local>

# --- TLS ---
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=true

# --- Mensaje de arranque util ---
# RUN_MSSQL_INTEGRATION no es necesario para el uso diario.
```

Notas:

- `MSSQL_RUNTIME=true` es **imprescindible**. Sin esa variable, `DB_CLIENT=mssql`
  queda inerte y el backend arranca en **SQLite** (ver `backend/src/config.js`).
- `DB_INSTANCE` vs `DB_PORT`: ver seccion 5.4.
- En modo MSSQL el arranque **no migra, no siembra y no restaura instantaneas**: solo
  **valida el esquema** (solo lectura). Si el esquema no coincide, el servidor HTTP
  **no se abre**.
- **Casa y oficina deben usar los mismos `DB_SERVER`, `DB_DATABASE`, `DB_USER`** para
  apuntar al mismo servidor. La contrasena se guarda por separado en cada `.env`.

### 6.2 Verificacion rapida de la configuracion privada

```powershell
# Desde backend/, arranque y observe el mensaje del motor efectivo
npm --prefix backend run start
```

En el log debe aparecer que el motor activo es **MSSQL** (y, si la validacion de
esquema falla, el detalle exacto y sin abrir el puerto). Para una prueba que **no
escriba** en la base, puede arrancar con `JOBS_ENABLED=false`.

---

## 7. Iniciar el proyecto cada dia sin volver a configurarlo

Una vez creado `backend/.env` (seccion 6), el arranque diario es siempre el mismo.

### 7.1 Antes de arrancar (10 segundos)

```powershell
# 1) Tailscale activo y servidor alcanzable
tailscale status
Test-NetConnection -ComputerName 100.100.4.60 -Port 1433

# 2) Ubicarse en el proyecto
cd D:\ticket

# 3) Estado del codigo (ver seccion 8 antes de tocar nada)
git status
git branch --show-current
```

### 7.2 Opcion A (recomendada): backend sirve tambien la interfaz

El backend sirve `frontend/dist` si existe (`backend/src/app.js`), asi que con un solo
proceso queda API + interfaz en `http://localhost:4000`, sin depender del proxy de
Vite. Es la forma mas estable para "usar" el sistema de verdad contra la base central.

```powershell
# Compilar la interfaz (solo cuando cambie el frontend)
npm run build

# Arrancar backend (lee backend/.env y conecta al SQL central)
npm start
```

Abrir: `http://localhost:4000`

### 7.3 Opcion B: desarrollo con Vite (hot reload del frontend)

El proxy por defecto de Vite apunta a `http://backend:4000` (nombre de servicio de
Docker). Fuera de Docker, ese nombre **no resuelve**. Para desarrollo del frontend
contra el backend local, use la Opcion A, o levante el entorno Docker de desarrollo
(seccion 7.4), que si resuelve `backend` en su red interna.

```powershell
npm run dev:frontend   # http://localhost:5173
```

### 7.4 Opcion C: Docker Compose de desarrollo

El backend de desarrollo lee `backend/.env` (esta montado como `/app/backend`), por lo
que toma `DB_*` del `.env` local. Las variables del compose ganan para lo que definen
(NODE_ENV, puerto, semilla), pero **no** definen `DB_*`, asi que la conexion MSSQL sale
del `.env`.

```powershell
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f backend
```

> En Windows, si el contenedor no alcanza `100.100.4.60`, el problema es de red
> Docker/Tailscale, no de SQL Server. En ese caso use la Opcion A (nativa), que es la
> que se apoya directamente en el adaptador Tailscale del host.

### 7.5 Cierre del dia

```powershell
# Opcion A / B: Ctrl+C en la consola del backend.
# Opcion C:
docker compose -f docker-compose.dev.yml down
```

No hay que deshacer ninguna configuracion: el `.env` permanece y el siguiente dia se
repiten solo los pasos 7.1 y 7.2.

---

## 8. Sincronizacion de codigo por GitHub (procedimiento seguro)

Reglas previas:

- **Prohibido** commitear `.env`, `backend/directory.json`, `backend/data/`,
  `backend/uploads/`, dumps `.bak`/`.db` ni certificados. `.gitignore` ya los cubre;
  aun asi, **revise siempre** `git status` antes de preparar un commit.
- **No** hacer `force-push`, ni `git add .` a ciegas.
- **La base de datos no viaja por Git.** Solo viaja el codigo.

### 8.1 Al terminar en una PC (por ejemplo, casa)

```powershell
# 1) Ver que cambio exactamente
git status
git diff

# 2) Crear/actualizar una rama propia de backup para no tocar main
git switch -c respaldo-casa-mssql-11oct   # si ya existe: git switch respaldo-casa-mssql-11oct

# 3) Preparar SOLO lo que corresponde (nada de .env, data, uploads)
git add backend/src backend/test backend/scripts docs

# 4) Commit descriptivo
git commit -m "backup(mssql): conservar correcciones de casa (tickets, secuencia, reporte)"

# 5) Publicar la rama
git push -u origin respaldo-casa-mssql-11oct
```

### 8.2 Al llegar a la otra PC (por ejemplo, oficina)

```powershell
# 1) Traer referencias SIN tocar el arbol de trabajo
git fetch origin

# 2) Ver que hay nuevo antes de decidir
git log --oneline --decorate --all -15
git diff --stat HEAD..origin/respaldo-casa-mssql-11oct

# 3) Traer los cambios a una rama de trabajo local (nunca sobre cambios sin guardar)
git switch -c oficina-integra-<fecha> origin/respaldo-casa-mssql-11oct

# 4) Resolver diferencias de forma explicita y, cuando este verificado, integrar
git switch main
git merge --no-ff oficina-integra-<fecha>
```

### 8.3 Puntos de cuidado

- **Nunca** haga `git pull` sobre una PC con cambios locales sin respaldo: puede crear
  un merge sucio o pisar trabajo. Primero `git status`, luego rama de backup, luego
  `fetch`.
- **`runMigrations()` (SQLite) corre al arrancar.** En MSSQL el arranque **no** migra,
  pero si en algun momento se vuelve a SQLite, un commit que reinicie el servidor
  aplica migraciones solo. Respalde antes de desplegar.
- Mantenga las ramas `respaldo-*` como red de seguridad; no las borre.
- Sincronice **solo codigo**; la configuracion MSSQL de cada PC queda fuera de Git.

---

## 9. Conservar los cambios locales MSSQL de casa

Los cambios de casa **no deben perderse**. Estado actual (2026-10-11):

- Rama: `respaldo-casa-mssql-11oct`.
- **Preparados (staged)**: los 8 archivos de la tabla 3.1
  (`mssql-seed-test-users.js`, `mssql-update-test-user-passwords.js`, `tickets.js`,
  `ticketNumber.js`, `helpers-mssql.js`, `mssql-integration.test.js`,
  `setup-mssql.js`, `REPORTE_ESTABILIZACION_MSSQL.md`).
- `backend/.env` (privado, ignorado por Git) apunta al SQL Server y **no se toca**.
- Existe un **archivo suelto con nombre invalido** en la raiz, creado por error en una
  sesion anterior (un intento de comando que acabo siendo nombre de archivo). No afecta
  al proyecto y conviene revisarlo/eliminarlo aparte; **no** lo incluya en commits.

Para blindar estos cambios antes de cualquier operacion con Git (comando de respaldo,
no destructivo; **no realiza commit ni push**):

```powershell
# Guardar un parche de todo (incluido lo staged) fuera del repo
git diff HEAD > D:\copias\ticket\casa-mssql-11oct.patch
git stash list
```

Recomendacion: antes de integrar trabajo de oficina, **crear un commit en la rama de
casa** (seccion 8.1) para que los cambios dejen de vivir solo en el arbol de trabajo.

---

## 10. Solucion de problemas

| Sintoma | Causa probable | Solucion |
|---|---|---|
| El backend arranca en **SQLite** | Falta `MSSQL_RUNTIME=true` | Anadir `MSSQL_RUNTIME=true` al `.env` |
| `tailscale ping` no responde | Tailscale caido o sin sesion | `tailscale up` y revisar `tailscale status` |
| `TcpTestSucceeded: False` en 1433 | SQL Server no escucha / firewall | Habilitar TCP y el firewall desde la interfaz Tailscale |
| No conecta con `DB_INSTANCE` | UDP 1434 (SQL Browser) bloqueado | Use la Variante B (`DB_PORT` estatico, sin `DB_INSTANCE`) |
| "No se pudo iniciar el servidor" con detalle de esquema | Esquema MSSQL distinto | NO iniciar a medias; revisar `schemaValidator` y el esquema real |
| Login 401 y el log pide `SECRET` | `SESSION_SECRET` invalido | Definir un secreto de 32+ caracteres (solo produccion) |
| Cookie de sesion no viaja | `COOKIE_SECURE=true` sobre HTTP | En local HTTP, dejar `COOKIE_SECURE=false` |
| El contenedor Docker no ve el SQL central | Red Docker/Tailscale en Windows | Use la Opcion A (arranque nativo) |

---

## 11. Pendientes

1. **Confirmar con el equipo** la base central definitiva para el trabajo diario
   (`SIFHA_Tickets_DEV` frente a otra) y su usuario/rol.
2. **Confirmar** la variante de conexion en la red (instancia nombrada vs puerto
   estatico) probando ambas desde las dos PC.
3. **Crear el commit de respaldo** de los cambios de casa (seccion 8.1) cuando se
   autorice; hoy permanecen sin commitear a proposito.
4. **Revisar/eliminar** el archivo suelto con nombre invalido de la raiz del repo.
5. **Validar `backend/.env`** en la PC de oficina (mismos `DB_SERVER`/`DB_DATABASE`/
   `DB_USER`, contrasena propia) y arrancar con la Opcion A.

---

*Restricciones respetadas al crear esta guia: no se ejecutaron migraciones ni seeds, no
se modificaron bases de datos, no se ejecuto `git pull`/`merge`/`commit`/`push`, no se
sobrescribieron archivos modificados y no se mostraron contrasenas.*
