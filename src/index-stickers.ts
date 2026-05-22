/**
 * index-stickers.ts — 从 data/raw/ 扫描消息，提取表情包/图片消息并建立索引。
 *
 * 索引文件（data/stickers/{session}.jsonl）每条记录只存：
 * - 消息 ID、会话、发送者、类型（image/face）、内容（URL 或 face ID）
 * - 不含上下文——context 在需要时通过 getStickerContext() 从 data/raw/ 反查
 *
 * 用法:
 *   bun run src/index-stickers.ts                     # 全量索引
 *   SESSION=group_313214094 bun run src/index-stickers.ts  # 只索引指定会话
 *
 * 运行多次是安全的：只追加新条目，不会重复已有的 msgId。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const RAW_DIR = resolve(import.meta.dirname, "../data/raw");
const STICKERS_DIR = resolve(import.meta.dirname, "../data/stickers");

export interface RawEntry {
  session: string;
  msgId: number;
  time: number;
  type: string;
  text: string;
  userId: number;
  nickname: string;
  card?: string;
  segmentTypes: string[];
  imageUrls?: string[];
  raw_message: string;
}

export interface StickerEntry {
  msgId: number;
  time: number;
  session: string;
  userId: number;
  nickname: string;
  card?: string;
  type: "image" | "face";
  /** 图片 URL 或 face ID（如 "123"）。 */
  content: string;
  text: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadExistingIds(session: string, stickersDir?: string): Set<number> {
  const dir = stickersDir || STICKERS_DIR;
  const path = join(dir, `${session}.jsonl`);
  if (!existsSync(path)) return new Set();
  const ids = new Set<number>();
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as StickerEntry;
      ids.add(entry.msgId);
    } catch { /* skip malformed lines */ }
  }
  return ids;
}

/** 从 CQ 码中提取 face ID */
export function parseFaceId(raw: string): string | null {
  const m = raw.match(/\[CQ:face,id=(\d+)\]/);
  return m ? m[1] : null;
}

/** 判断一条消息是否包含表情/图片（需要索引的） */
export function isStickerCandidate(e: RawEntry): boolean {
  if (e.segmentTypes.includes("image") && e.imageUrls && e.imageUrls.length > 0) return true;
  if (e.segmentTypes.includes("face")) return true;
  // 也检查 raw_message 中是否有 CQ:image（兼容 segmentTypes 未记录的情况）
  if (/\[CQ:image/.test(e.raw_message)) return true;
  return false;
}

/** 为一条消息提取 sticker 内容 */
export function extractContent(e: RawEntry): { type: "image" | "face"; content: string } | null {
  if (e.imageUrls && e.imageUrls.length > 0) {
    return { type: "image", content: e.imageUrls[0] };
  }
  const faceId = parseFaceId(e.raw_message);
  if (faceId) {
    return { type: "face", content: faceId };
  }
  // 可能是 image 但没提取到 URL，尝试从 raw_message 提取
  const urlMatch = e.raw_message.match(/\[CQ:image,.*?url=([^,\]]*)/);
  if (urlMatch) {
    return { type: "image", content: decodeURIComponent(urlMatch[1]) };
  }
  return null;
}

/**
 * 索引一个会话的表情包消息。
 * @param options.rawDir 覆盖 raw 目录（默认 data/raw）
 * @param options.stickersDir 覆盖 stickers 目录（默认 data/stickers）
 */
export function indexSession(
  session: string,
  options?: { rawDir?: string; stickersDir?: string },
): { newCount: number; existingCount: number } {
  const rawDir = options?.rawDir || RAW_DIR;
  const stickersDir = options?.stickersDir || STICKERS_DIR;
  ensureDir(stickersDir);
  const rawPath = join(rawDir, `${session}.jsonl`);
  if (!existsSync(rawPath)) {
    return { newCount: 0, existingCount: 0 };
  }

  const lines = readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean);
  const entries: RawEntry[] = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l) as RawEntry);
    } catch { /* skip corrupt lines */ }
  }
  entries.sort((a, b) => a.time - b.time);

  const existing = loadExistingIds(session, stickersDir);
  let newCount = 0;
  const stickerPath = join(stickersDir, `${session}.jsonl`);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isStickerCandidate(e)) continue;
    if (existing.has(e.msgId)) continue;

    const extracted = extractContent(e);
    if (!extracted) continue;

    const sticker: StickerEntry = {
      msgId: e.msgId,
      time: e.time,
      session,
      userId: e.userId,
      nickname: e.nickname,
      card: e.card,
      type: extracted.type,
      content: extracted.content,
      text: e.text,
    };

    appendFileSync(stickerPath, JSON.stringify(sticker) + "\n", "utf8");
    newCount++;
  }

  console.log(`  ${session}: ${newCount} new stickers (${existing.size} already indexed)`);
  return { newCount, existingCount: existing.size };
}

/**
 * 从 data/raw/ 反查一条表情消息的上下文。
 *
 * @param msgId 消息 ID
 * @param session 会话标识
 * @param windowSize 前后各取多少条（默认 3）
 * @returns 上下文消息列表（不含自己），按时间排序
 */
export function getStickerContext(
  msgId: number,
  session: string,
  windowSize = 3,
  options?: { rawDir?: string },
): { time: number; nickname: string; text: string }[] {
  const rawDir = options?.rawDir || RAW_DIR;
  const rawPath = join(rawDir, `${session}.jsonl`);
  if (!existsSync(rawPath)) return [];

  const lines = readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean);
  const entries: RawEntry[] = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l) as RawEntry);
    } catch { /* skip corrupt lines */ }
  }
  entries.sort((a, b) => a.time - b.time);

  const idx = entries.findIndex((e) => e.msgId === msgId);
  if (idx === -1) return [];

  const start = Math.max(0, idx - windowSize);
  const end = Math.min(entries.length, idx + windowSize + 1);

  return entries.slice(start, end)
    .filter((c) => c.msgId !== msgId)
    .map((c) => ({
      time: c.time,
      nickname: c.nickname,
      text: c.text.slice(0, 200),
    }));
}

function main(): void {
  ensureDir(STICKERS_DIR);

  const target = process.env.SESSION;

  if (target) {
    console.log(`Indexing stickers for session: ${target}`);
    indexSession(target);
  } else {
    if (!existsSync(RAW_DIR)) {
      console.log("data/raw/ does not exist, nothing to index.");
      return;
    }
    const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
    console.log(`Found ${files.length} session files in data/raw/`);
    for (const f of files) {
      const session = f.replace(/\.jsonl$/, "");
      indexSession(session);
    }
  }

  const stickerFiles = existsSync(STICKERS_DIR)
    ? readdirSync(STICKERS_DIR).filter((f) => f.endsWith(".jsonl"))
    : [];
  console.log(`\nDone. ${stickerFiles.length} session(s) have sticker indexes in data/stickers/`);
}

main();
