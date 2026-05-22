#!/usr/bin/env bash
# stop-listen.sh — 停止 OneBot 监听器

cd "$(dirname "$0")/.."

PID_FILE="data/listen.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "没有找到 PID 文件，尝试查找进程..."
  PIDS=$(pgrep -f "src/listen.ts" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "找到进程: $PIDS，停止中..."
    kill $PIDS 2>/dev/null || true
  else
    echo "没有找到运行中的监听器"
    exit 0
  fi
else
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "停止监听器 (PID $PID)..."
    kill "$PID" 2>/dev/null || true
  else
    echo "进程 $PID 已不在运行"
  fi
  rm -f "$PID_FILE"
fi

# 也杀掉可能残留的 bun 子进程
PIDS=$(pgrep -f "src/listen.ts" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
fi

echo "监听器已停止"
