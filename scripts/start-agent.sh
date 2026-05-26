#!/usr/bin/env bash
# start-agent.sh — 启动群聊回复 agent（持久化）

set -e

cd "$(dirname "$0")/.."

PID_FILE="data/agent.pid"
LOG_FILE="data/agent.log"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "agent 已在运行 (PID $OLD_PID)"
    echo "如需重启先执行: scripts/stop-agent.sh"
    exit 1
  fi
  echo "清理残留 PID 文件"
  rm -f "$PID_FILE"
fi

mkdir -p data/prod/raw

# 安全加载 .env（逐行读，避免特殊字符被 shell 解释）
if [ -f .env ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    [ -z "$key" ] && continue
    [[ "$key" =~ ^# ]] && continue
    export "$key=$val"
  done < .env
fi

nohup bun run src/agent/main.ts >> "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"

echo "agent 已启动 (PID $PID)"
echo "日志: $LOG_FILE"
