/**
 * agent/config.ts — 会话配置、回复概率、回复决策
 *
 * Agent 会话配置、回复概率与回复决策实现。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ListenEntry } from "../shared/types";
import { stripCqCodes, hasAtAll } from "../cq-codes";

const CONFIG_PATH = resolve(import.meta.dirname, "../../config/session-config.json");

const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const BOT_NAME = process.env.BOT_NAME || "Rin";
const DRY_RUN = process.env.DRY_RUN !== "false";

export interface SessionConfig {
  reply: boolean;
  /** 按会话覆写回复概率，不配置则使用全局 probabilities。 */
  probabilities?: ReplyProbabilities;
  /** 按会话覆写 random 分支的回复概率（对应环境变量 REPLY_CHANCE）。 */
  replyChance?: number;
}

/** 各场景回复概率。不配置则使用代码默认值。*/
export interface ReplyProbabilities {
  mentioned: number;
  media: number;
  bystander: number;
}

export const DEFAULT_PROBS: ReplyProbabilities = {
  mentioned: 0.7,
  media: 0.1,
  bystander: 0.05,
};

export function getBotQQ(): number {
  return Number(process.env.BOT_QQ || BOT_QQ);
}

export function getBotName(): string {
  return process.env.BOT_NAME || BOT_NAME;
}

export function getDefaultReplyChance(): number {
  return parseFloat(process.env.REPLY_CHANCE || String(REPLY_CHANCE));
}

export function getDryRun(): boolean {
  return process.env.DRY_RUN !== "false";
}

/** 加载会话配置和回复概率。文件不存在或格式错误时返回空对象/默认概率。 */
export function loadSessionConfig(configPath?: string): Record<string, SessionConfig> {
  const path = configPath ?? CONFIG_PATH;
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, SessionConfig> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (key === "probabilities") continue;
      if (val && typeof val === "object" && "reply" in (val as Record<string, unknown>)) {
        const v = val as { reply?: boolean; probabilities?: Partial<ReplyProbabilities>; replyChance?: number };
        if (typeof v.reply === "boolean") {
          const session: SessionConfig = { reply: v.reply };
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

/** 从配置中提取全局回复概率，不配置的字段使用默认值。 */
export function loadProbabilities(configPath?: string): ReplyProbabilities {
  const path = configPath ?? CONFIG_PATH;
  try {
    if (!existsSync(path)) return { ...DEFAULT_PROBS };
    const raw = readFileSync(path, "utf8");
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
const _replyProbs = loadProbabilities();

/**
 * 检查某个会话是否允许真实回复（非 dry-run）。
 * 优先级：会话配置 > 全局 DRY_RUN。
 * 未在配置中的会话使用全局 DRY_RUN 行为。
 */
export function canReplyReal(sessionId: string, overrides?: {
  configOverride?: Record<string, SessionConfig>;
  dryRunOverride?: boolean;
}): boolean {
  const dryRun = overrides?.dryRunOverride ?? DRY_RUN;
  if (!dryRun) return true;
  const cfg = (overrides?.configOverride ?? _sessionConfig)[sessionId];
  if (cfg !== undefined) return cfg.reply;
  return false;
}

/** 获取某会话的回复概率，未配置则使用全局概率。 */
export function getProbsForSession(sessionId: string): ReplyProbabilities {
  return _sessionConfig[sessionId]?.probabilities ?? _replyProbs;
}

/** 获取某会话的 random 分支回复概率，未配置则使用全局 REPLY_CHANCE。 */
export function getReplyChanceForSession(sessionId: string): number {
  return _sessionConfig[sessionId]?.replyChance ?? REPLY_CHANCE;
}

/**
 * 回复决策。
 * entry.atAll 为首选输入；若缺失则从 rawText 计算 @全体。
 */
export function decideReply(
  entry: ListenEntry,
  msgType: string,
  rawText: string,
  probs?: ReplyProbabilities,
  botQQ?: number,
  replyChance?: number,
): ReplyDecision {
  const botId = botQQ ?? getBotQQ();
  if (entry.userId === botId || entry.selfId === entry.userId) {
    return { should: false, reason: "self" };
  }

  const isAtSelf = entry.atUsers.includes(botId);
  const isAtAll = entry.atAll ?? hasAtAll(rawText);
  const isAtOther = entry.atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(getBotName().toLowerCase());

  const p = probs ?? DEFAULT_PROBS;

  if (isAtSelf || isAtAll) {
    return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  }

  if (mentioned) {
    return { should: Math.random() < p.mentioned, reason: "mentioned" };
  }

  if (msgType === "face" || msgType === "image") {
    return { should: Math.random() < p.media, reason: "media" };
  }

  if (isAtOther) {
    return { should: Math.random() < p.bystander, reason: "bystander" };
  }

  const chance = replyChance ?? REPLY_CHANCE;
  return { should: Math.random() < chance, reason: "random" };
}

export interface ReplyDecision {
  should: boolean;
  reason: string;
}
