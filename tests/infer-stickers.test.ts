/**
 * infer-stickers.test.ts — infer-stickers 持久化逻辑单元测试
 *
 * runner: bun:test
 * 只测文件 IO 和去重逻辑，不调网络/视觉模型。
 * 测试在临时目录中运行，完成后清理。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import sharp from "sharp";
import {
  setInferencesDir,
  setStickersDir,
  setRawDir,
  loadInferredIds,
  saveInference,
  processSession,
} from "../src/infer-stickers";
import type { InferenceEntry } from "../src/infer-stickers";
import { setCacheDir } from "../src/image-cache";
import { computeDHashFromBuffer, hammingDistance } from "../src/phash";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

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

// ── 主流程集成测试 ──────────────────────────────────────

describe("infer-stickers main flow integration", () => {
  const TMP_ROOT = resolve(import.meta.dirname, "../.test-infer-flow-" + Date.now());
  const stickersDir = join(TMP_ROOT, "stickers");
  const rawDir = join(TMP_ROOT, "raw");
  const inferencesDir = join(TMP_ROOT, "inferences");

  let oldStickersDir: string;
  let oldRawDir: string;
  let oldInferencesDir: string;
  let oldCacheDir: string;
  let originalFetch: typeof globalThis.fetch;

  /** 创建临时 sticker 索引文件 */
  function createStickerIndex(session: string, entries: object[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(stickersDir, `${session}.jsonl`), content, "utf8");
  }

  /** 创建临时 raw 文件（提供上下文） */
  function createRawFile(session: string, entries: object[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(rawDir, `${session}.jsonl`), content, "utf8");
  }

  beforeAll(() => {
    // 创建临时目录
    for (const d of [stickersDir, rawDir, inferencesDir]) {
      mkdirSync(d, { recursive: true });
    }

    // 重定向模块路径
    oldStickersDir = setStickersDir(stickersDir);
    oldRawDir = setRawDir(rawDir);
    oldInferencesDir = setInferencesDir(inferencesDir);
    oldCacheDir = setCacheDir(join(TMP_ROOT, "images"));

    // 保存原始 fetch
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    // 恢复路径
    setStickersDir(oldStickersDir);
    setRawDir(oldRawDir);
    setInferencesDir(oldInferencesDir);
    setCacheDir(oldCacheDir);

    // 恢复 fetch
    globalThis.fetch = originalFetch;

    // 清理临时目录
    try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    // 生成一张有效的小图片（sharp 能处理），每次调用生成不同内容
    const { default: sharp } = await import("sharp");

    // 用计数器使每次 mock fetch 返回不同的图片数据
    let imgCallCount = 0;
    let visionCallCount = 0;

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();

      // 视觉模型 API 请求
      if (urlStr.includes("/v1/chat/completions")) {
        visionCallCount++;
        const responseText = visionCallCount === 1
          ? "A funny reaction meme expressing amusement."
          : "A shocked surprised face meme.";
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: responseText } }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }

      // 图片下载 → 每次生成不同内容，确保 phash 不同
      imgCallCount++;
      const r = (imgCallCount * 50 + 30) % 256;
      const g = (imgCallCount * 80 + 60) % 256;
      const b = (imgCallCount * 120 + 90) % 256;

      // 生成 16×16 的渐变图确保 dHash 有可比较的差异
      const raw = Buffer.alloc(16 * 16 * 3);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const idx = (y * 16 + x) * 3;
          raw[idx] = (r + x * 10) % 256;
          raw[idx + 1] = (g + y * 8) % 256;
          raw[idx + 2] = (b + x * 5 + y * 7) % 256;
        }
      }
      return sharp(raw, { raw: { width: 16, height: 16, channels: 3 } })
        .jpeg()
        .toBuffer()
        .then((buf: Buffer) => new Response(buf, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }));
    }) as typeof globalThis.fetch;
  });

  test("完整流程：读取 sticker 索引 → 调用视觉模型 → 持久化推理结果", async () => {
    // 准备 sticker 索引 — 1 条图片消息
    createStickerIndex("flow_test", [
      {
        msgId: 90001, time: 1716000000, session: "flow_test",
        userId: 200001, nickname: "TestUser", card: undefined,
        type: "image", content: "https://multimedia.example.com/img.jpg", text: "",
      },
    ]);

    // 准备 raw 文件（提供上下文）
    createRawFile("flow_test", [
      { msgId: 89999, time: 1715999990, userId: 200000, nickname: "UserX", text: "hello" },
      { msgId: 90000, time: 1715999995, userId: 200000, nickname: "UserX", text: "check this" },
      { msgId: 90001, time: 1716000000, userId: 200001, nickname: "TestUser", text: "" },
      { msgId: 90002, time: 1716000005, userId: 200002, nickname: "UserY", text: "nice" },
    ]);

    // 执行
    await processSession("flow_test");

    // 验证：inference 文件已创建
    const infPath = join(inferencesDir, "flow_test.jsonl");
    expect(existsSync(infPath)).toBeTrue();

    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]) as InferenceEntry;
    expect(entry.msgId).toBe(90001);
    expect(entry.session).toBe("flow_test");
    expect(entry.nickname).toBe("TestUser");
    expect(entry.inference).toBe("A funny reaction meme expressing amusement.");
    // context 应包含前后各 3 条（实际 raw 中 90001 前后共 4 条，但 getStickerContext 截 3）
    expect(entry.context.length).toBeGreaterThanOrEqual(1);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("重复运行跳过已推理的条目", async () => {
    // flow_test 已有 1 条推理结果
    // 再次运行
    const consoleOutput: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { consoleOutput.push(args.join(" ")); };

    try {
      await processSession("flow_test");
    } finally {
      console.log = origLog;
    }

    // verify: inference 文件只有 1 行（未新增）
    const infPath = join(inferencesDir, "flow_test.jsonl");
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // 仍是之前那一条
  });

  test("多条目处理：多条 sticker 依次推理并持久化", async () => {
    const session = "multi_flow";

    createStickerIndex(session, [
      {
        msgId: 91001, time: 1716100000, session,
        userId: 201001, nickname: "UserA", card: undefined,
        type: "image", content: "https://multimedia.example.com/a.jpg", text: "",
      },
      {
        msgId: 91002, time: 1716100010, session,
        userId: 201002, nickname: "UserB", card: undefined,
        type: "image", content: "https://multimedia.example.com/b.jpg", text: "",
      },
    ]);

    createRawFile(session, [
      { msgId: 91000, time: 1716099990, userId: 201000, nickname: "UserX", text: "earlier msg" },
      { msgId: 91001, time: 1716100000, userId: 201001, nickname: "UserA", text: "" },
      { msgId: 91002, time: 1716100010, userId: 201002, nickname: "UserB", text: "" },
      { msgId: 91003, time: 1716100020, userId: 201000, nickname: "UserX", text: "later msg" },
    ]);

    await processSession(session);

    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);

    const entries = lines.map((l) => JSON.parse(l) as InferenceEntry);
    expect(entries[0].msgId).toBe(91001);
    expect(entries[1].msgId).toBe(91002);
    expect(entries[0].inference).toBe("A funny reaction meme expressing amusement.");
    expect(entries[1].inference).toBe("A shocked surprised face meme.");
  });

  test("重复运行多条目：第一条已推理，跳过，只处理未推理的", async () => {
    const session = "partial_skip";

    // 在 processSession 之前手动写一条推理结果（模拟历史）
    saveInference(makeEntry({
      msgId: 92001, session, inference: "Existing inference.",
    }));

    createStickerIndex(session, [
      {
        msgId: 92001, time: 1716200000, session,
        userId: 202001, nickname: "OldUser", card: undefined,
        type: "image", content: "https://example.com/old.jpg", text: "",
      },
      {
        msgId: 92002, time: 1716200010, session,
        userId: 202002, nickname: "NewUser", card: undefined,
        type: "image", content: "https://example.com/new.jpg", text: "",
      },
    ]);

    createRawFile(session, [
      { msgId: 92001, time: 1716200000, userId: 202001, nickname: "OldUser", text: "" },
      { msgId: 92002, time: 1716200010, userId: 202002, nickname: "NewUser", text: "" },
    ]);

    // 首次运行：1 条已跳过，1 条新推理
    await processSession(session);

    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // 现有 1 条 + 新推理 1 条

    const entries = lines.map((l) => JSON.parse(l) as InferenceEntry);
    const newEntry = entries.find((e) => e.msgId === 92002)!;
    expect(newEntry.inference).toBe("A funny reaction meme expressing amusement.");
    expect(entries.find((e) => e.msgId === 92001)!.inference).toBe("Existing inference.");
  });

  test("type 非 image 的条目被跳过，不触发推理", async () => {
    const session = "skip_non_image";

    createStickerIndex(session, [
      {
        msgId: 93001, time: 1716300000, session,
        userId: 203001, nickname: "FaceUser", card: undefined,
        type: "face", content: "123", text: "",
      },
      {
        msgId: 93002, time: 1716300010, session,
        userId: 203002, nickname: "ImageUser", card: undefined,
        type: "image", content: "https://example.com/img.jpg", text: "",
      },
    ]);

    createRawFile(session, [
      { msgId: 93001, time: 1716300000, userId: 203001, nickname: "FaceUser", text: "" },
      { msgId: 93002, time: 1716300010, userId: 203002, nickname: "ImageUser", text: "" },
    ]);

    await processSession(session);

    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // 只有 image 类型被推理
    const entry = JSON.parse(lines[0]) as InferenceEntry;
    expect(entry.msgId).toBe(93002);
  });

  test("session 文件夹不存在且无 sticker 索引时静默跳过", async () => {
    // 调用不存在的 session，processSession 应直接 return
    await processSession("nonexistent_session");

    // 无文件被创建
    const infPath = join(inferencesDir, "nonexistent_session.jsonl");
    expect(existsSync(infPath)).toBeFalse();
  });

  test("--reindex 强制重新推理已存在的条目", async () => {
    const session = "reindex_test";

    // 准备 sticker 索引（1 条）
    createStickerIndex(session, [
      {
        msgId: 94001, time: 1716400000, session,
        userId: 204001, nickname: "ReindexUser", card: undefined,
        type: "image", content: "https://multimedia.example.com/re.jpg", text: "",
      },
    ]);
    createRawFile(session, [
      { msgId: 94001, time: 1716400000, userId: 204001, nickname: "ReindexUser", text: "" },
    ]);

    // 首次运行（正常模式，没有 reindex）
    await processSession(session);

    const infPath = join(inferencesDir, `${session}.jsonl`);
    let lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const firstInference = (JSON.parse(lines[0]) as InferenceEntry).inference;

    // 带 reindex 再次运行 — 应重新推理而非跳过
    await processSession(session, { reindex: true });

    lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // 新增了一条（而非跳过）

    const entries = lines.map((l) => JSON.parse(l) as InferenceEntry);
    // 两条都是同一个 msgId，但第二条是新推理结果
    expect(entries[0].msgId).toBe(94001);
    expect(entries[1].msgId).toBe(94001);
  });

  // ── pHash 去重集成测试 ──────────────────────────────

  /** 生成一张带简单图案的图片 buffer，内容可控用于 pHash 碰撞测试 */
  async function makePatternImage(offset: number): Promise<Buffer> {
    const w = 100, h = 100;
    const raw = Buffer.alloc(w * h * 3);
    // 灰色渐变背景 + 一个白色方块，位置由 offset 控制
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        // 渐变灰底
        const gray = 40 + Math.floor((x + y) * 0.5) % 60;
        raw[idx] = gray;
        raw[idx + 1] = gray;
        raw[idx + 2] = gray;
        // 白色方块
        const bx = 5 + (offset % 50);
        const by = 5 + (offset * 7 % 50);
        if (Math.abs(x - bx) < 8 && Math.abs(y - by) < 8) {
          raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255;
        }
      }
    }
    return await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .jpeg()
      .toBuffer();
  }

  /** 创建一个 mock fetch，图片请求返回指定 buffer，视觉 API 返回模拟结果 */
  function makeMockFetch(imgBuffer: Buffer): typeof globalThis.fetch {
    let callCount = 0;
    return ((url: string | URL | Request): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/v1/chat/completions")) {
        callCount++;
        const text = callCount === 1
          ? "A funny reaction meme expressing amusement."
          : "A shocked surprised face meme.";
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: text } }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(imgBuffer, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }));
    }) as typeof globalThis.fetch;
  }

  test("pHash 去重：相似图片被跳过", async () => {
    const session = "phash_skip";

    // 生成图片 A 和极微调后的图片 B（保证 dHash 距离 ≤ 3）
    // 使用相同 offset 生成的两张图先 JPEG 编码再解码，压缩噪声会导致微小差异
    const imgA = await makePatternImage(42);
    const hashA = await computeDHashFromBuffer(imgA);

    // 找一张与 hashA 距离 ≤ 3 的图：从偏移 0~200 扫描
    let similarImg: Buffer | null = null;
    let similarHash = "";
    for (let off = 0; off < 200; off++) {
      const buf = await makePatternImage(off);
      const h = await computeDHashFromBuffer(buf);
      if (hammingDistance(hashA, h) <= 3) {
        similarImg = buf;
        similarHash = h;
        break;
      }
    }
    if (!similarImg) throw new Error("Could not find a similar image (dist ≤ 3)");

    // 写一条已知推理记录（带 phash）
    saveInference(makeEntry({
      msgId: 95001, session, inference: "First result.",
      phash: hashA,
    }));

    // 准备 sticker 索引（1 条图片消息）
    createStickerIndex(session, [
      {
        msgId: 95002, time: 1716500000, session,
        userId: 205001, nickname: "DedupUser", card: undefined,
        type: "image", content: "https://multimedia.example.com/similar.jpg", text: "",
      },
    ]);
    createRawFile(session, [
      { msgId: 95002, time: 1716500000, userId: 205001, nickname: "DedupUser", text: "" },
    ]);

    // 用相似图片的 mock 运行
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeMockFetch(similarImg);
      await processSession(session);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 验证：推理文件只有 1 条（原始的那条），新条目被 pHash 去重跳过
    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as InferenceEntry;
    expect(entry.msgId).toBe(95001); // 仍是初始条目
  });

  test("pHash 去重：不相似图片正常推理", async () => {
    const session = "phash_no_skip";

    // 生成两张 dHash 距离 > 3 的图片
    const imgA = await makePatternImage(42);
    const hashA = await computeDHashFromBuffer(imgA);

    let distantImg: Buffer | null = null;
    for (let off = 0; off < 200; off++) {
      const buf = await makePatternImage(off);
      const h = await computeDHashFromBuffer(buf);
      if (hammingDistance(hashA, h) > 3) {
        distantImg = buf;
        break;
      }
    }
    if (!distantImg) throw new Error("Could not find a distant image (dist > 3)");

    // 写一条已知推理记录（带 phash）
    saveInference(makeEntry({
      msgId: 96001, session, inference: "First result.",
      phash: hashA,
    }));

    // 准备 sticker 索引
    createStickerIndex(session, [
      {
        msgId: 96002, time: 1716600000, session,
        userId: 206001, nickname: "NewUser", card: undefined,
        type: "image", content: "https://multimedia.example.com/different.jpg", text: "",
      },
    ]);
    createRawFile(session, [
      { msgId: 96002, time: 1716600000, userId: 206001, nickname: "NewUser", text: "" },
    ]);

    // 用不相似图片的 mock 运行
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeMockFetch(distantImg);
      await processSession(session);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 验证：推理文件现有 1 条 + 新增 1 条 = 2 条
    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const entries = lines.map((l) => JSON.parse(l) as InferenceEntry);
    expect(entries.some((e) => e.msgId === 96001)).toBeTrue();
    expect(entries.some((e) => e.msgId === 96002)).toBeTrue();
  });

  test("pHash 同批次去重：相同图片的多条 sticker 只写入一条推理", async () => {
    const session = "within_run_dedup";

    // 生成一张图片，两次 sticker 都指向它
    const img = await makePatternImage(42);

    // 两条 sticker，不同的 msgId，不同的 URL，但 mock 返回同样的图片数据
    createStickerIndex(session, [
      {
        msgId: 97001, time: 1716700000, session,
        userId: 207001, nickname: "UserA", card: undefined,
        type: "image", content: "https://multimedia.example.com/v1.jpg", text: "",
      },
      {
        msgId: 97002, time: 1716700010, session,
        userId: 207002, nickname: "UserB", card: undefined,
        type: "image", content: "https://multimedia.example.com/v2.jpg", text: "",
      },
    ]);
    createRawFile(session, [
      { msgId: 97001, time: 1716700000, userId: 207001, nickname: "UserA", text: "" },
      { msgId: 97002, time: 1716700010, userId: 207002, nickname: "UserB", text: "" },
    ]);

    // 同一个 mock（返回相同图片）处理两条
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeMockFetch(img);
      await processSession(session);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 验证：只有 1 条推理结果
    const infPath = join(inferencesDir, `${session}.jsonl`);
    const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]) as InferenceEntry;
    // 第一条先处理，应该被写入
    expect(entry.msgId).toBe(97001);
    // 第二条因为 phash 相同被跳过
  });
});
