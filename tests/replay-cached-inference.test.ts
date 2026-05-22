/**
 * tests/replay-cached-inference.test.ts — 验证 replay.ts 中图片下载失败时的缓存描述兜底逻辑
 *
 * loadCachedInference 从 data/inferences/{session}.jsonl 中查找指定 msgId 的缓存视觉描述。
 * 测试覆盖：有缓存、无缓存、会话不存在三种场景。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

let loadCachedInference: (session: string, msgId: number) => string | null;

const INFERENCES_DIR = resolve(import.meta.dirname, "..", "data", "inferences");

beforeAll(async () => {
  const mod = await import("../src/replay");
  loadCachedInference = mod.loadCachedInference;
});

describe("loadCachedInference", () => {
  const testSession = "unittest_cached_inference";
  const testFilePath = join(INFERENCES_DIR, `${testSession}.jsonl`);

  afterAll(() => {
    try { unlinkSync(testFilePath); } catch { /* ok */ }
  });

  test("会话不存在时返回 null", () => {
    const result = loadCachedInference("nonexistent_session_xyz", 1);
    expect(result).toBeNull();
  });

  test("msgId 不存在时返回 null", () => {
    // 先确保文件存在（空 inference 文件）
    if (!existsSync(INFERENCES_DIR)) mkdirSync(INFERENCES_DIR, { recursive: true });
    writeFileSync(testFilePath, '{"msgId":100,"inference":"test desc"}\n', "utf8");

    const result = loadCachedInference(testSession, 999);
    expect(result).toBeNull();
  });

  test("返回匹配 msgId 的缓存描述", () => {
    writeFileSync(testFilePath, '{"msgId":100,"inference":"A peaceful, misty landscape with a lake"}\n', "utf8");

    const result = loadCachedInference(testSession, 100);
    expect(result).toBe("A peaceful, misty landscape with a lake");
  });

  test("多条记录中正确找到目标 msgId", () => {
    writeFileSync(
      testFilePath,
      [
        '{"msgId":1,"inference":"first"}',
        '{"msgId":2,"inference":"second"}',
        '{"msgId":3,"inference":"third"}',
        "",
      ].join("\n"),
      "utf8",
    );

    expect(loadCachedInference(testSession, 1)).toBe("first");
    expect(loadCachedInference(testSession, 2)).toBe("second");
    expect(loadCachedInference(testSession, 3)).toBe("third");
    expect(loadCachedInference(testSession, 4)).toBeNull();
  });

  test("inference 为 null 时视为无缓存", () => {
    writeFileSync(testFilePath, '{"msgId":100,"inference":null}\n', "utf8");

    const result = loadCachedInference(testSession, 100);
    expect(result).toBeNull();
  });

  test("inference 为空字符串时视为无缓存", () => {
    writeFileSync(testFilePath, '{"msgId":100,"inference":""}\n', "utf8");

    const result = loadCachedInference(testSession, 100);
    expect(result).toBeNull();
  });

  test("损坏的行被静默跳过", () => {
    writeFileSync(
      testFilePath,
      ['not json', '{"msgId":100,"inference":"valid"}', ""].join("\n"),
      "utf8",
    );

    const result = loadCachedInference(testSession, 100);
    expect(result).toBe("valid");
  });
});
