#!/usr/bin/env bash
# 社会実験の町を動かす（町の管理役 scripts/society-world.mjs を起動し、管理役が戸籍にいる住人をひとりずつ起動する）。
# 使い方: bash scripts/start-society.sh   ／ 全員止める: bash scripts/start-society.sh stop
# 結婚・出産・老衰も管理役が扱う。戸籍は society/town/world.json、管理役のログは society/world.log。
# 記憶は society/data/<名前>/、ログは society/logs/<名前>/ と society/run-<名前>.log、町の台帳と出来事は society/town/。
# 状態ページは住人の番号 n が 10 以下なら http://localhost:(3200 + n)/、11 以上なら (3500 + n)。町全体は http://localhost:3300/（scripts/society-dashboard.mjs）。
cd "$(dirname "$0")/.." || exit 1
stop_all() {
  # 管理役と住人（node src/society.js）、前の版の見張りループ（society-loop.sh）を止める
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*society-world.mjs*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object CommandLine -like '*society-loop.sh*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*src/society.js*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  rm -f society/pids
}
stop_all
[ "$1" = "stop" ] && { echo "町を止めました"; exit 0; }
mkdir -p society/town society/data society/logs
nohup node scripts/society-world.mjs >> society/world.log 2>&1 &
echo "町の管理役を起動しました（ログ: society/world.log）"
echo "町のダッシュボード: node scripts/society-dashboard.mjs → http://localhost:3300/"
