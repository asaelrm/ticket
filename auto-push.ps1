$repo = "D:\ticket"
Set-Location $repo

# Solo continuar si existen cambios
$status = git status --porcelain

if ($status) {
    $fecha = Get-Date -Format "yyyy-MM-dd HH:mm"

    git add -A
    git commit -m "Auto backup $fecha"

    # Actualizar antes de subir
    git pull --rebase origin main

    if ($LASTEXITCODE -eq 0) {
        git push origin main
    }
}
