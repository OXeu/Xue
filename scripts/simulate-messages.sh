#!/usr/bin/env bash
# simulate-messages.sh — 模拟群聊消息流入，验证端到端管线
#
# 向 data/raw/ 写入 20 条测试消息，跑 analyze-raw，然后清理。

set -e

cd "$(dirname "$0")/.."

RAW_DIR="data/raw"
TEST_FILE="$RAW_DIR/group_test_001.jsonl"
REPORT_DIR="docs/experiment-logs"
REPORT="$REPORT_DIR/pipeline-e2e-test.md"

mkdir -p "$RAW_DIR" "$REPORT_DIR"

echo "=== 端到端管线验证 ==="
echo ""

# ── 生成模拟数据 ────────────────────────────────────────

echo "生成 20 条模拟消息..."

NOW=$(date +%s)
BASE=$((NOW - 7200))

write_msg() {
  local idx=$1 uid=$2 nick=$3 card=$4 role=$5 msg_type=$6 text=$7 at_users=$8 reply_to=$9 seg_types=${10}
  local ts=$((BASE + idx * 400))
  local mid=$((1000 + idx))

  # 构建 atUsers
  local at_json="[]"
  [ -n "$at_users" ] && at_json="[$at_users]"

  # 构建 replyTo
  local reply_json="null"
  [ -n "$reply_to" ] && reply_json="$reply_to"

  # 构建 segmentTypes
  local seg_json='["text"]'
  [ -n "$seg_types" ] && seg_json="$seg_types"

  cat >> "$TEST_FILE" <<JSONLINE
{"session":"group_test_001","msgId":$mid,"time":$ts,"type":"$msg_type","text":$text,"userId":$uid,"nickname":"$nick","card":"$card","senderRole":"$role","subType":"normal","selfId":12345,"atUsers":$at_json,"replyTo":$reply_json,"segmentTypes":$seg_json}
JSONLINE
}

# 纯文本 8 条
write_msg 0  10001 "小明"   "小明" "member" "text" '"今天天气真好啊"'
write_msg 1  10002 "小红"   ""     "member" "text" '"嗯确实，不过下午可能要下雨"'
write_msg 2  10003 "大壮"   "大壮" "admin"  "text" '"你们晚上打不打游戏"'
write_msg 3  10004 "阿花"   ""     "member" "text" '"打啥游戏"'
write_msg 4  10005 "群主"   ""     "owner"  "text" '"新出的那个生存游戏"'
write_msg 5  10001 "小明"   "小明" "member" "text" '"那个我玩了，挺难的"'
write_msg 6  10006 "路人甲" ""     "member" "text" '"我去看看评测再决定"'
write_msg 7  10002 "小红"   ""     "member" "text" '"别看了直接冲，不好玩找我"'

# 含 @ 的 4 条
write_msg 8  10003 "大壮" "大壮" "admin"  "at"  '"@小明 你昨天说的那个事怎么样了"' "10001"
write_msg 9  10001 "小明" "小明" "member" "at"  '"@大壮 还在弄，快好了"' "10003"
write_msg 10 10004 "阿花" ""     "member" "at"  '"@群主 这个群要不要开个活动"' "10005"
write_msg 11 10005 "群主" ""     "owner"  "at"  '"@小明 啥事啊我也想知道"' "10001"

# 含表情/图片 3 条
write_msg 12 10006 "路人甲" ""  "member" "mixed" '"这个可以有👍"' "" "" '["text","face"]'
write_msg 13 10003 "大壮" "大壮" "admin"  "mixed" '"笑死我了😂"' "" "" '["text","face"]'
write_msg 14 10002 "小红"   ""   "member" "mixed" '"绝了.jpg 你们都在卷是吧"' "" "" '["text","image"]'

# 含回复引用 3 条
write_msg 15 10001 "小明" "小明" "member" "text" '"确实，我也这么觉得"' "" "1005" '["text","reply"]'
write_msg 16 10004 "阿花"   ""   "member" "text" '"+1 附议"' "" "1005" '["text","reply"]'
write_msg 17 10005 "群主"   ""   "owner"  "text" '"你们说的都对（狗头）"' "" "1008" '["text","reply"]'

# 纯表情 2 条
write_msg 18 10006 "路人甲" "" "member" "face" '""' "" "" '["face"]'
write_msg 19 10003 "大壮" "大壮" "admin"  "face" '""' "" "" '["face"]'

echo "  20 条消息已写入 $TEST_FILE"

# 验证 JSON 格式
echo "  验证 JSON 格式..."
bun -e "
const fs = require('fs');
const lines = fs.readFileSync('$TEST_FILE', 'utf8').trim().split('\n');
let ok = 0, fail = 0;
for (const l of lines) {
  try { JSON.parse(l); ok++; } catch { fail++; }
}
console.log('    有效: ' + ok + ', 无效: ' + fail);
if (fail > 0) process.exit(1);
" 2>&1

echo ""

# ── 运行 analyze-raw ─────────────────────────────────────

echo "运行 analyze-raw..."
echo ""
bun run analyze-raw 2>&1 || true
echo ""

# ── 记录验证结果 ─────────────────────────────────────────

LATEST_REPORT=$(ls -t docs/raw-summary-*.md 2>/dev/null | head -1)

echo "写入验证日志..."

cat > "$REPORT" <<EOF
# 端到端管线验证

**日期**: $(date -Iseconds)
**测试**: 模拟 20 条群聊消息 → analyze-raw → 清理

---

## 测试步骤

1. 生成 20 条模拟消息到 \`data/raw/group_test_001.jsonl\`
2. 验证 JSON 格式正确
3. 运行 \`bun run analyze-raw\` 分析
4. 确认报告生成
5. 删除模拟数据

## 消息构成

| 类型 | 数量 | 说明 |
|------|------|------|
| 纯文本 | 8 | 日常对话 |
| 含 @ | 4 | @特定用户 |
| 含表情/图片 | 3 | text+face/image 混合 |
| 含回复引用 | 3 | 引用之前消息 |
| 纯表情 | 2 | 仅 face 段 |

发送者 6 人，时间跨度 2 小时。

## 验证结果

$(if [ -f "$LATEST_REPORT" ]; then
  echo "✅ analyze-raw 成功产出报告: \`$LATEST_REPORT\`"
  echo ""
  echo "### 报告摘要"
  grep -E "^\\|" "$LATEST_REPORT" 2>/dev/null | head -15 | sed 's/^/> /'
else
  echo "❌ analyze-raw 未产出报告"
fi)
EOF

echo "  验证日志已写入: $REPORT"

# ── 清理 ─────────────────────────────────────────────────

echo ""
echo "清理模拟数据..."
rm -f "$TEST_FILE"
echo "  已删除: $TEST_FILE"

if [ -n "$LATEST_REPORT" ] && [ -f "$LATEST_REPORT" ]; then
  rm -f "$LATEST_REPORT"
  echo "  已删除: $LATEST_REPORT"
fi

echo ""
echo "=== 验证完成 ==="
