@echo off
rem SharyTech TikTok Hub (panel http://127.0.0.1:8800/)
chcp 65001 >nul
cd /d "%~dp0"
title SharyTech TikTok Hub
if not exist node_modules (
  echo 初回のみ必要なライブラリをインストールします...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。Node.js 20 以降が入っているか確認してください: https://nodejs.org/
    pause
    exit /b 1
  )
)
start "" http://127.0.0.1:8800/
node src/index.js
pause
