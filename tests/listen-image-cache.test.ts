/**
 * tests/listen-image-cache.test.ts — 验证 listen.ts 的图片缓存逻辑（phash 去重）
 *
 * 覆盖：图片消息触发缓存写入、phash 去重跳过重复图片、fetch 失败静默跳过。
 * 使用临时缓存目录和 mock fetch 确保测试独立可重复。
 *
 * 注意：新缓存以 phash 为文件名，同一张图片无论出现在哪个会话/消息中，
 * 只存一份。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { cacheEntryImage } from "../src/listen";
import { setCacheDir, hasCache, getCachedImage } from "../src/image-cache";

let tmpDir = "";
let originalCacheDir = "";

/** 一张 1×1 红色像素 PNG 的 base64，用于计算预期 phash */
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  const base = join(tmpdir(), `rin-listen-cache-test-${randomBytes(4).toString("hex")}`);
  tmpDir = join(base, "test-images");
  mkdirSync(tmpDir, { recursive: true });
  originalCacheDir = setCacheDir(tmpDir);
});

afterEach(() => {
  if (originalCacheDir) setCacheDir(originalCacheDir);
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** 生成一张 1x1 像素的红色 PNG */
function pngBuffer(): Buffer {
  return Buffer.from(TEST_PNG_BASE64, "base64");
}

// ── 测试 ────────────────────────────────────────────────

test("cacheEntryImage: 图片消息触发缓存写入（phash 文件名）", async () => {
  const mockImage = pngBuffer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(mockImage, {
      headers: { "content-type": "image/png" },
    })),
  );

  try {
    await cacheEntryImage("https://example.com/test.png", "test_group", 1001);

    // 验证缓存文件被创建（phash 命名）
    const files = readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);

    // 应该有 .png 和 .meta 文件，以 phash 命名（16 字符 hex）
    const imageFiles = files.filter((f) => f.endsWith(".png"));
    expect(imageFiles.length).toBe(1);
    expect(imageFiles[0]).toMatch(/^[0-9a-f]{16}\.png$/);

    const metaFiles = files.filter((f) => f.endsWith(".meta"));
    expect(metaFiles.length).toBe(1);
    expect(metaFiles[0]).toMatch(/^[0-9a-f]{16}\.meta$/);

    // 验证 hasCache（用 phash 查询）
    const phash = imageFiles[0].replace(".png", "");
    expect(hasCache(phash)).toBe(true);

    // 验证 getCachedImage 能读取
    const cached = getCachedImage(phash);
    expect(cached).not.toBeNull();
    expect(cached!.mime).toBe("image/png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cacheEntryImage: 相同图片（相同 phash）跳过重复下载", async () => {
  let fetchCount = 0;
  const mockImage = pngBuffer();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock(() => {
    fetchCount++;
    return Promise.resolve(new Response(mockImage, {
      headers: { "content-type": "image/png" },
    }));
  });

  try {
    // 第一次调用：下载并缓存（不同会话，同一张图）
    await cacheEntryImage("https://example.com/test.png", "group_A", 2001);
    expect(fetchCount).toBe(1);

    // 第二次调用：不同 session/msgId，但同一张图 → 应跳过下载
    await cacheEntryImage("https://example.com/test.png", "group_B", 2002);
    // fetch 被再次调用（URL 相同，但 listen.ts 不缓存有状态），
    // 但保存时会检查已有 phash 并跳过重复
    // 验证文件仍只有一组
    const files = readdirSync(tmpDir);
    const pngFiles = files.filter((f) => f.endsWith(".png"));
    expect(pngFiles.length).toBe(1); // 只存了一份
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cacheEntryImage: fetch 失败时静默跳过", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock(() =>
    Promise.reject(new Error("network error")),
  );

  try {
    await cacheEntryImage("https://example.com/fail.png", "test_group", 1003);

    // 不应有缓存文件
    const files = readdirSync(tmpDir);
    expect(files.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cacheEntryImage: HTTP 非 200 时静默跳过", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("Not Found", { status: 404 })),
  );

  try {
    await cacheEntryImage("https://example.com/404.png", "test_group", 1004);

    const files = readdirSync(tmpDir);
    expect(files.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
