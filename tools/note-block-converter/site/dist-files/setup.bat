@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  oto2noteblock setup (first time only)
echo ============================================
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python 3.10 or newer is required.
  echo Install it from https://www.python.org/downloads/  ^(check "Add python.exe to PATH"^)
  pause
  exit /b 1
)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" || (
  echo Python 3.10 or newer is required. https://www.python.org/downloads/
  pause
  exit /b 1
)
if not exist venv\Scripts\python.exe %PY% -m venv venv
venv\Scripts\python.exe -m pip install --disable-pip-version-check -q mido || goto fail
echo.
echo MIDI / .nbs files are ready to convert.
echo.
choice /c YN /m "Also install the audio (mp3/wav) converter Basic Pitch? It downloads about 300 MB"
if errorlevel 2 goto done
venv\Scripts\python.exe -m pip install --disable-pip-version-check -q --no-deps basic-pitch==0.4.0 || goto fail
venv\Scripts\python.exe -m pip install --disable-pip-version-check -q onnxruntime librosa mir-eval pretty-midi "resampy<0.4.3" scikit-learn scipy typing-extensions "numpy<2" "setuptools<81" || goto fail
echo Audio files are ready to convert too.
:done
echo.
echo Setup finished. Drop a song file onto one of the convert bat files.
pause
exit /b 0
:fail
echo.
echo Setup failed. Check your internet connection and run this file again.
echo If the error says "No such file or directory", the folder path is too long:
echo move this folder somewhere short, such as C:oto2noteblock, and try again.
pause
exit /b 1
