@echo off
rem Start Velocity. The NetworkCore plugin starts lobby automatically.
rem Type "end" in this window to stop the proxy and every server safely.
cd /d "%~dp0..\run\proxy"
java -Xms512M -Xmx512M -jar velocity.jar
