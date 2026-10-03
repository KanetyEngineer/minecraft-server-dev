@echo off
rem Starts the entrance router and the lobby server
start "" "%~dp0router\start-router.bat"
start "" "%~dp0server\start-lobby.bat"
