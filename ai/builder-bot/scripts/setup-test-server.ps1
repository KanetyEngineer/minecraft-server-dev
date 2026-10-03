# 試験用のバニラサーバー（1.21.11）を別フォルダに用意する。SMP 本体・DragonBot の試験鯖には触らない。
param(
  [string]$Dir = "$env:USERPROFILE\Documents\ClaudeCode\builder-bot-test",
  [string]$Version = "1.21.11",
  [int]$Port = 25572,
  [string]$Op = "kanetyyy"
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
server-port=$Port
difficulty=normal
gamemode=survival
spawn-protection=0
view-distance=8
simulation-distance=8
motd=BuilderBot test
"@ | Out-File -Encoding ascii server.properties
# オフライン認証での UUID（OfflinePlayer:名前 の MD5 を v3 にしたもの）で OP にする
$md5 = [System.Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("OfflinePlayer:$Op"))
$md5[6] = ($md5[6] -band 0x0f) -bor 0x30
$md5[8] = ($md5[8] -band 0x3f) -bor 0x80
$hex = ($md5 | ForEach-Object { $_.ToString("x2") }) -join ""
$uuid = "{0}-{1}-{2}-{3}-{4}" -f $hex.Substring(0,8), $hex.Substring(8,4), $hex.Substring(12,4), $hex.Substring(16,4), $hex.Substring(20,12)
"[{`"uuid`":`"$uuid`",`"name`":`"$Op`",`"level`":4,`"bypassesPlayerLimit`":false}]" | Out-File -Encoding ascii ops.json
"@echo off`r`ncd /d %~dp0`r`njava -Xmx3G -jar server.jar nogui`r`npause" | Out-File -Encoding ascii start.bat
Write-Host "準備完了: $Dir\start.bat で起動（127.0.0.1:$Port、OP: $Op）"
