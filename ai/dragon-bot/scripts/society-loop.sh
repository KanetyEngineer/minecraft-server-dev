#!/usr/bin/env bash
# 住人 1 人の見張りループ（start-society.sh から起動される）。落ちたら 10 秒後に起動し直す。
# 使い方: bash scripts/society-loop.sh <番号> <名前> <版>
cd "$(dirname "$0")/.." || exit 1
n=$1 name=$2 rev=$3
while true; do
  echo "=== start $(date '+%F %T') ($rev) ===" >> "society/run-$name.log"
  PERSONA=$n MC_PORT=${MC_PORT_SOCIETY:-25573} DATA_DIR=society/data/$name LOG_DIR=society/logs/$name SOCIETY_DIR=society/town \
    STATUS_PORT=$((3200 + n)) DISCORD_LEVEL=important \
    node --max-old-space-size=1024 --env-file=.env src/society.js >> "society/run-$name.log" 2>&1
  [ -f society/pids ] || exit 0
  sleep 10
done
