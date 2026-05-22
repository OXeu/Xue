/**
 * tests/listen-image-cache.test.ts — 验证 listen.ts 的图片缓存逻辑
 *
 * 覆盖：图片消息触发缓存、已缓存图片跳过重复下载、fetch 失败静默跳过。
 * 使用临时缓存目录和 mock fetch 确保测试独立可重复。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { cacheEntryImage } from "../src/listen";
import { setCacheDir, hasCache } from "../src/image-cache";

let tmpDir = "";
let originalCacheDir = "";

beforeEach(() => {
  // 创建临时缓存目录
  const base = join(tmpdir(), `rin-listen-cache-test-${randomBytes(4).toString("hex")}`);
  tmpDir = join(base, "test-images");
  mkdirSync(tmpDir, { recursive: true });
  originalCacheDir = setCacheDir(tmpDir);
});

afterEach(() => {
  // 恢复原缓存目录
  if (originalCacheDir) setCacheDir(originalCacheDir);
  // 清理临时目录
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** 生成一张 1x1 像素的 PNG 作为 mock 响应体 */
function pngBuffer(): Buffer {
  // 最小有效 PNG
  const png = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0x60, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x01, 0x27, 0x34, 0x27,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
    0xAE, 0x42, 0x60, 0x82,
  ]);
  return png;
}

// ── 测试 ────────────────────────────────────────────────

test("cacheEntryImage: 图片消息触发缓存写入", async () => {
  const mockImage = pngBuffer();
  const originalFetch = globalThis.fetch;

  // mock fetch 返回一张图片
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(mockImage, {
      headers: { "content-type": "image/png" },
    })),
  );

  try {
    await cacheEntryImage("https://example.com/test.png", "test_group", 1001);

    // 验证缓存文件被创建
    const files = readdirSync(tmpDir);
    const keyFiles = files.filter((f) => f.startsWith("test_group_1001"));
    expect(keyFiles.length).toBeGreaterThan(0);

    // 应该有图片文件和 json 元数据文件
    const hasImage = keyFiles.some((f) => !f.endsWith(".json"));
    const hasMeta = keyFiles.some((f) => f.endsWith(".json"));
    expect(hasImage).toBe(true);
    expect(hasMeta).toBe(true);

    // 验证 hasCache 返回 true
    expect(hasCache("test_group", 1001)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cacheEntryImage: 已缓存图片跳过重复下载", async () => {
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
    // 第一次调用：下载并缓存
    await cacheEntryImage("https://example.com/test.png", "test_group", 1002);
    expect(fetchCount).toBe(1);

    // 第二次调用：应跳过（hasCache 返回 true）
    await cacheEntryImage("https://example.com/test.png", "test_group", 1002);
    expect(fetchCount).toBe(1); // fetch 未被再次调用
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
    // 不应抛出异常
    await cacheEntryImage("https://example.com/fail.png", "test_group", 1003);

    // 不应有缓存文件
    expect(hasCache("test_group", 1003)).toBe(false);
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
    expect(hasCache("test_group", 1004)).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
