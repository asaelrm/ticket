# Estado al dejar esto en pausa

Documento de traspaso. Resume en qué punto queda el proyecto, qué está preparado y
qué falta decidir. **No contiene secretos.** Está sin commitear, a propósito: nadie
lo ha publicado.

Última actualización: 27 de septiembre de 2026, en el equipo del trabajo.

---

## 1. Lo primero, si algo no funciona

**Los contenedores de desarrollo están parados, y la aplicación en `localhost:4000`
no responde.** No es un fallo conocido: los mataron.

```
ticket-dev-backend   Exited (137)   21:34:55Z
ticket-dev-frontend  Exited (0)     21:34:55Z
RestartPolicy: no    -> no vuelven solos
```

Salida 137 es un SIGKILL, no una parada limpia. El log apunta al watcher de
`node --watch`:

```
1: FSWatcher.close (node:internal/fs/watchers:348:21)
2: #unwatch (node:internal/watch_mode/files_watcher:89:20)
```

La causa más probable es presión de memoria por la suite del frontend que se
ejecutó justo antes: 30 minutos de `vitest` en modo watch y después 34 ficheros de
prueba en paralelo. El log del sistema apunta a un fallo en `FSWatcher.close`, que
es el punto donde un watcher se rompe cuando se queda sin recursos. La causa exacta
no está registrada en ninguna parte, así que esto es una hipótesis razonable, no un
diagnóstico: el siguiente arranque en la consola sí dirá por qué.

**Los datos están intactos.** Comprobado montando el volumen en solo lectura:

```
journal_mode: wal     integrity_check: ok
tickets: 5    usuarios: 5    filas de adjunto: 1
```

Para levantarlos cuando haya autorización:

```powershell
$env:SEED_ADMIN_PASSWORD = ""   # la app ya esta sembrada; no hace falta sembrar
docker compose -f docker-compose.dev.yml up -d
```

No se ha hecho porque la instrucción era no reiniciar contenedores.

---

## 2. Reglas que siguen en pie

- **No reiniciar contenedores** sin autorización.
- **No modificar** los volúmenes `ticket_ticket_data` ni `ticket_ticket_uploads`.
- **No activar** el acceso remoto (Tailscale no está instalado).
- **No publicar** commits. `HEAD` sigue en `d3cfbad`, igual que `origin/main`.
- **No reactivar Git Auto Push.** La tarea sigue `Disabled`.

---

## 3. Estado de git

```
HEAD         d3cfbad
origin/main  d3cfbad
commits sin pushear: 0
```

Nada está commiteado. Todo lo de esta sesión está **sin commitear**, a propósito.

### Modificados

| Fichero | Qué cambia |
|---|---|
| `.dockerignore` | Nuevo. El contexto de build pasa de 208 MB a 2.49 MB |
| `.gitignore` | Añade credenciales de túnel y certificados exportados |
| `deploy/https/README.md` | Arquitectura HTTPS, 46 pruebas, separación de volúmenes, recuperación |

### Nuevos, sin commitear

| Fichero | Qué es |
|---|---|
| `backend/test/cors.test.js` | 13 pruebas que fijan la comparación exacta de orígenes CORS |
| `scripts/verificar-integridad.ps1` | Comprueba la base sin escribir en el volumen |
| `deploy/https/lab/compose.lab-prod.yml` | Laboratorio espejo de producción, con Caddy y sin Vite |
| `deploy/https/lab/smtp-sink.mjs` | Sumidero SMTP para probar la recuperación |
| `deploy/https/lab/verify-lab-prod.ps1` | 46 comprobaciones del despliegue espejo |
| `deploy/https/lab/compose.volsep-{prod,dev,colision}.yml` | Demostración de separación de volúmenes |
| `deploy/https/tunnel/compose.tunnel.yml` | Cloudflare Tunnel bajo perfil, inactivo |
| `deploy/https/tunnel/config.yml` | Plantilla de túnel, con marcadores sin rellenar |
| `deploy/central/ESTADO.md` | Este documento |

---

## 4. Pruebas: 972, todas en verde

| Suite | Resultado |
|---|---|
| Backend | 322/322 (antes 309; +13 de CORS) |
| Frontend | 604/604, 34 ficheros |
| Laboratorio de producción (HTTPS, cookies, recuperación, adjuntos, persistencia) | 46/46 |
| **Total** | **972, 0 fallos** |

Las 46 del laboratorio se volvieron a pasar con la imagen **reconstruida bajo el
`.dockerignore`**, para confirmar que el fichero nuevo no rompía el build.

> Aviso para cuando se executen aquí: `npm test` en `frontend/` arranca `vitest` en
> modo **watch** y se queda colgado. Usar `npx vitest run`. Es lo que probablemente
> causó la caída de contenedores: la primera ejecución de `npm test` estuvo 30
> minutos corriendo en watch hasta que la cortaron, y después corrieron 34 ficheros
> en paralelo. Si hay que repetirlo, con el desarrollo parado o con menos
> concurrencia.

---

## 5. Auditoría del sistema de servidor central

| Elemento | Estado |
|---|---|
| Volumen de datos | `ticket_ticket_data`: `tickets.db` 389 KB + **`-wal` 4.027 KB** + `-shm` |
| Volumen de adjuntos | `ticket_ticket_uploads`: 1 fichero, 72 KB |
| Contenedor de producción | **`ticket` no existe.** Nunca se ha creado en esta máquina |
| Lo único vivo (o que vivía) | `ticket-dev-backend` / `ticket-dev-frontend` |
| Puertos de desarrollo | `4000:4000` y `5173:5173` **en `0.0.0.0`**: accesibles desde toda la LAN |
| Laboratorios | 8443 y 8444, atados a `127.0.0.1`. Correcto |
| Proxy del frontend | Vite envía `/api` a `http://backend:4000` (`frontend/vite.config.js:20-25`) |
| Vite | `host: 'localhost'`, `allowedHosts: ['tickets.lan']` |
| Migraciones | **`runMigrations()` corre solo al arrancar** (`backend/src/server.js:8`) |
| `SESSION_SECRET` de desarrollo | valor fijo y público en `docker-compose.dev.yml`; la aplicación lo rechaza en producción |
| `.env` en el host | no existe |
| Tailscale | no instalado |

### Dos hallazgos que condicionan el diseño

**A. La base está en modo WAL, y el `-wal` pesa diez veces más que la base.**
Las escrituras confirmadas no están en `tickets.db`, están en el `-wal`. Copiar
solo el `.db` produce una copia incompleta. Para respaldar hay que usar la API de
copia de SQLite (`db.backup()`), no `docker cp` ni un `tar` del `.db`.

**B. Las migraciones se aplican solas al arrancar.** Cualquier commit que llegue
de casa y reinicie el servidor central **migra la base de datos real sin que nadie lo
decida**. Es el punto más delicado de todo el plan: hay que respaldar justo antes de
cada despliegue, y las migraciones tienen que ser aditivas y retrocompatibles.

---

## 6. Arquitectura decidida para el servidor central

**Una sola copia de los datos, un solo escritor.** SQLite no fusiona bases: replicar
produce dos bases que divergen el mismo día.

- **Equipo del trabajo** = copia maestra. Un `tickets.db`, un directorio de
  adjuntos, un proceso escribiendo.
- **Casa** = cliente fino. Su Vite hace de proxy hacia el backend del trabajo a
  través de Tailscale. Sin copia escribible.

Consecuencia, dicha de frente: desde casa se programa el frontend contra los datos
reales, pero **el backend no se desarrolla contra la base real**. Para tocar código
de backend en casa hace falta una instantánea local, y el cambio llega por Git.

**Prohibido**: compartir el volumen del trabajo por SMB y escribir sobre él con
SQLite. El bloqueo de SQLite sobre SMB es poco fiable y corrompe en silencio. Es la
forma más probable de que esto salga mal.

### Orden sugerido para cuando estés en la oficina

1. **Respaldos primero.** Es lo único que protege lo irreemplazable, y no depende
   de Tailscale ni de la empresa.
2. **Levantar el desarrollo** y comprobar que la aplicación responde.
3. **Verificar los respaldos** con una restauración de prueba, no solo mirarlos.
4. **Tailscale**, con la autorización de la empresa delante.
5. **Servidor central**, ya con la red privada funcionando.

Ese orden deja lo importante hecho antes de depender de permisos que pueden no
llegar.

---

## 7. Cambios pendientes de autorización

Ninguno está aplicado. Todos son preparables sin tocar volúmenes ni reiniciar nada.

| Nº | Cambio | Tarea |
|---|---|---|
| 1 | `deploy/central/compose.central.yml`: producción, secretos, puertos atados a la IP de Tailscale | 3 |
| 2 | `frontend/vite.config.js`: leer el destino del proxy de un fichero local, y **añadir `localhost` a `allowedHosts`** | 3 |
| 3 | `scripts/backup-diario.ps1`: copia con `db.backup()`, verificación y retención | 6 |
| 4 | `scripts/comprobar-antes-de-push.ps1` + hook `pre-push`: bloquea bases, adjuntos y copias | 5 |
| 5 | `scripts/identidad-base.ps1`: qué base está en uso, comparada con el servidor | 8 |
| 6 | Volúmenes de casa con otro nombre (`ticket_dev_data`) y backend de casa con interruptor explícito | 8 |
| 7 | Separar desarrollo y producción: `name:` explícito sin `external` en `docker-compose.dev.yml` | previo |

**El cambio 2 es obligatorio y se me pasó en el plan anterior**: como Vite está en
`host: 'localhost'` y `allowedHosts` solo admite `tickets.lan`, abrir
`localhost:5173` desde el navegador da 403. Hay que añadir `localhost` explícitamente
antes de que nada de esto funcione.

**El cambio 7 tiene un procedimiento completo y verificado** en
`deploy/https/README.md` §6. Lo que se demostró allí: quitar `external: true` **no
basta**, porque los dos ficheros están en el mismo directorio y ambos proyectos se
llaman `ticket`. Lo que separa es el `name:` explícito. Y el riesgo no es
hipotético: **ahora mismo el único contenedor vivo es el de desarrollo, montado
sobre los volúmenes de producción**, así que cualquier cuenta creada en
`localhost:4000` cae en la base de datos de producción.

---

## 8. Pendiente de una decisión tuya

**`logo/tailscale-setup-1.102.4.exe`** (1.3 MB) está dentro del repositorio. No lo
creó el agente: es una descarga de las 18:07 de hoy, posterior a la caída de
contenedores. `.gitignore` **no lo cubre**, así que un `git add .` lo subiría a
GitHub.

Se deja donde está, sin tocar. Cuando decidas: moverlo fuera del repo, o añadir
`*.exe` a `.gitignore`.

---

## 9. Al volver: por dónde empezar

```powershell
cd D:\ticket

# 1. Confirmar que nada se movió mientras tanto.
git log --oneline -1
git status --porcelain

# 2. Confirmar que los datos siguen intactos.
.\scripts\verificar-integridad.ps1

# 3. Confirmar que Git Auto Push sigue desactivado.
Get-ScheduledTask -TaskName "Ticket Git Auto Push" | Select-Object State

# 4. Ver el estado de los contenedores.
docker ps -a --format "{{.Names}} | {{.Status}}"
```

Después, seguir por el punto 6 de este documento, empezando por los respaldos.
