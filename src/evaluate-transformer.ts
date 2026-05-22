/**
 * evaluate-transformer.ts — 定量评估 style-transformer 原型效果。
 *
 * 读取基线数据，对每条正文运行 transform()，对比原文/改文的
 * 风格指标变化，输出评估报告。
 *
 * 用法: bun run eval-transformer
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { transform, type TransformResult } from "./style-transformer";

// ── 路径 ────────────────────────────────────────────────

const RIN_OUTBOX = resolve(import.meta.dirname, "../../loop/mailbox/outbox");
const JSONL_DIR = resolve(import.meta.dirname, "../data/baseline");
const DOCS_DIR = resolve(import.meta.dirname, "../docs");

// ── 读取 ────────────────────────────────────────────────

interface BaselineEntry {
  re: string;
  at: string;
  bodyLength: number;
  to: string;
  hasTask: boolean;
  failed: boolean;
  sourceFile: string;
}

function readLatestJsonl(): BaselineEntry[] {
  const files = readdirSync(JSONL_DIR)
    .filter((f) => f.startsWith("baseline-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error("没有找到基线文件，先跑 collect-baseline");
    process.exit(1);
  }

  const latest = join(JSONL_DIR, files[0]);
  const lines = readFileSync(latest, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l: string) => JSON.parse(l) as BaselineEntry);
}

function loadBodies(entries: BaselineEntry[]): string[] {
  const result: string[] = [];
  for (const e of entries) {
    if (e.failed) continue;
    const fp = join(RIN_OUTBOX, e.sourceFile);
    try {
      const raw = readFileSync(fp, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (m) {
        // 去掉任务前缀和签名，取正文
        const body = m[2]
          .replace(/^【[^】]*】\s*/, "")
          .replace(/\n\n?Rin\s*$/, "")
          .trim();
        if (body.length > 0) result.push(body);
      }
    } catch { /* skip */ }
  }
  return result;
}

// ── 指标计算（简化版，与 analyze-style.ts 保持一致）──────

interface Metrics {
  avgSentLen: number;
  medSentLen: number;
  shortSentPct: number;   // ≤10 字
  longSentPct: number;    // ≥50 字
  exclPerReply: number;
  quesPerReply: number;
  ellipsisPerReply: number;
  listLinePct: number;
  toneWordsPer1000: number;
  connWordsPer1000: number;
  avgLen: number;         // 正文平均长度
}

function computeMetrics(bodies: string[]): Metrics {
  if (bodies.length === 0) throw new Error("no bodies");

  let totalSents = 0;
  let shortSents = 0;
  let longSents = 0;
  const sentLens: number[] = [];

  let totalExcl = 0;
  let totalQues = 0;
  let totalEllipsis = 0;
  let totalListLines = 0;
  let totalLines = 0;
  let totalTone = 0;
  let totalConn = 0;
  let totalChars = 0;
  let totalLen = 0;

  for (const body of bodies) {
    totalLen += body.length;
    totalChars += body.length;

    // 拆句
    const sents = body.split(/(?<=[。！？…?!])\s*/).map((s) => s.trim()).filter(Boolean);
    totalSents += sents.length;

    for (const s of sents) {
      sentLens.push(s.length);
      if (s.length <= 10) shortSents++;
      if (s.length >= 50) longSents++;
    }

    // 标点
    const exclM = body.match(/[！!]/g);
    totalExcl += exclM ? exclM.length : 0;
    const quesM = body.match(/[？?]/g);
    totalQues += quesM ? quesM.length : 0;
    const ellM = body.match(/…{2,}/g);
    totalEllipsis += ellM ? ellM.length : 0;

    // 列表行
    const lines = body.split("\n");
    totalLines += lines.length;
    for (const line of lines) {
      if (/^\s*(?:[\d]+[.、．）)]|\d+\.|- |\* |•)/.test(line)) totalListLines++;
    }

    // 语气词
    const toneM = body.match(/[呢啊吧嘛哈哟唷哇耶咯啦]|哈哈|嘿嘿|呜呜/g);
    totalTone += toneM ? toneM.length : 0;

    // 连接词
    const connM = body.match(/但是|然而|不过|所以|因此|而且|并且|虽然|尽管|因为|如果|那么|于是/g);
    totalConn += connM ? connM.length : 0;
  }

  const n = bodies.length;
  const avgSent = sentLens.length > 0 ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  const sorted = [...sentLens].sort((a, b) => a - b);
  const medSent = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

  return {
    avgSentLen: Math.round(avgSent * 10) / 10,
    medSentLen: medSent,
    shortSentPct: totalSents > 0 ? Math.round((shortSents / totalSents) * 1000) / 10 : 0,
    longSentPct: totalSents > 0 ? Math.round((longSents / totalSents) * 1000) / 10 : 0,
    exclPerReply: Math.round((totalExcl / n) * 10) / 10,
    quesPerReply: Math.round((totalQues / n) * 10) / 10,
    ellipsisPerReply: Math.round((totalEllipsis / n) * 10) / 10,
    listLinePct: totalLines > 0 ? Math.round((totalListLines / totalLines) * 1000) / 10 : 0,
    toneWordsPer1000: totalChars > 0 ? Math.round((totalTone / totalChars) * 10000) / 10 : 0,
    connWordsPer1000: totalChars > 0 ? Math.round((totalConn / totalChars) * 10000) / 10 : 0,
    avgLen: Math.round(totalLen / n),
  };
}

// ── 对照参考值 ──────────────────────────────────────────

interface ReferenceRange {
  target: string;
  note: string;
}

const HUMAN_REFS: Record<string, ReferenceRange> = {
  avgSentLen: { target: "10~25 字", note: "群聊平均句长" },
  medSentLen: { target: "8~18 字", note: "群聊中位句长" },
  shortSentPct: { target: "30~50%", note: "短句(≤10字)占比" },
  longSentPct: { target: "≤5%", note: "长句(≥50字)占比" },
  exclPerReply: { target: "0.5~3", note: "感叹号每条回信" },
  quesPerReply: { target: "0.3~2", note: "问号每条回信" },
  ellipsisPerReply: { target: "0.5~3", note: "省略号每条回信" },
  listLinePct: { target: "≤1%", note: "列表行占比" },
  toneWordsPer1000: { target: "15~40‰", note: "语气词密度" },
  connWordsPer1000: { target: "5~15‰", note: "连接词密度" },
  avgLen: { target: "30~150 字", note: "回信正文长度" },
};

// ── 评估方向 ────────────────────────────────────────────

function compareToRef(
  key: string,
  origVal: number,
  newVal: number,
): { direction: string; verdict: string } {
  const ref = HUMAN_REFS[key];
  if (!ref) return { direction: "—", verdict: "—" };

  // 解析参考范围
  const parseRange = (s: string): [number, number] | null => {
    const m = s.match(/([\d.]+)\s*~\s*([\d.]+)/);
    if (m) return [Number(m[1]), Number(m[2])];
    const m2 = s.match(/≤\s*([\d.]+)/);
    if (m2) return [0, Number(m2[1])];
    return null;
  };

  const range = parseRange(ref.target);
  if (!range) return { direction: "—", verdict: "—" };

  const [low, high] = range;

  // 判断是否在范围内
  const origInRange = origVal >= low && origVal <= high;
  const newInRange = newVal >= low && newVal <= high;

  if (!origInRange && newInRange) return { direction: "↓ 缩小", verdict: "✅ 已进入参考范围" };
  if (origInRange && !newInRange) return { direction: "↑ 扩大", verdict: "❌ 退出参考范围" };
  if (!origInRange && !newInRange) {
    // 都没进范围，看是否靠近了
    const origDist = origVal < low ? low - origVal : origVal - high;
    const newDist = newVal < low ? low - newVal : newVal - high;
    if (newDist < origDist) return { direction: "↓ 缩小", verdict: "⬇ 接近中" };
    if (newDist > origDist) return { direction: "↑ 扩大", verdict: "⬆ 远离中" };
    return { direction: "—", verdict: "○ 持平" };
  }
  return { direction: "—", verdict: "○ 保持在范围内" };
}

// ── 规则触发统计 ────────────────────────────────────────

interface RuleStats {
  name: string;
  count: number;
  pct: string;
}

// ── 报告 ────────────────────────────────────────────────

function buildReport(
  orig: Metrics,
  transformed: Metrics,
  n: number,
  ruleStats: RuleStats[],
): string {
  const fields: [string, keyof Metrics, string][] = [
    ["平均句长", "avgSentLen", "字"],
    ["中位句长", "medSentLen", "字"],
    ["短句比例(≤10字)", "shortSentPct", "%"],
    ["长句比例(≥50字)", "longSentPct", "%"],
    ["回信正文长度", "avgLen", "字"],
    ["感叹号/回信", "exclPerReply", ""],
    ["问号/回信", "quesPerReply", ""],
    ["省略号/回信", "ellipsisPerReply", ""],
    ["列表行占比", "listLinePct", "%"],
    ["语气词密度", "toneWordsPer1000", "‰"],
    ["连接词密度", "connWordsPer1000", "‰"],
  ];

  let table = `| 指标 | 原文 | 改文 | 真人参考 | 变化方向 | 判定 |\n`;
  table += `|------|------|------|---------|---------|------|\n`;

  for (const [label, key, unit] of fields) {
    const o = orig[key];
    const t = transformed[key];
    const ref = HUMAN_REFS[key];
    const cmp = compareToRef(key, o, t);
    table += `| ${label} | ${o}${unit} | ${t}${unit} | ${ref?.target ?? "—"} | ${cmp.direction} | ${cmp.verdict} |\n`;
  }

  // 规则触发统计
  let ruleTable = `\n## 规则触发统计\n\n`;
  ruleTable += `| 规则 | 触发次数 | 触发率 |\n`;
  ruleTable += `|------|---------|-------|\n`;
  for (const rs of ruleStats) {
    ruleTable += `| ${rs.name} | ${rs.count} / ${n} | ${rs.pct}% |\n`;
  }

  // 结论
  const improved = fields.filter(([, key]) => {
    const o = orig[key];
    const t = transformed[key];
    const cmp = compareToRef(key, o, t);
    return cmp.verdict.includes("✅") || cmp.verdict.includes("⬇");
  }).length;

  const worsened = fields.filter(([, key]) => {
    const o = orig[key];
    const t = transformed[key];
    const cmp = compareToRef(key, o, t);
    return cmp.verdict.includes("❌") || cmp.verdict.includes("⬆");
  }).length;

  const unchanged = fields.length - improved - worsened;

  return `# 风格转换器评估报告

**样本量**: ${n} 条
**评估时间**: ${new Date().toISOString()}

---

## 对比总表

${table}

## 效果总结

| 类别 | 数量 |
|------|------|
| ✅ 差距缩小（向参考值靠近） | ${improved} |
| ❌ 差距扩大（远离参考值） | ${worsened} |
| ○ 无明显变化 | ${unchanged} |

${ruleTable}

## 逐维度解读

### 有效改进的维度

${fields
  .filter(([, key]) => {
    const o = orig[key];
    const t = transformed[key];
    return compareToRef(key, o, t).verdict.includes("✅") || compareToRef(key, o, t).verdict.includes("⬇");
  })
  .map(([label, key]) => `- **${label}**: ${orig[key]} → ${transformed[key]}（${compareToRef(key, orig[key], transformed[key]).verdict}）`)
  .join("\n") || "无"}

### 恶化或无变化的维度

${fields
  .filter(([, key]) => {
    const o = orig[key];
    const t = transformed[key];
    const cmp = compareToRef(key, o, t);
    return cmp.verdict.includes("❌") || cmp.verdict.includes("⬆") || cmp.verdict.includes("○");
  })
  .map(([label, key]) => `- **${label}**: ${orig[key]} → ${transformed[key]}（${compareToRef(key, orig[key], transformed[key]).verdict}）`)
  .join("\n") || "无"}

## 总体结论

**原型有效性**: ${
    improved > worsened
      ? "✅ 总体有效，部分维度向真人群聊风格靠近"
      : worsened > improved
        ? "❌ 总体无效，恶化维度多于改善维度"
        : "⚠️ 效果不明确，需要调整规则参数"
  }

**需要注意的问题**:
- 当前转换器使用随机概率，每次运行结果可能不同
- 部分规则（语气词、标点替换）没有语境感知，可能在技术性内容中产生不自然的表达
- 长句截断在特定句式（列表项、代码片段）中可能破坏语义完整性
`;
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const entries = readLatestJsonl();
  const bodies = loadBodies(entries);

  if (bodies.length === 0) {
    console.error("没有可用正文");
    process.exit(1);
  }

  console.log(`评估 ${bodies.length} 条回信的转换效果...`);

  // 原始指标
  const origMetrics = computeMetrics(bodies);

  // 转换所有正文
  const allTransformed: string[] = [];
  const ruleTriggerCount: Record<string, number> = {
    "1-长句截断": 0,
    "2-语气词注入": 0,
    "3-标点替换": 0,
    "4-列表消除": 0,
    "5-开头改写": 0,
    "6-短句穿插": 0,
  };

  for (const body of bodies) {
    const result = transform(body);
    allTransformed.push(result.transformed);
    for (const r of result.rules) {
      const name = r.rule;
      if (r.triggered && name in ruleTriggerCount) {
        ruleTriggerCount[name]++;
      }
    }
  }

  // 改文指标
  const newMetrics = computeMetrics(allTransformed);

  // 规则统计
  const ruleStats: RuleStats[] = Object.entries(ruleTriggerCount).map(([name, count]) => ({
    name,
    count,
    pct: ((count / bodies.length) * 100).toFixed(1),
  }));

  // 输出报告
  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(DOCS_DIR, `eval-transformer-${stamp}.md`);

  const report = buildReport(origMetrics, newMetrics, bodies.length, ruleStats);
  writeFileSync(outPath, report, "utf8");

  // 控制台摘要
  console.log(`\n  原文 vs 改文指标对比:`);
  const fields: [string, keyof Metrics, string][] = [
    ["平均句长", "avgSentLen", "字"],
    ["短句比例", "shortSentPct", "%"],
    ["长句比例", "longSentPct", "%"],
    ["列表行占比", "listLinePct", "%"],
    ["语气词密度", "toneWordsPer1000", "‰"],
    ["感叹号/回信", "exclPerReply", ""],
  ];
  for (const [label, key, unit] of fields) {
    const arrow = origMetrics[key] < newMetrics[key] ? "↑" : "↓";
    console.log(`    ${label}: ${origMetrics[key]}${unit} → ${newMetrics[key]}${unit} ${arrow}`);
  }

  const totalTriggered = Object.values(ruleTriggerCount).reduce((a, b) => a + b, 0);
  console.log(`\n  规则总触发: ${totalTriggered}/${bodies.length * Object.keys(ruleTriggerCount).length} 次`);
  console.log(`  报告已写入: ${outPath}`);
}

main();
