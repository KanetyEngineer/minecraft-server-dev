# Halloween Night: PC setup (Minecraft Java 26.2)
# 1) downloads the official 26.2 server.jar from Mojang
# 2) puts the datapack into world/datapacks so it is enabled when the world is created
# Nothing is deleted or overwritten: existing files are kept.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$Version = "26.2"

if (-not (Test-Path "server.jar")) {
    Write-Host "Downloading Minecraft server $Version ..."
    $manifest = Invoke-RestMethod "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
    $entry = $manifest.versions | Where-Object { $_.id -eq $Version } | Select-Object -First 1
    if (-not $entry) { throw "version $Version not found in the Mojang manifest" }
    $meta = Invoke-RestMethod $entry.url
    Invoke-WebRequest $meta.downloads.server.url -OutFile "server.jar"
    Write-Host "server.jar downloaded."
} else {
    Write-Host "server.jar already exists (kept)."
}

New-Item -ItemType Directory -Force -Path "world\datapacks" | Out-Null
$dp = "world\datapacks\halloween_night_datapack.zip"
if (-not (Test-Path $dp)) {
    Copy-Item "halloween_night_datapack.zip" $dp
    Write-Host "Datapack copied to $dp"
} else {
    Write-Host "Datapack already in world\datapacks (kept). Replace it by hand to update."
}

if (-not (Test-Path "eula.txt")) {
    Write-Host ""
    Write-Host "Minecraft EULA: https://aka.ms/MinecraftEULA"
    $ans = Read-Host "EULA に同意しますか？ (y/N)"
    if ($ans -eq "y") { Set-Content -Path "eula.txt" -Value "eula=true" -Encoding ASCII }
}
Write-Host ""
Write-Host "準備完了。start-server.bat でサーバーを起動し、コンソールで次を実行:"
Write-Host "  op <あなたのID>"
Write-Host "ゲーム内で: /function halloween:admin/build"
