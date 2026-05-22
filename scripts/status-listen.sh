#!/usr/bin/env bash
# status-listen.sh — 检查监听器状态

cd "$(dirname "$0")/.."

PID_FILE="data/listen.pid"
PID=""
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
fi

if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ELAPSED=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ' || echo "?")
  echo "状态: ✅ 运行中"
  echo "PID:    $PID"
  echo "运行时长: $ELAPSED"
else
  echo "状态: ❌ 未运行"
  if [ -f "$PID_FILE" ]; then
    echo "（存在残留 PID 文件）"
  fi
fi

echo ""

# data/raw/ 统计
RAW_DIR="data/raw"
if [ -d "$RAW_DIR" ]; then
  FILE_COUNT=$(find "$RAW_DIR" -name '*.jsonl' | wc -l)
  if [ "$FILE_COUNT" -gt 0 ]; then
    echo "数据文件: $FILE_COUNT 个"
    for f in "$RAW_DIR"/*.jsonl; do
      LINES=$(wc -l < "$f" 2>/dev/null || echo 0)
      echo "  $(basename "$f"): $LINES 条消息"
    done
  else
    echo "数据文件: 0 个（尚无消息流入）"
  fi
else
  echo "数据目录: 不存在"
fi

# 日志大小
LOG_FILE="data/listen.log"
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(wc -l < "$LOG_FILE")
  echo "日志: $LOG_FILE ($LOG_SIZE 行)"
fi
