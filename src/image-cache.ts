/**
 * image-cache.ts — 图片缓存管理
 *
 * 将从 CDN 下载的图片和描述元数据持久化到 data/images/，
 * 供 infer-stickers 和 replay 时复用，避免重复下载或重复调用视觉模型。
 *
 * 缓存文件:
 *   {session}_{msgId}.{ext}       — 图片文件
 *   {session}_{msgId}.json        — 描述元数据
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

let CACHE_DIR = resolve(import.meta.dirname, "../data/images");

/** 重设缓存目录（供测试使用）。返回旧目录以便恢复。 */
export function setCacheDir(dir: string): string {
  const old = CACHE_DIR;
  CACHE_DIR = dir;
  return old;
}

export interface CachedImage {
  description: string;
  mime: string;
  /** 原始来源 URL（用于溯源） */
  sourceUrl?: string;
}

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** 缓存键：{session}_{msgId}，如 group_313214094_1026175895 */
export function cacheKey(session: string, msgId: number): string {
  return `${session}_${msgId}`;
}

/** 读取缓存的图片描述，没有则返回 null */
export function getCachedDescription(session: string, msgId: number): string | null {
  const key = cacheKey(session, msgId);
  const jsonPath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf8")) as CachedImage;
    return data.description || null;
  } catch {
    return null;
  }
}

/** 读取缓存的图片 base64 + mime，没有则返回 null */
export function getCachedImage(
  session: string,
  msgId: number,
): { base64: string; mime: string } | null {
  const key = cacheKey(session, msgId);
  const jsonPath = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf8")) as CachedImage;
    const ext = data.mime.split("/")[1] || "jpg";
    const imgPath = join(CACHE_DIR, `${key}.${ext}`);
    if (!existsSync(imgPath)) return null;
    const base64 = readFileSync(imgPath, "base64");
    return { base64, mime: data.mime };
  } catch {
    return null;
  }
}

/** 保存图片 + 描述到缓存 */
export function saveCachedImage(
  session: string,
  msgId: number,
  base64: string,
  mime: string,
  description: string,
  sourceUrl?: string,
): void {
  ensureDir();
  const key = cacheKey(session, msgId);
  const ext = mime.split("/")[1] || "jpg";

  // 写图片文件（二进制）
  const imgPath = join(CACHE_DIR, `${key}.${ext}`);
  writeFileSync(imgPath, Buffer.from(base64, "base64"));

  // 写描述元数据
  const meta: CachedImage = { description, mime };
  if (sourceUrl) meta.sourceUrl = sourceUrl;
  const jsonPath = join(CACHE_DIR, `${key}.json`);
  writeFileSync(jsonPath, JSON.stringify(meta, null, 2), "utf8");
}

/** 检查某条消息是否有缓存 */
export function hasCache(session: string, msgId: number): boolean {
  return getCachedDescription(session, msgId) !== null;
}

/** 列出所有缓存的 key */
export function listCachedKeys(): string[] {
  if (!existsSync(CACHE_DIR)) return [];
  const files = readdirSync(CACHE_DIR);
  const keys = new Set<string>();
  for (const f of files) {
    const key = f.replace(/\.(json|jpg|jpeg|png|gif|webp)$/, "");
    if (key !== f) keys.add(key);
  }
  return [...keys];
}
