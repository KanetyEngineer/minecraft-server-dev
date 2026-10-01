# 試験用のバニラサーバー（1.21.11）を別フォルダに用意する。SMP 本体には触らない。
param(
  [string]$Dir = "$env:USERPROFILE\Documents\ClaudeCode\dragon-bot-test",
  [string]$Version = "1.21.11"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
$manifest = Invoke-RestMethod "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
$entry = $manifest.versions | Where-Object { $_.id -eq $Version }
if (-not $entry) { throw "バージョン $Version が見つかりません" }
$meta = Invoke-RestMethod $entry.url
Invoke-WebRequest $meta.downloads.server.url -OutFile "server.jar"
# EULA はユーザー同意済み。ボット用にオフライン認証・ローカル限定にする。
"eula=true" | Out-File -Encoding ascii eula.txt
@"
online-mode=false
server-ip=127.0.0.1
server-port=25570
difficulty=normal
gamemode=survival
spawn-protection=0
view-distance=8
simulation-distance=8
motd=DragonBot test
"@ | Out-File -Encoding ascii server.properties
"@echo off`r`ncd /d %~dp0`r`njava -Xmx3G -jar server.jar nogui`r`npause" | Out-File -Encoding ascii start.bat
Write-Host "準備完了: $Dir\start.bat で起動（127.0.0.1:25570）"
