# HTTPS unificado para la LAN y Cloudflare

Preparado y **medido en dos laboratorios aislados**. **Nada de esto esta
activo**: el servicio que esta en marcha hoy sigue siendo el mismo de siempre,
sin cambios.

---

## 1. Que se propone

Una sola entrada HTTPS, en Caddy, que sirve a los dos consumidores:

```
   Navegador en la LAN â”€â”€HTTPSâ”€â”€â”
                                â”‚
                          â”Œâ”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”
   cloudflared â”€â”€HTTPSâ”€â”€â”€â”¤   caddy    â”‚â”€â”€> app:4000   (Express + frontend)
   (desde este equipo)   â”‚  :443      â”‚      Express
                          â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

**En produccion no hay Vite, y esa es la clave de la propuesta.** El `Dockerfile`
compila el frontend y lo copia dentro de la imagen; Express lo sirve como
estatico (`backend/src/app.js:153-168`). Vite solo existe en desarrollo, para
el HMR. Por eso el unico contenedor de la aplicacion es `app`, y Caddy tiene un
unico destino: `reverse_proxy app:4000`.

Consecuencia: **no hay forma de que Vite quede expuesto**, porque en el
despliegue no existe. Lo unico que hay que impedir es que los puertos de
desarrollo sigan abiertos a la LAN (seccion 5).

### Medido en el laboratorio espejo de produccion

`deploy/https/lab/compose.lab-prod.yml` monta la **misma imagen** que produce
el `Dockerfile` y el **mismo `Caddyfile`** de produccion. No es una copia: si
el Caddyfile real se rompe, aqui se ve. 46 comprobaciones, todas en verde:

| Area | Comprobado |
|---|---|
| Inicio de sesion | login correcto, sesion identifica al usuario, contrasena incorrecta rechazada |
| Cookies seguras | `tf_sid` con `Secure` + `HttpOnly` + `SameSite`; HTTP plano no sirve la sesion; `X-Forwarded-Proto: http` del cliente se ignora; HSTS presente |
| Frontend | la build la sirve Express, ningun modulo fuente de Vite; las 4 rutas de React devuelven 200 |
| Recuperacion de contrasena | el token **no** vuelve en la respuesta; llega por SMTP; el enlace usa `https://tickets.lan`; el token es de un solo uso; la contrasena anterior deja de servir y la nueva entra |
| Adjuntos | subida y descarga con contenido identico; `nosniff`; `private, no-store`; `attachment`; tamano declarado correcto; `.exe` rechazado; 6 MB rechazados con limite de 5 MB; sin sesion = 401 |
| Persistencia | tickets, sesion y adjuntos sobreviven al reinicio del contenedor |

Reproducir (seccion 8).

### Por que Caddy y no solo Express

1. **Un solo pariente TCP.** Si Express confia en la IP de Caddy, esa IP es la
   unica cuya opinion sobre `X-Forwarded-Proto` cuenta. Sin proxy delante,
   habria que confiar en toda la red Docker.
2. **TLS fuera de la aplicacion.** No hay que mantener certificados en Node ni
   ahi donde buscarlos.
3. **Se pueden cerrar los puertos.** Caddy es el unico que publica puertos.

### Por que `/api` va directo a Express en el laboratorio de desarrollo

En `compose.lab.yml` (el de desarrollo) el proxy de Vite (http-proxy)
**concatena** la cabecera del cliente en vez de reemplazarla:

```js
req.headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] || '') + ',' + proto
```

Un cliente que mande `X-Forwarded-For: 8.8.8.8` conseguiria que Express creyera
que esa es su IP y **eludiria el limite de peticiones**. Por eso en ese
laboratorio `/api` salta a Express sin pasar por Vite. Caddy, en cambio, si
pisa la cabecera. **En produccion esto no aplica**: no hay Vite, y `/api` y el
frontend van al mismo contenedor.

---

## 2. Archivos

| Archivo | Que es | Activo |
|---|---|---|
| `Caddyfile` | proxy de produccion (todo -> `app:4000`) | no |
| `Caddyfile.lab` | topologia de desarrollo (`/api` -> Express, resto -> Vite + HMR) | no |
| `compose.https.yml` | override de produccion: anade Caddy, red fija, politica de cookies | no |
| `lab/compose.lab-prod.yml` | **espejo de produccion**: imagen real + Caddyfile real | no |
| `lab/compose.lab.yml` | laboratorio de desarrollo (Vite + HMR), puertos 8443 | no |
| `lab/smtp-sink.mjs` | sumidero de correo, solo para probar la recuperacion | no |
| `lab/verify-lab-prod.ps1` | las 46 comprobaciones de la tabla anterior | no |
| `lab/verify-https.ps1` | las comprobaciones del laboratorio de desarrollo | no |
| `tunnel/compose.tunnel.yml` | cloudflared, en un perfil que no se levanta solo | no |
| `tunnel/config.yml` | como debe ser el tunel (origen, CA, ingress) | no |

Los dos laboratorios pueden convivir: proyectos `ticketlab` y `ticketlabprod`,
redes `172.30.0.0/24` y `172.31.0.0/24`, puertos 8443 y 8444, volumenes con
prefijo distinto. Ninguno toca los puertos 4000/5173 ni los volumenes
`ticket_*`.

El servicio real **no se toca**: el laboratorio corre con su propio proyecto, su
propia red, sus propios volumenes y escucha solo en `127.0.0.1`.

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
hosts** de cada equipo, con la IP que tenga esa maquina en la LAN:

```
<IP-DE-LA-MAQUINA>   tickets.lan
```

Ojo: la IP de cada equipo es distinta, y la que se escribe aqui es la de la
maquina que quiero alcanzar, no la propia.

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
| **Windows** | Doble clic en `caddy-root.crt` -> *Instalar certificado* -> **Entidades de certificacion raiz de confianza** -> Importar en **MÃ¡quina**. Repetir en cada PC. |
| **Android** | Ajustes -> Seguridad -> Cifrado y credenciales -> Instalar un certificado -> **CA de usuario**. Opciones -> Seguridad -> Cifrado. Chrome exige pantalla bloqueada en some versions. |
| **iOS / iPadOS** | AirDrop o correo el `.crt` -> Ajustes -> **General** -> *VPN y gestiÃ³n de dispositivos* -> instalar perfil. **Imprescindible** ademas ir a Ajustes -> General -> Ajustes de confianza y **activar la confianza total**. |
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

Preparado en `deploy/https/tunnel/`, **inactivo**: el servicio lleva
`profiles: ["tunnel"]`, asi que `docker compose up` sin mas no lo levanta.

```
   Internet --TLS--> Cloudflare --TLS--> cloudflared --TLS--> caddy:443 --> app:4000
```

Dos decisiones que conviene no cambiar a la ligera:

1. **El tunel apunta a `caddy:443`, nunca a Vite ni al puerto 4000.** Es la
   misma entrada que usan los navegadores de la LAN, de modo que el tunel no
   abre una segunda ruta al backend ni un segundo sitio donde la politica de
   cookies y de HSTS pueda divergir de la de la LAN.
2. **El tramo `cloudflared -> caddy` va cifrado y verificado.** Caddy emite con
   su CA propia (`tls internal`), asi que el tunel recibe esa CA en `caPool` y
   el nombre esperado en `originServerName` (`tunnel/config.yml`). Asi no hace
   falta `--no-tls-verify` ni `noTLSVerify`. La alternativa comoda â€”apuntar a
   `http://caddy:80` en claroâ€” se descarta a proposito: el tramo interno de la
   red Docker no sale a la red, pero TLS ahi no cuesta nada.

`cloudflared` no publica puertos: sale por HTTPS saliente, asi que no hay que
abrir nada en el router ni cambiar el NAT.

### Que falta para activarlo

1. Crear el tunel y guardar sus credenciales (nunca en el repositorio):

   ```powershell
   cloudflared tunnel login
   cloudflared tunnel create ticket
   ```

   El comando imprime un ID y deja `credentials.json`. Poner el ID en
   `tunnel/config.yml` y copiar el fichero a `deploy/https/tunnel/`
   (esta en `.gitignore`).

2. Registrar un hostname publico con CNAME a `<id>.cfargotunnel.com` y anadir un
   *Public Hostname* que apunte a `https://caddy:443`. Poner ese hostname en
   `ingress:` de `config.yml`.

3. Arrancar con el perfil:

   ```powershell
   docker compose -f docker-compose.yml -f deploy/https/compose.https.yml `
     -f deploy/https/tunnel/compose.tunnel.yml --profile tunnel up -d
   ```

### Sobre `CORS_ORIGIN`

No hace falta tocarlo. El tunel publica la pagina y la API por el **mismo**
origen, asi que el navegador no hace peticiones con `Origin` cruzado y la
politica de CORS no llega a evaluarse. Solo habria que Ampliar `CORS_ORIGIN`
si en algun momento la API se sirviera desde un host distinto al de la pagina.

> Con `--url` (tunel rapido) Cloudflare genera un subdominio aleatorio
> `*.trycloudflare.com` distinto en cada ejecucion, y ese metodo no admite
> credenciales en fichero ni `caPool`. Para una direccion estable y esta
> configuracion hace falta el tunel con nombre de los pasos de arriba.

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

### Que esta pasando

`docker-compose.dev.yml` declara:

```yaml
  ticket_data:
    external: true
    name: ticket_ticket_data
```

Ese es exactamente el volumen que crea `docker-compose.yml`. Es decir: **las
pruebas de desarrollo escriben en la base de datos de produccion**, y comparten
la tabla de sesiones. Verificado en los contenedores reales:

```
  ticket-dev-backend -> ticket_ticket_data, ticket_ticket_uploads
```

### Por que NO basta con borrar `external: true`

Los dos ficheros estan en el mismo directorio, asi que los dos proyectos de
Compose se llaman `ticket`. Una clave de volumen sin `name:` se resuelve a
`<proyecto>_<clave>`: si desarrollo declarase `ticket_data:` a secas, seguiria
acabulando en `ticket_ticket_data`, que es el de produccion. Reproducido en el
laboratorio (`compose.volsep-colision.yml`), dos stacks con la misma clave y el
mismo proyecto:

```
  uno -> ticketvolsep_ticket_data
  dos -> ticketvolsep_ticket_data      # los dos escriben en el mismo
```

Por eso lo que separa de verdad es el **`name:` explicito**, no la ausencia de
`external`. Con el (mismo proyecto, misma clave) cada stack va a su volumen, y
escribir en desarrollo deja la produccion intacta byte a byte:

```
  volsep-dev  -> ticketvolsep_dev_data     # leia DESARROLLO
  volsep-prod -> ticketvolsep_prod_data    # seguia con PRODUCION, sha256 igual
```

Ventaja de `name:` sobre obligar a recordar un `-p`: el aislamiento esta escrito
en el fichero, no en la memoria de quien teclee el comando.

### Procedimiento sin perdida de datos

**No ejecutar hasta tener copia verificada.** Ningun paso borra
`ticket_ticket_data`: solo deja de ser el volumen que usa desarrollo.

```powershell
# 1. Copia de seguridad SIEMPRE antes de nada.
docker run --rm -v ticket_ticket_data:/datos -v ${PWD}:/respaldo `
  alpine tar czf /respaldo/ticket_data-$(Get-Date -f yyyyMMdd-HHmm).tgz -C /datos .

# 2. Comprobar que la copia existe y NO esta vacia. Un tgz de 0 bytes o de unos
#    pocos cientos seria un problema: pararse aqui.
Get-ChildItem .\ticket_data-*.tgz | Select-Object Name, Length

# 3. Crear el volumen de desarrollo, independiente.
docker volume create ticket_dev_data
docker volume create ticket_dev_uploads

# 4. Elegir UNA de estas dos, segun lo que se quiera:
#
#    4a. Empezar de cero (lo recomendado). El desarrollo es para romper cosas;
#        no necesita los tickets ni las cuentas reales, y asi los datos
#        personales de produccion no se propagan a un entorno donde se van a
#        tirar abajo. Al levantar, se crea el admin con SEED_ADMIN_PASSWORD.
#
#    4b. Copiar los datos actuales, para tener con que trabajar:
docker run --rm -v ticket_ticket_data:/origen -v ticket_dev_data:/destino `
  alpine sh -c "cp -a /origen/. /destino/"

# 5. En docker-compose.dev.yml, sustituir el bloque de volumenes por:
#      volumes:
#        backend_node_modules:
#        frontend_node_modules:
#        ticket_data:
#          name: ticket_dev_data        # sin `external: true`
#        ticket_uploads:
#          name: ticket_dev_uploads     # sin `external: true`
#
#    Comprobar ANTES de levantar que el fichero es valido y que ya no pide nada
#    externo:
docker compose -f docker-compose.dev.yml config | Select-String "name:|external:"

# 6. Levantar. Esto RECREA solo los contenedores de DESARROLLO (cambian sus
#    montajes); los de produccion no se tocan. Hazlo sin nadie usando dev.
docker compose -f docker-compose.dev.yml up -d

# 7. Comprobar que cada contenedor quedo en su volumen, sin suponerlo:
docker inspect ticket-dev-backend --format "{{range .Mounts}}{{.Name}} {{end}}"
#   esperado: ticket_backend_node_modules ticket_dev_data ticket_dev_uploads
# En una maquina donde produccion este levantada, ademas:
docker inspect ticket --format "{{range .Mounts}}{{.Name}} {{end}}"
#   esperado: ticket_ticket_data ticket_ticket_uploads
```

Ojo con el estado actual de esta maquina: **el contenedor de produccion
(`ticket`) no existe, solo corre el de desarrollo** (`ticket-dev-backend`), y ese
va montado sobre `ticket_ticket_data`. O sea que el riesgo de esta seccion no es
hipotetico, esta pasando ya ahora mismo: cualquier cuenta que se cree
en `localhost:4000` se esta guardando en la base de datos de produccion. Por eso
el paso 6 pide no levantar desarrollo con nadie usandolo.

### Comprobar que no se mezclaron

Que los montajes sean correctos no basta: hay que comparar el contenido.

```powershell
# Antes de tocar nada, guardar la huella de produccion.
$antes = (docker exec ticket node -e "const{DatabaseSync}=require('node:sqlite');process.stdout.write(String(new DatabaseSync('/app/backend/data/tickets.db',{readOnly:true}).prepare('SELECT count(*) c FROM tickets').get().c))")
"tickets en produccion: $antes"
# Repetir el 7 despues del 6. Si el numero ha cambiado, algo sigue escribiendo
# en produccion: para las pruebas y mira que contenedor monta que volumen.
```

### Deshacer

```powershell
# Restaurar la linea `external: true` + `name: ticket_ticket_data` en
# docker-compose.dev.yml y volver a levantar desarrollo.
docker compose -f docker-compose.dev.yml up -d
```

Los volumenes nuevos se pueden borrar cuando el usuario lo confirme:
`docker volume rm ticket_dev_data ticket_dev_uploads`.

---

## 7. Antes de exponer a Internet

| # | Comprobacion | Estado |
|---|---|---|
| 1 | `SESSION_SECRET` real y unico (no el de ejemplo) | **PENDIENTE** |
| 2 | Contrasena de admin distinta de `123456` | **PENDIENTE** |
| 3 | `SEED_ADMIN_PASSWORD` fuera del entorno | **PENDIENTE** |
| 4 | `backend/directory.json` fuera del repositorio publico | **CORREGIDO** |
| 5 | HTTPS verificado desde la LAN y desde Cloudflare | pendiente |
| 6 | 4000 y 5173 cerrados a la LAN | pendiente |

### 7.1 `SEED_ADMIN_PASSWORD` ya no pisa la contrasena

Antes `seed.js` **fuerza esa contrasena en cada arranque**: si se cambiaba la
contrasena del admin y se dejaba `SEED_ADMIN_PASSWORD` en el entorno, el
siguiente reinicio del contenedor la volvia a poner. Medido entonces en el
laboratorio:

```
con NODE_ENV=production -> ["admin"]        (crea el admin, y solo ese)
2o arranque -> password es SEED_ADMIN_PASSWORD: true
```

Ahora el arranque solo usa `SEED_ADMIN_PASSWORD` **al crear** la cuenta. Si el
administrador ya existe, la variable se ignora, se avisa por consola y la
contrasena que haya se respeta. Lo unico que la vuelve a aplicar es
`SEED_ADMIN_FORCE_PASSWORD=true`, que hay que pedir a proposito y quitar
despues. La via de recuperacion sigue siendo `/api/auth/reset-password` con
token.

Cubierto por `backend/test/directorySync.test.js` ("el seed no impone contrasenas
por defecto"), que ademas falla con el codigo anterior al arreglo.

### 7.2 `directory.json` ya no publica contrasenas

El problema era doble: el archivo estaba en un repositorio publico con hashes
bcrypt dentro, y ademas el arranque lo reimportaba y `seed.js` lo reescribia al
cambiar una contrasena, asi que **cambiar una contrasena publicaba su hash**.

Las dos partes estan corregidas:

- `backend/directory.json` esta en `.gitignore` y fuera del indice de Git. El
  archivo se conserva en local; cada instalacion tiene el suyo.
- El archivo **ya no contiene `password_hash`**, ni al escribirlo ni al leerlo.
  Un `directory.json` antiguo con hashes los ignora y avisa. Las cuentas nuevas
  que solo existan en el archivo se crean con una contrasena aleatoria
  inutilizable, y hay que restablecerlas.

Verificado en el laboratorio y en `backend/test/directorySync.test.js`: cambiar
la contrasena, reiniciar y comprobar que la anterior no entra.

Queda pendiente lo de siempre, y es independiente del HTTPS: si el repositorio
llego a ser publico, esos hashes antiguos hay que tratarlos como
comprometidos. El orden correcto (cambiar contrasenas primero, reescribir el
historial despues) esta en el README raiz, en "Retirar el archivo del
historial". Borrar el archivo del historial sin cambiar antes las contrasenas no
arregla nada.

---

## 8. Pruebas

Hay dos laboratorios. Los dos se levantan sin tocar el servicio real y con las
credenciales en el entorno, nunca en los archivos: si faltan, el compose no
arranca.

### 8.1 El espejo de produccion (el que valida el despliegue)

```powershell
$env:LABPROD_SESSION_SECRET = "lo-que-sea-32-caracteres-minimo"
$env:LABPROD_ADMIN_PASSWORD = "lo-que-sea-12-o-mas"
docker compose -p ticketlabprod -f deploy\https\lab\compose.lab-prod.yml up -d --build
docker cp ticketlabprod-caddy-1:/data/caddy/pki/authorities/local/root.crt $env:TEMP\labprod-root.crt

powershell -ExecutionPolicy Bypass -File deploy\https\lab\verify-lab-prod.ps1
```

Construye la imagen real del `Dockerfile` (tarda: es un `npm ci` y un build de
Vite). Salida esperada: **46 correctas, 0 fallidas**.

Cubre las seis areas de la tabla de la seccion 1. Dos detalles que hacen que
esta prueba sirva de algo y no sea decorativa:

- **Recuperacion de contrasena en modo produccion.** Aqui la API *no* devuelve
  el token (a proposito), asi que el laboratorio monta `smtp-sink.mjs`, un
  sumidero SMTP minimo sin dependencias, y lee el token del correo. Asi se
  prueba el camino real, con `PUBLIC_URL` correcto y sin el atajo del modo
  desarrollo.
- **El token llega codificado.** El correo sale en quoted-printable y el enlace
  se parte en varias lineas con cortes blandos. Los clientes de correo lo
  desempaquetan solos, asi que **no es un fallo de la aplicacion**, pero
  cualquier herramienta que lea el correo crudo tiene que descodificarlo antes
  de buscar el token. `verify-lab-prod.ps1` lo hace (`Decode-QP`).

Al final el script **restituye la contrasena original** del laboratorio, asi que
se puede repetir sin tocar el entorno a mano.

### 8.2 El laboratorio de desarrollo (Vite y HMR)

```powershell
$env:LAB_SESSION_SECRET = "lo-que-sea"
$env:LAB_ADMIN_PASSWORD = "lo-que-sea"
docker compose -p ticketlab -f deploy\https\lab\compose.lab.yml up -d
docker cp ticketlab-caddy-1:/data/caddy/pki/authorities/local/root.crt $env:TEMP\caddy-root.crt

powershell -ExecutionPolicy Bypass -File deploy\https\lab\verify-https.ps1 `
  -CaPath $env:TEMP\caddy-root.crt -WithRestart
```

Salida esperada: 15 PASS. Cubre la topologia con Vite, que es la que se usa al
programar, y de ahi la correccion de `allowedHosts` en `vite.config.js`.

### 8.3 Limpieza

```powershell
# Esto borra datos, pero solo de los laboratorios.
docker compose -p ticketlabprod -f deploy\https\lab\compose.lab-prod.yml down -v
docker compose -p ticketlab     -f deploy\https\lab\compose.lab.yml     down -v
```

### 8.4 Lo que las pruebas NO cubren

- El acceso real desde **otro** equipo de la LAN con el certificado instalado.
- El tunel de Cloudflare ya publicado (no hay ninguno).
- Correo real: el sumidero acepta el mensaje pero no lo entrega, asi que no se
  prueban ni SPF ni DKIM ni que el correo llegue a una bandeja real.
- El certificado en Android, iOS y macOS, que tienen sus propias reglas de
  instalacion de CA (seccion 3.3).

Las pruebas de codigo del transporte viven en el backend y se ejecutan con la
suite normal: `backend/test/transportSecurity.test.js` (18 casos).

---

## 9. Procedimiento de recuperacion

Todo lo de este documento es **aditivo**: los archivos nuevos no se usan hasta
que se invocan a mano, y los overrides solo aplican si se pasan con `-f`.
**Ningun paso borra una base de datos.**

### 9.1 Si nada de esto se ha aplicado todavia (estado actual)

No hay nada que deshacer. Es el estado en el que esta hoy.

### 9.2 Volver atras tras aplicar el override de HTTPS

```powershell
# 1. Parar el proxy y la aplicacion levantados con el override.
docker compose -f docker-compose.yml -f deploy\https\compose.https.yml down

# 2. Levantar el compose de desarrollo, que es el de siempre.
docker compose -f docker-compose.dev.yml up -d
```

El codigo de la aplicacion no ha cambiado, asi que no hay nada que deshacer en
el repositorio. Los archivos de `deploy/https/` se pueden borrar: no se usan
solos.

### 9.3 Si se perdio el acceso y hay que entrar ya

Este es el orden importante: **primero recuperar acceso, luego averiguar por
que**. No borrar volumenes para nada.

```powershell
# A. Entrada de emergencia, solo en loopback: nadie de la LAN llega.
#    Editar docker-compose.yml y dejar:  "127.0.0.1:4000:4000"
docker compose -f docker-compose.yml up -d
#    Entrar por http://localhost:4000
```

Con `COOKIE_SECURE=true` el navegador rechazara la cookie por HTTP. Para entrar
en una emergencia hay que pasar temporalmente por HTTP: cambiar `COOKIE_SECURE`
a `false`, levantar, entrar, y devolverlo a `true` en cuanto se este dentro.
**Eso invalida las sesiones abiertas**, asi que es una medida de una vez, en
horario sin uso.

### 9.4 Si se borro el volumen de Caddy por error

Es el fallo mas caro, porque no se puede recuperar: al borrar `caddy_data` se
pierde la CA, Caddy genera una nueva, y **todos los dispositivos dejan de
confiar en el sitio** hasta reinstalar el certificado raiz. Si solo se perdio el
certificado de un host y el volumen sigue ahi, no hace falta nada: reiniciar
Caddy lo vuelve a emitir.

### 9.5 Si el tunel no conecta

| Sintoma | Causa habitual | Que hacer |
|---|---|---|
| `x509: certificate signed by unknown authority` | falta la CA en `caPool` | comprobar la ruta del volumen `caddy_data` en `config.yml` |
| `x509: cannot validate certificate for caddy` | falta `originServerName` | anadir `originServerName: tickets.lan` |
| 404 en el hostname publico | el `ingress` no coincide | el `hostname` de `config.yml` debe ser el publico, no `tickets.lan` |
| responde `tickets.lan` desde internet | el tunel entra por el 443 de la LAN | comprobar que el CNAME apunta al `<id>.cfargotunnel.com` y no a la IP de la maquina |
| 502 desde internet | Caddy no esta levantado | `docker compose -p <proyecto> ps` |

Apagar el tunel **no** afecta a la LAN: son entradas independientes, la de la
LAN entra por el 443 publicado y la de Internet por el tunel. Se pueden quitar
por separado.

### 9.6 Datos

Ningun paso de este documento borra una base de datos. Los unicos `down -v` son
sobre `ticketlab_*` y `ticketlabprod_*`, que son volumenes aislados que crean
los propios laboratorios. Los volumenes del servicio real son `ticket_ticket_data`
y `ticket_ticket_uploads`, y no aparecen en ningun comando de este documento.
