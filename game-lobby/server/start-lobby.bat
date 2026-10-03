@echo off
rem Game Lobby (Paper 26.2 + ViaVersion/ViaBackwards) port 25579 (public entrance 25576 is router/router.js)
cd /d "%~dp0"
title Game Lobby
"C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin\java.exe" -Xms1G -Xmx2G -jar paper.jar --nogui
pause
