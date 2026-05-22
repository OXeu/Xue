/**
 * image-cache.ts — 图片缓存管理（基于 phash）
 *
 * 将从 CDN 下载的图片持久化到 data/prod/images/，以 phash 为文件名。
 * 不存储 URL 或描述文本——描述由 agent 按需调用视觉模型生成，运行时保存在内存中。
 *
 * 缓存文件:
 *   data/prod/images/{phash}.{ext}   — 图片文件
 *
 * 文件名即 phash，天然去重。同一张图片无论出现在哪个会话/消息中，
 * 只存一份。mime 类型从扩展名推断。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

let CACHE_DIR = resolve(import.meta.dirname, "../data/prod/images");

/** 重设缓存目录（供测试使用）。返回旧目录以便恢复。 */
export function setCacheDir(dir: string): string {
  const old = CACHE_DIR;
  CACHE_DIR = dir;
  return old;
}

export interface CachedImage {
  base64: string;
  mime: string;
}

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ── phash 索引 ──────────────────────────────────────────

/** URL → phash 索引文件路径。JSONL 格式，每行 { url, phash }。 */
const _URL_INDEX_PATH = () => join(CACHE_DIR, "_url_index.jsonl");

/** 对图片 URL 做 SHA-256 摘要，用作索引查找 key。 */
function _urlKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** 记录 URL → phash 映射。不阻塞，静默失败。 */
export function saveUrlIndex(url: string, phash: string): void {
  if (!url || !phash) return;
  try {
    ensureDir();
    const key = _urlKey(url);
    appendFileSync(_URL_INDEX_PATH(), JSON.stringify({ key, phash, url }) + "\n", "utf8");
  } catch { /* silent */ }
}

/** 根据 URL 查找对应的 phash。遍历索引文件（通常很小）。失败返回 null。 */
export function getPhashByUrl(url: string): string | null {
  if (!url) return null;
  const key = _urlKey(url);
  const idxPath = _URL_INDEX_PATH();
  if (!existsSync(idxPath)) return null;
  try {
    const lines = readFileSync(idxPath, "utf8").trim().split("\n").filter(Boolean);
    // 从后往前扫描（最新的优先），匹配 key 即返回
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as { key: string; phash: string };
        if (entry.key === key) return entry.phash;
      } catch { /* skip corrupt */ }
    }
  } catch { /* silent */ }
  return null;
}

/** 通过 URL 查找本地缓存图片。先查 URL→phash 索引，再取文件。 */
export function getCachedImageByUrl(url: string): CachedImage | null {
  const phash = getPhashByUrl(url);
  if (!phash) return null;
  return getCachedImage(phash);
}

// ── phash 缓存 ──────────────────────────────────────────
export function getCachedImage(phash: string): CachedImage | null {
  if (!phash) return null;
  const candidates = ["jpeg", "jpg", "png", "gif", "webp"];
  for (const ext of candidates) {
    const imgPath = join(CACHE_DIR, `${phash}.${ext}`);
    if (existsSync(imgPath)) {
      const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
      const base64 = readFileSync(imgPath, "base64");
      return { base64, mime };
    }
  }
  return null;
}

/** 保存图片到缓存（key = phash）。已存在则静默跳过（天然去重）。 */
export function saveCachedImage(phash: string, base64: string, mime: string): void {
  if (!phash) return;
  ensureDir();
  const ext = mime.split("/")[1] || "jpg";
  const imgPath = join(CACHE_DIR, `${phash}.${ext}`);
  if (existsSync(imgPath)) return; // 已缓存，去重

  writeFileSync(imgPath, Buffer.from(base64, "base64"));
}

/** 检查某 phash 是否有缓存。 */
export function hasCache(phash: string): boolean {
  if (!phash) return false;
  const candidates = ["jpeg", "jpg", "png", "gif", "webp"];
  for (const ext of candidates) {
    if (existsSync(join(CACHE_DIR, `${phash}.${ext}`))) return true;
  }
  return false;
}
