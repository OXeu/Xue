/**
 * tests/image-cache.test.ts — image-cache.ts 单元测试（phash 去重）
 *
 * 覆盖：保存、读取、缺失、损坏等边界。使用临时目录。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  saveCachedImage,
  getCachedImage,
  hasCache,
  saveUrlIndex,
  getPhashByUrl,
  getCachedImageByUrl,
  setCacheDir,
} from "../src/image-cache";

let TMP_DIR = "";

beforeEach(() => {
  TMP_DIR = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".test-imgcache-"));
  setCacheDir(TMP_DIR);
});

afterEach(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

const TEST_PHASH = "aabbccdd00112233";

describe("image-cache (phash-based)", () => {
  test("save + getCachedImage 完整来回", () => {
    const b64 = Buffer.from("fake-image-bytes").toString("base64");
    const mime = "image/png";

    saveCachedImage(TEST_PHASH, b64, mime);

    const got = getCachedImage(TEST_PHASH);
    expect(got).not.toBeNull();
    expect(got!.base64).toBe(b64);
    expect(got!.mime).toBe(mime);
  });

  test("保存后文件以 phash 命名", () => {
    const b64 = Buffer.from("test-data").toString("base64");
    saveCachedImage(TEST_PHASH, b64, "image/jpeg");

    // 验证 .jpeg 文件存在
    expect(existsSync(join(TMP_DIR, `${TEST_PHASH}.jpeg`))).toBeTrue();
  });

  test("getCachedImage 缓存不存在 → null", () => {
    expect(getCachedImage("nonexistent")).toBeNull();
  });

  test("hasCache 返回 false 当缓存不存在", () => {
    expect(hasCache("ghost")).toBeFalse();
  });

  test("hasCache 返回 true 当缓存存在", () => {
    saveCachedImage(TEST_PHASH, Buffer.from("x").toString("base64"), "image/png");
    expect(hasCache(TEST_PHASH)).toBeTrue();
  });

  test("不同 mime 类型: image/gif", () => {
    const b64 = Buffer.from("fake-gif").toString("base64");
    saveCachedImage("gif001", b64, "image/gif");
    const got = getCachedImage("gif001");
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/gif");
    expect(existsSync(join(TMP_DIR, "gif001.gif"))).toBeTrue();
  });

  test("不同 mime 类型: image/webp", () => {
    const b64 = Buffer.from("fake-webp").toString("base64");
    saveCachedImage("webp001", b64, "image/webp");
    const got = getCachedImage("webp001");
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/webp");
    expect(existsSync(join(TMP_DIR, "webp001.webp"))).toBeTrue();
  });

  test("重复保存相同 phash → 不覆盖（去重）", () => {
    const origB64 = Buffer.from("original").toString("base64");
    saveCachedImage(TEST_PHASH, origB64, "image/png");

    // 再次保存相同 phash（不同数据，同 mime）
    const newB64 = Buffer.from("different").toString("base64");
    saveCachedImage(TEST_PHASH, newB64, "image/png");

    // 应保留原数据（去重，不覆盖）
    const got = getCachedImage(TEST_PHASH);
    expect(got!.base64).toBe(origB64);
    expect(got!.mime).toBe("image/png");
  });

  test("空 phash 静默跳过不创建文件", async () => {
    saveCachedImage("", Buffer.from("x").toString("base64"), "image/png");
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(TMP_DIR);
    expect(files.length).toBe(0);
  });

  test("setCacheDir 重置后读写新目录", () => {
    const tmp2 = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".test-imgcache2-"));
    try {
      const old = setCacheDir(tmp2);
      expect(old).toBe(TMP_DIR);

      const b64 = Buffer.from("new-dir").toString("base64");
      saveCachedImage("newdir001", b64, "image/jpeg");

      expect(getCachedImage("newdir001")).not.toBeNull();
      // 原目录不应有该文件
      expect(existsSync(join(TMP_DIR, "newdir001.jpeg"))).toBeFalse();
    } finally {
      try { rmSync(tmp2, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── URL → phash 索引 ───────────────────────────────────

describe("URL→phash index", () => {
  const URL_A = "https://example.com/img1.jpg";
  const URL_B = "https://example.com/img2.png";
  const PHASH_A = "aaaabbbbccccdddd";
  const PHASH_B = "eeeeffff00001111";
  const PHASH_A2 = "aaaabbbbccccdddd_v2";

  test("saveUrlIndex 写入后 getPhashByUrl 返回对应 phash", () => {
    saveUrlIndex(URL_A, PHASH_A);
    const got = getPhashByUrl(URL_A);
    expect(got).toBe(PHASH_A);
  });

  test("同一个 URL 多次写入，返回最新那条", () => {
    saveUrlIndex(URL_A, PHASH_A);
    saveUrlIndex(URL_A, PHASH_A2);
    const got = getPhashByUrl(URL_A);
    // 最新的是 phash_A2（倒序扫描）
    expect(got).toBe(PHASH_A2);
  });

  test("多条 URL 各自正确映射", () => {
    saveUrlIndex(URL_A, PHASH_A);
    saveUrlIndex(URL_B, PHASH_B);
    expect(getPhashByUrl(URL_A)).toBe(PHASH_A);
    expect(getPhashByUrl(URL_B)).toBe(PHASH_B);
  });

  test("索引文件中没有匹配 URL 时返回 null", () => {
    saveUrlIndex(URL_A, PHASH_A);
    expect(getPhashByUrl("https://unknown.example.com/nope.jpg")).toBeNull();
  });

  test("索引文件不存在时返回 null（优雅降级）", () => {
    // 新建临时目录（尚未写入任何索引）
    // beforeEach 已经创建了 TMP_DIR，但没写入过 URL 索引
    // 换个不存在的 URL
    expect(getPhashByUrl("https://ghost.example.com/img.jpg")).toBeNull();
  });

  test("getCachedImageByUrl 完整链路：索引命中 + 缓存存在 → 返回图片", () => {
    const b64 = Buffer.from("real-image-data").toString("base64");
    const mime = "image/png";
    saveCachedImage(PHASH_A, b64, mime);
    saveUrlIndex(URL_A, PHASH_A);

    const result = getCachedImageByUrl(URL_A);
    expect(result).not.toBeNull();
    expect(result!.base64).toBe(b64);
    expect(result!.mime).toBe(mime);
  });

  test("索引命中但缓存文件已被删除 → 返回 null", () => {
    saveUrlIndex(URL_A, PHASH_A);

    // 不保存图片缓存文件，只有索引 → getCachedImage 返回 null
    const result = getCachedImageByUrl(URL_A);
    expect(result).toBeNull();
  });

  test("空 URL 返回 null（安全防护）", () => {
    expect(getPhashByUrl("")).toBeNull();
    expect(getCachedImageByUrl("")).toBeNull();
  });

  test("空 phash 写入不报错（静默跳过）", () => {
    // 不应抛出异常
    saveUrlIndex(URL_A, "");
    // 不应写入
    expect(getPhashByUrl(URL_A)).toBeNull();
  });
});
