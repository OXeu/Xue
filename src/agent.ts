/**
 * agent.ts — 群聊回复 agent
 *
 * 监听群聊消息，加载上下文，调用 LLM 生成回复，通过 OneBot 发送。
 * 与 listen.ts 互不干扰（各自使用独立的 WS 连接）。
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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanVisionDescription } from "./clean-vision";
import { saveCachedImage, getCachedDescription } from "./image-cache";
import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
  getVisionFormat,
  clearPromptCaches,
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
  senderRole?: string;
  subType: string;
  selfId: number;
  atUsers: number[];
  replyTo?: number;
  segmentTypes: string[];
}

// ── 工具 ────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] [agent] ${msg}`);
}

/** 从 OneBot raw_message 中提取被 @ 的 QQ 列表 */
function parseAtUsers(raw: string): number[] {
  const ids: number[] = [];
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    ids.push(Number(m[1]));
  }
  return ids;
}

/** 检查是否 @全体成员 */
function hasAtAll(raw: string): boolean {
  return /\[CQ:at,qq=all\]/.test(raw);
}

/** 剥离 CQ 码，提取纯文本内容 */
function stripCqCodes(raw: string): string {
  return raw
    .replace(/\[CQ:[^\]]*\]/g, "")
    .trim();
}

/** 粗略判断消息类型：纯文本 / 纯表情 / 纯图片 / 混合 */
function estimateMsgType(raw: string): "text" | "face" | "image" | "mixed" {
  const cqTypes = [...raw.matchAll(/\[CQ:(\w+),/g)].map((m) => m[1]);
  if (cqTypes.length === 0) return "text";

  // 如果有 CQ 码之外的文字内容，不可能是 pure face/image
  const stripped = stripCqCodes(raw);
  if (stripped.length > 0) return "mixed";

  if (cqTypes.every((t) => t === "face")) return "face";
  if (cqTypes.every((t) => t === "image")) return "image";
  if (cqTypes.every((t) => t === "face" || t === "image")) return "mixed";
  return "mixed";
}

/** 简单中文停用词 */
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

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([w]) => w);
}

// ── 图片理解 ────────────────────────────────────────────

/** 从 CQ 码中提取第一个图片的 url（返回 null 表示无 url） */
function parseFirstImageUrl(raw: string): string | null {
  const m = raw.match(/\[CQ:image,([^\]]*)\]/);
  if (!m) return null;
  const urlMatch = m[1].match(/url=([^,]*)/);
  return urlMatch ? decodeURIComponent(urlMatch[1]) : null;
}

/** 下载图片并 base64 编码 */
async function downloadImage(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    return { base64: Buffer.from(buf).toString("base64"), mime };
  } catch {
    return null;
  }
}

// cleanVisionDescription 已通过 import 导入（实现在 clean-vision.ts）

/** 调用视觉 LLM 描述图片，返回一句话描述，失败返回 null。
 *  若传入 session + msgId，会先查缓存，成功描述后也写入缓存。 */
async function describeImage(
  cqMatch: string,
  session?: string,
  msgId?: number,
): Promise<string | null> {
  if (!VISION_MODEL) return null;

  // 查缓存（重放场景下直接走缓存，不调视觉模型）
  if (session && msgId) {
    const cached = getCachedDescription(session, msgId);
    if (cached) return cached;
  }

  const url = parseFirstImageUrl(cqMatch);
  if (!url) return null;

  const img = await downloadImage(url);
  if (!img) return null;

  const dataUri = `data:${img.mime};base64,${img.base64}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_API_KEY || "ollama"}`,
    };

    const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "用一句话简短描述这张图片的内容" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 100,
        temperature: 0.5,
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices: { message: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;

    // 优先从 reasoning 字段提取，清洗后若无有效描述回退到 content
    const rawReasoning = msg?.reasoning?.trim();
    if (rawReasoning) {
      const clean = cleanVisionDescription(rawReasoning);
      if (clean) {
        // 写入缓存供后续 replay 使用
        if (session && msgId) {
          try { saveCachedImage(session, msgId, img.base64, img.mime, clean, url); } catch {}
        }
        return clean;
      }
    }

    const rawContent = msg?.content?.trim();
    if (rawContent) {
      const clean = cleanVisionDescription(rawContent);
      if (clean) {
        if (session && msgId) {
          try { saveCachedImage(session, msgId, img.base64, img.mime, clean, url); } catch {}
        }
        return clean;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── 上下文 ──────────────────────────────────────────────

/** 从历史消息中提取群聊特征词。读取最近 200 条消息，返回高频关键词概览。 */
export function buildSessionProfile(sessionId: string): string {
  if (sessionId.startsWith("private_")) return ""; // 私聊不做群特征提取
  const entries = loadRecentMessages(sessionId, 200);
  if (entries.length < 10) return ""; // 数据太少，没有足够信息量
  const keywords = extractKeywords(entries, 10);
  if (keywords.length === 0) return "";
  return `群聊特征：${keywords.join("、")}`;
}

function loadRecentMessages(sessionId: string, limit: number): ListenEntry[] {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as ListenEntry);
}

function buildContext(entries: ListenEntry[]): string {
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
      return `[${time}] ${name}${at}${reply}: ${text}`;
    })
    .join("\n");
}

// ── LLM ────────────────────────────────────────────────

async function callLlm(messages: { role: string; content: string }[]): Promise<string> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: 300,
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
  return data.choices?.[0]?.message?.content?.trim() || "";
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
    return { should: Math.random() < 0.15, reason: "bystander" };
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

    // 如果有图片，尝试获取描述
    let imageDescription: string | null = null;
    if (/\[CQ:image/.test(rawMessage)) {
      imageDescription = await describeImage(rawMessage, entry.session, entry.msgId);
      if (imageDescription) {
        log(`img: ${imageDescription.slice(0, 120)}`);
      }
    }

    // 加载上下文 + 话题摘要
    const recent = loadRecentMessages(entry.session, MAX_CONTEXT);
    const contextText = buildContext(recent);
    const keywords = extractKeywords(recent, 5);
    const topicSummary = keywords.length > 0
      ? `当前话题：${keywords.join("、")}`
      : "";

    // 决定角色定位
    const scenarioKey = isPrivate ? "private" : decision.reason;
    let roleInstruction = `【${getScenarioPrompt(scenarioKey, BOT_NAME)}】`;
    if (imageDescription) {
      roleInstruction = `【${getVisionFormat().replace("{IMAGE_DESCRIPTION}", imageDescription)}】`;
    }

    const senderName = entry.card || entry.nickname;
    log(`msg <${senderName}> in ${entry.session} [${decision.reason}]: ${cleanText.slice(0, 80)}`);

    try {
      const reply = await callLlm([
        {
          role: "system",
          content: [
            getSystemPrompt(BOT_NAME),
            getReplyRules(),
            buildSessionProfile(entry.session),
            topicSummary,
            `\n下面是这个群最近的消息：`,
            roleInstruction,
          ].filter(Boolean).join("\n"),
        },
        {
          role: "user",
          content: `【群聊上下文】\n${contextText}\n\n【新消息】${senderName}: ${cleanText}\n\n请以 ${BOT_NAME} 的身份自然回复。`,
        },
      ]);

      if (reply) {
        if (DRY_RUN) {
          log(`[dry-run] would reply to ${entry.session}: ${reply.slice(0, 200)}`);
        } else if (isPrivate) {
          const payload = JSON.stringify({
            action: "send_private_msg",
            params: { user_id: userId, message: reply },
          });
          ws!.send(payload);
          log(`replied private: ${reply.slice(0, 100)}`);
        } else {
          sendGroupMsg(ws!, data.group_id as number, reply);
          log(`replied: ${reply.slice(0, 100)}`);
        }
      } else {
        log("LLM returned empty, skipped");
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
    log(`data/raw 不存在，请先运行监听器采集数据`);
  } else {
    const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
    log(`data/raw 中有 ${files.length} 个会话文件`);
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
