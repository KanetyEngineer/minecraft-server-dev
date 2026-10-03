@echo off
rem Halloween Night build/test server (Minecraft Java 26.2)
cd /d "%~dp0"
if not exist server.jar (
  echo server.jar not found. Run setup.ps1 first.
  pause
  exit /b 1
)
java -Xms2G -Xmx4G -jar server.jar nogui
pause
