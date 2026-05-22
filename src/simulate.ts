/**
 * simulate.ts — 模拟重放，输出决策和 system prompt，不调 LLM
 *
 * 与 replay.ts 共享同样的决策逻辑和 prompt 组装，
 * 但不调用 LLM API，适合快速评估 prompt 改动效果。
 *
 * 用法:
 *   bun run src/simulate.ts
 *
 * 环境变量:
 *   SESSION     目标会话，默认 group_313214094
 *   MAX_MSGS    最多处理 N 条消息（从最新往前），默认 50
 *   BOT_NAME    机器人名称，默认 Rin
 *   BOT_QQ      Bot QQ 号，默认 3042160393
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 配置 ────────────────────────────────────────────────

const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = 0.3;
const SESSION = process.env.SESSION || "group_313214094";
const MAX_MSGS = Number(process.env.MAX_MSGS) || 50;

const RAW_DIR = resolve(import.meta.dirname, "../data/raw");

// ── 类型 ────────────────────────────────────────────────

interface ListenEntry {
  session: string;
  msgId: number;
  time: number;
  type: string;
  text: string;
  userId: number;
  nickname: string;
  card?: string;
  subType: string;
  selfId: number;
  atUsers: number[];
  replyTo?: number;
}

interface ReplyDecision {
  should: boolean;
  reason: string;
}

// ── 工具函数 ────────────────────────────────────────────

import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
  getVisionFormat,
} from "./prompts";

const STOPWORDS = new Set([
  "的","了","是","我","你","他","她","它","在","有","不","就","也","都","还",
  "这","那","什么","怎么","一个","这个","那个","我们","你们","他们","可以",
  "没有","因为","所以","但是","如果","虽然","不是","就是","还是","只是","可是",
  "而且","然后","之后","之前","现在","今天","明天","昨天","晚上","早上","中午",
  "那个","这种","这样","那种","那个","已经","应该","可能","大概","比较","非常",
  "真的","其实","还是","就是","觉得","知道","看到","听到","起来","出来","回来",
  "进去","过来","上去","下来","一下","一点","一些","一个","这种","那些","这些",
  "吗","啊","吧","呢","哦","嗯","哈","哎","哟","嘛","嗯嗯","哈哈","hhh","草","淦","靠",
]);

function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
}

function parseAtUsers(raw: string): number[] {
  const ids: number[] = [];
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) ids.push(Number(m[1]));
  return ids;
}

function hasAtAll(raw: string): boolean {
  return /\[CQ:at,qq=all\]/.test(raw);
}

function estimateMsgType(raw: string): string {
  const cqTypes = [...raw.matchAll(/\[CQ:(\w+),/g)].map((m) => m[1]);
  if (cqTypes.length === 0) return "text";
  if (stripCqCodes(raw).length > 0) return "mixed";
  if (cqTypes.every((t) => t === "face")) return "face";
  if (cqTypes.every((t) => t === "image")) return "image";
  return "mixed";
}

function extractKeywords(entries: ListenEntry[], maxTerms: number): string[] {
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
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxTerms).map(([w]) => w);
}

function buildContext(entries: ListenEntry[]): string {
  if (entries.length === 0) return "（暂无历史消息）";
  return entries.map((e) => {
    const name = e.card || e.nickname;
    const time = new Date(e.time * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit", minute: "2-digit",
    });
    const at = e.atUsers.length > 0 ? ` @${e.atUsers.join(",")}` : "";
    const reply = e.replyTo ? ` (回复 ${e.replyTo})` : "";
    const text = e.text || `[${e.type}]`;
    return `[${time}] ${name}${at}${reply}: ${text}`;
  }).join("\n");
}

function decideReply(entry: ListenEntry, rawText: string, msgType: string): ReplyDecision {
  if (entry.userId === BOT_QQ || entry.selfId === entry.userId) {
    return { should: false, reason: "self" };
  }
  const isAtSelf = entry.atUsers.includes(BOT_QQ);
  const isAtAll = hasAtAll(rawText);
  const isAtOther = entry.atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(BOT_NAME.toLowerCase());

  if (isAtSelf || isAtAll) return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  if (mentioned) return { should: Math.random() < 0.7, reason: "mentioned" };
  if (msgType === "face" || msgType === "image") return { should: false, reason: "media (skip)" };
  if (isAtOther) return { should: false, reason: "bystander (skip)" };
  return { should: Math.random() < REPLY_CHANCE, reason: "random" };
}

function roleInstruction(reason: string): string {
  const prompt = getScenarioPrompt(reason, BOT_NAME);
  return `【${prompt}】`;
}

function loadRecentMessages(sessionId: string, limit: number): ListenEntry[] {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as ListenEntry);
}

function buildSessionProfile(sessionId: string): string {
  if (sessionId.startsWith("private_")) return "";
  const entries = loadRecentMessages(sessionId, 200);
  if (entries.length < 10) return "";
  const keywords = extractKeywords(entries, 10);
  const lines: string[] = [];
  if (keywords.length > 0) lines.push(`群聊特征：${keywords.join("、")}`);
  const style = analyzeStyle(entries);
  if (style) lines.push(style);
  return lines.join("\n");
}

function analyzeStyle(entries: ListenEntry[]): string {
  if (entries.length < 10) return "";
  let shortCount = 0, questionCount = 0, toneCount = 0, totalMessages = 0;
  const toneRe = /[哈嘛嗯哦哟草靠淦]/g;
  for (const e of entries) {
    const text = stripCqCodes(e.text).trim();
    if (!text) continue;
    totalMessages++;
    if (text.length <= 15) shortCount++;
    if (text.includes("？") || text.endsWith("?") || /[吗呢么吧]/.test(text)) questionCount++;
    const m = text.match(toneRe);
    if (m) toneCount += m.length;
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

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const filePath = join(RAW_DIR, `${SESSION}.jsonl`);
  if (!existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(1);
  }

  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const allEntries: ListenEntry[] = lines.map((l) => JSON.parse(l) as ListenEntry);
  allEntries.sort((a, b) => a.time - b.time);

  const toProcess = allEntries.slice(-MAX_MSGS);
  const profile = buildSessionProfile(SESSION);

  console.log(`会话: ${SESSION}`);
  console.log(`总消息: ${allEntries.length}  |  模拟处理: ${toProcess.length}`);
  if (profile) console.log(`\n${profile}`);
  console.log("─".repeat(60));
  console.log("");

  let decided = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const e = toProcess[i];
    const raw = e.text;
    const cleanText = stripCqCodes(raw);
    const msgType = estimateMsgType(raw);
    const atUsers = parseAtUsers(raw);
    const sender = e.card || e.nickname;

    // 固定种子使每次重跑结果一致（用 msgId 做种子）
    const decision = decideReply(e, raw, msgType);

    // 这条消息之前的 30 条作为上下文
    const ctxIdx = Math.max(0, allEntries.indexOf(e) - 30);
    const contextEntries = allEntries.slice(ctxIdx, allEntries.indexOf(e));
    const contextText = buildContext(contextEntries);
    const keywords = extractKeywords(contextEntries, 5);
    const topicSummary = keywords.length > 0 ? `当前话题：${keywords.join("、")}` : "";

    const roleInst = roleInstruction(decision.reason);
    const systemContent = [
      getSystemPrompt(BOT_NAME),
      getReplyRules(),
      profile,
      topicSummary,
      `\n下面是这个群最近的消息：`,
      roleInst,
    ].filter(Boolean).join("\n");

    const userContent = `【群聊上下文】\n${contextText}\n\n【新消息】${sender}: ${cleanText}\n\n请以 ${BOT_NAME} 的身份自然回复。`;

    // 时间戳（可读格式）
    const timeStr = new Date(e.time * 1000).toISOString().slice(11, 19);

    // 输出
    const actionIcon = decision.should ? "🟢 回复" : "⚪ 跳过";
    console.log(`#${i + 1} [${timeStr}] ${sender}: ${cleanText.slice(0, 80)}`);
    console.log(`  ${actionIcon} [${decision.reason}]`);

    if (decision.should) {
      decided++;
      // 只输出回复的 system prompt 片段（太长，只输出关键行）
      const promptLines = systemContent.split("\n");
      const relevantLines = promptLines.filter(
        (l) => l.startsWith("群聊特征") || l.startsWith("当前话题") || l.startsWith("【"),
      );
      console.log(`  prompt:\n    ${relevantLines.join("\n    ")}`);
      console.log(`  等待 LLM 响应…（实际运行 replay.ts 可看到回复）`);
    }

    console.log("");
  }

  // 汇总
  console.log("─".repeat(40));
  console.log(`模拟完成`);
  console.log(`  处理: ${toProcess.length} 条`);
  console.log(`  决定回复: ${decided} 条`);
  console.log(`  跳过: ${toProcess.length - decided} 条`);
  console.log(`\n要看到实际 LLM 回复，请运行:`);
  console.log(`  LLM_API_KEY=sk-xxx bun run src/replay.ts`);
  console.log(`  或针对单条: LLM_API_KEY=sk-xxx MAX_MSGS=10 bun run src/replay.ts`);
}

main();
