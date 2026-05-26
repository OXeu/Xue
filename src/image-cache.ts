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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
