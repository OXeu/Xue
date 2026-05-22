/**
 * tests/index-stickers.test.ts — 验证 sticket 索引逻辑
 *
 * 覆盖：空数据、图片消息索引、face 类型、幂等性、context 反查、窗口边界。
 * 使用临时目录写测试 JSONL，测试后清理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  isStickerCandidate,
  extractContent,
  indexSession,
  getStickerContext,
  RawEntry,
  StickerEntry,
} from "../src/index-stickers";

/** 构建一条消息的原始 JSONL 行 */
function makeEntry(overrides: Partial<RawEntry> & { msgId: number; text: string }): string {
  const entry: RawEntry = {
    session: "test_session",
    msgId: overrides.msgId,
    time: overrides.time ?? 1_000_000 + overrides.msgId,
    type: overrides.type ?? "text",
    text: overrides.text,
    userId: overrides.userId ?? 10001,
    nickname: overrides.nickname ?? "TestUser",
    card: overrides.card,
    segmentTypes: overrides.segmentTypes ?? ["text"],
    imageUrls: overrides.imageUrls,
    raw_message: overrides.raw_message ?? overrides.text,
  };
  return JSON.stringify(entry);
}

let tmpRaw = "";
let tmpStickers = "";

afterEach(() => {
  if (tmpRaw && existsSync(tmpRaw)) rmSync(tmpRaw, { recursive: true, force: true });
  if (tmpStickers && existsSync(tmpStickers)) rmSync(tmpStickers, { recursive: true, force: true });
  tmpRaw = "";
  tmpStickers = "";
});

function setup(): void {
  const base = join(tmpdir(), `rin-stickers-test-${randomBytes(4).toString("hex")}`);
  tmpRaw = join(base, "raw");
  tmpStickers = join(base, "stickers");
  mkdirSync(tmpRaw, { recursive: true });
}

function writeRaw(session: string, lines: string[]): void {
  if (!existsSync(tmpRaw)) mkdirSync(tmpRaw, { recursive: true });
  writeFileSync(join(tmpRaw, `${session}.jsonl`), lines.join("\n") + "\n");
}

function readStickers(session: string): StickerEntry[] {
  const p = join(tmpStickers, `${session}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const SESSION = "test_stickers";

// ── 单元测试 ────────────────────────────────────────────

test("isStickerCandidate: 纯文本消息返回 false", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "text", text: "你好",
    userId: 1, nickname: "A", segmentTypes: ["text"], raw_message: "你好",
  };
  expect(isStickerCandidate(e)).toBe(false);
});

test("isStickerCandidate: 图片消息返回 true", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "image", text: "",
    userId: 1, nickname: "A", segmentTypes: ["image"], raw_message: "[CQ:image,url=https://x]",
    imageUrls: ["https://x"],
  };
  expect(isStickerCandidate(e)).toBe(true);
});

test("isStickerCandidate: face 消息返回 true", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "face", text: "",
    userId: 1, nickname: "A", segmentTypes: ["face"], raw_message: "[CQ:face,id=123]",
  };
  expect(isStickerCandidate(e)).toBe(true);
});

test("extractContent: 图片消息提取 URL", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "image", text: "",
    userId: 1, nickname: "A", segmentTypes: ["image"], raw_message: "[CQ:image,url=https://x]",
    imageUrls: ["https://example.com/img.png"],
  };
  const r = extractContent(e);
  expect(r).not.toBeNull();
  expect(r!.type).toBe("image");
  expect(r!.content).toBe("https://example.com/img.png");
});

test("extractContent: face 消息提取 face ID", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "face", text: "",
    userId: 1, nickname: "A", segmentTypes: ["face"], raw_message: "[CQ:face,id=123]",
  };
  const r = extractContent(e);
  expect(r).not.toBeNull();
  expect(r!.type).toBe("face");
  expect(r!.content).toBe("123");
});

test("extractContent: 无 sticker 内容返回 null", () => {
  const e: RawEntry = {
    session: "s", msgId: 1, time: 1000, type: "text", text: "你好",
    userId: 1, nickname: "A", segmentTypes: ["text"], raw_message: "[CQ:reply,id=5] 你好",
  };
  expect(extractContent(e)).toBeNull();
});

// ── 集成测试: indexSession ─────────────────────────────

beforeEach(() => setup());

test("空 raw 目录返回空结果", () => {
  const result = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(result.newCount).toBe(0);
  expect(result.existingCount).toBe(0);
});

test("图片消息被正确索引，不包含内嵌 context", () => {
  const lines = [
    makeEntry({ msgId: 1, text: "早上好", nickname: "A" }),
    makeEntry({ msgId: 2, text: "吃了没", nickname: "B" }),
    makeEntry({
      msgId: 3, text: "", nickname: "D", type: "image",
      segmentTypes: ["image"],
      imageUrls: ["https://example.com/sticker.png"],
      raw_message: "[CQ:image,url=https://example.com/sticker.png]",
    }),
    makeEntry({ msgId: 4, text: "哈哈", nickname: "A" }),
    makeEntry({ msgId: 5, text: "乐了", nickname: "B" }),
  ];
  writeRaw(SESSION, lines);

  const result = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(result.newCount).toBe(1);

  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].type).toBe("image");
  expect(stickers[0].content).toBe("https://example.com/sticker.png");
  expect(stickers[0].nickname).toBe("D");
  // StickerEntry 不含 context 字段
  expect((stickers[0] as Record<string, unknown>).context).toBeUndefined();
});

test("face 类型表情也被收录", () => {
  const lines = [
    makeEntry({ msgId: 1, text: "你好", nickname: "A" }),
    makeEntry({ msgId: 2, text: "", nickname: "B", type: "face", segmentTypes: ["face"], raw_message: "[CQ:face,id=14]" }),
    makeEntry({ msgId: 3, text: "草", nickname: "C" }),
  ];
  writeRaw(SESSION, lines);

  const result = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(result.newCount).toBe(1);

  const stickers = readStickers(SESSION);
  expect(stickers[0].type).toBe("face");
  expect(stickers[0].content).toBe("14");
});

test("重复运行不会重复写入已索引的消息", () => {
  const lines = [
    makeEntry({ msgId: 1, text: "你好", nickname: "A" }),
    makeEntry({
      msgId: 2, text: "", nickname: "B", type: "image",
      segmentTypes: ["image"],
      imageUrls: ["https://example.com/x.png"],
      raw_message: "[CQ:image,url=https://example.com/x.png]",
    }),
    makeEntry({ msgId: 3, text: "草", nickname: "C" }),
  ];
  writeRaw(SESSION, lines);

  const r1 = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(r1.newCount).toBe(1);

  const r2 = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(r2.newCount).toBe(0);

  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].msgId).toBe(2);
});

// ── 集成测试: getStickerContext ────────────────────────

test("getStickerContext 返回前后各 N 条上下文", () => {
  const lines = Array.from({ length: 7 }, (_, i) =>
    makeEntry({ msgId: i + 1, text: `msg${i + 1}`, nickname: "A" }),
  );
  // 把 msgId=4 改成图片消息
  const stickerLine = makeEntry({
    msgId: 4, text: "", nickname: "B", type: "image",
    segmentTypes: ["image"],
    imageUrls: ["https://x"],
    raw_message: "[CQ:image,url=https://x]",
  });
  lines[3] = stickerLine;
  writeRaw(SESSION, lines);

  const ctx = getStickerContext(4, SESSION, 3, { rawDir: tmpRaw });
  expect(ctx.length).toBe(6); // 前3 + 后3
  expect(ctx[0].text).toBe("msg1");
  expect(ctx[5].text).toBe("msg7");
});

test("getStickerContext 自定义 windowSize", () => {
  const lines = Array.from({ length: 7 }, (_, i) =>
    makeEntry({ msgId: i + 1, text: `msg${i + 1}`, nickname: "A" }),
  );
  const stickerLine = makeEntry({
    msgId: 4, text: "", nickname: "B", type: "image",
    segmentTypes: ["image"],
    imageUrls: ["https://x"],
    raw_message: "[CQ:image,url=https://x]",
  });
  lines[3] = stickerLine;
  writeRaw(SESSION, lines);

  // windowSize=1 → 前后各 1 条
  const ctx = getStickerContext(4, SESSION, 1, { rawDir: tmpRaw });
  expect(ctx.length).toBe(2);
  expect(ctx[0].text).toBe("msg3");
  expect(ctx[1].text).toBe("msg5");
});

test("getStickerContext 不存在的 msgId 返回空数组", () => {
  writeRaw(SESSION, [makeEntry({ msgId: 1, text: "你好", nickname: "A" })]);
  const ctx = getStickerContext(999, SESSION, 3, { rawDir: tmpRaw });
  expect(ctx).toEqual([]);
});

test("getStickerContext 窗口边界处理（首条）", () => {
  const lines = [
    makeEntry({
      msgId: 1, text: "", nickname: "A", type: "image",
      segmentTypes: ["image"],
      imageUrls: ["https://x"],
      raw_message: "[CQ:image,url=https://x]",
    }),
    makeEntry({ msgId: 2, text: "哈哈", nickname: "B" }),
    makeEntry({ msgId: 3, text: "乐了", nickname: "C" }),
  ];
  writeRaw(SESSION, lines);

  const ctx = getStickerContext(1, SESSION, 3, { rawDir: tmpRaw });
  // 前面没有消息，只取后面的
  expect(ctx.length).toBe(2);
  expect(ctx[0].text).toBe("哈哈");
});

test("getStickerContext 窗口边界处理（末条）", () => {
  const lines = [
    makeEntry({ msgId: 1, text: "早上好", nickname: "A" }),
    makeEntry({ msgId: 2, text: "吃了没", nickname: "B" }),
    makeEntry({
      msgId: 3, text: "", nickname: "C", type: "image",
      segmentTypes: ["image"],
      imageUrls: ["https://x"],
      raw_message: "[CQ:image,url=https://x]",
    }),
  ];
  writeRaw(SESSION, lines);

  const ctx = getStickerContext(3, SESSION, 3, { rawDir: tmpRaw });
  // 后面没有消息，只取前面的
  expect(ctx.length).toBe(2);
  expect(ctx[0].text).toBe("早上好");
});

test("getStickerContext 不存在的 session 文件返回空数组", () => {
  const ctx = getStickerContext(1, "nonexistent_session", 3, { rawDir: tmpRaw });
  expect(ctx).toEqual([]);
});
