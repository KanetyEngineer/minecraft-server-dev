#!/usr/bin/env bash
# チーム（リーダー 1 体＋係）をまとめて起動する。動いているボットは先に止める。
# 使い方: bash scripts/start-team.sh [体数=3] [team|solo]   （止めるだけなら: bash scripts/start-team.sh stop）
# 役割: 1 体目はリーダー、残りは前半が食料・木材係、後半が鉄・鉱石係。
# 名前は DragonBot, DragonBot2, ... 。データ・ログ・状態ページ（3007 + 番号 - 1）は 1 体ずつ分ける。
cd "$(dirname "$0")/.." || exit 1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*src/index.js*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Confirm:\$false }" >/dev/null 2>&1
[ "$1" = "stop" ] && exit 0
n_total=${1:-3}
# 2 番目の引数が solo なら、全員が独立して動く（チームを組まない）
mode=${2:-team}
rev=$(git rev-parse --short HEAD 2>/dev/null)
helpers=$((n_total - 1))
food_n=$((helpers / 2))
start_bot() { # 番号 役割
  local n=$1 role=$2
  local name=DragonBot suffix=""
  if [ "$n" != "1" ]; then name=DragonBot$n; suffix=$n; fi
  echo "=== restart $(date +%T) ($rev) $role ===" >> "bot-run$suffix.log"
  # 係は Discord に大事な行だけ送る（全員分を送ると Discord の送信上限を超える）
  # 独立モードでは DragonBot（1 体目）だけ全部送る
  local discord=all; [ "$n" != "1" ] && discord=important
  MC_USERNAME=$name ROLE=$role DATA_DIR=data$suffix LOG_DIR=logs$suffix STATUS_PORT=$((3006 + n)) DISCORD_LEVEL=$discord \
    nohup node --max-old-space-size=1536 --env-file=.env src/index.js >> "bot-run$suffix.log" 2>&1 &
}
if [ "$mode" = "solo" ]; then
  for ((n = 1; n <= n_total; n++)); do start_bot "$n" solo; sleep 2; done
else
  start_bot 1 leader
  for ((n = 2; n <= n_total; n++)); do
    sleep 2
    if (( n - 1 <= food_n )); then start_bot "$n" food; else start_bot "$n" iron; fi
  done
fi
wait
