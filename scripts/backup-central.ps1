$ErrorActionPreference = "Stop"

$Fecha = Get-Date -Format "yyyy-MM-dd_HH-mm"
$Destino = "E:\BackupsTicketCentral\$Fecha"

New-Item -ItemType Directory -Force "$Destino\uploads" | Out-Null

Write-Host "=== BACKUP TICKET CENTRAL ==="
Write-Host "Destino: $Destino"

# Backup consistente de SQLite mediante VACUUM INTO
docker run --rm `
  -v ticket_central_data:/data `
  -v "${Destino}:/backup" `
  node:24-alpine `
  node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/tickets.db'); db.exec(`"VACUUM INTO '/backup/tickets.db'`"); db.close();"

# Copiar uploads
docker run --rm `
  -v ticket_central_uploads:/source:ro `
  -v "${Destino}\uploads:/backup" `
  alpine sh -c "cp -a /source/. /backup/"

# Verificar base respaldada
docker run --rm `
  -v "${Destino}:/backup:ro" `
  node:24-alpine `
  node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/backup/tickets.db',{readOnly:true}); console.log('Integridad:',db.prepare('PRAGMA integrity_check').get().integrity_check); console.log('Usuarios:',db.prepare('SELECT COUNT(*) n FROM users').get().n); console.log('Tickets:',db.prepare('SELECT COUNT(*) n FROM tickets').get().n); console.log('Adjuntos:',db.prepare('SELECT COUNT(*) n FROM ticket_attachments').get().n); db.close();"

Write-Host ""
Write-Host "BACKUP TERMINADO CORRECTAMENTE"
