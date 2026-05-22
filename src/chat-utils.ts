/**
 * chat-utils.ts — agent.ts 和 replay.ts 共享的工具函数
 *
 * 本模块承载两份文件之间逐字相同的纯函数，消除代码重复。
 * 包括：关键词提取、气氛分析、风格分析、话题画像、最近消息加载、
 * 视觉描述质量检查与持久化。
 *
 * 不包含存在行为差异或有深度模块级耦合的函数
 * （如 buildContext, callLlmWithTools, decideReply, loadPhashMap, loadCachedInference）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripCqCodes } from "./cq-codes";

// ── 消息类型 ────────────────────────────────────────────

export interface ListenEntry {
  session: string;
  msgId: number;
  time: number;
  type: string;
  text: string;
  userId: number;
  nickname: string;
  card?: string;
  senderRole?: string;
  subType: string;
  selfId: number;
  atUsers: number[];
  replyTo?: number;
  segmentTypes?: string[];
  imageUrls?: string[];
}

// ── 关键词提取 ──────────────────────────────────────────

const STOPWORDS = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "在", "有",
  "不", "就", "也", "都", "还", "这", "那", "什么", "怎么",
  "一个", "这个", "那个", "我们", "你们", "他们", "可以",
  "没有", "因为", "所以", "但是", "如果", "虽然", "不是",
  "就是", "还是", "只是", "可是", "而且", "然后", "之后",
  "之前", "现在", "今天", "明天", "昨天", "晚上", "早上",
  "中午", "那个", "这种", "这样", "那种", "那个", "已经",
  "应该", "可能", "大概", "比较", "非常", "真的", "其实",
  "还是", "就是", "觉得", "知道", "看到", "听到",
  "起来", "出来", "回来", "进去", "过来", "上去", "下来",
  "一下", "一点", "一些", "一个", "这种", "那些", "这些",
  "吗", "啊", "吧", "呢", "哦", "嗯", "哈", "哎", "哟",
  "嘛", "嗯嗯", "哈哈", "hhh", "草", "淦", "靠",
]);

/** 从最近消息中提取高频关键词做话题摘要 */
export function extractKeywords(entries: ListenEntry[], maxTerms: number): string[] {
  const freq = new Map<string, number>();
  const wordRe = /[\u4e00-\u9fff\w]{2,}/g;

  for (const e of entries) {
    const text = stripCqCodes(e.text);
    const words = text.match(wordRe);
    if (!words) continue;
    for (const w of words) {
      const lower = w.toLowerCase();
      if (lower.length < 2 || STOPWORDS.has(lower)) continue;
      freq.set(lower, (freq.get(lower) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([w]) => w);
}

// ── 气氛分析 ────────────────────────────────────────────

/** 分析最近消息的气氛（正常 / 偏紧 / 有分歧） */
export function analyzeAtmosphere(entries: ListenEntry[]): string {
  if (entries.length < 5) return "";

  let disagreementCount = 0;
  let negativeCount = 0;
  let totalMsg = 0;

  const disagreementRe = /但是|不对|你搞错|错了|不是|反而|明明|难道|凭什么|你说的|你的意思|我觉得不是|你确定/i;
  const negativeRe = /垃圾|傻[逼叉]|无语|服了|醉了|吐了|离谱|有病|恶心|过分|算了吧|呵呵|呵呵|有毛病/i;

  for (const e of entries) {
    const text = e.text;
    if (!text) continue;
    totalMsg++;
    if (disagreementRe.test(text)) disagreementCount++;
    if (negativeRe.test(text)) negativeCount++;
  }

  if (totalMsg === 0) return "";

  const disagreeRatio = disagreementCount / totalMsg;
  const negativeRatio = negativeCount / totalMsg;

  if (disagreeRatio > 0.3 || negativeRatio > 0.2) return "气氛：有分歧";
  if (disagreeRatio > 0.15 || negativeRatio > 0.1) return "气氛：偏紧";
  return "气氛：正常";
}

// ── 风格分析 ────────────────────────────────────────────

/**
 * 分析消息历史中的说话风格特征。
 *
 * 阈值说明（基于 style-report 中真人基线校准）：
 * - 短句（≤15 字）：真人 30~50%。>60% 短平快消息为主（群聊常态）；
 *   30~60% 适中；<30% 偏少（群内长文讨论多）。
 * - 问句（以？结尾或含吗/呢/么/吧）：>30% 偏多，15~30% 适中，<15% 偏少。
 * - 语气词（哈/嘛/嗯/哦/草/靠/淦 等）：>0.3 次/条 偏多，0.1~0.3 适中，
 *   <0.1 偏少（偏严肃群聊）。
 */
export function analyzeStyle(entries: ListenEntry[]): string {
  if (entries.length < 10) return "";

  let shortCount = 0;
  let questionCount = 0;
  let toneCount = 0;
  let totalMessages = 0;

  const toneRe = /[哈嘛嗯哦哟草靠淦]/g;

  for (const e of entries) {
    const text = stripCqCodes(e.text).trim();
    if (!text) continue;
    totalMessages++;
    if (text.length <= 15) shortCount++;
    if (text.includes("？") || text.endsWith("?") || /[吗呢么吧]/.test(text)) {
      questionCount++;
    }
    const match = text.match(toneRe);
    if (match) toneCount += match.length;
  }

  if (totalMessages === 0) return "";

  const shortRatio = shortCount / totalMessages;
  const questionRatio = questionCount / totalMessages;
  const tonePerMsg = toneCount / totalMessages;

  const shortLabel = shortRatio > 0.6 ? "短句偏多" : shortRatio > 0.3 ? "短句适中" : "短句偏少";
  const questionLabel = questionRatio > 0.3 ? "问句偏多" : questionRatio > 0.15 ? "问句适中" : "问句偏少";
  const toneLabel = tonePerMsg > 0.3 ? "语气词偏多" : tonePerMsg > 0.1 ? "语气词适中" : "语气词偏少";

  return `风格：${shortLabel} | ${toneLabel} | ${questionLabel}`;
}

/**
 * 从 buildSessionProfile 的输出中解析风格行，生成语气指导。
 *
 * 映射规则（基于 style-report 中真人基线校准）：
 * - 短句偏多 → 回复请尽量控制在 20 字以内
 * - 短句适中 → 回复尽量简短
 * - 短句偏少 → 回复可适当展开，但避免长篇大论
 * - 语气词偏多 → 少用语气词（哈/嘛/嗯/哦）
 * - 语气词适中 → 语气自然即可
 * - 语气词偏少 → 保持简洁语气
 * - 问句偏多 → 可适度用问句
 * - 问句适中 → 可适当使用问句
 * - 问句偏少 → 减少问句
 */
export function styleGuidance(profile: string): string {
  if (!profile.includes("风格：")) return "";

  const guide: string[] = [];

  if (profile.includes("短句偏多")) guide.push("回复请尽量控制在 20 字以内");
  else if (profile.includes("短句适中")) guide.push("回复尽量简短");
  else if (profile.includes("短句偏少")) guide.push("回复可适当展开，但避免长篇大论");

  if (profile.includes("语气词偏多")) guide.push("少用语气词（哈/嘛/嗯/哦）");
  else if (profile.includes("语气词适中")) guide.push("语气自然即可");
  else if (profile.includes("语气词偏少")) guide.push("保持简洁语气");

  if (profile.includes("问句偏多")) guide.push("可适度用问句");
  else if (profile.includes("问句适中")) guide.push("可适当使用问句");
  else if (profile.includes("问句偏少")) guide.push("减少问句");

  if (guide.length === 0) return "";
  return `【语气指导】${guide.join("，")}`;
}

/** 从历史消息中提取群聊特征词和风格特征。读取最近 limit 条消息。 */
export function buildSessionProfile(sessionId: string, rawDir: string, entries?: ListenEntry[]): string {
  if (sessionId.startsWith("private_")) return "";
  const history = entries ?? loadRecentMessages(rawDir, sessionId, 200);
  if (history.length < 10) return "";
  const keywords = extractKeywords(history, 10);
  const lines: string[] = [];
  if (keywords.length > 0) lines.push(`群聊特征：${keywords.join("、")}`);
  const style = analyzeStyle(history);
  if (style) lines.push(style);
  return lines.join("\n");
}

// ── 消息加载 ────────────────────────────────────────────

/** 从 JSONL 文件加载最近 limit 条消息 */
export function loadRecentMessages(rawDir: string, sessionId: string, limit: number): ListenEntry[] {
  const path = join(rawDir, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const entries: ListenEntry[] = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l) as ListenEntry);
    } catch { /* skip corrupt lines */ }
  }
  return entries.slice(-limit);
}

// ── 视觉描述质量 ────────────────────────────────────────

/** 检查描述是否过于模糊，不适合持久化 */
export function isVagueDescription(desc: string): boolean {
  if (!desc || desc.length < 15) return true;
  const normalized = desc.replace(/[/\\|]/g, " ");
  const stripped = normalized
    .replace(/^(an?\s+)?(image|picture|photo|screenshot)\s+(of\s+)?/i, "")
    .replace(/^(a\s+)?single\s+(image|picture|photo)\s+(of\s+)?/i, "")
    .replace(/^(an?\s+)?(anime|manga)(\s+\w[\w-]*){0,3}\s+(illustration|artwork|character|style)\s*/i, "")
    .replace(/^the\s+user\s+(wants|is|needs|asks|would).*$/i, "")
    .replace(/^i (need|want|would)\s+to\s+(\w+\s+)*this\s+(image|picture|photo)/i, "")
    .trim();
  if (stripped.length < 10) return true;
  if (!/[\u4e00-\u9fff]/.test(stripped) &&
      !/\b(character|person|animal|scene|object|building|landscape|background|figure|color|style|pose|expression|setting|action|creature|plant|text|logo|meme)\b/i.test(stripped)) {
    if (/^(describe|answer|reply|respond|analyze|look|see|tell|explain|check)\b/i.test(stripped)) return true;
  }
  return false;
}

/**
 * 持久化最佳视觉描述到 inference 文件。
 * 读取现有文件 → 过滤同 msgId 的旧 inference 行 → 追加新行 → 覆盖写回。
 * 调用方负责先判断 isVagueDescription。
 */
export function persistBestDescription(
  dir: string,
  session: string,
  msgId: number,
  phash: string,
  desc: string,
): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${session}.jsonl`);
    let lines: string[] = [];
    if (existsSync(filePath)) {
      lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    }
    const filtered = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.msgId !== msgId || !parsed.inference;
      } catch {
        return true;
      }
    });
    filtered.push(
      JSON.stringify({
        msgId,
        session,
        phash,
        inference: desc,
        timestamp: new Date().toISOString(),
      }),
    );
    writeFileSync(filePath, filtered.join("\n") + "\n", "utf8");
  } catch {
    // 静默失败，持久化不是关键路径
  }
}
