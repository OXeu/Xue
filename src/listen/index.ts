/**
 * listen/index.ts — OneBot 正向 WebSocket 群聊监听器（重构版）
 *
 * 唯一连接 OneBot WebSocket 的进程。
 * 收到消息后：
 *   1. 解析消息
 *   2. 下载图片、计算 phash（顺序队列，保证落盘顺序）
 *   3. 写入 raw JSONL (data/prod/raw/)
 *   4. 通过本地 Unix Socket 推送处理后事件给 agent
 *
 * agent 不再直接连接 OneBot。
 *
 * 用法:
 *   ONEBOT_WS_URL=ws://localhost:6700 bun run src/listen/index.ts
 *
 * 环境变量:
 *   ONEBOT_WS_URL        OneBot 网关地址（默认 ws://localhost:6700）
 *   ONEBOT_ACCESS_TOKEN  可选鉴权 token
 *   DURATION_SECONDS     运行指定秒数后自动退出（不设则持续运行）
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ListenEntry } from "../shared/types";
import { EVENTS_SOCKET_PATH, sendEvent } from "../shared/events";
import { saveCachedImage } from "../image-cache";
import { computeDHashFromBuffer } from "../phash";

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

/** 解析后的消息元数据（仅用于内部处理，不入 JSONL）。 */
interface ParsedMessage {
  text: string;
  atUsers: number[];
  atAll: boolean;
  replyTo?: number;
  segmentTypes: string[];
  imageUrls: string[];
}

// ── 路径 ────────────────────────────────────────────────

const DATA_DIR = resolve(import.meta.dirname, "../../data/prod/raw");
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  atAll: boolean;
  replyTo?: number;
  segmentTypes: string[];
  imageUrls: string[];
} {
  const result = {
    text: "",
    atUsers: [] as number[],
    atAll: false,
    replyTo: undefined as number | undefined,
    segmentTypes: [] as string[],
    imageUrls: [] as string[],
  };

  // string 格式：从 CQ 码中解析 at / reply，剥离 CQ 码后得到纯文本
  if (typeof message === "string") {
    const replyMatch = message.match(/\[CQ:reply,id=(\d+)\]/);
    if (replyMatch) result.replyTo = Number(replyMatch[1]);

    const atRe = /\[CQ:at,qq=(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(message)) !== null) {
      result.atUsers.push(Number(m[1]));
    }

    result.atAll = /\[CQ:at,qq=all\]/.test(message);

    const imgRe = /\[CQ:image,([^\]]*)\]/g;
    while ((m = imgRe.exec(message)) !== null) {
      const urlMatch = m[1].match(/url=([^,]*)/);
      if (urlMatch) result.imageUrls.push(decodeURIComponent(urlMatch[1]));
    }

    const cqTypes = [...message.matchAll(/\[CQ:(\w+),/g)].map((x) => x[1]);
    result.segmentTypes = cqTypes.length > 0 ? cqTypes : ["text"];
    result.text = message.replace(/\[CQ:[^\]]*\]/g, "").trim();
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
        if (seg.data?.qq === "all") {
          result.atAll = true;
        } else if (seg.data?.qq) {
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
    }
  }

  result.text = result.text.trim();
  return result;
}

/** 估算消息的类型。导出供单元测试使用。 */
export function estimateMsgType(segmentTypes: string[], text: string): string {
  if (segmentTypes.length === 0) return "unknown";
  if (segmentTypes.every((t) => t === "text")) return "text";
  if (segmentTypes.length === 1 && segmentTypes[0] === "face") return "face";
  if (segmentTypes.length === 1 && segmentTypes[0] === "image") return "image";
  if (segmentTypes.every((t) => t === "text" || t === "face")) return "text+face";
  return "mixed";
}

// ── 写日志 ──────────────────────────────────────────────

function writeEntryRaw(entry: ListenEntry): void {
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(sessionLogPath(entry.session), line, "utf8");
}

// ── 日志前缀 ────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

// ── 图片缓存 ────────────────────────────────────────────

/** 下载图片到本地缓存，以 phash 为文件名。
 *  同一张图片无论出现在哪个消息中，只存一份（phash 去重）。
 *  返回 phash（下载失败时返回 null）。
 *  导出供测试使用。 */
export async function cacheEntryImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    const buffer = Buffer.from(buf);
    const mime = res.headers.get("content-type") || "image/jpeg";
    const base64 = buffer.toString("base64");
    const phash = await computeDHashFromBuffer(buffer);
    saveCachedImage(phash, base64, mime);
    console.log(`[${ts()}] [cache] cached image phash=${phash}`);
    return phash;
  } catch {
    return null;
  }
}

// ── 顺序处理队列 ────────────────────────────────────────

/**
 * 顺序处理队列，确保图片消息下载 → phash → 落盘按到达顺序执行。
 * 后续消息需等待前一条处理完成。
 */
let processQueue: Promise<void> = Promise.resolve();

/** 将一条消息加入顺序处理队列。 */
function enqueueProcess(entry: ListenEntry, imageUrls: string[]): void {
  processQueue = processQueue.then(async () => {
    try {
      // 下载图片、计算 phash
      if (imageUrls.length > 0) {
        const phashes: string[] = [];
        for (const url of imageUrls) {
          const phash = await cacheEntryImage(url);
          if (phash) phashes.push(phash);
        }
        if (phashes.length > 0) entry.phash = phashes;
      }

      // 写入 raw JSONL
      ensureDir(DATA_DIR);
      writeEntryRaw(entry);

      // 推送实时事件给 agent（agent 未启动时静默失败）
      await sendEvent(entry);

      console.log(`[${ts()}] [${entry.session}] <${entry.nickname}>: ${entry.text.slice(0, 120)}`);
    } catch (err) {
      console.error(`[${ts()}] [queue] error processing entry: ${err instanceof Error ? err.message : String(err)}`);
      // 即使处理失败也尝试写入
      try {
        ensureDir(DATA_DIR);
        writeEntryRaw(entry);
      } catch {}
    }
  });
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
    reconnectDelay = 1_000;
  };

  ws.onmessage = (event: MessageEvent) => {
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
    // 补一条合成 raw_message，让图片 URL 被 parseMessage 提取到。
    let rawMessage = data.raw_message;
    if (!/\[CQ:image/.test(rawMessage) && Array.isArray(data.message)) {
      for (const seg of data.message as Array<{ type?: string; data?: Record<string, unknown> }>) {
        if (seg?.type === "image" && typeof seg.data?.url === "string") {
          rawMessage += `[CQ:image,url=${seg.data.url}]`;
          break;
        }
      }
    }

    // 重新解析以获取完整 imageUrls（如果 raw_message 被补充了）
    const fullParsed = rawMessage !== data.raw_message ? parseMessage(rawMessage) : parsed;

    const entry: ListenEntry = {
      session: sessionId,
      msgId: data.message_id,
      time: data.time,
      type: estimateMsgType(fullParsed.segmentTypes, fullParsed.text),
      text: fullParsed.text,
      userId: data.user_id,
      nickname: data.sender.nickname,
      card: data.sender.card,
      senderRole: data.sender.role,
      subType: data.sub_type,
      selfId: data.self_id,
      atUsers: fullParsed.atUsers,
      atAll: fullParsed.atAll || undefined,
      replyTo: fullParsed.replyTo,
      segmentTypes: fullParsed.segmentTypes,
      // phash 在 enqueueProcess 中填充
    };

    // 控制台日志（精简）
    const atInfo = entry.atUsers.length > 0 ? ` @[${entry.atUsers.join(",")}]` : "";
    const replyInfo = entry.replyTo ? ` (回复 ${entry.replyTo})` : "";
    console.log(
      `[${ts()}] [${sessionId}] <${entry.nickname}>${atInfo}${replyInfo}: ${entry.text.slice(0, 120)}`,
    );

    // 加入顺序处理队列（下载 + phash + 落盘）
    enqueueProcess(entry, fullParsed.imageUrls);
  };

  ws.onclose = (event: CloseEvent) => {
    console.log(`[${ts()}] disconnected (code=${event.code})`);
    console.error(`[${ts()}] disconnected (code=${event.code})`);
    scheduleReconnect(wsUrl, accessToken);
  };

  ws.onerror = () => {};
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const wsUrl = process.env.ONEBOT_WS_URL || "ws://localhost:6700";
  const accessToken = process.env.ONEBOT_ACCESS_TOKEN || "";

  ensureDir(DATA_DIR);
  console.log(`[${ts()}] listen starting`);
  console.log(`[${ts()}] data dir: ${DATA_DIR}`);
  console.log(`[${ts()}] agent ipc socket: ${EVENTS_SOCKET_PATH}`);

  connect(wsUrl, accessToken);

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

  const startTime = Date.now();
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    let fileCount = 0;
    try {
      fileCount = readdirSync(DATA_DIR).filter((f: string) => f.endsWith(".jsonl")).length;
    } catch { /* ignore */ }
    console.error(`[${ts()}] [heartbeat] running, ${elapsed}s elapsed, ${fileCount} files in data/prod/raw/`);
  }, 300_000);

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
