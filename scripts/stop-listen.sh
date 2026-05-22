#!/bin/bash
cd "$(dirname "$0")/.."
PID_FILE="data/listen.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "监听器未运行 (PID 文件不存在)"
  exit 1
fi

PID=$(cat "$PID_FILE")
echo "停止监听器 (PID $PID)..."
kill "$PID" 2>/dev/null
rm -f "$PID_FILE"
echo "监听器已停止"
