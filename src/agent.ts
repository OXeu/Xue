/**
 * agent.ts — 群聊回复 agent
 *
 * 监听群聊消息，加载上下文，调用 LLM 生成回复，通过 OneBot 发送。
 * 与 listen.ts 互不干扰（各自使用独立的 WS 连接）。
 *
 * 图片消息处理流程（视觉问答循环）：
 *   收到图片 → 计算 pHash → 保存在上下文中显示 [图片 #phash_xxx]
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeDHash } from "./phash";
import { cleanVisionDescription } from "./clean-vision";
import { downloadImage, gifToJpeg } from "./image-download";
import { parseAtUsers, hasAtAll, stripCqCodes, estimateMsgType } from "./cq-codes";
import {
  extractKeywords,
  analyzeAtmosphere,
  analyzeStyle,
  styleGuidance,
  buildSessionProfile,
  loadRecentMessages,
  isVagueDescription,
  persistBestDescription,
} from "./chat-utils";

// 保持导出兼容（让 import from "agent" 的用户不中断）
export {
  analyzeAtmosphere,
  isVagueDescription,
  persistBestDescription,
  styleGuidance,
  buildSessionProfile,
};

import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
  getVisionFormat,
  getSilenceCheckPrompt,
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
let _inferencesDir = resolve(import.meta.dirname, "../data/prod/inferences");

function ensureInferencesDir(): void {
  if (!existsSync(_inferencesDir)) mkdirSync(_inferencesDir, { recursive: true });
}

/** 临时图片缓存：pHash → base64 + mime。在单次 onmessage 调用期间有效。 */
const _imageCache = new Map<string, { base64: string; mime: string }>();

const DESCRIBE_IMAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "describe_image",
    description:
      "询问某张图片的内容。图片在上下文中以 [图片 #phash_xxx] 形式出现，用 phash 作为 id 引用它。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "图片的 phash ID（来自上下文中的 [图片 #phash_xxx]）",
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
/** 加载某会话已缓存的图片 phash 记录，返回 msgId → phash 映射表。
 *  兼容新旧格式：检测 entry.phash 和 entry.inference 字段。 */
export function loadPhashMap(session: string): Map<number, string> {
  const path = join(_inferencesDir, `${session}.jsonl`);
  if (!existsSync(path)) return new Map();

  const map = new Map<number, string>();
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.msgId) {
        if (entry.phash) {
          map.set(entry.msgId, entry.phash);
        } else if (entry.inference) {
          // 兼容旧格式：inference 字段作为 phash（老数据）
          map.set(entry.msgId, entry.inference);
        }
      }
    } catch { /* skip corrupt lines */ }
  }
  return map;
}

/** 从 data/prod/inferences/{session}.jsonl 中查找某个 msgId 的缓存视觉描述。
 *  当图片下载失败时，用此兜底注入 [图片描述: ...] 到消息文本中。 */
export function loadCachedInference(session: string, msgId: number): string | null {
  const path = join(_inferencesDir, `${session}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.msgId === msgId && entry.inference && typeof entry.inference === "string") {
        return entry.inference;
      }
    } catch { /* skip */ }
  }
  return null;
}

export function buildContext(entries: ListenEntry[]): string {
  return buildContextWithPhashIds(entries, new Map());
}

/** 带 phash ID 注入的上下文构建。
 *  phashMap 可由 loadPhashMap() 加载，有 phash 时显示 [图片 #phash_xxx] 而非纯 [图片]。 */
export function buildContextWithPhashIds(
  entries: ListenEntry[],
  phashMap: Map<number, string>,
): string {
  if (entries.length === 0) return "（暂无历史消息）";

  return entries
    .map((e) => {
      const name = e.card || e.nickname;
      const time = new Date(e.time * 1000).toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit",
      });
      const at = e.atUsers.length > 0 ? ` @${e.atUsers.join(",")}` : "";
      const reply = e.replyTo ? ` (回复 ${e.replyTo})` : "";
      const text = e.text || `[${e.type}]`;
      let imgMark = "";
      if (e.segmentTypes?.includes("image")) {
        const phash = phashMap.get(e.msgId);
        if (phash) {
          imgMark = ` [图片 #${phash}]`;
        } else {
          imgMark = " [图片]";
        }
      }
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

// ── 快速沉默决策（低确定性触发器用） ───────────────────

/** 对低确定性触发（random/bystander/media），先问模型有没有话想说。
 *  返回 SILENT 或模型生成的简短回复。 */
export async function quickDecideSilence(
  contextText: string,
  senderName: string,
  messageText: string,
  scenarioKey: string,
  topicSummary: string,
  atmosphereTag: string,
): Promise<string | null> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const scenarioPrompt = getScenarioPrompt(scenarioKey, BOT_NAME);

  const systemContent = [
    getSystemPrompt(BOT_NAME),
    getReplyRules(),
    topicSummary,
    atmosphereTag,
    `\n下面是这个群最近的消息：`,
    `【${scenarioPrompt}】`,
  ].filter(Boolean).join("\n");

  try {
    const userMsg = getSilenceCheckPrompt(contextText, senderName, messageText);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: systemContent },
          {
            role: "user",
            content: userMsg,
          },
        ],
        max_tokens: 60,
        temperature: 0.8,
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices: { message: { content?: string | null } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── 回复决策 ────────────────────────────────────────────

interface ReplyDecision {
  should: boolean;
  reason: string; // 用于 prompt 告知 LLM 的角色定位
}

function decideReply(entry: ListenEntry, msgType: string, rawText: string): ReplyDecision {
  // 不要回复自己的消息
  if (entry.userId === BOT_QQ || entry.selfId === entry.userId) {
    return { should: false, reason: "self" };
  }

  const isAtSelf = entry.atUsers.includes(BOT_QQ);
  const isAtAll = hasAtAll(rawText);
  const isAtOther = entry.atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(BOT_NAME.toLowerCase());

  // 被 @（自己）或 @全体 → 必回
  if (isAtSelf || isAtAll) {
    return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  }

  // 被提到名字 → 大概率回
  if (mentioned) {
    return { should: Math.random() < 0.7, reason: "mentioned" };
  }

  // 纯表情/图片 → 低概率
  if (msgType === "face" || msgType === "image") {
    return { should: Math.random() < 0.1, reason: "media" };
  }

  // 被 @ 别人 → 旁观者模式，降低概率
  if (isAtOther) {
    return { should: Math.random() < 0.05, reason: "bystander" };
  }

  // 默认
  return { should: Math.random() < REPLY_CHANCE, reason: "random" };
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
    const rawMessage = typeof data.raw_message === "string" ? data.raw_message : "";

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

    // 决策是否回复（私聊必回但跳过自己的消息，群聊按原有逻辑）
    const decision = isPrivate
      ? { should: userId !== BOT_QQ, reason: "private" }
      : decideReply(entry, msgType, rawMessage);
    if (!decision.should) return;

    const senderName = entry.card || entry.nickname;
    log(`msg <${senderName}> in ${entry.session} [${decision.reason}]: ${cleanText.slice(0, 80)}`);

    // 加载上下文（轻量操作，先做，后续沉默检查要用）
    const recent = loadRecentMessages(RAW_DIR, entry.session, MAX_CONTEXT);
    const phashMap = loadPhashMap(entry.session);
    const contextText = buildContextWithPhashIds(recent, phashMap);
    const keywords = extractKeywords(recent, 5);
    const topicSummary = keywords.length > 0
      ? `当前话题：${keywords.join("、")}`
      : "";
    const atmosphereTag = analyzeAtmosphere(recent);

    const scenarioKey = isPrivate ? "private" : decision.reason;

    // 低确定性触发：先做快速沉默检查，但附带图片描述（如有）
    const lowCertainty = scenarioKey === "random" || scenarioKey === "bystander" || scenarioKey === "media";
    if (lowCertainty) {
      // 如果消息包含图片，先下载并做单轮视觉描述
      let imageDesc = "";
      if (/\[CQ:image/.test(rawMessage)) {
        const imgUrl = parseFirstImageUrl(rawMessage);
        if (imgUrl) {
          const downloaded = await downloadImage(imgUrl);
          if (downloaded) {
            const phash = await computeDHash(downloaded.base64, downloaded.mime);
            _imageCache.set(phash, downloaded);
            try {
              ensureInferencesDir();
              appendFileSync(
                join(_inferencesDir, `${entry.session}.jsonl`),
                JSON.stringify({ msgId: entry.msgId, session: entry.session, phash, timestamp: new Date().toISOString() }) + "\n",
                "utf8",
              );
            } catch {}
            if (VISION_MODEL) {
              const answer = await callVision("用一条简短的自然语句描述这张图片的核心内容：主体是什么、情绪或氛围如何、是否包含文字。不要模板化的描述。", downloaded.base64, downloaded.mime);
              if (answer && !isVagueDescription(answer)) {
                imageDesc = answer;
                persistBestDescription(_inferencesDir, entry.session, entry.msgId, phash, imageDesc);
              }
            }
          }
        }
        // 下载失败时查缓存
        if (!imageDesc) {
          const cached = loadCachedInference(entry.session, entry.msgId);
          if (cached) imageDesc = cached;
        }
      }

      const displayText = imageDesc
        ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
        : cleanText;

      const quickReply = await quickDecideSilence(
        contextText, senderName, displayText, scenarioKey, topicSummary, atmosphereTag,
      );
      if (!quickReply || quickReply.toUpperCase() === "SILENT") {
        log(`silent (model chose not to speak)`);
        return;
      }
      // 模型有话说，直接发送简短回复
      if (DRY_RUN) {
        log(`[dry-run] would reply to ${entry.session}: ${quickReply.slice(0, 200)}`);
      } else if (isPrivate) {
        ws!.send(JSON.stringify({ action: "send_private_msg", params: { user_id: userId, message: quickReply } }));
      } else {
        sendGroupMsg(ws!, data.group_id as number, quickReply);
      }
      log(`replied: ${quickReply.slice(0, 100)}`);
      return;
    }

    // 高确定性触发（at-self / mentioned / at-all / private）：原有流程

    // 如果有图片，先下载图片
    let downloadedImg: { base64: string; mime: string } | null = null;
    let currentPhash: string | null = null;
    let cachedDescription: string | null = null;
    if (/\[CQ:image/.test(rawMessage)) {
      const imgUrl = parseFirstImageUrl(rawMessage);
      if (imgUrl) downloadedImg = await downloadImage(imgUrl);
      if (downloadedImg) {
        currentPhash = await computeDHash(downloadedImg.base64, downloadedImg.mime);
        _imageCache.set(currentPhash, downloadedImg);
        // 保存 phash 到 inference 文件，供将来上下文使用
        try {
          ensureInferencesDir();
          appendFileSync(
            join(_inferencesDir, `${entry.session}.jsonl`),
            JSON.stringify({ msgId: entry.msgId, session: entry.session, phash: currentPhash, timestamp: new Date().toISOString() }) + "\n",
            "utf8",
          );
        } catch {}
      } else if (imgUrl) {
        cachedDescription = loadCachedInference(entry.session, entry.msgId);
      }
    }
    // 将当前图片的 phash 注入上下文
    if (currentPhash) {
      phashMap.set(entry.msgId, currentPhash);
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
      const descSuffix = cachedDescription
        ? ` [图片描述: ${cachedDescription.slice(0, 80)}]`
        : "";
      const messageText = `${cleanText}${descSuffix}`;
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
                // 持久化视觉描述到 inferences 文件（只保存有信息量的描述，后轮覆盖前轮）
                if (answer && !isVagueDescription(answer)) {
                  persistBestDescription(_inferencesDir, entry.session, entry.msgId, id, answer);
                }
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
        if (DRY_RUN) {
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
