@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set "HERE=%~dp0"
rem Drop audio / MIDI / .nbs files onto this bat. Output is written next to each input file.
if not exist "%HERE%venv\Scripts\python.exe" (
  echo Please run setup.bat first.
  pause
  exit /b 1
)
if "%~1"=="" (
  echo Drop audio / MIDI / .nbs files onto this bat file.
  pause
  exit /b
)
:loop
if "%~1"=="" goto done
echo.
echo ==== %~nx1 ====
"%HERE%venv\Scripts\python.exe" "%HERE%oto2noteblock.py" "%~f1" --mc 1.19.4 --row-length 64
shift
goto loop
:done
pause
