#!/usr/bin/env bash
# start-listen.sh — 启动 OneBot 监听器（持久化）

set -e

cd "$(dirname "$0")/.."

PID_FILE="data/listen.pid"
LOG_FILE="data/listen.log"

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "监听器已在运行 (PID $OLD_PID)"
    echo "如需重启先执行: scripts/stop-listen.sh"
    exit 1
  fi
  echo "清理残留 PID 文件"
  rm -f "$PID_FILE"
fi

# 确保 data/ 和 raw/ 存在
mkdir -p data/raw

# 启动，日志重定向
nohup bun run src/listen.ts >> "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"

echo "监听器已启动 (PID $PID)"
echo "日志: $LOG_FILE"
echo "数据: data/raw/"
