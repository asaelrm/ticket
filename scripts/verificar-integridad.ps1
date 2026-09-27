# ============================================================================
# Verificar la integridad de la base de datos SIN escribir en el volumen
# ============================================================================
# Por defecto comprueba el volumen de datos de Docker tal cual esta. Con -Volumen
# se puede apuntar a cualquier otro, por ejemplo un volumen recien restaurado
# desde una copia, que es como se comprueba que una restauracion sirvio de algo.
#
# Por que no se abre la base de datos directamente en su sitio: esta en modo WAL,
# asi que al lado del .db hay un -wal y un -shm, y abrirla en solo lectura
# necesita poder crear el -shm. Montar el volumen como :ro y trabajar sobre una
# copia en memoria da el mismo resultado y no puede danar nada, ni aunque el
# script tuviera un fallo.
#
# Este script NO reinicia contenedores, NO escribe en el volumen y NO modifica la
# base de datos. Solo levanta un contenedor efimero que ya se borra solo.
#
#   .\scripts\verificar-integridad.ps1
#   .\scripts\verificar-integridad.ps1 -Volumen ticket_dev_data
#   .\scripts\verificar-integridad.ps1 -Json

[CmdletBinding()]
param(
    [string]$Volumen = 'ticket_ticket_data',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# El script que corre dentro del contenedor efimero.
$interno = Join-Path $env:TEMP 'ticket-verificar-integridad.mjs'

# Se ejecuta dentro de un contenedor efimero. El volumen llega en :ro y se copia
# a /tmp antes de abrir nada, para no depender de permisos de escritura.
@'
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const origen = process.env.ORIGEN ?? '/d';
const trabajo = '/tmp/verificacion';
fs.rmSync(trabajo, { recursive: true, force: true });
fs.mkdirSync(trabajo, { recursive: true });

const enElVolumen = fs.readdirSync(origen).filter((f) => f.startsWith('tickets.db'));
if (!enElVolumen.length) {
  console.log(JSON.stringify({ ok: false, error: 'no hay ningun tickets.db en ' + origen }));
  process.exit(2);
}
for (const f of enElVolumen) fs.copyFileSync(`${origen}/${f}`, `${trabajo}/${f}`);

const db = new DatabaseSync(`${trabajo}/tickets.db`);
const pr = (q) => db.prepare('PRAGMA ' + q).get();
const n = (s) => db.prepare(s).get().c;

const salida = {
  ok: true,
  journal_mode: pr('journal_mode').journal_mode,
  page_size: pr('page_size').page_size,
  integrity_check: pr('integrity_check').integrity_check,
  tickets: n('select count(*) c from tickets'),
  usuarios: n('select count(*) c from users'),
  categorias: n('select count(*) c from categories'),
  articulos_kb: n('select count(*) c from kb_articles'),
  filas_adjunto: n('select count(*) c from ticket_attachments'),
  ficheros_al_lado: enElVolumen.length,
};
db.close();

// Un -wal grande significa que hay escrituras sin consolidar. No es un error,
// pero conviene saberlo antes de copiar el .db a mano, porque asi NO es una copia.
try {
  salida.wal_kb = Math.round(fs.statSync(`${origen}/tickets.db-wal`).size / 1024);
} catch {
  salida.wal_kb = 0;
}

console.log(JSON.stringify(salida));
'@ | Set-Content -LiteralPath $interno -Encoding UTF8

Write-Host "Verificando el volumen '$Volumen' (solo lectura)..." -ForegroundColor Cyan

$salidaCruda = docker run --rm `
    -v "${Volumen}:/d:ro" `
    -v "${interno}:/tmp/verificar.mjs:ro" `
    -e ORIGEN=/d `
    --entrypoint node node:24-alpine /tmp/verificar.mjs 2>&1

$codigo = $LASTEXITCODE
Remove-Item -LiteralPath $interno -Force -ErrorAction SilentlyContinue

if ($codigo -ne 0) {
    Write-Host "  FALLO: no se pudo leer el volumen." -ForegroundColor Red
    $salidaCruda | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    exit $codigo
}

$datos = ($salidaCruda -join '') | ConvertFrom-Json

if ($Json) {
    $datos | ConvertTo-Json
    exit 0
}

Write-Host ''
Write-Host ("  journal_mode     : " + $datos.journal_mode) -ForegroundColor Gray
$colorIntegridad = if ($datos.integrity_check -eq 'ok') { 'Green' } else { 'Red' }
Write-Host ("  integrity_check  : " + $datos.integrity_check) -ForegroundColor $colorIntegridad
Write-Host ("  tickets          : " + $datos.tickets)
Write-Host ("  usuarios         : " + $datos.usuarios)
Write-Host ("  categorias       : " + $datos.categorias)
Write-Host ("  articulos KB     : " + $datos.articulos_kb)
Write-Host ("  filas de adjunto : " + $datos.filas_adjunto)
Write-Host ("  tamano del -wal  : " + $datos.wal_kb + " KB") -ForegroundColor Gray
Write-Host ''

if ($datos.wal_kb -gt 0) {
    Write-Host "  AVISO: hay escrituras sin consolidar en el -wal." -ForegroundColor Yellow
    Write-Host "  Para copiar la base, usar la API de copia de SQLite, NO copiar el .db." -ForegroundColor Yellow
    Write-Host ''
}

if ($datos.integrity_check -ne 'ok') {
    Write-Host "  RESULTADO: base de datos DAÑADA. No usarla, restaurar una copia." -ForegroundColor Red
    exit 1
}

Write-Host "  RESULTADO: base de datos integra." -ForegroundColor Green
exit 0
