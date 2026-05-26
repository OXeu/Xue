/**
 * agent/context.ts — 上下文构建、图片解析、消息合并
 *
 * 从 agent.ts 拆出。
 */

import { resolve } from "node:path";
import { loadRecentMessages } from "../chat-utils";
import { getCachedImage } from "../image-cache";
import type { ListenEntry } from "../shared/types";

const IMAGE_ENTRY_WAIT_MS = 50;
const IMAGE_ENTRY_MAX_POLLS = 8;

let RAW_DIR = resolve(import.meta.dirname, "../../data/prod/raw");

/** 重设 RAW_DIR（供测试使用）。返回旧目录。 */
export function __setRawDirForTest(dir: string): string {
  const old = RAW_DIR;
  RAW_DIR = dir;
  return old;
}

/** 构建可读的上下文文本。图片消息显示 [图片] 标记。 */
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

/** 将当前消息合并到 recent 列表，避免重复。 */
export function mergeCurrentEntryIntoRecent(
  recent: ListenEntry[],
  currentEntry: ListenEntry,
  persistedEntry: ListenEntry | null,
): ListenEntry[] {
  const mergedCurrent = persistedEntry ?? currentEntry;
  const index = recent.findIndex((entry) => entry.msgId === currentEntry.msgId);

  if (index === -1) {
    return [...recent, mergedCurrent];
  }

  if (!persistedEntry) {
    return recent;
  }

  const next = recent.slice();
  next[index] = persistedEntry;
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPersistedImageEntry(recent: ListenEntry[], msgId: number): ListenEntry | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i]?.msgId === msgId) return recent[i];
  }
  return null;
}

/**
 * 加载上下文并等待当前消息落盘（图片 phash 填充完成）。
 * 在新架构中，事件在写入 events 前已确保 phash 填充，
 * 但保留此函数以保证健壮性。
 */
export async function loadRecentWithPersistedImage(
  sessionId: string,
  msgId: number,
  expectImage: boolean,
): Promise<{ recent: ListenEntry[]; persistedEntry: ListenEntry | null }> {
  let recent = loadRecentMessages(RAW_DIR, sessionId, 30);
  let persistedEntry = getPersistedImageEntry(recent, msgId);

  for (let i = 0; i < IMAGE_ENTRY_MAX_POLLS; i++) {
    if (persistedEntry && (!expectImage || persistedEntry.phash?.[0])) {
      return { recent, persistedEntry };
    }
    await sleep(IMAGE_ENTRY_WAIT_MS);
    recent = loadRecentMessages(RAW_DIR, sessionId, 30);
    persistedEntry = getPersistedImageEntry(recent, msgId);
  }

  return { recent, persistedEntry };
}

/** 从已落盘的事件中解析图片缓存数据。 */
export async function resolveMessageImage(
  persistedEntry: ListenEntry | null,
): Promise<{ downloaded: { base64: string; mime: string } | null; phash: string | null }> {
  if (persistedEntry?.phash?.[0]) {
    const cached = getCachedImage(persistedEntry.phash[0]);
    if (cached) {
      return { downloaded: cached, phash: persistedEntry.phash[0] };
    }
  }
  return { downloaded: null, phash: null };
}

/** 构造展示文本：带图片时追加 [图片] 标记。 */
export function buildDisplayText(cleanText: string, hasImage: boolean, phash: string | null): string {
  if (phash) return `${cleanText} [图片#${phash}]`;
  if (hasImage) return `${cleanText} [图片]`;
  return cleanText;
}
