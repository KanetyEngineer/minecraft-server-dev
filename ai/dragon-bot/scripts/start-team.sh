#!/usr/bin/env bash
# チーム（リーダー 1 体＋係）をまとめて起動する。動いているボットは先に止める。
# 使い方: bash scripts/start-team.sh [体数=3] [team|solo]
#   全部止める: stop ／ 番号を指定して止める: stop 11 100（ほかは動いたまま）／ 追加: add 11 20 [solo]
# 役割: 1 体目はリーダー、残りは前半が食料・木材係、後半が鉄・鉱石係。
# 名前は DragonBot01, DragonBot02, ... 。データ・ログ・状態ページ（3007 + 番号 - 1）は 1 体ずつ分ける。
cd "$(dirname "$0")/.." || exit 1
# add 開始番号 終了番号 [役割=solo]: 動いているボットは止めずに、指定の番号のボットだけ追加で起動する
if [ "$1" = "add" ]; then
  rev=$(git rev-parse --short HEAD 2>/dev/null)
  role=${4:-solo}
  for ((n = $2; n <= $3; n++)); do
    echo "=== restart $(date +%T) ($rev) $role ===" >> "bot-run$n.log"
    MC_USERNAME=$(printf 'DragonBot%02d' "$n") ROLE=$role DATA_DIR=data$n LOG_DIR=logs$n STATUS_PORT=$((3006 + n)) DISCORD_LEVEL=important       nohup node --max-old-space-size=1536 --env-file=.env src/index.js >> "bot-run$n.log" 2>&1 &
    sleep 2
  done
  wait
  exit 0
fi
# stop 開始番号 終了番号: その番号のボットだけ止める。ボットの見分けは状態ページのポート（3006 + 番号）を開いているプロセスで行う
if [ "$1" = "stop" ] && [ -n "$2" ]; then
  for ((n = $2; n <= ${3:-$2}; n++)); do
    port=$((3006 + 10#$n))
    powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Confirm:\$false }" >/dev/null 2>&1 \
      && echo "stop $(printf 'DragonBot%02d' "$n") (port $port)"
  done
  exit 0
fi
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
  # 名前は 2 桁の番号付き（DragonBot01〜）。データ・ログのフォルダ名は今までどおり（1 体目は番号なし）
  local name suffix=""
  name=$(printf 'DragonBot%02d' "$n")
  if [ "$n" != "1" ]; then suffix=$n; fi
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
