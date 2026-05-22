#!/usr/bin/env bash
# ensure-listen.sh — 保活脚本，适合 crontab 每 5 分钟调用
# 用法: */5 * * * * cd /path/to/rin-research-humanize && bash scripts/ensure-listen.sh

set -e

cd "$(dirname "$0")/.."

PID_FILE="data/listen.pid"

# 检查 PID 文件是否存在
if [ ! -f "$PID_FILE" ]; then
  echo "[$(date -Iseconds)] PID 文件不存在，启动监听器..." >> "data/listen.log"
  bash scripts/start-listen.sh >> "data/listen.log" 2>&1
  exit 0
fi

PID=$(cat "$PID_FILE")

# 检查进程是否存活
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[$(date -Iseconds)] 进程 $PID 已死，重启监听器..." >> "data/listen.log"
  rm -f "$PID_FILE"
  bash scripts/start-listen.sh >> "data/listen.log" 2>&1
  exit 0
fi

# 进程存活，静默退出
exit 0
