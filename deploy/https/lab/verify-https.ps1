# ============================================================
# Verificacion del laboratorio HTTPS aislado  (stack `ticketlab`)
# ============================================================
# No toca el servicio real. Solo exercise 127.0.0.1:8443 del
# laboratorio, que corre en su propia red y sus propios volumenes.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File deploy\https\lab\verify-https.ps1 `
#       -CaPath C:\ruta\a\caddy-root.crt
#
# La cuenta del laboratorio se toma del entorno (mismas variables que
# compose.lab.yml) o de -Username / -Password. No hay ninguna credencial
# escrita en este archivo a proposito.
#
# Sale con codigo 0 si todo pasa, o con el numero de fallos.

param(
  [Parameter(Mandatory = $true)][string]$CaPath,
  [string]$Host_ = "tickets.lan",
  [int]$Port = 8443,
  [string]$Container = "ticketlab-backend-1",
  [string]$Username = $(if ($env:LAB_ADMIN_USERNAME) { $env:LAB_ADMIN_USERNAME } else { "admin" }),
  [string]$Password = $env:LAB_ADMIN_PASSWORD,
  # Reinicia el backend del laboratorio y comprueba que la sesion aguanta.
  [switch]$WithRestart
)

if ([string]::IsNullOrWhiteSpace($Password)) {
  "ERROR: falta la contrasena del laboratorio."
  "  Defina LAB_ADMIN_PASSWORD en el entorno o pase -Password."
  "  Es la misma variable que usa compose.lab.yml para crear la cuenta."
  exit 2
}

$ErrorActionPreference = "Continue"
$script:fail = 0
$work = Join-Path $env:TEMP "ticketlab-verify"
New-Item -ItemType Directory -Path $work -Force | Out-Null
Set-Location $work

# Nota: el nombre NO puede ser `Curl`, porque en PowerShell el alias
# `curl` (Invoke-WebRequest) tiene prioridad sobre las funciones.
function CurlLab {
  $a = @("--cacert", $CaPath, "--ssl-no-revoke", "--resolve", "$($Host_):$($Port):127.0.0.1", "-s") + $args
  & curl.exe @a
}

function Check($name, $cond, $detail) {
  if ($cond) { "  PASS  $name" }
  else { $script:fail++; "  FAIL  $name  ->  $detail" }
}

$jar = "jar.txt"
Remove-Item $jar,h*.txt -ErrorAction SilentlyContinue
# El cuerpo se genera con ConvertTo-Json para no tener que escapar a mano ni
# dejar la contrasena escrita en el archivo.
@{ account = $Username; password = $Password } | ConvertTo-Json -Compress |
  Out-File -Encoding ascii body.json

"== 1. HTTPS real y HSTS por host =="
$code = CurlLab -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/health"
Check "health por HTTPS responde 200" ($code -eq "200") "codigo=$code"
$h = CurlLab -D - -o NUL "https://$($Host_):$($Port)/api/health"
Check "HSTS presente" ($h -match "strict-transport-security") "no aparece"

"== 2. Cabeceras de proxy falsificadas por el cliente =="
$h = CurlLab -D - -o NUL -H "X-Forwarded-Proto: http" -H "X-Forwarded-Host: evil.example" -H "X-Forwarded-For: 8.8.8.8" "https://$($Host_):$($Port)/api/health"
Check "X-Forwarded-Proto:http ignorado (HSTS sigue)" ($h -match "strict-transport-security") "HSTS desaparecio: gano la cabecera falsificada"

"== 3. Cookies de sesion por HTTPS =="
CurlLab -c $jar -o NUL "https://$($Host_):$($Port)/api/auth/me" | Out-Null
$csrf = ((Get-Content $jar | Where-Object { $_ -match "tf_csrf" }) -split "`t")[-1]
CurlLab -b $jar -c $jar -D h1.txt -o b1.txt -X POST -H "Content-Type: application/json" -H "x-csrf-token: $csrf" --data "@body.json" "https://$($Host_):$($Port)/api/auth/login" | Out-Null
$login = Get-Content h1.txt -Raw
Check "login correcto" ($login -match "200 OK") "estado: $((Select-String -Path h1.txt -Pattern '^HTTP/' | ForEach-Object { $_.Line }))"
Check "tf_sid con Secure"  ($login -match "tf_sid=[^;]*;[^\r\n]*Secure")  "falta Secure"
Check "tf_sid con HttpOnly" ($login -match "tf_sid=[^;]*;[^\r\n]*HttpOnly")      "falta HttpOnly"
Check "tf_sid con SameSite" ($login -match "tf_sid=[^;]*;[^\r\n]*SameSite")      "falta SameSite"

"== 4. Sin entrada HTTP directa al backend =="
# El puerto 8443 del laboratorio es el 443 de Caddy, que solo habla TLS.
# Un cliente HTTP plano recibe un 400 de Caddy o falla la conexion; lo que
# NO debe ocurrir nunca es un 200 con datos de sesion.
$code = CurlLab -b $jar -o NUL -w "%{http_code}" "http://$($Host_):$($Port)/api/auth/me"
Check "no sirve la API por HTTP plano" ($code -ne "200") "respondio $code con la sesion"

"== 5. CSRF sigue vigente =="
# /api/auth/login esta exento de CSRF por diseno, asi que se prueba sobre un
# endpoint protegido: crear un ticket.
CurlLab -b $jar -o NUL -D h2.txt -X POST -H "Content-Type: application/json" -H "x-csrf-token: token-falso" --data "{}" "https://$($Host_):$($Port)/api/tickets" | Out-Null
$bad = (Select-String -Path h2.txt -Pattern "^HTTP/" | ForEach-Object { $_.Line })
Check "token falso rechazado (403)" ($bad -match "403") "estado: $bad"
$csrf2 = ((Get-Content $jar | Where-Object { $_ -match "tf_csrf" }) -split "`t")[-1]
CurlLab -b $jar -c $jar -D h3.txt -o NUL -X POST -H "Content-Type: application/json" -H "x-csrf-token: $csrf2" --data "{}" "https://$($Host_):$($Port)/api/tickets" | Out-Null
$ok = (Select-String -Path h3.txt -Pattern "^HTTP/" | ForEach-Object { $_.Line })
Check "token valido llega al controlador (no 403)" ($ok -notmatch "403") "estado: $ok"

"== 6. El certificado no vale para otros nombres =="
$code = & curl.exe --cacert $CaPath --ssl-no-revoke -s -o NUL -w "%{http_code}" "https://127.0.0.1:$($Port)/api/health"
Check "rechaza otro hostname" ($code -eq "000") "respondio $code"

"== 7. Reinicio del contenedor =="
if (-not $WithRestart) {
  "  (omitida: pasar -WithRestart para ejecutarla)"
} else {
  $code = CurlLab -b $jar -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/auth/me"
  Check "sesion viva antes de reiniciar" ($code -eq "200") "estado: $code"
  docker restart $Container | Out-Null
  # El arranque tarda: npm install + migraciones + seed.
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    $code = CurlLab -b $jar -o NUL -w "%{http_code}" "https://$($Host_):$($Port)/api/auth/me"
    if ($code -eq "200") { $ok = $true; break }
  }
  Check "el backend vuelve a responder" ($ok) "no respondio 200 tras el reinicio"
  Check "la sesion sobrevive al reinicio" ($code -eq "200") "estado: $code (SECRET o.store cambiaron)"
  $h = CurlLab -D - -o NUL "https://$($Host_):$($Port)/api/health"
  Check "HSTS sigue tras el reinicio" ($h -match "strict-transport-security") "HSTS desaparecio"
}

""
if ($script:fail -eq 0) { "RESULTADO: todas las comprobaciones pasaron"; exit 0 }
"RESULTADO: $($script:fail) comprobacion(es) fallaron"; exit $script:fail
