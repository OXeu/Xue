#!/bin/bash
# 启动监听器（后台持久化，写 PID 文件）
cd "$(dirname "$0")/.."
PID_FILE="data/listen.pid"
LOG_FILE="data/listen.log"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "监听器已在运行 (PID $OLD_PID)"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

nohup bun src/listen.ts >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "监听器已启动 (PID $(cat $PID_FILE))"
echo "日志: $LOG_FILE"
echo "数据: data/raw/"
