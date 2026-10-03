<#
.SYNOPSIS
  Windows にサインインしたとき start-network.bat を自動で起動するタスクを登録する。
  解除するときは: Unregister-ScheduledTask -TaskName "MinecraftNetwork"
#>
$ErrorActionPreference = "Stop"
$bat = Join-Path $PSScriptRoot "start-network.bat"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "MinecraftNetwork" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "サインイン時に Minecraft ネットワークが起動するよう登録しました。"
