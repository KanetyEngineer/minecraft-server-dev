# Publish the BlockMotion site: fetch the latest Windows zip from GitHub, then wrangler deploy
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$rel = Invoke-RestMethod "https://api.github.com/repos/KanetyEngineer/minecraft-server-dev/releases?per_page=30"
$r = $rel | Where-Object { $_.tag_name -like "blockmotion-v*" } | Select-Object -First 1
$asset = $r.assets | Where-Object { $_.name -eq "BlockMotion-windows.zip" }
$ver = $r.tag_name -replace "blockmotion-v", ""
New-Item -ItemType Directory -Force public/download | Out-Null
Write-Host "Downloading BlockMotion $ver ..."
Invoke-WebRequest $asset.browser_download_url -OutFile public/download/BlockMotion-windows.zip
$html = Get-Content public/index.html -Raw -Encoding UTF8
$html = $html -replace '<span id="ver">[^<]*</span>', "<span id=`"ver`">$ver</span>"
[IO.File]::WriteAllText("$PWD/public/index.html", $html, (New-Object Text.UTF8Encoding $false))
npx --yes wrangler deploy
