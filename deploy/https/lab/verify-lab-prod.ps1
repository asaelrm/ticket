# ============================================================
# Verificacion del LABORATORIO ESPEJO DE PRODUCCION (ticketlabprod)
# ============================================================
# No toca el servicio real. Solo exercise 127.0.0.1:8444 del laboratorio,
# que corre en su propia red, sus propios volumenes y su propia imagen.
#
# Cubre, en este orden:
#   1. Inicio de sesion
#   2. Cookies seguras (y que HTTP plano no sirva la sesion)
#   3. Recuperacion de contrasena (con SMTP de verdad, no el modo dev)
#   4. Archivos adjuntos (subida, descarga y permisos)
#   5. Persistencia de datos (el proceso se reinicia; los datos no)
#
# Uso:
#   $env:LABPROD_ADMIN_PASSWORD = "..."
#   powershell -ExecutionPolicy Bypass -File deploy\https\lab\verify-lab-prod.ps1
#
# La contrasena del laboratorio se toma del entorno o de -Password. Al final
# se RESTITUYE la contrasena original, para que el script se pueda repetir.
# No hay ninguna credencial escrita en este archivo a proposito.

param(
  [string]$CaPath = (Join-Path $env:TEMP "labprod-root.crt"),
  [string]$Host_ = "tickets.lan",
  [int]$Port = 8444,
  [string]$App = "ticketlabprod-app-1",
  [string]$Sink = "ticketlabprod-smtpsink-1",
  [string]$Username = $(if ($env:LABPROD_ADMIN_USERNAME) { $env:LABPROD_ADMIN_USERNAME } else { "admin" }),
  [string]$Password = $env:LABPROD_ADMIN_PASSWORD
)

if ([string]::IsNullOrWhiteSpace($Password)) {
  "ERROR: falta la contrasena del laboratorio."
  "  Defina LABPROD_ADMIN_PASSWORD en el entorno o pase -Password."
  exit 2
}
if (-not (Test-Path $CaPath)) {
  "ERROR: no esta el certificado de la CA en $CaPath"
  exit 2
}

$ErrorActionPreference = "Continue"
$script:fail = 0
$script:pass = 0
$work = Join-Path $env:TEMP "ticketlabprod-verify"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work -Force | Out-Null
Set-Location $work

function CurlLab {
  $a = @("--cacert", $CaPath, "--ssl-no-revoke", "--resolve", "$($Host_):$($Port):127.0.0.1", "-s") + $args
  & curl.exe @a
}

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; "  PASS  $name" }
  else { $script:fail++; "  FAIL  $name  ->  $detail" }
}

function Estado($f) {
  if (Test-Path $f) {
    # Se toma la ULTIMA linea de estado: con cuerpos grandes curl abre una
    # conexion y el servidor responde "100 Continue" antes que la real.
    $l = @(Select-String -Path $f -Pattern "^HTTP/") | Select-Object -Last 1
    if ($l) { $l.Line } else { "(sin linea de estado)" }
  } else { "(sin respuesta)" }
}

# Deshace quoted-printable. El correo llega con el cuerpo codificado y el
# enlace partido en lineas con cortes blandos ("=" al final de la linea), que
# es como se codifican los textos largos. Un cliente de correo lo desempaqueta
# antes de mostrarlo; este extractor tiene que hacerlo igual.
function Decode-QP([string]$texto) {
  $t = $texto -replace "=\r?\n", ""
  [regex]::Replace($t, "=([0-9A-Fa-f]{2})", {
    param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16)
  })
}

# Hace un POST con JSON. Deja el codigo HTTP en $script:code, las cabeceras
# en el fichero indicado y el cuerpo en cuerpo-salida.txt (y en $script:cuerpo).
function PostJson($fichero, $url, $objeto, $csrf) {
  $objeto | ConvertTo-Json -Compress | Out-File -Encoding ascii cuerpo.json
  $base = @("--cacert", $CaPath, "--ssl-no-revoke", "--resolve", "$($Host_):$($Port):127.0.0.1", "-s")
  $peticion = @("-b", $jar, "-c", $jar, "-D", $fichero, "-o", "cuerpo-salida.txt",
                "-w", "%{http_code}", "-X", "POST",
                "-H", "Content-Type: application/json", "-H", "x-csrf-token: $csrf",
                "--data", "@cuerpo.json", $url)
  $salida = & curl.exe @($base + $peticion)
  $script:code = ($salida -join "").Trim()
  $script:cuerpo = ""
  if (Test-Path "cuerpo-salida.txt") { $script:cuerpo = Get-Content "cuerpo-salida.txt" -Raw }
}

# Devuelve el valor de tf_csrf del tarro de cookies.
function Csrf() {
  $linea = Get-Content $jar -ErrorAction SilentlyContinue | Where-Object { $_ -match "tf_csrf" }
  if ($linea) { return ($linea -split "`t")[-1] }
  return ""
}

# Abre sesion y deja la cookie en el tarro.
function Login($clave) {
  Remove-Item $jar -Force -ErrorAction SilentlyContinue
  CurlLab -c $jar -o NUL "https://$($Host_):$($Port)/api/auth/me" | Out-Null
  $c = Csrf
  PostJson "hlog.txt" "https://$($Host_):$($Port)/api/auth/login" @{ account = $Username; password = $clave } $c
  return $script:code
}

$jar = "jar.txt"

# ---------------------------------------------------------------- 1
"== 1. Inicio de sesion =="
$code = Login $Password
Check "login correcto" ($code -eq "200") "codigo=$code"
$me = CurlLab -b $jar "https://$($Host_):$($Port)/api/auth/me"
$patronUsuario = '"username"\s*:\s*"' + [regex]::Escape($Username) + '"'
Check "la sesion identifica al usuario" ($me -match $patronUsuario) "respuesta: $me"
$c = Csrf
PostJson "hbad.txt" "https://$($Host_):$($Port)/api/auth/login" @{ account = $Username; password = "no-es-la-contrasena" } $c
Check "una contrasena incorrecta se rechaza" ($code -eq "401" -or $code -eq "400") "codigo=$code"
$code = Login $Password

# ---------------------------------------------------------------- 2
"== 2. Cookies seguras =="
$cab = Get-Content hlog.txt -Raw
Check "tf_sid con Secure"  ($cab -match "tf_sid=[^;]*;[^\r\n]*Secure")  "falta Secure"
Check "tf_sid con HttpOnly" ($cab -match "tf_sid=[^;]*;[^\r\n]*HttpOnly") "falta HttpOnly"
Check "tf_sid con SameSite" ($cab -match "tf_sid=[^;]*;[^\r\n]*SameSite") "falta SameSite"

# El laboratorio solo publica el 443 de Caddy, y Caddy solo habla TLS. Un
# cliente HTTP plano no llega a la aplicacion; lo que NO debe pasar es un 200.
$code = CurlLab -b $jar -o NUL -w "%{http_code}" "http://$($Host_):$($Port)/api/auth/me"
Check "no sirve la sesion por HTTP plano" ($code -ne "200") "respondio $code con la sesion"

# El cliente no puede degradar la cookie declarando http.
$h = CurlLab -b $jar -D - -o NUL -H "X-Forwarded-Proto: http" "https://$($Host_):$($Port)/api/auth/me"
Check "X-Forwarded-Proto:http del cliente se ignora" ($h -match "200 OK") "no respondio 200: la cabecera falsificada gano"
Check "HSTS presente" ($h -match "strict-transport-security") "no aparece Strict-Transport-Security"

# El frontend lo sirve Express desde la build, no Vite.
$code = CurlLab -o page.html -w "%{http_code}" "https://$($Host_):$($Port)/"
$page = Get-Content page.html -Raw
Check "el frontend compilado responde 200" ($code -eq "200") "codigo=$code"
Check "no se sirve ningun modulo fuente de Vite" ($page -notmatch "/src/main.jsx") "el HTML apunta a /src/: eso es Vite, no la build"
Check "el HTML monta la aplicacion" ($page -match 'id="root"') "no aparece id=root"
foreach ($r in @("/login", "/forgot-password", "/reset-password", "/app/tickets")) {
  $code = CurlLab -o NUL -w "%{http_code}" "https://$($Host_):$($Port)$r"
  Check "ruta $r devuelve 200" ($code -eq "200") "codigo=$code"
}

# ---------------------------------------------------------------- 3
"== 3. Recuperacion de contrasena =="
$antes = [int](& docker exec $Sink sh -c "ls /correo 2>/dev/null | wc -l")
$c = Csrf
PostJson "hforgot.txt" "https://$($Host_):$($Port)/api/auth/forgot-password" @{ account = $Username } $c
Check "forgot-password responde 200" ($code -eq "200") "codigo=$code"
# En produccion el token NO puede volver en la respuesta: solo por correo.
Check "la respuesta NO devuelve el token" ($script:cuerpo -notmatch 'token') "respuesta: $($script:cuerpo)"

$despues = [int](& docker exec $Sink sh -c "ls /correo 2>/dev/null | wc -l")
Check "llego un correo al SMTP del laboratorio" ($despues -gt $antes) "antes=$antes despues=$despues"

$correo = Decode-QP ((& docker exec $Sink sh -c 'cat /correo/$(ls -t /correo | head -1)') -join "`n")
$enlace = [regex]::Match($correo, 'https?://[^\s"''<>]+/reset-password\?token=[A-Za-z0-9_-]+')
Check "el correo trae un enlace de recuperacion" ($enlace.Success) "no se encontro el enlace en el correo"
if ($enlace.Success) {
  $valorEnlace = $enlace.Value
  $tokenRec = ($enlace.Value -split "token=")[-1]
  Check "el enlace usa el origen publico HTTPS" ($valorEnlace.StartsWith("https://tickets.lan/reset-password?token=")) "enlace: $($valorEnlace -replace 'token=.*','token=...')"

  $c = Csrf
  # La contrasena nueva se genera en cada ejecucion en vez de estar escrita aqui.
  # El script solo necesita una contrasena que acabo de fijar, no una en
  # concreto, asi que no hay motivo para dejar ninguna en el repositorio: este
  # es un fichero publico y las cadenas que parecen contrasenas se copian.
  $claveNueva = "Lab" + [guid]::NewGuid().ToString("N").Substring(0, 10) + "!"
  $claveVieja = "Lab" + [guid]::NewGuid().ToString("N").Substring(0, 10) + "!"

  PostJson "hreset.txt" "https://$($Host_):$($Port)/api/auth/reset-password" @{ token = $tokenRec; password = $claveNueva } $c
  Check "reset-password con el token del correo" ($code -eq "200") "codigo=$code"

  $c = Csrf
  PostJson "hreuso.txt" "https://$($Host_):$($Port)/api/auth/reset-password" @{ token = $tokenRec; password = $claveVieja } $c
  Check "el token no se puede reutilizar" ($code -eq "400") "codigo=$code"

  # La anterior deja de servir y la nueva entra.
  $code = Login $Password
  Check "la contrasena anterior deja de servir" ($code -ne "200") "codigo=$code"
  $code = Login $claveNueva
  Check "la contrasena nueva entra" ($code -eq "200") "codigo=$code"

  # Se restituye la original, para que el script se pueda repetir.
  $c = Csrf
  PostJson "hrest.txt" "https://$($Host_):$($Port)/api/auth/change-password" @{ current_password = $claveNueva; new_password = $Password } $c
  Check "se restituye la contrasena original" ($code -eq "200") "codigo=$code"
  $code = Login $Password
  Check "se puede volver a entrar con la original" ($code -eq "200") "codigo=$code"
}

# ---------------------------------------------------------------- 4
"== 4. Archivos adjuntos =="
$cat = CurlLab -b $jar "https://$($Host_):$($Port)/api/categories"
$catId = ([regex]::Match($cat, '"id"\s*:\s*(\d+)')).Groups[1].Value
Check "hay categorias para crear el ticket" ([bool]$catId) "no se pudo leer /api/categories: $cat"

Set-Content -Path adjunto.txt -Value "contenido-del-adjunto-del-laboratorio-1234567890" -Encoding ascii -NoNewline
$suma = (Get-FileHash adjunto.txt -Algorithm SHA256).Hash
$bytes = (Get-Item adjunto.txt).Length
$c = Csrf
CurlLab -b $jar -c $jar -D hticket.txt -o bticket.txt -X POST -H "x-csrf-token: $c" `
  -F "title=Ticket de prueba del laboratorio" -F "description=Creado por verify-lab-prod.ps1" `
  -F "category_id=$catId" -F "priority=MEDIUM" -F "files=@adjunto.txt;type=text/plain" `
  "https://$($Host_):$($Port)/api/tickets" | Out-Null
$estadoTicket = Estado hticket.txt
Check "crear ticket con adjunto" ($estadoTicket -match "200 OK" -or $estadoTicket -match "201") "estado: $estadoTicket"

$adjId = & docker exec $App node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/backend/data/tickets.db');const r=db.prepare('SELECT id FROM ticket_attachments ORDER BY id DESC LIMIT 1').get();process.stdout.write(String(r?r.id:''))"
Check "el adjunto queda registrado" ([bool]$adjId) "no hay filas en ticket_attachments"

if ($adjId) {
  # Sin sesion no se descarga.
  $code = CurlLab -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/files/$adjId"
  Check "sin sesion no se descarga el adjunto" ($code -eq "401") "codigo=$code"

  $code = Login $Password
  CurlLab -b $jar -D hfile.txt -o descargado.txt "https://$($Host_):$($Port)/api/files/$adjId"
  Check "el adjunto se descarga" ((Estado hfile.txt) -match "200") "estado: $(Estado hfile.txt)"
  if (Test-Path descargado.txt) {
    $descarga = (Get-FileHash descargado.txt -Algorithm SHA256).Hash
    Check "el contenido descargado es identico al subido" ($descarga -eq $suma) "sha256 subido=$($suma.Substring(0,12)) descargado=$($descarga.Substring(0,12))"
  }
  $fh = Get-Content hfile.txt -Raw
  Check "el adjunto lleva nosniff" ($fh -match "X-Content-Type-Options:\s*nosniff") "falta nosniff"
  Check "el adjunto no se cachea" ($fh -match "Cache-Control:\s*private, no-store") "falta no-store"
  Check "el adjunto se ofrece como descarga" ($fh -match "Content-Disposition:\s*attachment") "falta attachment"
  Check "el tamano declarado coincide" ($fh -match "Content-Length:\s*$bytes") "cabecera: $(($fh -split "`n" | Where-Object { $_ -match 'Content-Length' }) -join '')"

  # Una extension prohibida se rechaza, aunque el MIME diga lo que quiera.
  Set-Content -Path peligroso.exe -Value "MZ-falso" -Encoding ascii
  $c = Csrf
  CurlLab -b $jar -c $jar -D hbad2.txt -o NUL -X POST -H "x-csrf-token: $c" `
    -F "title=Ticket con adjunto prohibido" -F "description=Prueba de filtrado" `
    -F "category_id=$catId" -F "files=@peligroso.exe;type=application/octet-stream" `
    "https://$($Host_):$($Port)/api/tickets" | Out-Null
  Check "un .exe se rechaza" ((Estado hbad2.txt) -match "400") "estado: $(Estado hbad2.txt)"

  # Un archivo que pasa del limite se rechaza sin tumbar el servicio.
  Set-Content -Path grande.txt -Value ("x" * (6 * 1024 * 1024)) -Encoding ascii
  $c = Csrf
  # "Expect:" vacio: sin el 100-continue, la respuesta real es la primera.
  CurlLab -b $jar -c $jar -D hbig.txt -o NUL -X POST -H "x-csrf-token: $c" -H "Expect:" `
    -F "title=Ticket con adjunto enorme" -F "description=Prueba de limite" `
    -F "category_id=$catId" -F "files=@grande.txt;type=text/plain" `
    "https://$($Host_):$($Port)/api/tickets" | Out-Null
  Check "un adjunto de 6 MB se rechaza (limite 5 MB)" ((Estado hbig.txt) -match "400") "estado: $(Estado hbig.txt)"

  $code = CurlLab -b $jar -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/health"
  Check "el servicio sigue vivo tras los rechazos" ($code -eq "200") "codigo=$code"
}

# ---------------------------------------------------------------- 5
"== 5. Persistencia de datos =="
$ticketsAntes = & docker exec $App node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/backend/data/tickets.db');process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM tickets').get().c))"
Check "hay tickets creados en el laboratorio" ([int]$ticketsAntes -ge 1) "tickets=$ticketsAntes"
"  (reiniciando el contenedor: el proceso muere, los volumenes no)"
& docker restart $App | Out-Null
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  $code = CurlLab -b $jar -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/health"
  if ($code -eq "200") { $ok = $true; break }
}
Check "el servicio vuelve tras el reinicio" ($ok) "no respondio 200"
$ticketsDespues = & docker exec $App node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/backend/data/tickets.db');process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM tickets').get().c))"
Check "los tickets sobreviven al reinicio" ($ticketsDespues -eq $ticketsAntes) "antes=$ticketsAntes despues=$ticketsDespues"
$code = CurlLab -b $jar -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/auth/me"
Check "la sesion sobrevive al reinicio" ($code -eq "200") "codigo=$code"
if ($adjId) {
  $code = Login $Password
  CurlLab -b $jar -o persistido.txt "https://$($Host_):$($Port)/api/files/$adjId"
  $p = (Get-FileHash persistido.txt -Algorithm SHA256).Hash
  Check "el adjunto sigue descargandose tras el reinicio" ($p -eq $suma) "sha256 esperado=$($suma.Substring(0,12)) obtenido=$($p.Substring(0,12))"
  $uploads = & docker exec $App sh -c "ls /app/backend/uploads 2>/dev/null | head -1"
  Check "el fichero sigue en el volumen de adjuntos" ([bool]$uploads) "el volumen de uploads esta vacio"
}

""
"  ---- $script:pass correctas, $script:fail fallidas ----"
if ($script:fail -eq 0) { "RESULTADO: todas las comprobaciones pasaron"; exit 0 }
"RESULTADO: $($script:fail) comprobacion(es) fallaron"; exit $script:fail
