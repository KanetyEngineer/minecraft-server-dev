#!/usr/bin/env bash
# 社会実験の住人（MBTI の性格を持つ 10 人）をまとめて起動する。動いている住人は先に止める。
# 使い方: bash scripts/start-society.sh [人数=10]   ／ 全員止める: bash scripts/start-society.sh stop
# 1 人ずつ、落ちたら 10 秒後に起動し直す見張りのループの中で動かす。
# 記憶は society/data/<名前>/、ログは society/logs/<名前>/ と society/run-<名前>.log、町の台帳と出来事は society/town/。
# 状態ページは住人 n が http://localhost:(3200 + n)/、町全体のダッシュボードは http://localhost:3300/（scripts/society-dashboard.mjs）。
cd "$(dirname "$0")/.." || exit 1
NAMES=(Rin_INTJ Kaito_ENTP Shiori_INFJ Hinata_ENFP Kenji_ISTJ Mio_ESFJ Takumi_ISTP Nana_ESFP Yuki_INFP Daichi_ESTJ)
stop_all() {
  # 見張りのループ（bash）と住人（node src/society.js）の両方を止める
  [ -f society/pids ] && while read -r pid; do kill "$pid" 2>/dev/null; done < society/pids
  rm -f society/pids
  # pids に載っていない見張りのループ（前の起動を同時に 2 回走らせたときの残りなど）も止める。
  # ループは scripts/society-loop.sh として動くので、その名前で探す（start-society の名前で探すと、これを呼んだシェルまで止めてしまう）
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object CommandLine -like '*society-loop.sh*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -Confirm:\$false -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*src/society.js*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Confirm:\$false }" >/dev/null 2>&1
}
stop_all
[ "$1" = "stop" ] && { echo "住人を全員止めました"; exit 0; }
n_total=${1:-10}
mkdir -p society/town society/data society/logs
rev=$(git rev-parse --short HEAD 2>/dev/null)
for ((n = 1; n <= n_total; n++)); do
  name=${NAMES[$((n - 1))]}
  nohup bash scripts/society-loop.sh "$n" "$name" "$rev" > /dev/null 2>&1 &
  echo $! >> society/pids
  echo "start $name（状態ページ http://localhost:$((3200 + n))/）"
  sleep 3
done
echo "町のダッシュボード: node scripts/society-dashboard.mjs → http://localhost:3300/"
