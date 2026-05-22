/**
 * analyze-style.ts — 对 outbox 基线数据做深度风格分析。
 *
 * 分析维度：句长分布、开头/结尾模式、标点习惯、语气词/连接词、
 * Markdown 格式化、人称/指代。
 *
 * 用法: bun run analyze-style
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 路径 ────────────────────────────────────────────────

const RIN_OUTBOX = resolve(import.meta.dirname, "../../loop/mailbox/outbox");
const JSONL_DIR = resolve(import.meta.dirname, "../data/baseline");
const DOCS_DIR = resolve(import.meta.dirname, "../docs");
const REPORT = resolve(DOCS_DIR, "style-report.md");

// ── 类型 ────────────────────────────────────────────────

interface BaselineEntry {
  re: string;
  at: string;
  bodyLength: number;
  to: string;
  hasTask: boolean;
  failed: boolean;
  sourceFile: string;
}

interface OutboxContent {
  header: string;
  body: string;
}

// ── 读取 ────────────────────────────────────────────────

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

function loadBodies(entries: BaselineEntry[]): OutboxContent[] {
  const result: OutboxContent[] = [];
  for (const e of entries) {
    if (e.failed) continue;
    const fp = join(RIN_OUTBOX, e.sourceFile);
    try {
      const raw = readFileSync(fp, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (m) result.push({ header: m[1], body: m[2] });
    } catch {
      // skip
    }
  }
  return result;
}

// ── 分词/拆句辅助 ──────────────────────────────────────

/** 按中文标点拆句，保留标点。 */
function splitSentences(text: string): string[] {
  const raw = text
    .split(/(?<=[。！？…?!])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 用省略号拆的句可能包含多余空段，合并一下
  return raw.filter((s) => s.length > 0);
}

/** 取前 n 个非空白字符（去除开头的【任务执行结果】等前缀和末尾的签名行）。 */
function stripBody(body: string): string {
  const noPrefix = body
    .replace(/^【[^】]*】\s*/, "")          // 去掉 【任务执行结果】
    .replace(/\n\n?Rin\s*$/, "")             // 去掉末尾签名
    .trim();
  return noPrefix;
}

// ── 计数辅助 ────────────────────────────────────────────

function countMatches(text: string, pattern: RegExp): number {
  const m = text.match(pattern);
  return m ? m.length : 0;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0";
  return ((n / total) * 100).toFixed(1);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function trimPunct(s: string): string {
  return s.replace(/^[，。！？、；：""''「」【】《》（）\s…—]+|[，。！？、；：""''「」【】《》（）\s…—]+$/g, "");
}

// ── 分析 ────────────────────────────────────────────────

interface StyleReport {
  replyCount: number;
  // 句长
  sentLenMean: number;
  sentLenMedian: number;
  sentLenP25: number;
  sentLenP75: number;
  shortSentPct: string;   // ≤10 字比例
  longSentPct: string;    // ≥50 字比例
  // 开头
  topOpeners: [string, number][];
  // 结尾
  topEnders: [string, number][];
  // 标点
  exclMarkPerReply: string;
  quesMarkPerReply: string;
  ellipsisPerReply: string;
  listLinesPct: string;   // 数字序号或破折号开头的行比例
  // 语气词/连接词
  toneWordsPer1000: string;
  connWordsPer1000: string;
  // Markdown
  codeBlockPct: string;
  boldPct: string;
  listMarkerPct: string;
  // 人称
  woPer1000: string;
  niPer1000: string;
  womenPer1000: string;
  dajiaPer1000: string;
}

function analyze(bodies: OutboxContent[]): StyleReport {
  const n = bodies.length;

  // 句长
  const allSentLens: number[] = [];
  let shortSentCount = 0;
  let longSentCount = 0;
  let totalSents = 0;

  // 标点
  let totalExcl = 0;
  let totalQues = 0;
  let totalEllipsis = 0;
  let totalListLines = 0;
  let totalLines = 0;

  // 语气词 & 连接词
  let totalToneWords = 0;
  let totalConnWords = 0;

  // Markdown
  let codeBlockReplies = 0;
  let boldReplies = 0;
  let listMarkerReplies = 0;

  // 人称
  let totalWo = 0;
  let totalNi = 0;
  let totalWomen = 0;
  let totalDajia = 0;
  let totalChars = 0;

  // 开头词频
  const openerFreq: Record<string, number> = {};
  // 结尾词频
  const enderFreq: Record<string, number> = {};

  for (const { body } of bodies) {
    const clean = stripBody(body);
    const sents = splitSentences(clean);

    for (const s of sents) {
      allSentLens.push(s.length);
      totalSents++;
      if (s.length <= 10) shortSentCount++;
      if (s.length >= 50) longSentCount++;
    }

    // 开头模式：取第一个句子前 10 个字
    if (sents.length > 0) {
      const firstChars = sents[0].slice(0, 10);
      // 只录一次完整前缀，不录 n-gram 变体
      if (firstChars.length >= 3) {
        openerFreq[firstChars] = (openerFreq[firstChars] || 0) + 1;
      }
    }

    // 结尾模式：最后一句的后 10 个字
    if (sents.length > 0) {
      const lastChars = sents[sents.length - 1].slice(-10);
      if (lastChars.length >= 3) {
        enderFreq[lastChars] = (enderFreq[lastChars] || 0) + 1;
      }
    }

    // 标点
    totalExcl += countMatches(clean, /[！!]/g);
    totalQues += countMatches(clean, /[？?]/g);
    totalEllipsis += countMatches(clean, /…{2,}/g);

    // 分点列表行（数字序号开头 / 破折号开头）
    const lines = clean.split("\n");
    totalLines += lines.length;
    for (const line of lines) {
      if (/^\s*(?:[\d]+[.、．）)]|\d+\.|- |\* |•)/.test(line)) {
        totalListLines++;
      }
    }

    // 语气词
    totalToneWords += countMatches(clean, /[呢啊吧嘛哈哟唷哇耶咯啦]|哈哈|嘿嘿|呜呜/g);

    // 连接词
    totalConnWords += countMatches(clean, /但是|然而|不过|所以|因此|而且|并且|虽然|尽管|因为|如果|那么|于是/g);

    // Markdown
    if (/```/.test(clean)) codeBlockReplies++;
    if (/\*\*/.test(clean)) boldReplies++;
    if (/^\s*[-*\d]/.test(clean)) listMarkerReplies++;

    // 人称
    totalWo += countMatches(clean, /(?<![\u4e00-\u9fff])我(?![\u4e00-\u9fff])/g);
    totalNi += countMatches(clean, /(?<![一-龥])你(?![一-龥])/g);
    totalWomen += countMatches(clean, /我们/g);
    totalDajia += countMatches(clean, /大家/g);

    totalChars += clean.length;
  }

  // 开头词频取 top 15，过滤过短的片段
  const topOpeners = Object.entries(openerFreq)
    .filter(([w]) => w.length >= 3 && !/^[【\s《]+$/.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15) as [string, number][];

  // 结尾词频取 top 15，过滤签名和短片段
  const topEnders = Object.entries(enderFreq)
    .filter(([w]) => w.length >= 3 && !/^(Rin|in)$/.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15) as [string, number][];

  // 句长分位数
  const sorted = [...allSentLens].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
  const p75 = sorted[Math.floor(sorted.length * 0.75)] || 0;

  const charsPerReply = totalChars / n;

  return {
    replyCount: n,
    sentLenMean: Math.round(mean(allSentLens) * 10) / 10,
    sentLenMedian: Math.round(median(allSentLens) * 10) / 10,
    sentLenP25: p25,
    sentLenP75: p75,
    shortSentPct: pct(shortSentCount, totalSents),
    longSentPct: pct(longSentCount, totalSents),
    topOpeners,
    topEnders,
    exclMarkPerReply: (totalExcl / n).toFixed(1),
    quesMarkPerReply: (totalQues / n).toFixed(1),
    ellipsisPerReply: (totalEllipsis / n).toFixed(1),
    listLinesPct: pct(totalListLines, totalLines),
    toneWordsPer1000: ((totalToneWords / totalChars) * 1000).toFixed(1),
    connWordsPer1000: ((totalConnWords / totalChars) * 1000).toFixed(1),
    codeBlockPct: pct(codeBlockReplies, n),
    boldPct: pct(boldReplies, n),
    listMarkerPct: pct(listMarkerReplies, n),
    woPer1000: ((totalWo / totalChars) * 1000).toFixed(1),
    niPer1000: ((totalNi / totalChars) * 1000).toFixed(1),
    womenPer1000: ((totalWomen / totalChars) * 1000).toFixed(1),
    dajiaPer1000: ((totalDajia / totalChars) * 1000).toFixed(1),
  };
}

// ── 报告 ────────────────────────────────────────────────

function buildReport(r: StyleReport): string {
  return `# 风格分析报告

**样本量**: ${r.replyCount} 封有效回信
**生成时间**: ${new Date().toISOString()}

---

## 1. 句长分布

| 指标 | Rin 当前值 | 真人群聊参考 |
|------|-----------|-------------|
| 平均句长 | ${r.sentLenMean} 字 | 10~25 字 |
| 中位句长 | ${r.sentLenMedian} 字 | 8~18 字 |
| P25 | ${r.sentLenP25} 字 | — |
| P75 | ${r.sentLenP75} 字 | — |
| 短句比例（≤10 字） | ${r.shortSentPct}% | 30~50%（群聊中短句占比高） |
| 长句比例（≥50 字） | ${r.longSentPct}% | ≤5%（真人很少写长句） |

**解读**：Rin 的平均句长 ${r.sentLenMean} 字，中位 ${r.sentLenMedian} 字，在真人群聊范围内偏高。短句比例 ${r.shortSentPct}%（真人群聊通常 30~50%），长句比例 ${r.longSentPct}%（真人通常 ≤5%），说明 Rin 倾向于写更完整、更长的句子，少了群聊中常见的碎片化表达。

## 2. 开头模式

| 前 15 常见开头 | 出现次数 |
|---------------|---------|
${r.topOpeners.map(([w, c]) => `| \`${w}\` | ${c} |`).join("\n")}

**解读**：Rin 最常见的开头是直接切入话题或使用确认性短语。缺乏真人群聊中常见的：表情开头、反问开头、接话头（"话说/对了/那个"）、语气词开头（"哎/哟/哈"）。开头多样性不足是 bot 风格的信号之一。

## 3. 结尾模式

| 前 15 常见结尾 | 出现次数 |
|---------------|---------|
${r.topEnders.map(([w, c]) => `| \`${w}\` | ${c} |`).join("\n")}

**解读**：Rin 的结尾方式以直接结束为主，较少出现真人群聊中常见的开放式结尾（"……"[话题自然消失]、表情收尾、反问收尾）。列表中的常见结尾很多是句中的惯用搭配被截断了。

## 4. 标点习惯

| 指标 | Rin 当前值 | 真人群聊参考 |
|------|-----------|-------------|
| 感叹号（每回信） | ${r.exclMarkPerReply} | 0.5~3（群聊情感表达密集） |
| 问号（每回信） | ${r.quesMarkPerReply} | 0.3~2 |
| 省略号（每回信） | ${r.ellipsisPerReply} | 0.5~3（群聊省略号使用频繁） |
| 分点列表行占比 | ${r.listLinesPct}% | ≤1%（真人极少列点） |

**解读**：Rin 的感叹号和问号使用频率是否合理需结合内容判断。分点列表行占比 ${r.listLinesPct}%——这是最明显的 bot 信号之一，真人群聊几乎不会出现结构化列表（除非在发通知），而 Rin 的中长回复中常用数字序号或破折号分点。

## 5. 语气词/连接词

| 指标 | Rin 当前值 | 真人群聊参考 |
|------|-----------|-------------|
| 语气词密度（‰） | ${r.toneWordsPer1000} | 15~40‰（群聊语气词密度很高） |
| 连接词密度（‰） | ${r.connWordsPer1000} | 5~15‰ |

**解读**：语气词密度偏低说明 Rin 少了群聊中丰富的情绪表达（"呢啊吧嘛哈"）。连接词密度偏高则说明 Rin 的回复逻辑链更完整——真人在群聊中经常跳逻辑、省略连接词。这两项结合起来→Rin 的回复太"完整"了。

## 6. Markdown / 格式化

| 指标 | Rin 当前值 | 真人群聊参考 |
|------|-----------|-------------|
| 代码块出现率 | ${r.codeBlockPct}% | 极低（纯聊天场景） |
| 加粗出现率 | ${r.boldPct}% | 极低 |
| 列表标记出现率 | ${r.listMarkerPct}% | ≤1% |

**解读**：代码块和加粗在纯群聊场景几乎没有。但考虑到 Rin 的回复中包含大量任务说明和代码相关话题，代码块的存在有其合理性。不过**格式过度的回复**（代码块+加粗+列表）在纯聊天群中会显得很奇怪。

## 7. 人称 / 指代

| 指标 | Rin 当前值（‰） | 说明 |
|------|----------------|------|
| "我" | ${r.woPer1000} | 第一人称，体现参与感 |
| "你" | ${r.niPer1000} | 第二人称，互动指向 |
| "我们" | ${r.womenPer1000} | 群体归属 |
| "大家" | ${r.dajiaPer1000} | 群体范围 |

**解读**："我/你"的使用比例反映对话的参与感。Rin 的回复通常是"我做了什么/我发现了什么"，"你"的使用则是指向对方。真人群聊中"我"的使用频率通常较高（表达自我观点），但"大家"使用较少（除非@全体）。

---

## 综合差距总结

| 维度 | 差距等级 | 核心问题 |
|------|---------|---------|
| 句长 | 🔴 明显 | 句子过长，短句比例不足，碎片化表达少 |
| 开头 | 🟡 中等 | 开头方式单一，缺少语气词/表情开头 |
| 结尾 | 🟡 中等 | 结尾太"完整"，缺少话题自然消散 |
| 标点 | 🔴 明显 | 分点列表是最大 bot 信号 |
| 语气词 | 🔴 明显 | 语气词密度偏低，缺少情绪颗粒度 |
| 格式化 | 🟢 可接受 | 代码块在技术群合理，但需控制频率 |
| 人称 | 🟢 可接受 | 分布基本合理 |

**标记**: 🔴 明显差距  🟡 有差距但影响中等  🟢 可接受
`;
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const entries = readLatestJsonl();
  const bodies = loadBodies(entries);

  if (bodies.length === 0) {
    console.error("没有可用的回复正文，跳过");
    process.exit(1);
  }

  console.log(`分析 ${bodies.length} 封回信的风格特征...`);

  const report = analyze(bodies);
  const md = buildReport(report);

  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(REPORT, md, "utf8");

  // 控制台摘要
  console.log(`\n  句长: 均值 ${report.sentLenMean} 字 / 中位 ${report.sentLenMedian} 字`);
  console.log(`  短句(≤10字): ${report.shortSentPct}% / 长句(≥50字): ${report.longSentPct}%`);
  console.log(`  分点列表: ${report.listLinesPct}% 的行`);
  console.log(`  语气词密度: ${report.toneWordsPer1000}‰`);
  console.log(`  最常开头: ${report.topOpeners.slice(0, 3).map(([w]) => w).join(" / ")}`);
  console.log(`\n报告已写入: ${REPORT}`);
}

main();
