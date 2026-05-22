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
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 配置 ────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const WS_URL = process.env.ONEBOT_WS_URL || "ws://localhost:6700";
const ACCESS_TOKEN = process.env.ONEBOT_ACCESS_TOKEN || "";
const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const MAX_CONTEXT = 30; // 加载最近 N 条消息作为上下文

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

// ── 上下文 ──────────────────────────────────────────────

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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
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

function shouldReply(entry: ListenEntry, allEntries: ListenEntry[]): boolean {
  // 不要回复自己的消息
  if (entry.userId === BOT_QQ || entry.selfId === entry.userId) return false;

  // Bot 被 @ 了 → 必回
  if (entry.atUsers.includes(BOT_QQ)) return true;

  // 非 @ 消息按概率回复
  return Math.random() < REPLY_CHANCE;
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

    // 只处理 group message 事件
    if (data.post_type !== "message" || data.message_type !== "group") return;

    const groupId = data.group_id as number;
    const userId = data.user_id as number;
    const msgText = typeof data.raw_message === "string" ? data.raw_message : "";

    const entry: ListenEntry = {
      session: `group_${groupId}`,
      msgId: data.message_id as number,
      time: data.time as number,
      type: "text",
      text: msgText,
      userId,
      nickname: (data.sender as Record<string, unknown>)?.nickname as string || "",
      card: (data.sender as Record<string, unknown>)?.card as string || "",
      senderRole: (data.sender as Record<string, unknown>)?.role as string || "",
      subType: data.sub_type as string,
      selfId: data.self_id as number,
      atUsers: [],
      segmentTypes: ["text"],
    };

    // 是否需要回复
    if (!shouldReply(entry, [])) return;

    // 加载上下文
    const recent = loadRecentMessages(entry.session, MAX_CONTEXT);
    const contextText = buildContext(recent);

    log(`msg <${entry.nickname}> in ${entry.session}: ${msgText.slice(0, 80)}`);

    try {
      const reply = await callLlm([
        {
          role: "system",
          content: [
            `你叫${BOT_NAME}，是一个在 QQ 群里聊天的人类。`,
            `你的回复要简短、自然，像真的群友在说话。`,
            `不要列点，不要用 formal 语气，不要每条都回得很完整。`,
            `偶尔可以只回几个字或一个表情。`,
            `下面是这个群最近的消息：`,
          ].join("\n"),
        },
        {
          role: "user",
          content: `【群聊上下文】\n${contextText}\n\n【新消息】${entry.nickname}: ${msgText}\n\n请以 ${BOT_NAME} 的身份回复这条消息（如果觉得没什么好说的也可以不回）。`,
        },
      ]);

      if (reply) {
        sendGroupMsg(ws!, groupId, reply);
        log(`replied: ${reply.slice(0, 100)}`);
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
    console.error("请设置 LLM_API_KEY 环境变量");
    process.exit(1);
  }

  if (!existsSync(RAW_DIR)) {
    log(`data/raw 不存在，请先运行监听器采集数据`);
  } else {
    const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
    log(`data/raw 中有 ${files.length} 个会话文件`);
  }

  connect();

  process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });
}

main();
