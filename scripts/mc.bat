@echo off
rem Send a command to a running server: mc lobby whitelist add NAME / mc all list / mc s1 (interactive)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rcon.ps1" %*
