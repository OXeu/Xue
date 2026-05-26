/**
 * agent/main.ts — Agent 主循环
 *
 * 从 shared/events Unix Socket 接收处理后事件，驱动 runAgentTurn，
 * 通过 onebot 发送连接输出回复。
 *
 * 不再连接 OneBot 接收消息。
 */

import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startEventServer, EVENTS_SOCKET_PATH } from "../shared/events";
import type { ListenEntry } from "../shared/types";
import { runAgentTurn } from "./engine";
import { connectSender, sendGroupMsg, sendPrivateMsg } from "./onebot";
import { getBotQQ, getBotName, getDryRun, canReplyReal } from "./config";

// ── 配置 ──────────────────────────────────────────────

const RAW_DIR = resolve(import.meta.dirname, "../../data/prod/raw");
const BOT_QQ = getBotQQ();
const BOT_NAME = getBotName();

let eventServer: ReturnType<typeof startEventServer> | null = null;
let handleQueue: Promise<void> = Promise.resolve();

// ── 日志 ──────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] [agent] ${msg}`);
}

function sessionLogPath(sessionId: string): string {
  return resolve(RAW_DIR, `${sessionId}.jsonl`);
}

function appendAgentReplyEntry(entry: ListenEntry): void {
  try {
    appendFileSync(sessionLogPath(entry.session), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // ignore raw log write failure
  }
}

// ── 事件处理 ──────────────────────────────────────────

async function handleEvent(entry: ListenEntry): Promise<void> {
  // 跳过 bot 自己的消息
  if (entry.userId === BOT_QQ || entry.selfId === entry.userId) return;

  const sessionId = entry.session;
  const isPrivate = sessionId.startsWith("private_");
  const cleanText = entry.text;
  const senderName = entry.card || entry.nickname;

  log(`[msg-diagnose] session=${sessionId} userId=${entry.userId} atSelf=${entry.atUsers.includes(BOT_QQ)} hasImage=${entry.segmentTypes?.includes("image")} textLen=${cleanText.length}`);

  const replyHandler = async (reply: string): Promise<void> => {
    if (!canReplyReal(entry.session)) {
      log(`[dry-run] would reply to ${sessionId}: ${reply.slice(0, 200)}`);
      return;
    }
    if (isPrivate) {
      sendPrivateMsg(entry.userId, reply);
      return;
    }
    // 从 sessionId 中提取 group_id: "group_12345" → 12345
    const groupId = Number(sessionId.replace("group_", ""));
    if (!isNaN(groupId)) {
      sendGroupMsg(groupId, reply);
    }
  };

  const turn = await runAgentTurn(entry, {
    isPrivate,
    rawMessage: entry.text,
    onReply: replyHandler,
    logger: log,
  });

  if (turn.reply) {
    appendAgentReplyEntry({
      session: sessionId,
      msgId: -Date.now(),
      time: Math.floor(Date.now() / 1000),
      type: "text",
      text: turn.reply,
      userId: BOT_QQ,
      nickname: BOT_NAME,
      card: BOT_NAME,
      senderRole: "bot",
      subType: "normal",
      selfId: BOT_QQ,
      atUsers: [],
      atAll: false,
      segmentTypes: ["text"],
    });
  }
}

function startEventReceiver(): void {
  if (eventServer) return;
  eventServer = startEventServer((entry) => {
    handleQueue = handleQueue.then(async () => {
      try {
        await handleEvent(entry);
      } catch (err) {
        log(`error processing event ${entry.msgId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });
}

function stopEventReceiver(): void {
  if (!eventServer) return;
  try {
    eventServer.close();
  } catch {
    // ignore close failure
  }
  eventServer = null;
}

// ── Main ──────────────────────────────────────────────

export function main(): void {
  const LLM_API_KEY = process.env.LLM_API_KEY || "";
  if (!LLM_API_KEY) {
    log("LLM_API_KEY 未设置，视觉功能依赖本地 Ollama 时可能正常工作");
  }

  if (!existsSync(RAW_DIR)) {
    log(`data/prod/raw 不存在，请先运行监听器采集数据`);
  } else {
    try {
      const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
      log(`data/prod/raw 中有 ${files.length} 个会话文件`);
    } catch {
      // 可能不存在
    }
  }

  log(`dry-run=${getDryRun()}（${getDryRun() ? "仅模拟，不会实际发送消息" : "会实际发送消息到群聊"}）`);

  if (process.env.VISION_MODEL) {
    log(`vision: ${process.env.VISION_MODEL} @ ${process.env.VISION_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1"}`);
  } else {
    log("vision: disabled (no model configured)");
  }

  log(`event receiver: ${EVENTS_SOCKET_PATH}`);

  // 建立发送连接
  connectSender();

  // 启动 Unix Socket 事件接收器
  startEventReceiver();

  process.on("SIGINT", () => { log("shutting down"); stopEventReceiver(); process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); stopEventReceiver(); process.exit(0); });
}

const isDirectRun = import.meta.path === Bun.main;
if (isDirectRun && !process.env.RIN_TEST) {
  main();
}
