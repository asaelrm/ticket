# HTTPS unificado para la LAN y Cloudflare

Preparado y **medido en un laboratorio aislado**. **Nada de esto esta activo**:
el servicio que esta en marcha hoy sigue siendo el mismo de siempre, sin cambios.

---

## 1. Que se propone

Una sola entrada HTTPS, en Caddy, que sirve a los dos consumidores:

```
   Navegador en la LAN ──HTTPS──┐
                                │
                          ┌─────┴──────┐
   cloudflared ──HTTPS───┤   caddy    │──> app:4000   (Express + frontend)
   (desde este equipo)   │  :443      │      Express
                         └────────────┘
```

Medido en el laboratorio (`deploy/https/lab`):

| Comprobacion | Resultado |
|---|---|
| HTTPS端 a extremo, certificado de la CA local | correcto |
| HSTS solo en el host declarado | correcto |
| Cliente falsifica `X-Forwarded-Proto: http` | **ignorado** por Caddy |
| `tf_sid` con `Secure` + `HttpOnly` + `SameSite` | correcto |
| API servida por HTTP plano | rechazada |
| CSRF: token falso / token valido | 403 / pasa al controlador |
| Certificado aceptado para otro hostname | rechazado |
| Sesion y HSTS tras reiniciar el contenedor | se mantienen |

Comando para reproducirlo: ver seccion 8.

### Por que Caddy y no solo Express

1. **Un solo pariente TCP.** Si Express confia en la IP de Caddy, esa IP es la
   unica cuya opinion sobre `X-Forwarded-Proto` cuenta. Sin proxy delante,
   habria que confiar en toda la red Docker.
2. **TLS fuera de la aplicacion.** No hay que mantener certificados en Node ni
   ahi donde buscarlos.
3. **Se pueden cerrar los puertos.** Caddy es el unico que publica puertos.

### Por que `/api` va directo a Express en el laboratorio

El proxy de Vite (http-proxy) **concatena** la cabecera del cliente en vez de
reemplazarla:

```js
req.headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] || '') + ',' + proto
```

Un cliente que mande `X-Forwarded-For: 8.8.8.8` consigue que Express crea que esa
es su IP y **eluda el limite de peticiones**. Por eso en el laboratorio `/api`
salta a Express sin pasar por Vite. Caddy, en cambio, si pisa la cabecera.

---

## 2. Archivos

| Archivo | Que es | Activo |
|---|---|---|
| `Caddyfile` | proxy de produccion (todo -> `app:4000`) | no |
| `Caddyfile.lab` | topologia de desarrollo (`/api` -> Express, resto -> Vite + HMR) | no |
| `compose.https.yml` | override de produccion: anade Caddy, red fija, politica de cookies | no |
| `lab/compose.lab.yml` | laboratorio aislado, puertos 8443, volumenes propios | no |
| `lab/verify-https.ps1` | las comprobaciones de la tabla anterior | no |

El servicio real **no se toca**: el laboratorio corre con el proyecto `ticketlab`,
en la red `172.30.0.0/24`, con volumenes `ticketlab_*` y escucha solo en
`127.0.0.1:8443`.

---

## 3. Certificados y DNS

### 3.1 El certificado

`tls internal` hace que Caddy cree su propia CA y emita el certificado. No hace
falta ningun dominio publico ni puertos 80 abiertos.

Exportar la CA raiz (es el fichero que hay que instalar en cada dispositivo):

```powershell
docker cp ticket-caddy-1:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt
```

El volumen `caddy_data` guarda esa CA. **No lo borre**: si se pierde, Caddy crea
una CA nueva y todos los dispositivos dejan de confiar en el sitio.

### 3.2 El nombre

Propuesta: `tickets.lan`, resuelto a la IP de esta maquina.

La opcion mas simple y sin depender de ningun servidor DNS es el **archivo de
hosts** de cada equipo:

```
10.0.0.208   tickets.lan
```

En Windows, que es un fichero comun a todos los usuarios y no se toca con
permisos de administrador:

```
notepad C:\Windows\System32\drivers\etc\hosts
```

> Si en la red hay un servidor DNS propio (Pi-hole, AdGuard, el del router), es
> preferible ahi: evita tocar 20 ficheros de hosts. El nombre puede ser
> cualquiera; `.lan` esta reservado para uso privado y no lo resuelve nadie mas.

### 3.3 Confiar en el certificado, por dispositivo

| Dispositivo | Como |
|---|---|
| **Windows** | Doble clic en `caddy-root.crt` -> *Instalar certificado* -> **Entidades de certificacion raiz de confianza** -> Importar en **Máquina**. Repetir en cada PC. |
| **Android** | Ajustes -> Seguridad -> Cifrado y credenciales -> Instalar un certificado -> **CA de usuario**. Opciones -> Seguridad -> Cifrado. Chrome exige pantalla bloqueada en some versions. |
| **iOS / iPadOS** | AirDrop o correo el `.crt` -> Ajustes -> **General** -> *VPN y gestión de dispositivos* -> instalar perfil. **Imprescindible** ademas ir a Ajustes -> General -> Ajustes de confianza y **activar la confianza total**. |
| **macOS** | Doble clic -> *Aceptar* -> se anade al llavero. Si no, Arrastrar a *Accesos de llaves* -> *Certificados* -> *Siempre confiar*. |

Comprobar que funciona (PowerShell):

```powershell
curl.exe --ssl-no-revoke -I https://tickets.lan/api/health
```

`--ssl-no-revoke` hace falta porque la CA privada no publica lista de revocacion
y el motor de Windows (Schannel) lo rechaza por defecto. En el navegador no hace
falta: no se comprueba la revocacion.

---

## 4. cloudflared

Actualmente:

```
cloudflared tunnel --url http://localhost:5173
```

Eso mete a Vite en medio y deja el origen en HTTP plano. Con el proxy delante,
el comando pasa a ser:

```
cloudflared tunnel --url https://tickets.lan
```

- Se apunta a la **misma** entrada que usa la LAN, que es el objetivo.
- cloudflared corre en este equipo, asi que resuelve `tickets.lan` por el hosts
  y valida el certificado con la CA de Caddy, que se puede instalar en el
  almacen de confianza de Windows. **No hace falta `--no-tls-verify`.**
- Solo cambiarlo **despues** de que HTTPS este verificado. Durante la transicion
  se pueden tener los dos a la vez: el comando antiguo en una ventana, el nuevo
  en otra, y comparar.

> Con `--url` (tunel rapido) Cloudflare genera un subdominio aleatorio
> `*.trycloudflare.com` distinto en cada ejecucion. Si hace falta una direccion
> estable, hace falta un tunel con nombre en el panel de Cloudflare
> (`cloudflared tunnel login`, `tunnel create`, `tunnel route dns`). Eso es un
> paso aparte, no covered por este documento.

---

## 5. Cerrar 4000 y 5173 al acceso directo

Hoy ambos estan publicados en `0.0.0.0`, o sea que **cualquier equipo de la LAN
llega a Express y a Vite saltandose el TLS**. Con `COOKIE_SECURE=true` el
navegador no dejaria usar la sesion por ahi, pero la aplicacion seguiria
alcanzable y el CSRF relies en que no se puedan emitir cookies sin `Secure`.

Cerrarlos es **editar `docker-compose.yml`** y borrar la entrada `ports` de
`app`, porque el compose de produccion publica 4000 desde el mismo servicio.

> Un override **no** sirve: Compose concatena las listas `ports` en vez de
> reemplazarlas, y `ports: []` no las quita. Comprobado en este equipo:
> `ports: !reset []` si las quita (Compose >= 2.24), pero es menos legible al
> revisar que borrar la linea.

En `docker-compose.dev.yml` pasa igual con `4000:4000` y `5173:5173`. Si se
quiere conservar la depuracion en local, publicarlos solo en loopback
(`127.0.0.1:4000:4000`), que no es alcanzable desde la LAN.

Orden recommended: primero HTTPS funcionando, luego cerrar puertos. Al reves,
se queda sin acceso a la aplicacion y no hay por donde entrar.

---

## 6. Separar los volumenes de desarrollo y produccion

**Hoy estan compartidos.** `docker-compose.dev.yml` declara:

```yaml
  ticket_data:
    external: true
    name: ticket_ticket_data
```

Ese es exactamente el volumen que crea `docker-compose.yml` (proyecto `ticket`).
Es decir: **las pruebas de desarrollo escriben en la base de datos de
produccion**, y comparten la tabla de sesiones.

Procedimiento sin perdida de datos. **No ejecutar hasta tener copia verificada.**

```powershell
# 1. Copia de seguridad SIEMPRE antes de nada.
docker run --rm -v ticket_ticket_data:/datos -v ${PWD}:/respaldo `
  alpine tar czf /respaldo/ticket_data-$(Get-Date -f yyyyMMdd-HHmm).tgz -C /datos .

# 2. Comprobar que la copia existe y no esta vacia.
Get-ChildItem .\ticket_data-*.tgz | Select-Object Name, Length

# 3. Crear el volumen de desarrollo, independiente.
docker volume create ticket_dev_data
docker volume create ticket_dev_uploads

# 4. Copiar los datos actuales al volumen de desarrollo, para que el
#    desarrollo siga viendo lo que habia.
docker run --rm -v ticket_ticket_data:/origen -v ticket_dev_data:/destino `
  alpine sh -c "cp -a /origen/. /destino/"

# 5. En docker-compose.dev.yml, sustituir por:
#      ticket_data:
#        name: ticket_dev_data
#      ticket_uploads:
#        name: ticket_dev_uploads
#    (sin `external: true`)

# 6. Levantar y comprobar.
docker compose -f docker-compose.dev.yml up -d
```

El volumen `ticket_ticket_data` **no se borra en ningun paso**. Se conserva como
la copia de produccion, y se puede archivar cuando，随اقرأ lo confirme.

---

## 7. Antes de exponer a Internet

| # | Comprobacion | Estado |
|---|---|---|
| 1 | `SESSION_SECRET` real y unico (no el de ejemplo) | **PENDIENTE** |
| 2 | Contrasena de admin distinta de `123456` | **PENDIENTE** |
| 3 | `SEED_ADMIN_PASSWORD` fuera del entorno | **PENDIENTE** |
| 4 | `backend/directory.json` fuera del repositorio publico | **PENDIENTE** |
| 5 | HTTPS verificado desde la LAN y desde Cloudflare | pendiente |
| 6 | 4000 y 5173 cerrados a la LAN | pendiente |

### 7.1 El fallo de `SEED_ADMIN_PASSWORD`

`docker-compose.yml:27` trae `SEED_ADMIN_PASSWORD: ${SEED_ADMIN_PASSWORD:-123456}`,
y `seed.js:195-203` **fuerza esa contrasena en cada arranque**.

Medido en el laboratorio, con el codigo real:

```
con NODE_ENV=production -> ["admin"]        (crea el admin, y solo ese)
2o arranque -> password es SEED_ADMIN_PASSWORD: true
```

Es decir: **si se cambia la contrasena del admin y se deja
`SEED_ADMIN_PASSWORD` en el entorno, el siguiente reinicio del contenedor la
vuelve a poner.** Es la forma mas facil de creer que la contrasena esta
cambiada cuando no lo esta.

Al terminar el alta inicial hay que **quitar `SEED_ADMIN_PASSWORD` del
entorno**, y si se pierde el acceso, la via de recuperacion es
`/api/auth/reset-password` con token, no esa variable.

Ademas, `seed.js:207` impide las cuentas demo en produccion y eso se cumple:
en una base nueva con `NODE_ENV=production` solo se crea `admin`.

### 7.2 `directory.json`

`backend/directory.json` esta en un repositorio publico y contiene tres hashes
bcrypt de contrasenas. `server.js` lo reimporta al arrancar y `seed.js` lo
reescribe cuando cambia una contrasena. Enquanto siga asi, un cambio de
contrasena **publica su hash**. Es el punto mas urgente de la lista, y es
independiente del HTTPS.

---

## 8. Pruebas

El laboratorio se levanta sin tocar el servicio real:

```powershell
docker compose -p ticketlab -f deploy\https\lab\compose.lab.yml up -d
docker cp ticketlab-caddy-1:/data/caddy/pki/authorities/local/root.crt $env:TEMP\caddy-root.crt

powershell -ExecutionPolicy Bypass -File deploy\https\lab\verify-https.ps1 `
  -CaPath $env:TEMP\caddy-root.crt -WithRestart
```

Salida esperada: 14 PASS y `RESULTADO: todas las comprobaciones pasaron`.
Cubre HTTPS local, cabeceras de proxy falsificadas, cookies seguras, CSRF,
bloqueo de HTTP autenticado y reinicio de contenedores.

Para limpiar el laboratorio:

```powershell
docker compose -p ticketlab -f deploy\https\lab\compose.lab.yml down -v
```

Lo que **no** cubren las pruebas automatizadas, y hay que hacer a mano:
el acesso real desde otro equipo de la LAN con el certificado instalado, y el
tunel de Cloudflare publicado.

Las pruebas de codigo del transporte viven en el backend y se ejecutan con la
suite normal: `backend/test/transportSecurity.test.js` (18 casos), que incluyen
la sesion inutilizable por HTTP cuando la cookie es `Secure`.

---

## 9. Procedimiento para volver atras

Todo lo de este documento es **aditivo**: los archivos nuevos no se usan hasta
que se invocan a mano, y el override solo aplica si se pasa con `-f`.

### Volver al estado actual

```powershell
# 1. Parar proxy y aplicacion con el override.
docker compose -f docker-compose.yml -f deploy\https\compose.https.yml down

# 2. Levantar el compose de desarrollo, que es el que esta hoy.
docker compose -f docker-compose.dev.yml up -d
```

El codigo de la aplicacion no ha cambiado, asi que no hay nada que
deshacer en el repositorio. Los archivos de `deploy/https/` se pueden borrar:
no se usan solos.

### Si se llego a quitar los puertos y algo falla

```powershell
# Reabrir el acceso local inmediato, solo en loopback.
# Editar docker-compose.yml y dejar:  "127.0.0.1:4000:4000"
docker compose -f docker-compose.yml up -d
```

### Si habia que volver atras en la cookie

`COOKIE_SECURE=false` es un cambio de una variable, pero **invalida las
sesiones abiertas por HTTPS** en cuanto los navegadores reciben una cookie sin
`Secure` en un contexto distinto. Hacerlo en horario sin uso.

### Datos

Ningun paso de este documento borra una base de datos. El unico `rm` del
laboratorio es sobre `ticketlab_lab_data`, que es un volumen aislado que crea el
propio laboratorio.
