/**
 * image-cache.test.ts — image-cache 单元测试
 *
 * runner: bun:test
 * 不调网络/视觉模型，只测文件 IO 和缓存逻辑。
 * 测试在临时目录中运行，完成后清理。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setCacheDir,
  saveCachedImage,
  getCachedDescription,
  getCachedImage,
  hasCache,
  cacheKey,
} from "../src/image-cache";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TMP_DIR = resolve(import.meta.dirname, "../.test-cache-" + Date.now());
let oldCacheDir: string;

beforeAll(() => {
  // 切换到临时目录，存下旧路径以便后续恢复
  oldCacheDir = setCacheDir(TMP_DIR);
});

afterAll(() => {
  // 恢复旧目录，清理临时文件
  setCacheDir(oldCacheDir);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("image-cache", () => {
  // ── 基础读写 ──

  test("save + getCachedDescription 完整来回", () => {
    const session = "test_session";
    const msgId = 10001;
    const desc = "A red apple on a wooden table.";
    const mime = "image/jpeg";
    const b64 = Buffer.from("fake-jpeg-data").toString("base64");

    saveCachedImage(session, msgId, b64, mime, desc);

    const got = getCachedDescription(session, msgId);
    expect(got).toBe(desc);
  });

  test("getCachedImage 返回正确的 base64 和 mime", () => {
    const session = "test_session";
    const msgId = 10001; // 复用上一用例写入的文件
    const result = getCachedImage(session, msgId);

    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/jpeg");
    expect(result!.base64).toBe(Buffer.from("fake-jpeg-data").toString("base64"));
  });

  test("save 时记录 sourceUrl", () => {
    const session = "test_url";
    const msgId = 20001;
    const desc = "Mountains at sunset.";
    const mime = "image/png";
    const b64 = Buffer.from("png-data").toString("base64");
    const url = "https://example.com/photo.png";

    saveCachedImage(session, msgId, b64, mime, desc, url);

    const jsonPath = join(TMP_DIR, `${cacheKey(session, msgId)}.json`);
    const meta = JSON.parse(require("fs").readFileSync(jsonPath, "utf8"));
    expect(meta.sourceUrl).toBe(url);
    expect(meta.description).toBe(desc);
    expect(meta.mime).toBe("image/png");
  });

  // ── 缓存不存在 ──

  test("getCachedDescription 缓存不存在 → null", () => {
    expect(getCachedDescription("ghost", 99999)).toBeNull();
  });

  test("getCachedImage 缓存不存在 → null", () => {
    expect(getCachedImage("ghost", 99999)).toBeNull();
  });

  test("hasCache 返回 false 当缓存不存在", () => {
    expect(hasCache("ghost", 99999)).toBeFalse();
  });

  test("hasCache 返回 true 当缓存存在", () => {
    expect(hasCache("test_session", 10001)).toBeTrue();
  });

  // ── 文件损坏 / 异常 ──

  test("JSON 文件损坏（非 JSON）→ 返回 null", () => {
    const key = cacheKey("corrupt", 30001);
    const jsonPath = join(TMP_DIR, `${key}.json`);
    writeFileSync(jsonPath, "这不是有效 json", "utf8");

    expect(getCachedDescription("corrupt", 30001)).toBeNull();
    expect(getCachedImage("corrupt", 30001)).toBeNull();
  });

  test("JSON 存在但图片文件缺失 → getCachedImage 返回 null", () => {
    const session = "missing_img";
    const msgId = 40001;
    const jsonPath = join(TMP_DIR, `${cacheKey(session, msgId)}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify({ description: "desc", mime: "image/jpeg" }),
      "utf8",
    );

    // 描述可读（JSON 有效）
    expect(getCachedDescription(session, msgId)).toBe("desc");
    // 图片文件不存在 → null
    expect(getCachedImage(session, msgId)).toBeNull();
  });

  test("JSON 中 description 字段为空字符串 → 返回 null", () => {
    const session = "empty_desc";
    const msgId = 50001;
    const jsonPath = join(TMP_DIR, `${cacheKey(session, msgId)}.json`);
    writeFileSync(
      jsonPath,
      JSON.stringify({ description: "", mime: "image/jpeg" }),
      "utf8",
    );

    expect(getCachedDescription(session, msgId)).toBeNull();
  });

  // ── 自动创建目录 ──

  test("写入时自动创建缓存目录", () => {
    const nestedDir = join(TMP_DIR, "../.test-cache-nested-" + Date.now());
    // 确保目录不存在
    try { rmSync(nestedDir, { recursive: true, force: true }); } catch {}
    expect(existsSync(nestedDir)).toBeFalse();

    const oldDir = setCacheDir(nestedDir);
    try {
      saveCachedImage("auto", 60001, "AAAA", "image/png", "auto-created dir");
      expect(existsSync(nestedDir)).toBeTrue();
      expect(getCachedDescription("auto", 60001)).toBe("auto-created dir");
    } finally {
      setCacheDir(oldDir);
      try { rmSync(nestedDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ── cacheKey ──

  test("cacheKey 格式正确", () => {
    expect(cacheKey("group_123", 456)).toBe("group_123_456");
    expect(cacheKey("private_1", 0)).toBe("private_1_0");
    expect(cacheKey("test", 999999999)).toBe("test_999999999");
  });
});
