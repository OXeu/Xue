#!/usr/bin/env bash
# stop-agent.sh — 停止群聊回复 agent

set -e

cd "$(dirname "$0")/.."

PID_FILE="data/agent.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "agent 未运行（无 PID 文件）"
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "正在停止 agent (PID $PID) ..."
  kill "$PID" 2>/dev/null || true
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "强制停止 ..."
    kill -9 "$PID" 2>/dev/null || true
  fi
else
  echo "agent 进程已不存在"
fi

rm -f "$PID_FILE"
echo "agent 已停止"
