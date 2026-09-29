<#
.SYNOPSIS
  run/ フォルダに Velocity と lobby / s1 / c1 / dev の Fabric サーバーを用意する。

.DESCRIPTION
  何度実行してもよい。jar と MOD は最新に入れ替え、server.properties やワールドなど
  既存の設定・データは上書きしない。

.PARAMETER McVersion
  Minecraft のバージョン。省略すると、Fabric API と FabricProxy-Lite が対応している
  最新のリリース版を自動で選ぶ。
#>
param(
    [string]$McVersion = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = Split-Path $PSScriptRoot -Parent
$RunDir = Join-Path $RepoRoot "run"
$Servers = @("lobby", "s1", "c1", "dev")
$Headers = @{ "User-Agent" = "KanetyEngineer/minecraft-server-dev (setup.ps1)" }

function Get-Json([string]$Url) {
    # PowerShell 5.1 の Invoke-RestMethod は JSON 配列を1つのオブジェクトとして流すので、
    # 変数に受けてから return で要素ごとに展開する（直接パイプすると Where-Object が効かない）
    $result = Invoke-RestMethod -Uri $Url -Headers $Headers
    return $result
}

function Save-File([string]$Url, [string]$Path) {
    Invoke-WebRequest -Uri $Url -Headers $Headers -OutFile $Path -UseBasicParsing
}

function Copy-IfMissing([string]$From, [string]$To) {
    if (-not (Test-Path $To)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $To -Parent) | Out-Null
        Copy-Item $From $To
    }
}

# --- Java ---
# Minecraft 26.x と Velocity 4.x は Java 25 以上が必要
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    throw "java が見つかりません。Temurin (https://adoptium.net/) の JDK 25 以上を入れてから再実行してください。"
}
$javaVersionLine = (& cmd /c "java -version 2>&1" | Select-Object -First 1) -as [string]
if ($javaVersionLine -match '"(\d+)') {
    if ([int]$Matches[1] -lt 25) {
        throw "java のバージョンが古いです ($javaVersionLine)。Temurin の JDK 25 以上を入れ、PATH の先頭にしてから再実行してください。"
    }
}

# --- EULA ---
$answer = Read-Host "Minecraft EULA (https://aka.ms/MinecraftEULA) に同意しますか？ [y/N]"
if ($answer -ne "y") {
    throw "EULA に同意しないとサーバーを起動できません。"
}

# --- バージョン決定 ---
Write-Host "MOD の対応バージョンを確認しています..."
$fabricApiVersions = Get-Json "https://api.modrinth.com/v2/project/fabric-api/version?loaders=%5B%22fabric%22%5D"
$proxyLiteVersions = Get-Json "https://api.modrinth.com/v2/project/fabricproxy-lite/version?loaders=%5B%22fabric%22%5D"
$fabricGames = Get-Json "https://meta.fabricmc.net/v2/versions/game"

if (-not $McVersion) {
    $apiGames = $fabricApiVersions | ForEach-Object { $_.game_versions }
    $proxyGames = $proxyLiteVersions | ForEach-Object { $_.game_versions }
    $candidate = $fabricGames | Where-Object {
        $_.stable -and ($apiGames -contains $_.version) -and ($proxyGames -contains $_.version)
    } | Select-Object -First 1
    if (-not $candidate) {
        throw "Fabric API と FabricProxy-Lite の両方が対応する Minecraft バージョンが見つかりません。"
    }
    $McVersion = $candidate.version
}
Write-Host "Minecraft $McVersion を使います。"

function Get-ModFile($Versions, [string]$Name) {
    $matched = $Versions | Where-Object { $_.game_versions -contains $McVersion }
    $release = $matched | Where-Object { $_.version_type -eq "release" } | Select-Object -First 1
    if (-not $release) { $release = $matched | Select-Object -First 1 }
    if (-not $release) { throw "$Name は Minecraft $McVersion に未対応です。-McVersion で別のバージョンを指定してください。" }
    $file = $release.files | Where-Object { $_.primary } | Select-Object -First 1
    if (-not $file) { $file = $release.files | Select-Object -First 1 }
    return $file
}

$fabricApiFile = Get-ModFile $fabricApiVersions "Fabric API"
$proxyLiteFile = Get-ModFile $proxyLiteVersions "FabricProxy-Lite"
$loader = (Get-Json "https://meta.fabricmc.net/v2/versions/loader" | Where-Object { $_.stable } | Select-Object -First 1).version
$installer = (Get-Json "https://meta.fabricmc.net/v2/versions/installer" | Where-Object { $_.stable } | Select-Object -First 1).version
$serverJarUrl = "https://meta.fabricmc.net/v2/versions/loader/$McVersion/$loader/$installer/server/jar"

# --- プロキシ ---
$proxyDir = Join-Path $RunDir "proxy"
New-Item -ItemType Directory -Force -Path (Join-Path $proxyDir "plugins") | Out-Null
Copy-IfMissing (Join-Path $RepoRoot "proxy\config\velocity.toml") (Join-Path $proxyDir "velocity.toml")

$secretFile = Join-Path $proxyDir "forwarding.secret"
if (-not (Test-Path $secretFile)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = ([Convert]::ToBase64String($bytes)) -replace "[+/=]", ""
    [IO.File]::WriteAllText($secretFile, $secret)
}
$secret = ([IO.File]::ReadAllText($secretFile)).Trim()

Write-Host "Velocity をダウンロードしています..."
try {
    $velocityVersions = Get-Json "https://fill.papermc.io/v3/projects/velocity/versions"
    # SNAPSHOT やサポート切れを避け、サポート中の正式版で一番新しいものを使う
    $velocityVersion = ($velocityVersions.versions | Where-Object {
        $_.version.id -notlike "*-SNAPSHOT" -and $_.version.support.status -eq "SUPPORTED"
    } | Select-Object -First 1).version.id
    if (-not $velocityVersion) { $velocityVersion = $velocityVersions.versions[0].version.id }
    $build = Get-Json "https://fill.papermc.io/v3/projects/velocity/versions/$velocityVersion/builds/latest"
    Save-File $build.downloads."server:default".url (Join-Path $proxyDir "velocity.jar")
    Write-Host "Velocity $velocityVersion (build $($build.id)) を入れました。"
} catch {
    if (-not (Test-Path (Join-Path $proxyDir "velocity.jar"))) {
        Write-Warning "Velocity を自動で取得できませんでした。https://papermc.io/downloads/velocity から jar を落とし、$proxyDir\velocity.jar として保存してください。"
    }
}

$pluginJar = Get-ChildItem (Join-Path $RepoRoot "proxy\plugin\build\libs") -Filter "network-core-*.jar" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($pluginJar) {
    Get-ChildItem (Join-Path $proxyDir "plugins") -Filter "network-core-*.jar" | Remove-Item
    Copy-Item $pluginJar.FullName (Join-Path $proxyDir "plugins")
    Write-Host "NetworkCore プラグイン ($($pluginJar.Name)) を入れました。"
} else {
    Write-Warning "NetworkCore プラグインがまだビルドされていません。proxy\plugin で .\gradlew.bat build を実行してから、もう一度このスクリプトを実行してください。"
}

# --- 各鯖 ---
foreach ($name in $Servers) {
    Write-Host "$name を用意しています..."
    $serverDir = Join-Path $RunDir $name
    $template = Join-Path $RepoRoot "servers\$name"
    New-Item -ItemType Directory -Force -Path (Join-Path $serverDir "mods") | Out-Null

    Copy-IfMissing (Join-Path $template "server.properties") (Join-Path $serverDir "server.properties")
    $proxyConfig = Join-Path $serverDir "config\FabricProxy-Lite.toml"
    Copy-IfMissing (Join-Path $template "config\FabricProxy-Lite.toml") $proxyConfig
    $content = [IO.File]::ReadAllText($proxyConfig) -replace "__FORWARDING_SECRET__", $secret
    [IO.File]::WriteAllText($proxyConfig, $content)
    [IO.File]::WriteAllText((Join-Path $serverDir "eula.txt"), "eula=true`n")

    Save-File $serverJarUrl (Join-Path $serverDir "server.jar")

    $modsDir = Join-Path $serverDir "mods"
    Get-ChildItem $modsDir -Filter "fabric-api-*.jar" | Remove-Item
    Get-ChildItem $modsDir -Filter "FabricProxy-Lite-*.jar" | Remove-Item
    Save-File $fabricApiFile.url (Join-Path $modsDir $fabricApiFile.filename)
    Save-File $proxyLiteFile.url (Join-Path $modsDir $proxyLiteFile.filename)
}

Write-Host ""
Write-Host "完了しました。scripts\start-network.bat で起動できます。" -ForegroundColor Green
