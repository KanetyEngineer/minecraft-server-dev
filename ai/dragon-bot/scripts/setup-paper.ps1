# 試験鯖（dragon-bot-test）をバニラから Paper に替えて、ボットを何十体も動かすための軽量化設定を入れる。SMP 本体には触らない。
# 使い方（鯖のコンソールで end と打って止めてから）:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-paper.ps1 [-Dir ...] [-Version 1.21.11] [-Xmx 12G] [-MaxPlayers 80] [-ViewDistance 6] [-SimulationDistance 6]
# やること:
#   1) server.properties・start.bat・既存の設定を backup_before_paper_<日時>\ に写す（何も消さない）
#   2) Paper の最新ビルドを落として sha256 を確かめる（fill.papermc.io v3、だめなら api.papermc.io v2）
#   3) server.properties（距離・最大人数など）と start.bat（Aikar の JVM フラグ）を書き換える
#   4) Paper を一度起動して設定ファイルを作らせ、ワールドの移行（world/DIM-1 → world_nether など、Paper が自動で行う）を済ませてから止める
#   5) node scripts\paper-tune.mjs で軽量化の値を書き込む
# 終わったら start.bat で起動する。元に戻すときは backup_before_paper_<日時>\ の server.properties と start.bat を戻せばバニラに戻る
# （ワールドは world\ に加えて world_nether\ と world_the_end\ に分かれるが、バニラに戻すときは Paper が逆の移行はしないので、
#   world_nether\DIM-1 と world_the_end\DIM1 を world\ の下に戻す）。
param(
  [string]$Dir = "$env:USERPROFILE\Documents\ClaudeCode\dragon-bot-test",
  [string]$Version = "1.21.11",
  [string]$Xmx = "12G",
  [int]$MaxPlayers = 80,
  [int]$ViewDistance = 6,
  [int]$SimulationDistance = 6,
  [int]$Port = 25570,
  [switch]$SkipFirstStart,   # 設定ファイルが既にあるときなど、一度起動する手順を飛ばす
  [switch]$SkipDownload      # 既に paper-*.jar があるときに使う
)
$ErrorActionPreference = "Stop"
$botDir = Split-Path -Parent $PSScriptRoot   # ai\dragon-bot
if (-not (Test-Path (Join-Path $Dir "server.properties"))) { throw "$Dir に server.properties がありません。先に scripts\setup-test-server.ps1 で試験鯖を用意してください" }
Set-Location $Dir

# 鯖が動いたままだと設定の書き換えが無駄になるので、ポートが使われていたら止める
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { throw "ポート $Port がまだ使われています。鯖のコンソールで end（Paper なら stop）と打って止めてから、もう一度実行してください" }

# 1) バックアップ（コピーするだけ。消さない）
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $Dir "backup_before_paper_$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($f in @("server.properties", "start.bat", "bukkit.yml", "spigot.yml", "config")) {
  if (Test-Path $f) { Copy-Item $f -Destination $backup -Recurse -Force }
}
Write-Host "バックアップ: $backup"

# 2) Paper のダウンロード
$ua = @{ "User-Agent" = "dragon-bot-setup/1.0 (https://github.com/KanetyEngineer/minecraft-server-dev)" }
function Get-Sha256([string]$file) { (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() }
function Save-Jar([string]$url, [string]$name, [string]$sha256) {
  if (-not (Test-Path $name)) {
    Write-Host "ダウンロード: $url"
    Invoke-WebRequest -Headers $ua -Uri $url -OutFile $name
  }
  if ($sha256 -and ((Get-Sha256 $name) -ne $sha256.ToLower())) {
    Rename-Item $name "$name.broken_$stamp"
    throw "$name の sha256 が合いません（壊れたファイルは $name.broken_$stamp に改名しました）"
  }
}
$jar = $null
if ($SkipDownload) {
  $jar = Get-ChildItem -Filter "paper-*.jar" | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty Name
  if (-not $jar) { throw "paper-*.jar が見つかりません（-SkipDownload を外してください）" }
} else {
  try {
    $build = Invoke-RestMethod -Headers $ua -Uri "https://fill.papermc.io/v3/projects/paper/versions/$Version/builds/latest"
    $dl = $build.downloads.'server:default'
    if (-not $dl.url) { throw "v3 の返事に server:default がありません" }
    Save-Jar $dl.url $dl.name $dl.checksums.sha256
    $jar = $dl.name
    Write-Host "Paper $Version build $($build.id)（$($build.channel)）: $jar"
  } catch {
    Write-Host "fill.papermc.io からの取得に失敗（$($_.Exception.Message)）。api.papermc.io（v2）を試します"
    $builds = Invoke-RestMethod -Headers $ua -Uri "https://api.papermc.io/v2/projects/paper/versions/$Version/builds"
    $b = $builds.builds | Select-Object -Last 1
    if (-not $b) { throw "Paper $Version のビルドが見つかりません" }
    $name = $b.downloads.application.name
    Save-Jar "https://api.papermc.io/v2/projects/paper/versions/$Version/builds/$($b.build)/downloads/$name" $name $b.downloads.application.sha256
    $jar = $name
    Write-Host "Paper $Version build $($b.build)（$($b.channel)）: $jar"
  }
}

# 3) server.properties と start.bat
function Set-Properties([string]$file, [hashtable]$values) {
  $lines = @(Get-Content $file)
  foreach ($k in $values.Keys) {
    $pattern = "^" + [regex]::Escape($k) + "="
    $found = $false
    $lines = @($lines | ForEach-Object { if ($_ -match $pattern) { $found = $true; "$k=$($values[$k])" } else { $_ } })
    if (-not $found) { $lines += "$k=$($values[$k])" }
  }
  [System.IO.File]::WriteAllLines((Join-Path $Dir $file), $lines)   # BOM 無しで書く（BOM があると 1 行目が壊れる）
}
Set-Properties "server.properties" @{
  "view-distance" = $ViewDistance
  "simulation-distance" = $SimulationDistance
  "max-players" = $MaxPlayers
  "sync-chunk-writes" = "false"          # Paper の既定。チャンク保存を待たない
  "network-compression-threshold" = "-1"  # ボットは同じ PC・LAN 内なので圧縮の CPU を省く
}
# Aikar のフラグ（ヒープ 12GB 以上向けの値）。-Xms を -Xmx と同じにして、起動時にメモリを確保しておく
$flags = @(
  "-Xms$Xmx", "-Xmx$Xmx",
  "-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=40", "-XX:G1MaxNewSizePercent=50",
  "-XX:G1HeapRegionSize=16M", "-XX:G1ReservePercent=15", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=20", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5",
  "-XX:SurvivorRatio=32", "-XX:+PerfDisableSharedMem", "-XX:MaxTenuringThreshold=1",
  "-Dusing.aikars.flags=https://mcflags.emc.gs", "-Daikars.new.flags=true"
) -join " "
$bat = "@echo off`r`ncd /d %~dp0`r`njava $flags -jar $jar nogui`r`npause`r`n"
[System.IO.File]::WriteAllText((Join-Path $Dir "start.bat"), $bat)
Write-Host "start.bat を Paper 用に書き換えました（$jar、-Xmx$Xmx）"

# 4) 一度起動して設定ファイルを作らせ、ワールドの移行を済ませてから止める
if (-not $SkipFirstStart) {
  Write-Host "Paper を一度起動します（設定ファイルの生成とワールドの移行のため。起動が終わったら自動で止めます）"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "java"
  $psi.Arguments = "-Xmx$Xmx -jar `"$jar`" nogui"
  $psi.WorkingDirectory = $Dir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $done = $false
  $deadline = (Get-Date).AddMinutes(10)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    $line = $p.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    Write-Host "  $line"
    if ($line -match 'Done \(') { $done = $true; break }
  }
  if ($done) {
    Write-Host "起動を確認したので止めます（stop）"
    $p.StandardInput.WriteLine("stop")
    $p.StandardInput.Flush()
  }
  $p.StandardOutput.ReadToEnd() | Out-Null
  if (-not $p.WaitForExit(300000)) { $p.Kill(); throw "Paper が 5 分たっても止まりませんでした" }
  if (-not $done) { throw "Paper の起動が確認できませんでした（Done が出なかった）。上のログを確認してください。backup_before_paper_$stamp から戻せます" }
}

# 5) 軽量化の値を書き込む
$tune = Join-Path $botDir "scripts\paper-tune.mjs"
& node $tune $Dir
if ($LASTEXITCODE -ne 0) { throw "paper-tune.mjs が失敗しました" }

Write-Host ""
Write-Host "準備完了: $Dir\start.bat で起動（127.0.0.1:$Port、最大 $MaxPlayers 人、距離 $ViewDistance / $SimulationDistance）"
Write-Host "ボットの名前を増やしたときは、鯖のコンソールで whitelist add DragonBot51 ... のように登録してください"
