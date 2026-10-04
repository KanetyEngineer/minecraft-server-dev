@echo off
rem BlockMotion をソースから起動する（exe がブロックされるとき用）。Python 3.10 以降が必要。
cd /d "%~dp0"
py -3 -m pip install --quiet --user pillow
start "" pyw -3 app\blockmotion.py
