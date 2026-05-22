#!/usr/bin/env bash
# status-agent.sh — 检查 agent 运行状态

set -e

cd "$(dirname "$0")/.."

PID_FILE="data/agent.pid"
LOG_FILE="data/agent.log"

if [ ! -f "$PID_FILE" ]; then
  echo "状态: ❌ 未运行（无 PID 文件）"
  exit 0
fi

PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "状态: ❌ 未运行（PID $PID 已不存在）"
  rm -f "$PID_FILE"
  exit 0
fi

# 运行时长
START=$(stat -c %Y "$PID_FILE" 2>/dev/null || echo "$(date +%s)")
NOW=$(date +%s)
ELAPSED=$((NOW - START))
ELAPSED_FMT="$(printf '%02d:%02d' $((ELAPSED / 3600)) $(((ELAPSED % 3600) / 60)))"

echo "状态: ✅ 运行中"
echo "PID:    $PID"
echo "运行时长: $ELAPSED_FMT"

# 数据文件
RAW_DIR="data/prod/raw"
if [ -d "$RAW_DIR" ]; then
  FILES=$(find "$RAW_DIR" -name '*.jsonl' 2>/dev/null | wc -l)
  echo ""
  echo "数据文件: $FILES 个"
  for f in "$RAW_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    NAME=$(basename "$f")
    COUNT=$(wc -l < "$f")
    echo "  $NAME: $COUNT 条消息"
  done
fi

echo "日志: $LOG_FILE ($(wc -l < "$LOG_FILE") 行)"
