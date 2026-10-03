# 社会実験用の Paper 鯖（1.21.11、127.0.0.1:25573）を新しいフォルダに用意する。既存の鯖・ワールドには触らない。
# 使い方: powershell -ExecutionPolicy Bypass -File scripts\setup-society-server.ps1 [-Dir ...] [-Port 25573] [-Op kanetyyy]
# やること:
#   1) フォルダを作り、Paper を落とす（dragon-bot-test に同じ版の paper-*.jar があればコピーして使う）
#   2) server.properties（オフライン認証・難易度ふつう・RCON あり）、eula.txt、ops.json（-Op の人を OP に）、start.bat を書く
#   3) 起動したら node scripts/society-rcon.mjs setup で、ゲームルール（死んでも持ち物を失わない・1 人寝れば朝）を入れる
# すでに server.properties があるときは上書きしない（作り直すときはフォルダごと別名に移してから実行する）。
param(
  [string]$Dir = "$env:USERPROFILE\Documents\ClaudeCode\society-server",
  [string]$Version = "1.21.11",
  [int]$Port = 25573,
  [int]$RconPort = 25583,
  [string]$Op = "kanetyyy",
  [string]$Xmx = "4G"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
if (Test-Path "server.properties") { throw "$Dir にはもう server.properties があります（上書きしません）" }

# 1) Paper
$ua = @{ "User-Agent" = "society-bot-setup/1.0 (https://github.com/KanetyEngineer/minecraft-server-dev)" }
$local = Get-ChildItem "$env:USERPROFILE\Documents\ClaudeCode\dragon-bot-test" -Filter "paper-$Version-*.jar" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
if ($local) {
  Copy-Item $local.FullName -Destination $Dir
  $jar = $local.Name
  Write-Host "Paper: $jar（dragon-bot-test からコピー）"
} else {
  $build = Invoke-RestMethod -Headers $ua -Uri "https://fill.papermc.io/v3/projects/paper/versions/$Version/builds/latest"
  $dl = $build.downloads.'server:default'
  Invoke-WebRequest -Headers $ua -Uri $dl.url -OutFile $dl.name
  if ((Get-FileHash $dl.name -Algorithm SHA256).Hash.ToLower() -ne $dl.checksums.sha256.ToLower()) { throw "$($dl.name) の sha256 が合いません" }
  $jar = $dl.name
  Write-Host "Paper: $jar（ダウンロード）"
}

# 2) 設定
# RCON のパスワードは毎回ランダムに作り、rcon.txt にだけ残す（127.0.0.1 からしか接続できない）
$rconPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
"eula=true" | Out-File -Encoding ascii eula.txt
$props = @"
online-mode=false
server-ip=127.0.0.1
server-port=$Port
difficulty=easy
gamemode=survival
spawn-protection=0
view-distance=8
simulation-distance=6
max-players=20
white-list=false
motd=MBTI Society Experiment
level-name=world
enable-rcon=true
rcon.port=$RconPort
rcon.password=$rconPass
network-compression-threshold=-1
"@
[System.IO.File]::WriteAllText((Join-Path $Dir "server.properties"), $props.Replace("`r`n", "`n"))
[System.IO.File]::WriteAllText((Join-Path $Dir "rcon.txt"), "127.0.0.1:$RconPort`n$rconPass`n")

# オフライン認証の UUID（"OfflinePlayer:名前" の MD5 から作る版 3 の UUID）
function Get-OfflineUuid([string]$name) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $b = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("OfflinePlayer:$name"))
  $b[6] = ($b[6] -band 0x0f) -bor 0x30
  $b[8] = ($b[8] -band 0x3f) -bor 0x80
  $h = -join ($b | ForEach-Object { $_.ToString("x2") })
  return "$($h.Substring(0,8))-$($h.Substring(8,4))-$($h.Substring(12,4))-$($h.Substring(16,4))-$($h.Substring(20,12))"
}
$ops = "[`n  {`n    `"uuid`": `"$(Get-OfflineUuid $Op)`",`n    `"name`": `"$Op`",`n    `"level`": 4,`n    `"bypassesPlayerLimit`": false`n  }`n]`n"
[System.IO.File]::WriteAllText((Join-Path $Dir "ops.json"), $ops)

$bat = "@echo off`r`nchcp 65001 > nul`r`ncd /d %~dp0`r`njava -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Xms$Xmx -Xmx$Xmx -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -jar $jar nogui`r`npause`r`n"
[System.IO.File]::WriteAllText((Join-Path $Dir "start.bat"), $bat)

Write-Host ""
Write-Host "準備完了: $Dir\start.bat で起動（127.0.0.1:$Port、OP: $Op）"
Write-Host "起動後に: node scripts\society-rcon.mjs setup   （ゲームルールを入れる）"
Write-Host "住人 10 人の起動: bash scripts/start-society.sh"
