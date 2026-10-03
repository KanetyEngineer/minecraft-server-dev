# 社会実験鯖（society-server）を Paper から Fabric に切り替え、鯖側で録画する ServerReplay を入れる。ワールドは引き継ぐ。
# 使い方（鯖と住人を止めてから）: powershell -ExecutionPolicy Bypass -File scripts\society-to-fabric.ps1 [-Dir ...]
# やること:
#   1) world* を backup_before_fabric_<日時>\ にコピー（何も消さない）
#   2) Paper の分かれたワールド（world_nether\DIM-1・world_the_end\DIM1）をバニラ／Fabric の形（world\DIM-1・world\DIM1）へ移す
#   3) Fabric の鯖ランチャーと MOD（Fabric API・Fabric Language Kotlin・ServerReplay）を Modrinth から落とし、sha512 を確かめる
#   4) start.bat を Fabric 用に書き換える（Paper の jar と設定は残すので、start.bat を戻せば Paper に戻せる）
param(
  [string]$Dir = "$env:USERPROFILE\Documents\ClaudeCode\society-server",
  [string]$Version = "1.21.11",
  [string]$Xmx = "4G"
)
$ErrorActionPreference = "Stop"
Set-Location $Dir
$port = (Select-String -Path server.properties -Pattern '^server-port=(\d+)').Matches[0].Groups[1].Value
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "ポート $port の鯖がまだ動いています。止めてから実行してください" }
$ua = @{ "User-Agent" = "society-bot-setup/1.0 (https://github.com/KanetyEngineer/minecraft-server-dev)" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# 1) バックアップ
$backup = Join-Path $Dir "backup_before_fabric_$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($w in @("world", "world_nether", "world_the_end", "start.bat")) { if (Test-Path $w) { Copy-Item $w -Destination $backup -Recurse -Force } }
Write-Host "バックアップ: $backup"

# 2) ワールドの形をそろえる（移すだけ。移した後の空のフォルダは別名にして残す）
foreach ($pair in @(@("world_nether", "DIM-1"), @("world_the_end", "DIM1"))) {
  $src = Join-Path $Dir "$($pair[0])\$($pair[1])"
  $dst = Join-Path $Dir "world\$($pair[1])"
  if ((Test-Path $src) -and -not (Test-Path $dst)) {
    Move-Item $src $dst
    Rename-Item (Join-Path $Dir $pair[0]) "$($pair[0])_paper_$stamp"
    Write-Host "移した: $($pair[0])\$($pair[1]) → world\$($pair[1])"
  }
}

# 3) Fabric とMOD
$loader = (Invoke-RestMethod -Headers $ua "https://meta.fabricmc.net/v2/versions/loader/$Version")[0].loader.version
$installer = (Invoke-RestMethod -Headers $ua "https://meta.fabricmc.net/v2/versions/installer")[0].version
$launcher = "fabric-server-mc.$Version-loader.$loader-launcher.$installer.jar"
if (-not (Test-Path $launcher)) {
  Invoke-WebRequest -Headers $ua -Uri "https://meta.fabricmc.net/v2/versions/loader/$Version/$loader/$installer/server/jar" -OutFile $launcher
}
Write-Host "Fabric: $launcher"
New-Item -ItemType Directory -Force -Path mods | Out-Null
foreach ($slug in @("fabric-api", "fabric-language-kotlin", "server-replay")) {
  $q = "game_versions=" + [uri]::EscapeDataString("[`"$Version`"]") + "&loaders=" + [uri]::EscapeDataString('["fabric"]')
  $v = (Invoke-RestMethod -Headers $ua "https://api.modrinth.com/v2/project/$slug/version?$q")[0]
  if (-not $v) { throw "$slug の $Version 用が見つかりません" }
  $f = $v.files | Where-Object { $_.primary } | Select-Object -First 1
  if (-not $f) { $f = $v.files[0] }
  $out = Join-Path "mods" $f.filename
  if (-not (Test-Path $out)) { Invoke-WebRequest -Headers $ua -Uri $f.url -OutFile $out }
  if ((Get-FileHash $out -Algorithm SHA512).Hash.ToLower() -ne $f.hashes.sha512.ToLower()) { Rename-Item $out "$out.broken_$stamp"; throw "$($f.filename) の sha512 が合いません" }
  Write-Host "MOD: $($f.filename)"
}

# 4) start.bat
$bat = "@echo off`r`nchcp 65001 > nul`r`ncd /d %~dp0`r`njava -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Xms$Xmx -Xmx$Xmx -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -jar $launcher nogui`r`npause`r`n"
[System.IO.File]::WriteAllText((Join-Path $Dir "start.bat"), $bat)
Write-Host ""
Write-Host "準備完了: start.bat で Fabric の鯖として起動します。録画は node scripts\society-rcon.mjs record で始めます"
