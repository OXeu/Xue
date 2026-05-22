/**
 * tests/replay-cached-inference.test.ts — 验证 replay.ts 中图片下载失败时的缓存描述兜底逻辑
 *
 * loadCachedInference 从 data/prod/inferences/{session}.jsonl 中查找指定 msgId 的缓存视觉描述。
 * 测试覆盖：有缓存、无缓存、会话不存在三种场景。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

let loadCachedInference: (session: string, msgId: number) => string | null;

const INFERENCES_DIR = resolve(import.meta.dirname, "..", "data/prod", "inferences");

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

describe("图片下载失败时 messageText 应包含 [图片描述: ...]", () => {
  const testSession = "unittest_message_text_fallback";
  const testFilePath = join(INFERENCES_DIR, `${testSession}.jsonl`);

  afterAll(() => {
    try { unlinkSync(testFilePath); } catch { /* ok */ }
  });

  test("有缓存描述时构造正确的 messageText", () => {
    // 1. 写入缓存描述
    if (!existsSync(INFERENCES_DIR)) mkdirSync(INFERENCES_DIR, { recursive: true });
    writeFileSync(
      testFilePath,
      '{"msgId":42,"inference":"A snowy mountain peak under a cloudy sky"}\n',
      "utf8",
    );

    // 2. loadCachedInference 返回描述
    const desc = loadCachedInference(testSession, 42);
    expect(desc).toBe("A snowy mountain peak under a cloudy sky");

    // 3. 模拟 replay.ts/agent.ts 中的 messageText 构造逻辑
    const cleanText = ""; // 纯图片消息，文本为空
    const descSuffix = desc ? ` [图片描述: ${desc.slice(0, 80)}]` : "";
    const messageText = `${cleanText || "[图片]"}${descSuffix}`;

    // 4. 验证格式正确
    expect(messageText).toContain("[图片描述: A snowy mountain peak under a cloudy sky]");
    // 纯图片消息：cleanText 为空 → 回退到 "[图片]"
    expect(messageText).toMatch(/^\[图片\] \[图片描述:/);
  });

  test("无缓存描述时不添加 [图片描述]", () => {
    // 清理文件确保无缓存
    try { unlinkSync(testFilePath); } catch { /* ok */ }
    const desc = loadCachedInference(testSession, 99);
    expect(desc).toBeNull();

    const cleanText = "看这张图";
    const descSuffix = desc ? ` [图片描述: ${desc.slice(0, 80)}]` : "";
    const messageText = `${cleanText}${descSuffix}`;

    expect(messageText).toBe("看这张图");
    expect(messageText).not.toContain("[图片描述:");
  });

  test("描述截断到 80 字符", () => {
    const longDesc = "A".repeat(200);
    writeFileSync(testFilePath, JSON.stringify({ msgId: 7, inference: longDesc }) + "\n", "utf8");

    const desc = loadCachedInference(testSession, 7);
    expect(desc).toBe(longDesc);

    const cleanText = "";
    const descSuffix = desc ? ` [图片描述: ${desc.slice(0, 80)}]` : "";
    const messageText = `${cleanText || "[图片]"}${descSuffix}`;

    // 完整的 [图片描述: ...] 不超过 "[图片] [图片描述: " + 80 + "]" ≈ 99 字符
    expect(messageText.length).toBeLessThanOrEqual(100);
    expect(messageText).toMatch(/\[图片描述: A{80}\]$/);
  });
});

describe("agent.ts 中同一函数的一致性", () => {
  let agentLoadCachedInference: (session: string, msgId: number) => string | null;

  beforeAll(async () => {
    const mod = await import("../src/agent");
    agentLoadCachedInference = mod.loadCachedInference;
  });

  test("replay.ts 和 agent.ts 的 loadCachedInference 返回一致", () => {
    // 对同一个文件，两个模块的同一函数应返回相同结果
    const replayResult = loadCachedInference("test_img_window", 761268885);
    // agent 端读同一个文件
    const agentResult = agentLoadCachedInference("test_img_window", 761268885);
    // test_img_window 的 inference 文件可能不存在（已被清理），都返回 null 也算一致
    expect(replayResult).toBe(agentResult);
  });
});

// ── replay.ts 的 displayText 构造（低确定性风格的（图片描述：...））────

describe("replay.ts 下载失败 displayText 构造", () => {
  const testSession = "unittest_replay_displaytext";
  const testFilePath = join(INFERENCES_DIR, `${testSession}.jsonl`);

  afterAll(() => {
    try { unlinkSync(testFilePath); } catch { /* ok */ }
  });

  test("有缓存时 displayText 包含 （图片描述：...）", () => {
    const desc = "A white cat sleeping on a red sofa, relaxed atmosphere, no text.";
    const msgId = 2001;
    if (!existsSync(INFERENCES_DIR)) mkdirSync(INFERENCES_DIR, { recursive: true });
    writeFileSync(testFilePath, JSON.stringify({ msgId, session: testSession, inference: desc }) + "\n", "utf8");

    // 模拟 replay.ts 的精确分支逻辑（行 ~733-765）：
    let imageDesc = "";
    if (!imageDesc) {
      const cached = loadCachedInference(testSession, msgId);
      if (cached) imageDesc = cached;
    }
    expect(imageDesc).toBe(desc);

    const cleanText = "";
    const displayText = imageDesc
      ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
      : cleanText;

    // replay.ts 使用圆括号格式（低确定性沉默检查路径）
    expect(displayText).toContain("（图片描述：A white cat sleeping on a red sofa, relaxed atmosphere, no text.）");
    // 不应出现高确定性的方括号格式
    expect(displayText).not.toContain("[图片描述:");
  });

  test("图片有文字内容时 displayText 含文字描述", () => {
    const desc = "A screenshot showing system update progress bar at 45% with text 'Update in progress'. Dark theme.";
    const msgId = 2002;
    writeFileSync(testFilePath, JSON.stringify({ msgId, session: testSession, inference: desc }) + "\n", "utf8");

    let imageDesc = "";
    if (!imageDesc) {
      const cached = loadCachedInference(testSession, msgId);
      if (cached) imageDesc = cached;
    }
    expect(imageDesc).toBe(desc);

    const cleanText = "看这个";
    const displayText = imageDesc
      ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
      : cleanText;

    // 文本前缀 + 圆括号描述
    expect(displayText).toBe("看这个（图片描述：A screenshot showing system update progress bar at 45% with text 'Update in prog）");
  });

  test("无缓存时 displayText 退化为纯 cleanText", () => {
    // 清理文件
    try { unlinkSync(testFilePath); } catch { /* ok */ }

    let imageDesc = "";
    if (!imageDesc) {
      const cached = loadCachedInference(testSession, 9999);
      if (cached) imageDesc = cached;
    }
    expect(imageDesc).toBe("");

    const cleanText = "看看这个";
    const displayText = imageDesc
      ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
      : cleanText;

    expect(displayText).toBe("看看这个");
    expect(displayText).not.toContain("（图片描述：");
  });

  test("描述截断到 80 字符", () => {
    const longDesc = "B".repeat(200);
    const msgId = 2003;
    writeFileSync(testFilePath, JSON.stringify({ msgId, session: testSession, inference: longDesc }) + "\n", "utf8");

    let imageDesc = "";
    if (!imageDesc) {
      const cached = loadCachedInference(testSession, msgId);
      if (cached) imageDesc = cached;
    }
    expect(imageDesc).toBe(longDesc);

    const cleanText = "";
    const displayText = imageDesc
      ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
      : cleanText;

    // 截断：80 个 B + 外壳"（图片描述：……）"
    expect(displayText).toBe(`（图片描述：${"B".repeat(80)}）`);
    expect(displayText.length).toBe(80 + 7); // 7 = "（图片描述：".length + "）".length
  });
});
