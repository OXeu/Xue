#!/bin/bash
cd "$(dirname "$0")/.."
PID_FILE="data/listen.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "状态: ❌ 未运行"
  exit 1
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "状态: ✅ 运行中"
  echo "PID:    $PID"

  if [ -f "data/listen.log" ]; then
    LOG_LINES=$(wc -l < data/listen.log)
    echo "日志: data/listen.log ($LOG_LINES 行)"
  fi

  echo ""
  echo "数据文件:"
  if [ -d data/raw ]; then
    for f in data/raw/*.jsonl; do
      LINES=$(wc -l < "$f" 2>/dev/null || echo 0)
      echo "  $(basename $f): $LINES 条消息"
    done
  fi
else
  echo "状态: ❌ PID 文件存在但进程已消失"
  rm -f "$PID_FILE"
fi
