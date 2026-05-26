/**
 * agent/engine.ts — Agent 核心流程：runAgentTurn
 *
 * 从 agent.ts 拆出。包含 turn 决策、LLM 调用循环、视觉工具执行。
 */

import { resolve } from "node:path";
import {
  getSystemPrompt,
  getReplyRules,
  getScenarioPrompt,
  getVisionFormat,
} from "../prompts";
import {
  extractKeywords,
  analyzeAtmosphere,
  styleGuidance,
  buildSessionProfile,
  buildStructuredContext,
  buildUserMessages,
  quickDecideSilence,
} from "../chat-utils";
import {
  decideReply,
  getProbsForSession,
  getReplyChanceForSession,
  getBotQQ,
  getBotName,
  getDefaultReplyChance,
  canReplyReal,
} from "./config";
import {
  loadRecentWithPersistedImage,
  mergeCurrentEntryIntoRecent,
  buildDisplayText,
  resolveMessageImage,
} from "./context";
import {
  callVision,
  DESCRIBE_IMAGE_TOOL,
} from "./vision";
import type { ListenEntry } from "../shared/types";

// ── 模块级常量 ──────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const BOT_NAME = process.env.BOT_NAME || "Rin";
const VISION_MODEL = process.env.VISION_MODEL || "";
const VISION_BASE_URL = (process.env.VISION_BASE_URL || LLM_BASE_URL).replace(/\/+$/, "");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const MAX_CONTEXT = 30;
const RAW_DIR = resolve(import.meta.dirname, "../../data/prod/raw");

// ── 对话延续跟踪 ────────────────────────────────────────

/** 临时图片缓存：pHash → base64 + mime。在单次 onmessage 调用期间有效。 */
export const _imageCache = new Map<string, { base64: string; mime: string }>();

/** 记录最后一次回复的目标用户，用于检测对话延续。 */
let _lastBotReply: { userId: number; session: string; time: number } | null = null;
const CONTINUATION_WINDOW_MS = 60_000;

/** 同一用户在同一会话中刚被回复过，判定为对话延续。 */
export function isConversationContinuation(userId: number, session: string, now?: number): boolean {
  if (!_lastBotReply) return false;
  if (_lastBotReply.userId !== userId || _lastBotReply.session !== session) return false;
  return (now ?? Date.now()) - _lastBotReply.time <= CONTINUATION_WINDOW_MS;
}

export function setLastBotReply(userId: number, session: string, time?: number): void {
  _lastBotReply = { userId, session, time: time ?? Date.now() };
}

export function clearLastBotReply(): void {
  _lastBotReply = null;
}

// ── LLM 调用 ──────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LlmResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  reasoning_content: string | null;
}

async function callLlmWithTools(
  messages: Array<Record<string, unknown>>,
  tools?: typeof DESCRIBE_IMAGE_TOOL[],
): Promise<LlmResponse> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;

  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    max_tokens: 300,
    temperature: 0.8,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content?: string | null; tool_calls?: ToolCall[] | null; reasoning_content?: string | null } }[];
  };
  const msg = data.choices?.[0]?.message;

  return {
    content: msg?.content?.trim() ?? null,
    tool_calls: msg?.tool_calls ?? null,
    reasoning_content: msg?.reasoning_content?.trim() ?? null,
  };
}

// ── 工具 ──────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] [agent] ${msg}`);
}

// ── ReplyDecision ──────────────────────────────────────

interface ReplyDecision {
  should: boolean;
  reason: string;
}

// ── RunAgentTurn ──────────────────────────────────────

interface ContextBundle {
  recent: ListenEntry[];
  persistedEntry: ListenEntry | null;
}

export interface RunAgentTurnOptions {
  isPrivate: boolean;
  rawMessage: string;
  contextOverride?: ContextBundle;
  decisionOverride?: ReplyDecision;
  continuationHintOverride?: string;
  skipContinuationTracking?: boolean;
  onReply?: (reply: string) => Promise<void> | void;
  logger?: (msg: string) => void;
}

export interface RunAgentTurnResult {
  decision: ReplyDecision;
  reply: string | null;
  replySent: boolean;
  scenarioKey: string;
  contextSize: number;
  displayText: string;
}

export async function runAgentTurn(entry: ListenEntry, options: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  _imageCache.clear();

  const logger = options.logger ?? log;
  const rawMessage = options.rawMessage;
  const cleanText = entry.text;
  const senderName = entry.card || entry.nickname;
  const expectsImage = entry.segmentTypes?.includes("image") ?? false;
  const loaded = options.contextOverride
    ?? await loadRecentWithPersistedImage(entry.session, entry.msgId, expectsImage);
  const recent = mergeCurrentEntryIntoRecent(loaded.recent, entry, loaded.persistedEntry);

  const replyMap = new Map<number, { sender: string; text: string }>();
  for (const e of recent) {
    if (e.msgId) {
      replyMap.set(e.msgId, {
        sender: e.card || e.nickname,
        text: (e.text || "").slice(0, 80),
      });
    }
  }

  const structuredContext = buildStructuredContext(recent, replyMap);
  const keywords = extractKeywords(recent, 5);
  const topicSummary = keywords.length > 0
    ? `当前话题：${keywords.join("、")}`
    : "";
  const atmosphereTag = analyzeAtmosphere(recent);
  const persistedEntry = loaded.persistedEntry;

  const decision = options.decisionOverride ?? (options.isPrivate
    ? { should: entry.userId !== BOT_QQ, reason: "private" }
    : decideReply(entry, entry.type, rawMessage, getProbsForSession(entry.session), undefined, getReplyChanceForSession(entry.session)));
  if (!decision.should) {
    return {
      decision,
      reply: null,
      replySent: false,
      scenarioKey: options.isPrivate ? "private" : decision.reason,
      contextSize: recent.length,
      displayText: cleanText,
    };
  }

  logger(`msg <${senderName}> in ${entry.session} [${decision.reason}]: ${cleanText.slice(0, 80)}`);

  const scenarioKey = options.isPrivate ? "private" : decision.reason;
  let continuationHint = options.continuationHintOverride ?? "";
  if (!continuationHint && !options.skipContinuationTracking && isConversationContinuation(entry.userId, entry.session)) {
    continuationHint = `（你刚才回复过 ${senderName}，这可能是对刚才对话的继续）`;
  }

  const hasImage = entry.segmentTypes?.includes("image") ?? false;
  let downloadedImg: { base64: string; mime: string } | null = null;
  let currentPhash: string | null = null;
  if (hasImage) {
    const resolved = await resolveMessageImage(persistedEntry);
    downloadedImg = resolved.downloaded;
    currentPhash = resolved.phash;
    if (downloadedImg && currentPhash) {
      _imageCache.set(currentPhash, downloadedImg);
    }
  }

  const displayText = buildDisplayText(cleanText, hasImage, currentPhash);
  const lowCertainty = scenarioKey === "random" || scenarioKey === "bystander" || scenarioKey === "media";
  if (lowCertainty) {
    const quickDecision = await quickDecideSilence(
      structuredContext, senderName, displayText, scenarioKey, topicSummary, atmosphereTag, continuationHint,
    );
    if (!quickDecision || quickDecision === "SILENT") {
      logger("silent (model chose not to speak)");
      return { decision, reply: null, replySent: false, scenarioKey, contextSize: recent.length, displayText };
    }
  }

  const roleInstruction = `【${getScenarioPrompt(scenarioKey, BOT_NAME)}】`;

  try {
    const profile = buildSessionProfile(entry.session, RAW_DIR);
    const systemParts = [
      getSystemPrompt(BOT_NAME),
      getReplyRules(),
      profile,
      styleGuidance(profile),
      topicSummary,
      atmosphereTag,
      `\n下面是这个群最近的消息：`,
      roleInstruction,
    ];
    if (downloadedImg && VISION_MODEL) {
      systemParts.push(`\n\n${getVisionFormat()}`);
    }

    const messages: any[] = [{
      role: "system",
      content: systemParts.filter(Boolean).join("\n"),
    }, ...buildUserMessages({
        sessionType: options.isPrivate ? "private" : "group",
        context: structuredContext,
        continuationHint,
      })];

    let finalReply: string | null = null;
    let rounds = 0;

    while (!finalReply && rounds < 5) {
      rounds++;
      const tools = (downloadedImg && VISION_MODEL) ? [DESCRIBE_IMAGE_TOOL] : undefined;
      const result = await callLlmWithTools(messages, tools);

      if (result.tool_calls && result.tool_calls.length > 0 && VISION_MODEL) {
        const assistantBase: Record<string, unknown> = {
          role: "assistant",
          content: result.content,
          tool_calls: result.tool_calls,
        };
        if (result.reasoning_content) {
          assistantBase.reasoning_content = result.reasoning_content;
        }
        messages.push(assistantBase);

        for (const tc of result.tool_calls) {
          if (tc.function.name === "describe_image") {
            let args: { id: string; question: string };
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "参数错误：请传合法 JSON，对象格式必须是 {\"id\":\"16位小写hex\",\"question\":\"一个具体问题\"}。id 只能填当前消息里 [图片#...] 中 # 后面的 16 位小写 hex，不要带 # 或 [图片#]。",
              });
              continue;
            }
            const { id, question } = args;
            if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || typeof question !== "string" || question.trim().length === 0) {
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "参数错误：id 必须是 16 位小写 hex 字符串；question 必须是非空且具体的单个问题。示例：{\"id\":\"abcdef1234567890\",\"question\":\"图里有几个人？\"}",
              });
              continue;
            }
            logger(`[describe_image id=${id}] ${question.slice(0, 100)}`);

            const cachedImg = _imageCache.get(id);
            let toolResult: string;
            if (cachedImg) {
              const answer = await callVision(question, cachedImg.base64, cachedImg.mime);
              toolResult = answer || "(分析失败)";
              logger(`[describe_image a] ${toolResult.slice(0, 100)}`);
            } else {
              toolResult = "（该图片数据已过期，无法查看）";
              logger(`[describe_image] image data expired: ${id}`);
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }
        }
      } else if (result.content) {
        finalReply = result.content;
      } else {
        break;
      }
    }

    if (finalReply) {
      if (options.onReply) {
        await options.onReply(finalReply);
      }
      logger(`replied: ${finalReply.slice(0, 100)}`);
      if (!options.skipContinuationTracking) {
        setLastBotReply(entry.userId, entry.session);
      }
      return { decision, reply: finalReply, replySent: Boolean(options.onReply), scenarioKey, contextSize: recent.length, displayText };
    }

    logger("no reply (model chose silence or vision loop exhausted)");
    return { decision, reply: null, replySent: false, scenarioKey, contextSize: recent.length, displayText };
  } catch (err) {
    logger(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      decision,
      reply: null,
      replySent: false,
      scenarioKey,
      contextSize: recent.length,
      displayText: cleanText,
    };
  }
}
