# Halloween Night: make the distributable world zip from the built server world.
# Run this AFTER stopping the server. The original world folder is not modified.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
if (-not (Test-Path "world\level.dat")) { throw "world\level.dat がありません。先にサーバーでマップを建築してください。" }
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$staging = Join-Path $env:TEMP "HalloweenNight-$stamp"
$out = Join-Path $PSScriptRoot "dist\HalloweenNight_26.2_$stamp.zip"
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "dist") | Out-Null
Copy-Item "world" (Join-Path $staging "HalloweenNight") -Recurse
# player-specific data should not ship with a map
foreach ($d in @("playerdata", "stats", "advancements")) {
    $p = Join-Path $staging "HalloweenNight\$d"
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Compress-Archive -Path (Join-Path $staging "HalloweenNight") -DestinationPath $out
Remove-Item $staging -Recurse -Force
Write-Host "作成しました: $out"
Write-Host "受け取った人は .minecraft\saves に展開すればシングルプレイで遊べます。"
