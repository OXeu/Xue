/**
 * listen.ts — OneBot 正向 WebSocket 群聊监听器。
 *
 * 只收不发。收到消息后按会话写入 JSONL 到 data/prod/raw/，
 * 用于后续分析群聊风格基线。
 *
 * 用法:  ONEBOT_WS_URL=ws://localhost:6700 bun run src/listen.ts
 *        DURATION_SECONDS=300 bun run src/listen.ts   # 5 分钟后自动退出
 *
 * 环境变量:
 *   ONEBOT_WS_URL        OneBot 网关地址（默认 ws://localhost:6700）
 *   ONEBOT_ACCESS_TOKEN  可选鉴权 token
 *   DURATION_SECONDS     运行指定秒数后自动退出（不设则持续运行）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { saveCachedImage } from "./image-cache";
import { computeDHash } from "./phash";

// ── 类型 ────────────────────────────────────────────────

interface OneBotSender {
  user_id: number;
  nickname: string;
  card?: string;
  role?: string;
}

interface OneBotMsgEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  raw_message: string;
  message: string | unknown[];
  sender: OneBotSender;
  self_id: number;
  time: number;
}

interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/** 解析后的消息记录，写入 JSONL 的一行。 */
interface ListenEntry {
  /** 会话标识: group_{id} 或 private_{id}。 */
  session: string;
  /** 消息 ID。 */
  msgId: number;
  /** 时间戳（秒）。 */
  time: number;
  /** 消息类型: text / at / image / reply / … */
  type: string;
  /** 纯文本内容（strip 掉 at/reply 标记后的正文）。 */
  text: string;
  /** 发送者 QQ。 */
  userId: number;
  /** 发送者昵称。 */
  nickname: string;
  /** 发送者群名片（如有）。 */
  card?: string;
  /** 发送者群角色（owner / admin / member）。 */
  senderRole?: string;
  /** 消息子类型（friend / group / normal / anonymous 等）。 */
  subType: string;
  /** 收到此消息的 bot QQ。 */
  selfId: number;
  /** @ 了哪些 QQ（数组）。 */
  atUsers: number[];
  /** 回复引用的消息 ID（如有）。 */
  replyTo?: number;
  /** 原始消息段类型分布（脱敏摘要）。 */
  segmentTypes: string[];
  /** 图片 URL 列表（如有）。 */
  imageUrls?: string[];
  /** 图片 pHash 值列表（与 imageUrls 一一对应），用于 replay 时查找本地缓存。 */
  phash?: string[];
  /** 原始 CQ 码（未剥离的 raw_message 字段）。 */
  raw_message: string;
  /** 完整消息段数组（OneBot 数组格式，保留原始数据）。 */
  segments: MessageSegment[];
}

// ── 路径 ────────────────────────────────────────────────

const DATA_DIR = resolve(import.meta.dirname, "../data/prod/raw");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function sessionLogPath(sessionId: string): string {
  return join(DATA_DIR, `${sessionId}.jsonl`);
}

// ── 消息解析 ────────────────────────────────────────────

/**
 * 解析 OneBot message 字段。
 * 兼容 array 格式和 string 格式。
 * 导出供单元测试使用。
 */
export function parseMessage(message: string | unknown[]): {
  text: string;
  atUsers: number[];
  replyTo?: number;
  segmentTypes: string[];
  imageUrls: string[];
} {
  const result = {
    text: "",
    atUsers: [] as number[],
    replyTo: undefined as number | undefined,
    segmentTypes: [] as string[],
    imageUrls: [] as string[],
  };

  // string 格式：直接作为纯文本
  if (typeof message === "string") {
    result.text = message;
    result.segmentTypes = ["text"];
    return result;
  }

  // array 格式
  if (!Array.isArray(message)) return result;

  for (const seg of message as MessageSegment[]) {
    if (!seg || !seg.type) continue;
    result.segmentTypes.push(seg.type);

    switch (seg.type) {
      case "text":
        result.text += seg.data?.text ?? "";
        break;
      case "at":
        if (seg.data?.qq && seg.data.qq !== "all") {
          result.atUsers.push(Number(seg.data.qq));
        }
        break;
      case "reply":
        if (seg.data?.id) {
          result.replyTo = Number(seg.data.id);
        }
        break;
      case "image":
        if (seg.data?.url) {
          result.imageUrls.push(String(seg.data.url));
        }
        break;
      // face / forward / mface / … — 只记录类型，不提取内容
    }
  }

  result.text = result.text.trim();
  return result;
}

/** 估算消息的"类型"：纯文本、表情为主、图片为主、混合。
 *  导出供单元测试使用。 */
export function estimateMsgType(segmentTypes: string[], text: string): string {
  if (segmentTypes.length === 0) return "unknown";
  if (segmentTypes.every((t) => t === "text")) return "text";
  if (segmentTypes.length === 1 && segmentTypes[0] === "face") return "face";
  if (segmentTypes.length === 1 && segmentTypes[0] === "image") return "image";
  if (segmentTypes.every((t) => t === "text" || t === "face")) return "text+face";
  return "mixed";
}

/** 将 message 字段统一转为数组格式（string 格式转成单段 text）。 */
function normalizeSegments(message: string | unknown[]): MessageSegment[] {
  if (typeof message === "string") {
    return [{ type: "text", data: { text: message } }];
  }
  if (!Array.isArray(message)) return [];
  return message as MessageSegment[];
}

// ── 写日志 ──────────────────────────────────────────────

function writeEntry(entry: ListenEntry): void {
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(sessionLogPath(entry.session), line, "utf8");
}

// ── 日志前缀 ────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

// ── 图片缓存 ────────────────────────────────────────────

/** 下载图片到本地缓存（不阻塞消息处理），以 phash 为文件名。
 *  同一张图片无论出现在哪个消息中，只存一份（phash 去重）。
 *  返回 phash（下载失败时返回 null）。
 *  导出供测试使用。 */
export async function cacheEntryImage(url: string, _session: string, _msgId: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    const base64 = Buffer.from(buf).toString("base64");
    const phash = await computeDHash(base64, mime);
    saveCachedImage(phash, base64, mime);
    console.log(`[${ts()}] [cache] cached image phash=${phash}`);
    return phash;
  } catch {
    return null;
  }
}

// ── 连接与重连 ──────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(wsUrl: string, accessToken: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(delay * 2, 30_000);
  console.log(`[${ts()}] reconnecting in ${delay}ms ...`);
  reconnectTimer = setTimeout(() => connect(wsUrl, accessToken), delay);
}

function connect(wsUrl: string, accessToken: string): void {
  // 清理旧连接及其监听器，避免嵌套重连
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

  // 将 token 注入 URL query 参数（OneBot 标准鉴权方式）
  const finalUrl = accessToken
    ? (() => {
        const u = new URL(wsUrl);
        u.searchParams.set("access_token", accessToken);
        return u.toString();
      })()
    : wsUrl;

  console.log(`[${ts()}] connecting to ${finalUrl} ...`);

  ws = new WebSocket(finalUrl);

  ws.onopen = () => {
    console.log(`[${ts()}] connected to ${finalUrl}`);
    reconnectDelay = 1_000; // 连接成功，重置退避
  };

  ws.onmessage = async (event: MessageEvent) => {
    const raw = typeof event.data === "string"
      ? event.data
      : Buffer.from(event.data).toString();

    let data: OneBotMsgEvent;
    try {
      data = JSON.parse(raw) as OneBotMsgEvent;
    } catch {
      console.warn(`[${ts()}] failed to parse message: ${raw.slice(0, 200)}`);
      return;
    }

    if (data.post_type !== "message") return;

    const sessionId = data.group_id
      ? `group_${data.group_id}`
      : `private_${data.user_id}`;

    const parsed = parseMessage(data.message);

    // 如果 raw_message 不含图片 CQ 码但 message 是数组格式且有图片段，
    // 补一条合成 CQ 码，确保 JSONL 中记录完整图片信息，下游 replay 可查。
    if (!/\[CQ:image/.test(data.raw_message) && Array.isArray(data.message)) {
      for (const seg of data.message as Array<{ type?: string; data?: Record<string, unknown> }>) {
        if (seg?.type === "image" && typeof seg.data?.url === "string") {
          data.raw_message += `[CQ:image,url=${seg.data.url}]`;
          break;
        }
      }
    }

    const entry: ListenEntry = {
      session: sessionId,
      msgId: data.message_id,
      time: data.time,
      type: estimateMsgType(parsed.segmentTypes, parsed.text),
      text: parsed.text,
      userId: data.user_id,
      nickname: data.sender.nickname,
      card: data.sender.card,
      senderRole: data.sender.role,
      subType: data.sub_type,
      selfId: data.self_id,
      atUsers: parsed.atUsers,
      replyTo: parsed.replyTo,
      segmentTypes: parsed.segmentTypes,
      raw_message: data.raw_message,
      segments: normalizeSegments(data.message),
    };
    if (parsed.imageUrls.length > 0) {
      entry.imageUrls = parsed.imageUrls;
    }

    // 控制台日志（精简）
    const atInfo = entry.atUsers.length > 0 ? ` @[${entry.atUsers.join(",")}]` : "";
    const replyInfo = entry.replyTo ? ` (回复 ${entry.replyTo})` : "";
    console.log(
      `[${ts()}] [${sessionId}] <${entry.nickname}>${atInfo}${replyInfo}: ${entry.text.slice(0, 120)}`,
    );

    // 写入消息前先下载图片、计算 phash，存入 entry 供 replay 时定位本地缓存
    if (entry.imageUrls && entry.imageUrls.length > 0) {
      const phashes: string[] = [];
      for (const url of entry.imageUrls) {
        const phash = await cacheEntryImage(url, entry.session, entry.msgId);
        if (phash) phashes.push(phash);
      }
      if (phashes.length > 0) entry.phash = phashes;
    }

    writeEntry(entry);
  };

  ws.onclose = (event: CloseEvent) => {
    console.log(`[${ts()}] disconnected (code=${event.code})`);
    console.error(`[${ts()}] disconnected (code=${event.code})`);
    // 指数退避重连（初始 1s，最大 30s）
    scheduleReconnect(wsUrl, accessToken);
  };

  ws.onerror = () => {
    // onerror 后必然触发 onclose，不在 error 里重连避免双重触发
  };
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const wsUrl = process.env.ONEBOT_WS_URL || "ws://localhost:6700";
  const accessToken = process.env.ONEBOT_ACCESS_TOKEN || "";

  ensureDataDir();

  console.log(`[${ts()}] listen starting`);
  console.log(`[${ts()}] data dir: ${DATA_DIR}`);

  connect(wsUrl, accessToken);

  // 支持 DURATION_SECONDS 自动退出
  const duration = process.env.DURATION_SECONDS;
  if (duration) {
    const secs = Number(duration);
    if (Number.isFinite(secs) && secs > 0) {
      console.log(`[${ts()}] will auto-exit after ${secs}s`);
      setTimeout(() => {
        console.log(`[${ts()}] DURATION_SECONDS reached, shutting down ...`);
        if (ws) { try { ws.close(); } catch {} }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        process.exit(0);
      }, secs * 1000);
    }
  }

  // 心跳日志：每 5 分钟输出状态到 stderr
  const startTime = Date.now();
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    let fileCount = 0;
    try {
      fileCount = readdirSync(DATA_DIR).filter((f: string) => f.endsWith(".jsonl")).length;
    } catch { /* ignore */ }
    console.error(`[${ts()}] [heartbeat] running, ${elapsed}s elapsed, ${fileCount} files in data/prod/raw/`);
  }, 300_000);

  // 保持进程运行
  process.on("SIGINT", () => {
    console.log(`\n[${ts()}] shutting down ...`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    console.log(`[${ts()}] shutting down ...`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    process.exit(0);
  });
}

if (!process.env.RIN_TEST) {
  main();
}
