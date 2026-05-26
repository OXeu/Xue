/**
 * agent/onebot.ts — OneBot 消息发送连接（仅发送，不接收消息）
 *
 * agent 不再监听 OneBot 消息流。此模块维护一个独立的 WS 连接
 * 仅用于发送 action（send_group_msg / send_private_msg）。
 */

const WS_URL = process.env.ONEBOT_WS_URL || "ws://localhost:6700";
const ACCESS_TOKEN = process.env.ONEBOT_ACCESS_TOKEN || "";

let ws: WebSocket | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] [agent-sender] ${msg}`);
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(delay * 2, 30_000);
  log(`reconnecting sender in ${delay}ms ...`);
  reconnectTimer = setTimeout(connectSender, delay);
}

/** 建立或重连发送 WS。只发送 action，不处理 message 事件。 */
export function connectSender(): void {
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

  log(`connecting sender to ${finalUrl}`);
  ws = new WebSocket(finalUrl);

  ws.onopen = () => {
    log("sender connected");
    reconnectDelay = 1_000;
  };

  // 不处理 message 事件——只发送，不接收
  ws.onmessage = () => {};

  ws.onclose = (event: CloseEvent) => {
    log(`sender disconnected (code=${event.code})`);
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

/** 发送群消息。连接断开时静默失败。 */
export function sendGroupMsg(groupId: number, message: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("sender not connected, cannot send");
    return;
  }
  const payload = JSON.stringify({
    action: "send_group_msg",
    params: { group_id: groupId, message },
  });
  ws.send(payload);
}

/** 发送私聊消息。连接断开时静默失败。 */
export function sendPrivateMsg(userId: number, message: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("sender not connected, cannot send");
    return;
  }
  const payload = JSON.stringify({
    action: "send_private_msg",
    params: { user_id: userId, message },
  });
  ws.send(payload);
}

/** 检查发送连接状态。 */
export function isSenderConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
