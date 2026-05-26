/**
 * shared/events.ts — listen -> agent 进程间实时事件通道
 *
 * 使用本地 Unix Socket 传递处理后的 ListenEntry，避免文件轮询。
 * 协议为 JSONL：每行一个 ListenEntry。
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { ListenEntry } from "./types";

export const IPC_DIR = resolve(import.meta.dirname, "../../data/ipc");
export const EVENTS_SOCKET_PATH = resolve(IPC_DIR, "agent-events.sock");

function ensureIpcDir(): void {
  if (!existsSync(IPC_DIR)) {
    mkdirSync(IPC_DIR, { recursive: true });
  }
}

/** 启动 agent 侧的 Unix Socket 事件服务器。 */
export function startEventServer(onEvent: (entry: ListenEntry) => void | Promise<void>): Server {
  ensureIpcDir();
  if (existsSync(EVENTS_SOCKET_PATH)) {
    try {
      unlinkSync(EVENTS_SOCKET_PATH);
    } catch {
      // ignore stale socket cleanup failure
    }
  }

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          void onEvent(JSON.parse(line) as ListenEntry);
        } catch {
          // skip malformed payloads
        }
      }
    });
  });

  server.listen(EVENTS_SOCKET_PATH);
  return server;
}

/** listen 侧发送一条事件；agent 未启动时静默失败。 */
export function sendEvent(entry: ListenEntry): Promise<void> {
  ensureIpcDir();
  return new Promise((resolve) => {
    const socket: Socket = createConnection(EVENTS_SOCKET_PATH);
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    socket.on("connect", () => {
      socket.end(JSON.stringify(entry) + "\n");
    });
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("end", finish);
  });
}
