#!/usr/bin/env bash
# 3 体のチーム（リーダー・食料係・鉄係）をまとめて起動する。動いているボットは先に止める。
# 使い方: bash scripts/start-team.sh   （止めるだけなら: bash scripts/start-team.sh stop）
cd "$(dirname "$0")/.." || exit 1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*src/index.js*' | ForEach-Object { Stop-Process -Id \$_.ProcessId -Confirm:\$false }" >/dev/null 2>&1
[ "$1" = "stop" ] && exit 0
rev=$(git rev-parse --short HEAD 2>/dev/null)
start_bot() { # 名前 役割 番号（データ・ログ・状態ページを分ける）
  local name=$1 role=$2 n=$3
  local suffix=""; [ "$n" != "1" ] && suffix=$n
  echo "=== restart $(date +%T) ($rev) ===" >> "bot-run$suffix.log"
  MC_USERNAME=$name ROLE=$role DATA_DIR=data$suffix LOG_DIR=logs$suffix STATUS_PORT=$((3006 + n)) \
    nohup node --env-file=.env src/index.js >> "bot-run$suffix.log" 2>&1 &
}
start_bot DragonBot leader 1
sleep 3
start_bot DragonBot2 food 2
sleep 3
start_bot DragonBot3 iron 3
wait
