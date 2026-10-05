@echo off
rem 参加券の購入者を各ゲーム鯖のホワイトリストへ反映する（常時動かす）
cd /d "%~dp0"
node sync.js config.json >> sync.log 2>&1
