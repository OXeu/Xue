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
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const SESSION = process.env.SESSION || "group_313214094";
const MAX_MSGS = Number(process.env.MAX_MSGS) || 50;

const RAW_DIR = resolve(import.meta.dirname, "../data/prod/raw");
const CONFIG_PATH = resolve(import.meta.dirname, "../config/session-config.json");

// ── 类型 ────────────────────────────────────────────────

import type { ListenEntry } from "./shared/types";

interface ReplyDecision {
  should: boolean;
  reason: string;
}

interface ReplyProbabilities {
  mentioned: number;
  media: number;
  bystander: number;
}

const DEFAULT_PROBS: ReplyProbabilities = {
  mentioned: 0.7,
  media: 0.1,
  bystander: 0.05,
};

// ── 配置加载 ────────────────────────────────────────────

/** 加载会话配置。文件不存在或格式错误时返回空对象。 */
function loadSessionConfig(): Record<string, { reply: boolean; probabilities?: ReplyProbabilities; replyChance?: number }> {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (key === "probabilities") continue;
      if (val && typeof val === "object" && "reply" in (val as Record<string, unknown>)) {
        const v = val as any;
        if (typeof v.reply === "boolean") {
          const session: any = { reply: v.reply };
          if (v.probabilities && typeof v.probabilities === "object") {
            const p: ReplyProbabilities = { ...DEFAULT_PROBS };
            if (typeof v.probabilities.mentioned === "number") p.mentioned = v.probabilities.mentioned;
            if (typeof v.probabilities.media === "number") p.media = v.probabilities.media;
            if (typeof v.probabilities.bystander === "number") p.bystander = v.probabilities.bystander;
            session.probabilities = p;
          }
          if (typeof v.replyChance === "number") {
            session.replyChance = v.replyChance;
          }
          result[key] = session;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** 加载全局概率。 */
function loadProbabilities(): ReplyProbabilities {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_PROBS };
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const probs = parsed.probabilities as Partial<ReplyProbabilities> | undefined;
    if (!probs) return { ...DEFAULT_PROBS };
    return {
      mentioned: typeof probs.mentioned === "number" ? probs.mentioned : DEFAULT_PROBS.mentioned,
      media: typeof probs.media === "number" ? probs.media : DEFAULT_PROBS.media,
      bystander: typeof probs.bystander === "number" ? probs.bystander : DEFAULT_PROBS.bystander,
    };
  } catch {
    return { ...DEFAULT_PROBS };
  }
}

const _sessionConfig = loadSessionConfig();
const _globalProbs = loadProbabilities();

function getProbsForSession(sessionId: string): ReplyProbabilities {
  return _sessionConfig[sessionId]?.probabilities ?? _globalProbs;
}

function getReplyChanceForSession(sessionId: string): number {
  return _sessionConfig[sessionId]?.replyChance ?? REPLY_CHANCE;
}

// ── 工具函数 ────────────────────────────────────────────

import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
} from "./prompts";
import { stripCqCodes, parseAtUsers, hasAtAll, estimateMsgType } from "./cq-codes";
import {
  extractKeywords,
  styleGuidance,
  buildSessionProfile,
} from "./chat-utils";

function buildContext(entries: ListenEntry[], replyMap?: Map<number, { sender: string; text: string }>): string {
  if (entries.length === 0) return "（暂无历史消息）";
  return entries
    .map((e) => {
      const name = e.card || e.nickname;
      const time = new Date(e.time * 1000).toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
      });
      const at = e.atUsers.length > 0 ? ` @${e.atUsers.join(",")}` : "";
      const reply = e.replyTo
        ? (replyMap?.has(e.replyTo)
            ? ` (回复 ${replyMap.get(e.replyTo)!.sender} "${replyMap.get(e.replyTo)!.text}")`
            : ` (回复 ${e.replyTo})`)
        : "";
      const text = e.text || `[${e.type}]`;
      const imgMark = e.segmentTypes?.includes("image") ? " [图片]" : "";
      return `[${time}] ${name}${at}${reply}: ${text}${imgMark}`;
    })
    .join("\n");
}

function decideReply(entry: ListenEntry, rawText: string, msgType: string, probs?: ReplyProbabilities, replyChance?: number): ReplyDecision {
  if (entry.userId === BOT_QQ || entry.selfId === entry.userId) {
    return { should: false, reason: "self" };
  }
  const isAtSelf = entry.atUsers.includes(BOT_QQ);
  const isAtAll = hasAtAll(rawText);
  const isAtOther = entry.atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(BOT_NAME.toLowerCase());

  const p = probs ?? DEFAULT_PROBS;

  if (isAtSelf || isAtAll) return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  if (mentioned) return { should: Math.random() < p.mentioned, reason: "mentioned" };
  if (msgType === "face" || msgType === "image") return { should: Math.random() < p.media, reason: "media" };
  if (isAtOther) return { should: Math.random() < p.bystander, reason: "bystander" };
  const chance = replyChance ?? REPLY_CHANCE;
  return { should: Math.random() < chance, reason: "random" };
}

function roleInstruction(reason: string): string {
  const prompt = getScenarioPrompt(reason, BOT_NAME);
  return `【${prompt}】`;
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const filePath = join(RAW_DIR, `${SESSION}.jsonl`);
  if (!existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(1);
  }

  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const allEntries: ListenEntry[] = [];
  for (const l of lines) {
    try {
      allEntries.push(JSON.parse(l) as ListenEntry);
    } catch { /* skip corrupt lines */ }
  }
  allEntries.sort((a, b) => a.time - b.time);

  const toProcess = allEntries.slice(-MAX_MSGS);
  const profile = buildSessionProfile(SESSION, RAW_DIR);

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

    // 用会话级配置覆写概率
    const sessionProbs = getProbsForSession(SESSION);
    const sessionReplyChance = getReplyChanceForSession(SESSION);
    const decision = decideReply(e, raw, msgType, sessionProbs, sessionReplyChance);

    // 这条消息之前的 30 条作为上下文
    const ctxIdx = Math.max(0, allEntries.indexOf(e) - 30);
    const contextEntries = allEntries.slice(ctxIdx, allEntries.indexOf(e));
    // 构建 replyTo 查找表：msgId → { sender, text }
    const replyMap = new Map<number, { sender: string; text: string }>();
    for (const ce of contextEntries) {
      if (ce.msgId) {
        replyMap.set(ce.msgId, {
          sender: ce.card || ce.nickname,
          text: (ce.text || "").slice(0, 80),
        });
      }
    }
    const contextText = buildContext(contextEntries, replyMap);
    const keywords = extractKeywords(contextEntries, 5);
    const topicSummary = keywords.length > 0 ? `当前话题：${keywords.join("、")}` : "";

    const roleInst = roleInstruction(decision.reason);
    const systemContent = [
      getSystemPrompt(BOT_NAME),
      getReplyRules(),
      profile,
      styleGuidance(profile),
      topicSummary,
      `\n下面是这个群最近的消息：`,
      roleInst,
    ].filter(Boolean).join("\n");

    const userContent = `【群聊上下文】\n${contextText}\n\n【新消息】${sender}: ${cleanText}\n\n请以 ${BOT_NAME} 的身份自然回复。`;

    // 时间戳（可读格式）
    const timeStr = new Date(e.time * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });

    // 输出
    const actionIcon = decision.should ? "🟢 回复" : "⚪ 跳过";
    console.log(`#${i + 1} [${timeStr}] ${sender}: ${cleanText.slice(0, 80)}`);
    console.log(`  ${actionIcon} [${decision.reason}]`);

    if (decision.should) {
      decided++;
      // 只输出回复的 system prompt 片段（太长，只输出关键行）
      const promptLines = systemContent.split("\n");
      const relevantLines = promptLines.filter(
        (l) => l.startsWith("群聊特征") || l.startsWith("风格") || l.startsWith("当前话题") || l.startsWith("【"),
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
