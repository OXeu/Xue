/**
 * style-transformer.ts — 原型级风格转换器（v2）。
 *
 * 基于 docs/eval-transformer-*.md 的评估数据迭代优化。
 * v2 改进：
 * - 添加问句生成（规则 7）
 * - 语气词注入感知技术术语上下文
 * - 调参提升效果
 *
 * 用法: bun run style-demo
 */

// ── 规则配置 ────────────────────────────────────────────

interface TransformerConfig {
  /** 长句截断阈值（字） */
  maxSentenceLen: number;
  /** 陈述句语气词概率（非技术句） */
  toneWordProb: number;
  /** 陈述句语气词概率（含技术术语的句子） */
  toneWordTechProb: number;
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
  /** 末尾加反问句概率 */
  questionTailProb: number;
}

const DEFAULT_CONFIG: TransformerConfig = {
  maxSentenceLen: 40,
  toneWordProb: 0.45,
  toneWordTechProb: 0.05,
  toneQuestionProb: 0.5,
  exclaimProb: 0.2,
  ellipsisProb: 0.4,
  removeLists: true,
  rewriteOpenerProb: 0.3,
  interjectProb: 0.25,
  questionTailProb: 0.3,
};

// ── 语气词池 ────────────────────────────────────────────

const TONE_WORDS_STATEMENT = ["呢", "啊", "吧", "嘛", "哈"] as const;
const TONE_WORDS_QUESTION = ["吗", "呢"] as const;

// ── 技术术语列表（语气词低概率命中） ────────────────────

const TECH_TERMS = [
  "代码", "测试", "接口", "配置", "工具", "函数",
  "提交", "分支", "部署", "仓库", "脚本", "命令",
  "报错", "日志", "缓存", "队列", "进程", "线程",
  "异步", "同步", "回调", "参数", "返回", "请求",
  "响应", "协议", "格式", "类型", "变量", "对象",
  "类名", "模块", "插件", "扩展", "构建", "编译",
  "运行时", "配置项", "依赖", "版本", "合并", "推送",
  "拉取", "回滚", "修复", "复现", "兼容",
];

// ── 开头改写池 ──────────────────────────────────────────

const OPENER_REPLACEMENTS: [RegExp, string][] = [
  [/^【任务执行[^】]*】\s*/, ""],
  [/^改好了[。！]?\s*/, "行，" ],
  [/^已完成[。！]?\s*/, "好了，" ],
  [/^让主 agent/, "先" ],
  [/^继续/, "接着" ],
];

// ── 短句池 ──────────────────────────────────────────────

const INTERJECTIONS = [
  "不错。", "有意思。", "行吧。", "也是。", "好问题。",
  "确实。", "正常。", "嗯。", "好。", "懂了。",
  "明白了。", "对啊。", "原来如此。", "也是哈。", "可以可以。",
];

// ── 反问句池 ────────────────────────────────────────────

const QUESTION_TAILS = [
  "你说是吧？",
  "对吧？",
  "你觉得呢？",
  "是不是？",
  "你说呢？",
  "你想想看？",
  "是吧？",
];

// ── 规则应用 ────────────────────────────────────────────

interface RuleResult {
  rule: string;
  triggered: boolean;
  detail?: string;
}

/** 按中英文标点拆句，保留标点符号。 */
function splitWithPunct(text: string): string[] {
  const parts = text.split(/(?<=[。！？…?!\n])\s*/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** 检查句子是否包含技术术语。 */
function hasTechTerms(sent: string): boolean {
  return TECH_TERMS.some((term) => sent.includes(term));
}

/** 规则 1: 长句截断 — 超 40 字按逗号/连词拆句。 */
function ruleLongSentence(sent: string, maxLen: number): string[] {
  if (sent.length <= maxLen) return [sent];

  const breakPoints = [
    ...sent.matchAll(/[，、；]/g),
  ].map((m) => m.index!).sort((a, b) => a - b);

  const mid = sent.length / 2;
  let best = -1;
  for (const p of breakPoints) {
    if (best === -1 || Math.abs(p - mid) < Math.abs(best - mid)) {
      best = p;
    }
  }

  if (best === -1) {
    const splitAt = Math.min(Math.floor(sent.length * 0.6), maxLen);
    const segs = [sent.slice(0, splitAt).trim(), sent.slice(splitAt).trim()];
    return [segs[0] + "…", segs[1]];
  }

  return [sent.slice(0, best).trim() + "…", sent.slice(best + 1).trim()];
}

/** 规则 2: 语气词注入（感知技术术语上下文）。 */
function ruleToneWords(sent: string, config: TransformerConfig): string {
  if (sent.length < 4) return sent;

  const isQuestion = /[？?]$/.test(sent);
  const isStatement = /[。！!…]$/.test(sent) || /[^\s]$/.test(sent);

  if (isQuestion && Math.random() < config.toneQuestionProb) {
    const word = TONE_WORDS_QUESTION[Math.floor(Math.random() * TONE_WORDS_QUESTION.length)];
    const base = sent.replace(/[？?]\s*$/, "");
    return base + word + "？";
  }

  if (isStatement) {
    // 技术术语句子用低概率
    const prob = hasTechTerms(sent) ? config.toneWordTechProb : config.toneWordProb;
    if (Math.random() < prob) {
      const word = TONE_WORDS_STATEMENT[Math.floor(Math.random() * TONE_WORDS_STATEMENT.length)];
      const base = sent.replace(/[。！!…]\s*$/, "");
      return base + word + "。";
    }
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

  for (const [pattern, replacement] of OPENER_REPLACEMENTS) {
    if (pattern.test(result)) {
      if (Math.random() < config.rewriteOpenerProb) {
        result = result.replace(pattern, replacement);
      }
      break;
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

/** 规则 7: 末尾加反问/确认句。 */
function ruleAddQuestion(text: string, config: TransformerConfig): string {
  // 检查正文中是否包含疑问结构
  const hasDoubtPattern = /需不需要|是不是|能不能|要不要|有没有|可不可以|该不该/.test(text);

  // 检查最后一句是不是肯定是 不是反问
  const sents = splitWithPunct(text);
  const lastSent = sents.length > 0 ? sents[sents.length - 1] : "";
  const endsWithQuestion = /[？?]$/.test(lastSent);

  // 如果已经有问句了或内容太短，不追加
  if (endsWithQuestion || text.length < 20) return text;

  // 有疑问结构 → 更高概率追加反问
  const prob = hasDoubtPattern ? config.questionTailProb * 1.5 : config.questionTailProb;

  if (Math.random() < prob) {
    const tail = QUESTION_TAILS[Math.floor(Math.random() * QUESTION_TAILS.length)];
    return text + tail;
  }

  return text;
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

  // 规则 5 开头改写（最优先执行）
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
        p = rulePunctuation(p, config);
        if (p !== part) punctTriggered = true;
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

  // 规则 7: 末尾反问句
  const afterQuestion = ruleAddQuestion(result, config);
  const questionTriggered = afterQuestion !== result;
  rules.push({ rule: "7-反问句尾", triggered: questionTriggered, detail: questionTriggered ? "已添加确认性反问" : undefined });
  result = afterQuestion;

  return { original: text, transformed: result, rules };
}

// ── Demo ────────────────────────────────────────────────

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function getSampleTexts(): string[] {
  const outboxDir = resolve(import.meta.dirname, "../../loop/mailbox/outbox");
  if (!existsSync(outboxDir)) return ["样本不可用（outbox 目录不存在）"];

  const files = readdirSync(outboxDir)
    .filter((f) => f.startsWith("re-") && f.endsWith(".md"))
    .sort()
    .slice(0, 5);

  return files.map((f) => {
    const raw = readFileSync(join(outboxDir, f), "utf8");
    const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = m ? m[1].trim() : raw.trim();
    return body.slice(0, 200);
  });
}

export function demo(): void {
  console.log("=".repeat(60));
  console.log("  Style Transformer Demo (v2)");
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

if (import.meta.main) {
  demo();
}
