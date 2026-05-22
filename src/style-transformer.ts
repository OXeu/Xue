/**
 * style-transformer.ts — 原型级风格转换器。
 *
 * 基于 docs/style-report.md 的差距分析，将 Rin 的
 * 技术文档风格回复转为更像真人群聊的表达。
 *
 * 每个规则独立开关，返回转换结果 + 触发规则列表。
 *
 * 用法: bun run style-demo
 */

// ── 规则配置 ────────────────────────────────────────────

interface TransformerConfig {
  /** 长句截断阈值（字） */
  maxSentenceLen: number;
  /** 陈述句语气词概率 */
  toneWordProb: number;
  /** 问句加语气词概率 */
  toneQuestionProb: number;
  /** 句号→感叹号概率 */
  exclaimProb: number;
  /** 句号→省略号概率 */
  ellipsisProb: number;
  /** 列表消除开关 */
  removeLists: boolean;
  /** 开头改写概率 */
  rewriteOpenerProb: number;
  /** 短句穿插概率 */
  interjectProb: number;
}

const DEFAULT_CONFIG: TransformerConfig = {
  maxSentenceLen: 40,
  toneWordProb: 0.3,
  toneQuestionProb: 0.5,
  exclaimProb: 0.2,
  ellipsisProb: 0.3,
  removeLists: true,
  rewriteOpenerProb: 0.3,
  interjectProb: 0.15,
};

// ── 语气词池 ────────────────────────────────────────────

const TONE_WORDS_STATEMENT = ["呢", "啊", "吧", "嘛", "哈"] as const;
const TONE_WORDS_QUESTION = ["吗", "呢"] as const;

// ── 开头改写池 ──────────────────────────────────────────

const OPENER_REPLACEMENTS: [RegExp, string][] = [
  [/^【任务执行[^】]*】\s*/, ""],  // 直接去掉任务前缀
  [/^改好了[。！]?\s*/, "行，" ],
  [/^已完成[。！]?\s*/, "好了，" ],
  [/^让主 agent/, "先" ],
  [/^继续/, "接着" ],
];

const NATURAL_OPENERS = ["嗯", "行", "好", "差不多了", "可以"];

// ── 短句池 ──────────────────────────────────────────────

const INTERJECTIONS = [
  "不错。", "有意思。", "行吧。", "也是。", "好问题。",
  "确实。", "正常。", "嗯。", "好。", "懂了。",
  "明白了。", "对啊。", "原来如此。", "也是哈。", "可以可以。",
];

// ── 规则应用 ────────────────────────────────────────────

interface RuleResult {
  rule: string;
  triggered: boolean;
  detail?: string;
}

/** 按中英文标点拆句，保留标点符号。 */
function splitWithPunct(text: string): string[] {
  // 在句尾标点后拆开，保留标点
  const parts = text.split(/(?<=[。！？…?!\n])\s*/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** 规则 1: 长句截断 — 超 40 字按逗号/连词拆句。 */
function ruleLongSentence(sent: string, maxLen: number): string[] {
  if (sent.length <= maxLen) return [sent];

  const breakPoints = [
    ...sent.matchAll(/[，、；]/g),
  ].map((m) => m.index!).sort((a, b) => a - b);

  // 找离中间最近的分割点
  const mid = sent.length / 2;
  let best = -1;
  for (const p of breakPoints) {
    if (best === -1 || Math.abs(p - mid) < Math.abs(best - mid)) {
      best = p;
    }
  }

  if (best === -1) {
    // 没有逗号，在中间强行拆
    const splitAt = Math.min(Math.floor(sent.length * 0.6), maxLen);
    const segs = [sent.slice(0, splitAt).trim(), sent.slice(splitAt).trim()];
    // 第二个片段加上省略号开头表示语流中断
    return [segs[0] + "…", segs[1]];
  }

  return [sent.slice(0, best).trim() + "…", sent.slice(best + 1).trim()];
}

/** 规则 2: 语气词注入。 */
function ruleToneWords(sent: string, config: TransformerConfig): string {
  if (sent.length < 4) return sent;

  const isQuestion = /[？?]$/.test(sent);
  const isStatement = /[。！!…]$/.test(sent) || /[^\s]$/.test(sent);

  if (isQuestion && Math.random() < config.toneQuestionProb) {
    const word = TONE_WORDS_QUESTION[Math.floor(Math.random() * TONE_WORDS_QUESTION.length)];
    // 去掉末尾标点加上语气词+标点
    const base = sent.replace(/[？?]\s*$/, "");
    return base + word + "？";
  }

  if (isStatement && Math.random() < config.toneWordProb) {
    const word = TONE_WORDS_STATEMENT[Math.floor(Math.random() * TONE_WORDS_STATEMENT.length)];
    const base = sent.replace(/[。！!…]\s*$/, "");
    return base + word + "。";
  }

  return sent;
}

/** 规则 3: 标点替换 — 句号→感叹号/省略号。 */
function rulePunctuation(sent: string, config: TransformerConfig): string {
  if (!sent.endsWith("。")) return sent;

  const roll = Math.random();
  if (roll < config.exclaimProb) {
    return sent.slice(0, -1) + "！";
  }
  if (roll < config.exclaimProb + config.ellipsisProb) {
    return sent.slice(0, -1) + "……";
  }
  return sent;
}

/** 规则 4: 列表消除 — 序号/破折号行转平铺。 */
function ruleRemoveList(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let listBuffer: string[] = [];
  let inList = false;

  for (const line of lines) {
    const listMatch = line.match(/^\s*(?:[\d]+[.、．）)]|\d+\.|- |\* |•)\s*(.+)/);
    if (listMatch) {
      listBuffer.push(listMatch[1].trim());
      inList = true;
    } else {
      if (inList && listBuffer.length > 0) {
        // 将缓冲的列表项合并为逗号连接的自然句
        const merged = listBuffer.length <= 3
          ? listBuffer.join("，")
          : listBuffer.slice(0, 3).join("，") + "等等";
        result.push(merged + "。");
        listBuffer = [];
        inList = false;
      }
      result.push(line);
    }
  }

  // 处理末尾的列表
  if (inList && listBuffer.length > 0) {
    const merged = listBuffer.length <= 3
      ? listBuffer.join("，")
      : listBuffer.slice(0, 3).join("，") + "等等";
    result.push(merged + "。");
  }

  return result.join("\n");
}

/** 规则 5: 开头改写。 */
function ruleRewriteOpener(text: string, config: TransformerConfig): string {
  let result = text;
  let rewritten = false;

  for (const [pattern, replacement] of OPENER_REPLACEMENTS) {
    if (pattern.test(result)) {
      if (Math.random() < config.rewriteOpenerProb) {
        result = result.replace(pattern, replacement);
        rewritten = true;
      }
      break; // 只匹配第一条
    }
  }

  // 如果触发了替换且替换后开头不够自然，再补个自然开头
  if (rewritten && result.length > 0) {
    const firstChar = result.trim()[0];
    if (firstChar && /[a-zA-Z0-9]/.test(firstChar)) {
      // 不改了，保留原样
    }
  }

  return result;
}

/** 规则 6: 短句穿插。 */
function ruleInterject(text: string, config: TransformerConfig): string {
  const paragraphs = text.split("\n");
  const result: string[] = [];

  for (const para of paragraphs) {
    result.push(para);
    // 非空行且不是列表行的后面，有概率插入短句
    if (
      para.trim().length > 10 &&
      !para.match(/^\s*(?:[\d]+[.、．）)]|\d+\.|- |\* |•)/) &&
      Math.random() < config.interjectProb
    ) {
      const interj = INTERJECTIONS[Math.floor(Math.random() * INTERJECTIONS.length)];
      result.push(interj);
    }
  }

  return result.join("\n");
}

// ── 主转换器 ────────────────────────────────────────────

export interface TransformResult {
  original: string;
  transformed: string;
  rules: RuleResult[];
}

/**
 * 对输入正文应用风格转换。返回转换结果 + 触发规则列表。
 */
export function transform(text: string, config: TransformerConfig = DEFAULT_CONFIG): TransformResult {
  const rules: RuleResult[] = [];

  // 规则 5 开头改写（先执行，改写后的文本进入后续规则）
  const afterOpener = ruleRewriteOpener(text, config);
  const openerTriggered = afterOpener !== text;
  rules.push({ rule: "5-开头改写", triggered: openerTriggered, detail: openerTriggered ? "已改写任务型开头" : undefined });

  // 规则 4 列表消除
  let afterList = afterOpener;
  if (config.removeLists) {
    const before = afterList;
    afterList = ruleRemoveList(afterList);
    const triggered = afterList !== before;
    rules.push({ rule: "4-列表消除", triggered, detail: triggered ? "序号列表已转平铺" : undefined });
  } else {
    rules.push({ rule: "4-列表消除", triggered: false });
  }

  // 按句处理规则 1/2/3
  const sentences = splitWithPunct(afterList);
  const processed: string[] = [];
  let longSentTriggered = false;
  let toneTriggered = false;
  let punctTriggered = false;

  for (const sent of sentences) {
    let s = sent;

    // 规则 1: 长句截断
    const parts = ruleLongSentence(s, config.maxSentenceLen);
    if (parts.length > 1) {
      longSentTriggered = true;
      for (const part of parts) {
        let p = part;
        p = ruleToneWords(p, config);
        if (rulePunctuation(p, config) !== p) {
          p = rulePunctuation(p, config);
          punctTriggered = true;
        }
        processed.push(p);
      }
    } else {
      // 规则 2: 语气词
      const afterTone = ruleToneWords(s, config);
      if (afterTone !== s) toneTriggered = true;

      // 规则 3: 标点替换
      const afterPunct = rulePunctuation(afterTone, config);
      if (afterPunct !== afterTone) punctTriggered = true;

      processed.push(afterPunct);
    }
  }

  rules.push({ rule: "1-长句截断", triggered: longSentTriggered, detail: longSentTriggered ? "超40字句已拆分" : undefined });
  rules.push({ rule: "2-语气词注入", triggered: toneTriggered, detail: toneTriggered ? "已添加语气词" : undefined });
  rules.push({ rule: "3-标点替换", triggered: punctTriggered, detail: punctTriggered ? "部分句号已替换" : undefined });

  let result = processed.join("");

  // 规则 6: 短句穿插
  const afterInterject = ruleInterject(result, config);
  const interjectTriggered = afterInterject !== result;
  rules.push({ rule: "6-短句穿插", triggered: interjectTriggered, detail: interjectTriggered ? "已插入短句" : undefined });
  result = afterInterject;

  return { original: text, transformed: result, rules };
}

// ── Demo ────────────────────────────────────────────────

/** 获取 style-report.md 中的示例文本用于演示。 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function getSampleTexts(): string[] {
  const outboxDir = resolve(import.meta.dirname, "../../loop/mailbox/outbox");
  if (!existsSync(outboxDir)) return ["样本不可用（outbox 目录不存在）"];

  const files = readdirSync(outboxDir)
    .filter((f) => f.startsWith("re-") && f.endsWith(".md"))
    .sort()
    .slice(0, 5); // 取前 5 封

  return files.map((f) => {
    const raw = readFileSync(join(outboxDir, f), "utf8");
    const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = m ? m[1].trim() : raw.trim();
    // 取前 200 字
    return body.slice(0, 200);
  });
}

export function demo(): void {
  console.log("=".repeat(60));
  console.log("  Style Transformer Demo");
  console.log("=".repeat(60));
  console.log();

  const samples = getSampleTexts();

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    console.log(`--- 样本 ${i + 1} ---`);
    console.log();

    const result = transform(sample);

    console.log("【原文】");
    console.log(sample);
    console.log();
    console.log("【改文】");
    console.log(result.transformed);
    console.log();

    const triggered = result.rules.filter((r) => r.triggered);
    if (triggered.length > 0) {
      console.log("触发规则:");
      for (const r of triggered) {
        console.log(`  ✅ ${r.rule}${r.detail ? ` — ${r.detail}` : ""}`);
      }
    } else {
      console.log("未触发任何规则（原文已较自然）");
    }
    console.log();
  }
}

// ── CLI ─────────────────────────────────────────────────

if (import.meta.main) {
  demo();
}
