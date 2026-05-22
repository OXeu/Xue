/**
 * agent.ts — 群聊回复 agent
 *
 * 监听群聊消息，加载上下文，调用 LLM 生成回复，通过 OneBot 发送。
 * 与 listen.ts 互不干扰（各自使用独立的 WS 连接）。
 *
 * 图片消息处理流程（视觉问答循环）：
 *   收到图片 → 计算 pHash → 在上下文中显示 [图片#phash] 标记
 *   → Agent 通过工具调用（describe_image）询问图片内容
 *   → 系统执行工具调用视觉模型 → 工具结果注入对话 → Agent 可继续追问或直接回复
 *   （每消息最多 5 轮问答）
 *
 * 用法:
 *   LLM_API_KEY=sk-xxx bun run src/agent.ts
 *
 * 环境变量:
 *   LLM_API_KEY          LLM API Key（必填）
 *   LLM_BASE_URL         API 地址，默认 https://api.openai.com/v1
 *   LLM_MODEL            模型名，默认 gpt-4o-mini
 *   ONEBOT_WS_URL        OneBot 网关，默认 ws://localhost:6700
 *   ONEBOT_ACCESS_TOKEN  鉴权 token（可选）
 *   BOT_NAME             机器人名称，默认 Rin
 *   REPLY_CHANCE         回复概率 0-1，默认 0.3（仅非 @ 消息生效）
 *   BOT_QQ               Bot 自身 QQ 号（从 listen data 的 selfId 可知为 3042160393）
 *   DRY_RUN              默认为 true，仅模拟回复不上报发送，设为 false 时才实际发消息
 *   VISION_MODEL         视觉模型名，默认 deepseek-v4-flash
 *   VISION_BASE_URL      视觉 API 地址，默认同 LLM_BASE_URL（可设为
 *                        http://127.0.0.1:11444/v1 使用本地 Ollama）
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { computeDHash } from "./phash";
import { cleanVisionDescription } from "./clean-vision";
import { downloadImage, gifToJpeg } from "./image-download";
import { getCachedImage, getCachedImageByUrl } from "./image-cache";
import { parseAtUsers, hasAtAll, stripCqCodes, estimateMsgType } from "./cq-codes";
import {
  extractKeywords,
  analyzeAtmosphere,
  styleGuidance,
  buildSessionProfile,
  loadRecentMessages,
  quickDecideSilence,
} from "./chat-utils";

// 保持导出兼容（让 import from "agent" 的用户不中断）
export {
  analyzeAtmosphere,
  styleGuidance,
  buildSessionProfile,
  quickDecideSilence,
};

// 配置加载与决策导出（供测试使用）
export type { SessionConfig, ReplyProbabilities };
export { DEFAULT_PROBS, loadSessionConfig, loadProbabilities, canReplyReal, decideReply, getProbsForSession, getReplyChanceForSession };

import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
  getVisionFormat,
} from "./prompts";

// ── 配置 ────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const WS_URL = process.env.ONEBOT_WS_URL || "ws://localhost:6700";
const ACCESS_TOKEN = process.env.ONEBOT_ACCESS_TOKEN || "";
const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const DRY_RUN = process.env.DRY_RUN !== "false"; // 默认 true，仅模拟
const MAX_CONTEXT = 30; // 加载最近 N 条消息作为上下文
const VISION_MODEL = process.env.VISION_MODEL || "";
const VISION_BASE_URL = (process.env.VISION_BASE_URL || LLM_BASE_URL).replace(/\/+$/, "");

const RAW_DIR = resolve(import.meta.dirname, "../data/prod/raw");
const CONFIG_PATH = resolve(import.meta.dirname, "../config/session-config.json");

interface SessionConfig {
  reply: boolean;
  /** 按会话覆写回复概率，不配置则使用全局 probabilities。 */
  probabilities?: ReplyProbabilities;
  /** 按会话覆写 random 分支的回复概率（对应环境变量 REPLY_CHANCE）。 */
  replyChance?: number;
}

/** 各场景回复概率。不配置则使用代码默认值。*/
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

/** 加载会话配置和回复概率。文件不存在或格式错误时返回空对象/默认概率。 */
function loadSessionConfig(configPath?: string): Record<string, SessionConfig> {
  const path = configPath ?? CONFIG_PATH;
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, SessionConfig> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (key === "probabilities") continue; // 全局概率，不走 session 配置
      if (val && typeof val === "object" && "reply" in (val as Record<string, unknown>)) {
        const v = val as { reply?: boolean; probabilities?: Partial<ReplyProbabilities>; replyChance?: number };
        if (typeof v.reply === "boolean") {
          const session: SessionConfig = { reply: v.reply };
          // 按会话覆写概率
          if (v.probabilities && typeof v.probabilities === "object") {
            const p: ReplyProbabilities = { ...DEFAULT_PROBS };
            if (typeof v.probabilities.mentioned === "number") p.mentioned = v.probabilities.mentioned;
            if (typeof v.probabilities.media === "number") p.media = v.probabilities.media;
            if (typeof v.probabilities.bystander === "number") p.bystander = v.probabilities.bystander;
            session.probabilities = p;
          }
          // 按会话覆写 random 概率
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
function loadProbabilities(configPath?: string): ReplyProbabilities {
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
 * 可传 configOverride / dryRunOverride 用于测试。
 */
function canReplyReal(sessionId: string, overrides?: {
  configOverride?: Record<string, SessionConfig>;
  dryRunOverride?: boolean;
}): boolean {
  const dryRun = overrides?.dryRunOverride ?? DRY_RUN;
  if (!dryRun) return true; // 全局非 dry-run，所有会话都真实回复
  const cfg = (overrides?.configOverride ?? _sessionConfig)[sessionId];
  if (cfg !== undefined) return cfg.reply; // 会话配置覆写
  return false; // 全局 dry-run 且无配置 → dry-run
}

/** 获取某会话的回复概率，未配置则使用全局概率。 */
function getProbsForSession(sessionId: string): ReplyProbabilities {
  return _sessionConfig[sessionId]?.probabilities ?? _replyProbs;
}

/** 获取某会话的 random 分支回复概率，未配置则使用全局 REPLY_CHANCE。 */
function getReplyChanceForSession(sessionId: string): number {
  return _sessionConfig[sessionId]?.replyChance ?? REPLY_CHANCE;
}

/** 临时图片缓存：pHash → base64 + mime。在单次 onmessage 调用期间有效。 */
const _imageCache = new Map<string, { base64: string; mime: string }>();

/** 跨消息的最近用户图片缓存：key = session:userId → 图片数据 + phash + 时间。
 * 同一用户在 120 秒内先后发图+文字时，文字消息可复用其图片。 */
const _recentUserImage = new Map<string, { downloaded: { base64: string; mime: string }; phash: string; time: number }>();
const USER_IMAGE_TTL_MS = 120_000;

/** 记录最后一次回复的目标用户，用于检测对话延续。 */
let _lastBotReply: { userId: number; session: string; time: number } | null = null;
const CONTINUATION_WINDOW_MS = 60_000; // 同一用户 60 秒内继续发消息视为对话延续

/** 同一用户在同一会话中刚被回复过，判定为对话延续。now 参数用于测试。 */
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

const DESCRIBE_IMAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "describe_image",
    description:
      "询问某张图片的内容。图片 ID（pHash）在消息文本中形如 [图片#phash]，传入 # 后面的 16 位 hex 字符串。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "图片的 pHash ID（16 位 hex 字符串，来自 [图片#...] 中 # 后面的部分）",
        },
        question: {
          type: "string",
          description: "你想问这张图片的具体问题",
        },
      },
      required: ["id", "question"],
    },
  },
};

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
  senderRole?: string;
  subType: string;
  selfId: number;
  atUsers: number[];
  replyTo?: number;
  segmentTypes?: string[];
  imageUrls?: string[];
  phash?: string[];
}

// ── 工具 ────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] [agent] ${msg}`);
}

// ── 图片理解 ────────────────────────────────────────────

/** 从 CQ 码中提取第一个图片的 url（返回 null 表示无 url） */
function parseFirstImageUrl(raw: string): string | null {
  const m = raw.match(/\[CQ:image,([^\]]*)\]/);
  if (!m) return null;
  const urlMatch = m[1].match(/url=([^,]*)/);
  return urlMatch ? decodeURIComponent(urlMatch[1]) : null;
}

function getPersistedImageEntry(recent: ListenEntry[], msgId: number): ListenEntry | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i]?.msgId === msgId) return recent[i];
  }
  return null;
}

async function resolveMessageImage(
  persistedEntry: ListenEntry | null,
  rawMessage: string,
): Promise<{ downloaded: { base64: string; mime: string } | null; phash: string | null }> {
  if (persistedEntry?.phash?.[0]) {
    const cached = getCachedImage(persistedEntry.phash[0]);
    if (cached) {
      return { downloaded: cached, phash: persistedEntry.phash[0] };
    }
  }

  const imgUrl = persistedEntry?.imageUrls?.[0] ?? parseFirstImageUrl(rawMessage);
  if (!imgUrl) return { downloaded: null, phash: null };

  let downloaded = await downloadImage(imgUrl);
  if (!downloaded) {
    const cached = getCachedImageByUrl(imgUrl);
    if (cached) downloaded = cached;
  }
  if (!downloaded) return { downloaded: null, phash: null };

  const phash = await computeDHash(downloaded.base64, downloaded.mime);
  return { downloaded, phash };
}

// cleanVisionDescription 已通过 import 导入（实现在 clean-vision.ts）

/** 调用视觉模型回答一个问题，返回回答文本，失败返回 null */
export async function callVision(query: string, base64: string, mime: string): Promise<string | null> {
  const visionModel = process.env.VISION_MODEL || VISION_MODEL || "";
  if (!visionModel) return null;

  const visionBaseUrl = (process.env.VISION_BASE_URL || VISION_BASE_URL).replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || LLM_API_KEY || "ollama";

  // GIF → JPEG 转换
  const converted = await gifToJpeg(base64, mime);
  const dataUri = `data:${converted.mime};base64,${converted.base64}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    const res = await fetch(`${visionBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: query },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices: { message: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;

    const rawReasoning = msg?.reasoning?.trim();
    if (rawReasoning) {
      const clean = cleanVisionDescription(rawReasoning);
      if (clean) return clean;
    }

    const rawContent = msg?.content?.trim();
    if (rawContent) {
      const clean = cleanVisionDescription(rawContent);
      if (clean) return clean;
    }

    return null;
  } catch {
    return null;
  }
}

// ── 上下文 ──────────────────────────────────────────────

/** 构建可读的上下文文本。图片消息显示 [图片] 标记。
 *  replyMap 可选，提供 msgId → { sender, text } 映射，将 (回复 msgId)
 *  替换为 (回复 发送者 "原文摘要")。 */
export function buildContext(entries: ListenEntry[], replyMap?: Map<number, { sender: string; text: string }>): string {
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

// ── LLM ────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LlmResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
}

async function callLlmWithTools(
  messages: { role: string; content: string }[],
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
    choices: { message: { content?: string | null; tool_calls?: ToolCall[] | null } }[];
  };
  const msg = data.choices?.[0]?.message;

  return {
    content: msg?.content?.trim() ?? null,
    tool_calls: msg?.tool_calls ?? null,
  };
}

// ── OneBot 发送 ────────────────────────────────────────

function sendGroupMsg(ws: WebSocket, groupId: number, message: string): void {
  const payload = JSON.stringify({
    action: "send_group_msg",
    params: { group_id: groupId, message },
  });
  ws.send(payload);
}

// ── 回复决策 ────────────────────────────────────────────

interface ReplyDecision {
  should: boolean;
  reason: string; // 用于 prompt 告知 LLM 的角色定位
}

function decideReply(entry: ListenEntry, msgType: string, rawText: string, probs?: ReplyProbabilities, botQQ?: number, replyChance?: number): ReplyDecision {
  const botId = botQQ ?? BOT_QQ;
  // 不要回复自己的消息
  if (entry.userId === botId || entry.selfId === entry.userId) {
    return { should: false, reason: "self" };
  }

  const isAtSelf = entry.atUsers.includes(botId);
  const isAtAll = hasAtAll(rawText);
  const isAtOther = entry.atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(BOT_NAME.toLowerCase());

  const p = probs ?? DEFAULT_PROBS;

  // 被 @（自己）或 @全体 → 必回
  if (isAtSelf || isAtAll) {
    return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  }

  // 被提到名字 → 大概率回
  if (mentioned) {
    return { should: Math.random() < p.mentioned, reason: "mentioned" };
  }

  // 纯表情/图片 → 低概率
  if (msgType === "face" || msgType === "image") {
    return { should: Math.random() < p.media, reason: "media" };
  }

  // 被 @ 别人 → 旁观者模式，降低概率
  if (isAtOther) {
    return { should: Math.random() < p.bystander, reason: "bystander" };
  }

  // 默认
  const chance = replyChance ?? REPLY_CHANCE;
  return { should: Math.random() < chance, reason: "random" };
}

// ── 主循环 ──────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(delay * 2, 30_000);
  log(`reconnecting in ${delay}ms ...`);
  reconnectTimer = setTimeout(connect, delay);
}

function connect(): void {
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch { /* ignore */ }
    ws = null;
  }

  const finalUrl = ACCESS_TOKEN
    ? (() => { const u = new URL(WS_URL); u.searchParams.set("access_token", ACCESS_TOKEN); return u.toString(); })()
    : WS_URL;

  log(`connecting to ${finalUrl}`);
  ws = new WebSocket(finalUrl);

  ws.onopen = () => {
    log("connected");
    reconnectDelay = 1_000;
  };

  ws.onmessage = async (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString();

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // 处理 group 和 private 两种消息类型
    if (data.post_type !== "message" || (data.message_type !== "group" && data.message_type !== "private")) return;

    // 每次消息处理开始时清空图片缓存
    _imageCache.clear();

    const isPrivate = data.message_type === "private";
    const sessionId = isPrivate ? `private_${data.user_id}` : `group_${data.group_id}`;
    const userId = data.user_id as number;
    let rawMessage = typeof data.raw_message === "string" ? data.raw_message : "";

    // 如果 raw_message 不含图片 CQ 码但 message 是数组格式且有图片段，
    // 补一条合成 CQ 码，让下游的图片下载 / 视觉描述逻辑正常工作。
    if (!/\[CQ:image/.test(rawMessage) && Array.isArray(data.message)) {
      for (const seg of data.message as Array<{ type?: string; data?: Record<string, unknown> }>) {
        if (seg?.type === "image" && typeof seg.data?.url === "string") {
          rawMessage += `[CQ:image,url=${seg.data.url}]`;
          break;
        }
      }
    }

    // 如果当前消息自身没有图片，检查同一用户最近是否发过图
    const _recentUserKey = `${sessionId}:${userId}`;
    let _recentUserCache: { downloaded: { base64: string; mime: string }; phash: string } | null = null;
    if (!/\[CQ:image/.test(rawMessage)) {
      const cached = _recentUserImage.get(_recentUserKey);
      if (cached && Date.now() - cached.time < USER_IMAGE_TTL_MS) {
        _recentUserCache = { downloaded: cached.downloaded, phash: cached.phash };
      }
    }

    // 解析 @ 列表和消息类型
    const atUsers = parseAtUsers(rawMessage);
    const msgType = estimateMsgType(rawMessage);
    const cleanText = stripCqCodes(rawMessage);

    const entry: ListenEntry = {
      session: sessionId,
      msgId: data.message_id as number,
      time: data.time as number,
      type: msgType,
      text: cleanText,
      userId,
      nickname: (data.sender as Record<string, unknown>)?.nickname as string || "",
      card: (data.sender as Record<string, unknown>)?.card as string || "",
      senderRole: (data.sender as Record<string, unknown>)?.role as string || "",
      subType: data.sub_type as string,
      selfId: data.self_id as number,
      atUsers,
      segmentTypes: [],
    };

    log(`[msg-diagnose] session=${sessionId} userId=${userId} atSelf=${entry.atUsers.includes(BOT_QQ)} hasImage=${/\[CQ:image/.test(rawMessage)} hasFace=${/\[CQ:face/.test(rawMessage)} textLen=${cleanText.length} rawMsgLen=${rawMessage.length}`);

    // 决策是否回复（私聊必回但跳过自己的消息，群聊按原有逻辑）
    const decision = isPrivate
      ? { should: userId !== BOT_QQ, reason: "private" }
      : decideReply(entry, msgType, rawMessage, getProbsForSession(sessionId), undefined, getReplyChanceForSession(sessionId));
    if (!decision.should) return;

    const senderName = entry.card || entry.nickname;
    log(`msg <${senderName}> in ${entry.session} [${decision.reason}]: ${cleanText.slice(0, 80)}`);

    // 加载上下文（轻量操作，先做，后续沉默检查要用）
    const recent = loadRecentMessages(RAW_DIR, entry.session, MAX_CONTEXT);
    // 构建 replyTo 查找表：msgId → { sender, text }，用于上下文显示引用原文
    const replyMap = new Map<number, { sender: string; text: string }>();
    for (const e of recent) {
      if (e.msgId) {
        replyMap.set(e.msgId, {
          sender: e.card || e.nickname,
          text: (e.text || "").slice(0, 80),
        });
      }
    }
    const contextText = buildContext(recent, replyMap);
    const keywords = extractKeywords(recent, 5);
    const topicSummary = keywords.length > 0
      ? `当前话题：${keywords.join("、")}`
      : "";
    const atmosphereTag = analyzeAtmosphere(recent);
    const persistedEntry = getPersistedImageEntry(recent, entry.msgId);

    const scenarioKey = isPrivate ? "private" : decision.reason;

    // 检查对话延续：bot 刚回复过此人，生成 hint 供沉默检查参考
    let continuationHint = "";
    if (isConversationContinuation(entry.userId, entry.session)) {
      continuationHint = `（你刚才回复过 ${senderName}，这可能是对刚才对话的继续）`;
    }

    // 低确定性触发：先做快速沉默检查
    const lowCertainty = scenarioKey === "random" || scenarioKey === "bystander" || scenarioKey === "media";
    if (lowCertainty) {
      let imgPhash: string | null = null;
      // 如果有图片，下载并缓存（供下游复用），但不预识别
      if (/\[CQ:image/.test(rawMessage)) {
        const { downloaded, phash } = await resolveMessageImage(persistedEntry, rawMessage);
        if (downloaded && phash) {
          imgPhash = phash;
          _imageCache.set(phash, downloaded);
          _recentUserImage.set(_recentUserKey, { downloaded, phash, time: Date.now() });
        }
      }

      const displayText = imgPhash
        ? `${cleanText} [图片#${imgPhash}]`
        : /\[CQ:image/.test(rawMessage)
          ? `${cleanText} [图片]`
          : cleanText;

      const quickReply = await quickDecideSilence(
        contextText, senderName, displayText, scenarioKey, topicSummary, atmosphereTag, continuationHint,
      );
      if (!quickReply || quickReply.toUpperCase() === "SILENT") {
        log(`silent (model chose not to speak)`);
        return;
      }
      // 模型有话说，直接发送简短回复
      if (!canReplyReal(entry.session)) {
        log(`[dry-run] would reply to ${entry.session}: ${quickReply.slice(0, 200)}`);
      } else if (isPrivate) {
        ws!.send(JSON.stringify({ action: "send_private_msg", params: { user_id: userId, message: quickReply } }));
      } else {
        sendGroupMsg(ws!, data.group_id as number, quickReply);
      }
      log(`replied: ${quickReply.slice(0, 100)}`);
      setLastBotReply(entry.userId, entry.session);
      return;
    }

    // 高确定性触发（at-self / mentioned / at-all / private 或对话延续）：原有流程

    // 如果有图片，先下载图片
    let downloadedImg: { base64: string; mime: string } | null = null;
    let currentPhash: string | null = null;
    if (/\[CQ:image/.test(rawMessage)) {
      const resolved = await resolveMessageImage(persistedEntry, rawMessage);
      downloadedImg = resolved.downloaded;
      currentPhash = resolved.phash;
      if (downloadedImg && currentPhash) {
        _imageCache.set(currentPhash, downloadedImg);
        _recentUserImage.set(_recentUserKey, { downloaded: downloadedImg, phash: currentPhash, time: Date.now() });
      }
    } else if (_recentUserCache) {
      // 当前消息无图，复用同一用户最近发的图
      downloadedImg = _recentUserCache.downloaded;
      currentPhash = _recentUserCache.phash;
      _imageCache.set(currentPhash, downloadedImg);
      log(`[user-image-cache] reused cached image phash=${currentPhash} for ${sessionId} userId=${userId}`);
    }
    const roleInstruction = `【${getScenarioPrompt(scenarioKey, BOT_NAME)}】`;

    try {
      // 构造系统提示
      const systemParts = [
        getSystemPrompt(BOT_NAME),
        getReplyRules(),
        buildSessionProfile(entry.session, RAW_DIR),
        styleGuidance(buildSessionProfile(entry.session, RAW_DIR)),
        topicSummary,
        atmosphereTag,
        `\n下面是这个群最近的消息：`,
        roleInstruction,
      ];
      if (downloadedImg && VISION_MODEL) {
        systemParts.push(`\n\n${getVisionFormat()}`);
      }

      // 初始消息列表
      const messageText = currentPhash !== null
        ? `${cleanText} [图片#${currentPhash}]`
        : /\[CQ:image/.test(rawMessage)
          ? `${cleanText} [图片]`
          : `${cleanText}`;
      const messages: any[] = [{
        role: "system",
        content: systemParts.filter(Boolean).join("\n"),
      }, {
        role: "user",
        content: downloadedImg
          ? `【群聊上下文】\n${contextText}\n\n【新消息（含图片 #${currentPhash}）】${senderName}: ${messageText}\n\n想回复就直接说，觉得没什么可说的就保持沉默。`
          : `【群聊上下文】\n${contextText}\n\n【新消息】${senderName}: ${messageText}\n\n想回复就直接说，觉得没什么可说的就保持沉默。`,
      }];

      // 视觉循环：Agent 通过 tool calling 询问图片内容，可以多轮追问
      let finalReply: string | null = null;
      let rounds = 0;

      while (!finalReply && rounds < 5) {
        rounds++;
        const tools = (downloadedImg && VISION_MODEL) ? [DESCRIBE_IMAGE_TOOL] : undefined;
        const result = await callLlmWithTools(messages, tools);

        if (result.tool_calls && result.tool_calls.length > 0 && VISION_MODEL) {
          for (const tc of result.tool_calls) {
            if (tc.function.name === "describe_image") {
              let args: { id: string; question: string };
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                // 参数解析失败，注入 tool 错误消息
                const assistantMsg: any = {
                  role: "assistant",
                  content: null,
                  tool_calls: [tc],
                };
                messages.push(assistantMsg);
                messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: "参数解析失败",
                });
                continue;
              }
              const { id, question } = args;
              log(`[describe_image id=${id}] ${question.slice(0, 100)}`);

              const cachedImg = _imageCache.get(id);
              let toolResult: string;
              if (cachedImg) {
                const answer = await callVision(question, cachedImg.base64, cachedImg.mime);
                toolResult = answer || "(分析失败)";
                log(`[describe_image a] ${toolResult.slice(0, 100)}`);
              } else {
                toolResult = "（该图片数据已过期，无法查看）";
                log(`[describe_image] image data expired: ${id}`);
              }

              // 注入 assistant 消息（包含 tool_calls） + tool 结果
              const assistantMsg: any = {
                role: "assistant",
                content: null,
                tool_calls: [tc],
              };
              messages.push(assistantMsg);
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: toolResult,
              });
            }
          }
        } else if (result.content) {
          finalReply = result.content;
        } else {
          // 既无 tool_calls 也无 content — 安全退出
          break;
        }
      }

      if (finalReply) {
        if (!canReplyReal(entry.session)) {
          log(`[dry-run] would reply to ${entry.session}: ${finalReply.slice(0, 200)}`);
        } else if (isPrivate) {
          const payload = JSON.stringify({
            action: "send_private_msg",
            params: { user_id: userId, message: finalReply },
          });
          ws!.send(payload);
          log(`replied private: ${finalReply.slice(0, 100)}`);
        } else {
          sendGroupMsg(ws!, data.group_id as number, finalReply);
          log(`replied: ${finalReply.slice(0, 100)}`);
        }
        setLastBotReply(entry.userId, entry.session);
      } else {
        log("no reply (model chose silence or vision loop exhausted)");
      }
    } catch (err) {
      log(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  ws.onclose = (event: CloseEvent) => {
    log(`disconnected (code=${event.code})`);
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

// ── 入口 ────────────────────────────────────────────────

function main(): void {
  if (!LLM_API_KEY) {
    log("LLM_API_KEY 未设置，视觉功能依赖本地 Ollama 时可能正常工作");
  }

  if (!existsSync(RAW_DIR)) {
    log(`data/prod/raw 不存在，请先运行监听器采集数据`);
  } else {
    const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
    log(`data/prod/raw 中有 ${files.length} 个会话文件`);
  }

  log(`dry-run=${DRY_RUN}（${DRY_RUN ? "仅模拟，不会实际发送消息" : "会实际发送消息到群聊"}）`);
  if (VISION_MODEL) {
    log(`vision: ${VISION_MODEL} @ ${VISION_BASE_URL}`);
  } else {
    log("vision: disabled (no model configured)");
  }

  connect();

  process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });
}

if (!process.env.RIN_TEST) {
  main();
}
