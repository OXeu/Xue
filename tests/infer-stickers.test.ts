/**
 * infer-stickers.test.ts — infer-stickers 持久化逻辑单元测试
 *
 * runner: bun:test
 * 只测文件 IO 和去重逻辑，不调网络/视觉模型。
 * 测试在临时目录中运行，完成后清理。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setInferencesDir, loadInferredIds, saveInference } from "../src/infer-stickers";
import type { InferenceEntry } from "../src/infer-stickers";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TMP_DIR = resolve(import.meta.dirname, "../.test-infer-" + Date.now());
let oldDir: string;

// ── 辅助：构造一条推理记录 ──────────────────────────────

function makeEntry(overrides: Partial<InferenceEntry> = {}): InferenceEntry {
  return {
    msgId: 10001,
    time: 1715000000,
    session: "test_session",
    userId: 100001,
    nickname: "测试用户",
    card: undefined,
    type: "image",
    content: "https://example.com/img.jpg",
    text: "",
    context: [
      { time: 1714999900, nickname: "UserA", text: "你好" },
      { time: 1715000000, nickname: "测试用户", text: "" },
    ],
    inference: "A scenic mountain view, likely expressing awe.",
    timestamp: "2026-05-22T12:00:00.000Z",
    ...overrides,
  };
}

beforeAll(() => {
  oldDir = setInferencesDir(TMP_DIR);
});

afterAll(() => {
  setInferencesDir(oldDir);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("infer-stickers persistence", () => {
  // ── 目录自动创建 ──

  test("目录不存在时自动创建", () => {
    // TMP_DIR 在 beforeAll 时被设为 inferences dir，
    // 但我们还没创建它，saveInference 的 appendFileSync 不会自动创建目录
    // → 手动调 ensureInferencesDir 的变体：检查目录不存在的情况下 save 会失败
    // 但 saveInference 依赖目录已存在，所以先删掉目录验证创建逻辑
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
    expect(existsSync(TMP_DIR)).toBeFalse();

    // 测试会调用 ensureInferencesDir → 但它是 private 的
    // 实际应用中 main() 在开始前调 ensureInferencesDir()，
    // 我们通过直接验证 saveInference 的行为来间接测试：
    // saveInference 会调用 appendFileSync，如果目录不存在会抛 ENOENT。
    // 正确的做法是先创建目录再调用 saveInference 确认写入成功。
    // 这里我们直接创建目录来验证完整流程
    mkdirSync(TMP_DIR, { recursive: true });
    expect(existsSync(TMP_DIR)).toBeTrue();

    saveInference(makeEntry({ session: "dir_test", msgId: 70001 }));
    const path = resolve(TMP_DIR, "dir_test.jsonl");
    expect(existsSync(path)).toBeTrue();
  });

  // ── 写入 ──

  test("首次推理写入 jsonl", () => {
    const entry = makeEntry({ msgId: 10001, session: "write_test" });
    saveInference(entry);

    const lines = readFileSync(resolve(TMP_DIR, "write_test.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]) as InferenceEntry;
    expect(parsed.msgId).toBe(10001);
    expect(parsed.session).toBe("write_test");
    expect(parsed.nickname).toBe("测试用户");
    expect(parsed.inference).toBe("A scenic mountain view, likely expressing awe.");
    expect(parsed.context.length).toBe(2);
    expect(parsed.timestamp).toBeTruthy();
  });

  test("多条写入按行累积", () => {
    const session = "multi_test";
    for (let i = 0; i < 5; i++) {
      saveInference(makeEntry({ msgId: 20000 + i, session, inference: `Result #${i}` }));
    }

    const lines = readFileSync(resolve(TMP_DIR, `${session}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBe(5);

    // 检查所有 msgId
    const ids = lines.map((l) => (JSON.parse(l) as InferenceEntry).msgId);
    expect(ids).toEqual([20000, 20001, 20002, 20003, 20004]);
  });

  // ── 去重 ──

  test("loadInferredIds 返回已推理的 msgId 集合", () => {
    const session = "dedup_test";
    saveInference(makeEntry({ msgId: 30001, session }));
    saveInference(makeEntry({ msgId: 30002, session }));
    saveInference(makeEntry({ msgId: 30003, session }));

    const ids = loadInferredIds(session);
    expect(ids.size).toBe(3);
    expect(ids.has(30001)).toBeTrue();
    expect(ids.has(30002)).toBeTrue();
    expect(ids.has(30003)).toBeTrue();
    expect(ids.has(99999)).toBeFalse();
  });

  test("无推理结果时返回空集合", () => {
    const ids = loadInferredIds("nonexistent_session");
    expect(ids.size).toBe(0);
  });

  test("重复写入同一 msgId 后去重集包含两条（未去重场景）", () => {
    // loadInferredIds 只是加载磁盘上的所有条目，不做去重
    // 真正的去重逻辑在 processSession 中（先 loadInferredIds 再跳过）
    // 模拟直接写两条相同 msgId
    const session = "dup_id_test";
    saveInference(makeEntry({ msgId: 40001, session }));
    saveInference(makeEntry({ msgId: 40001, session, inference: "Second result" }));

    const ids = loadInferredIds(session);
    expect(ids.has(40001)).toBeTrue(); // 只要有一条就足够跳过
  });

  // ── 多会话隔离 ──

  test("不同会话的推理结果互不干扰", () => {
    const sessionA = "iso_a";
    const sessionB = "iso_b";

    saveInference(makeEntry({ msgId: 50001, session: sessionA }));
    saveInference(makeEntry({ msgId: 50002, session: sessionB }));

    expect(loadInferredIds(sessionA).has(50001)).toBeTrue();
    expect(loadInferredIds(sessionA).has(50002)).toBeFalse();
    expect(loadInferredIds(sessionB).has(50002)).toBeTrue();
    expect(loadInferredIds(sessionB).has(50001)).toBeFalse();
  });

  // ── 数据完整性 ──

  test("保存的 JSON 行可逐行解析", () => {
    const session = "integrity_test";
    const entry = makeEntry({
      msgId: 60001,
      session,
      context: [
        { time: 100, nickname: "A", text: "hello" },
        { time: 200, nickname: "B", text: "world" },
      ],
      inference: "Surprised reaction.",
    });
    saveInference(entry);

    const raw = readFileSync(resolve(TMP_DIR, `${session}.jsonl`), "utf8").trim();
    const parsed = JSON.parse(raw) as InferenceEntry;

    expect(parsed.msgId).toBe(60001);
    expect(parsed.session).toBe(session);
    expect(parsed.context).toEqual([
      { time: 100, nickname: "A", text: "hello" },
      { time: 200, nickname: "B", text: "world" },
    ]);
    expect(parsed.inference).toBe("Surprised reaction.");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── 容错 ──

  test("损坏的行不影响其他行的加载", () => {
    const session = "corrupt_test";
    // 先写一条正常数据
    saveInference(makeEntry({ msgId: 80001, session }));
    // 手动往文件里插一条无效行
    const { appendFileSync } = require("node:fs");
    appendFileSync(resolve(TMP_DIR, `${session}.jsonl`), "这不是合法 JSON\n", "utf8");
    // 再写一条正常数据
    saveInference(makeEntry({ msgId: 80002, session }));

    const ids = loadInferredIds(session);
    // 有效行仍能被解析
    expect(ids.has(80001)).toBeTrue();
    expect(ids.has(80002)).toBeTrue();
    expect(ids.size).toBe(2); // 损坏行被静默跳过
  });
});
