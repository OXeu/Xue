/**
 * tests/index-stickers.test.ts — 验证 sticket 索引逻辑
 *
 * 覆盖：空数据、图片消息 + context、face 类型、幂等性、首尾窗口边界。
 * 使用临时目录写测试 JSONL，测试后清理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  isStickerCandidate,
  extractContent,
  indexSession,
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

function setup(dirs: { raw?: string; stickers?: string }): void {
  tmpRaw = dirs.raw || "";
  tmpStickers = dirs.stickers || "";
}

function cleanup(): void {
  if (tmpRaw && existsSync(tmpRaw)) rmSync(tmpRaw, { recursive: true, force: true });
  if (tmpStickers && existsSync(tmpStickers)) rmSync(tmpStickers, { recursive: true, force: true });
  tmpRaw = "";
  tmpStickers = "";
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

// ── 测试 ────────────────────────────────────────────────

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

// ── 集成测试（写临时文件） ──────────────────────────────

const SESSION = "test_stickers_integration";

beforeEach(() => {
  const base = join(tmpdir(), `rin-stickers-test-${randomBytes(4).toString("hex")}`);
  tmpRaw = join(base, "raw");
  tmpStickers = join(base, "stickers");
  mkdirSync(tmpRaw, { recursive: true });
});

afterEach(() => {
  cleanup();
});

test("空 raw 目录返回空结果", () => {
  // 不写任何文件，空的 raw 目录
  const result = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(result.newCount).toBe(0);
  expect(result.existingCount).toBe(0);
});

test("有图片消息时正确提取并含 context（前后各 3 条）", () => {
  // 7 条消息：纯文本*3 → 图片 → 纯文本*3
  const lines = [
    makeEntry({ msgId: 1, text: "早上好", nickname: "A" }),
    makeEntry({ msgId: 2, text: "吃了没", nickname: "B" }),
    makeEntry({ msgId: 3, text: "刚吃完", nickname: "C" }),
    makeEntry({
      msgId: 4, text: "", nickname: "D", type: "image",
      segmentTypes: ["image"],
      imageUrls: ["https://example.com/sticker.png"],
      raw_message: "[CQ:image,url=https://example.com/sticker.png]",
    }),
    makeEntry({ msgId: 5, text: "哈哈", nickname: "A" }),
    makeEntry({ msgId: 6, text: "乐了", nickname: "B" }),
    makeEntry({ msgId: 7, text: "确实", nickname: "C" }),
  ];
  writeRaw(SESSION, lines);

  const result = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(result.newCount).toBe(1);

  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].type).toBe("image");
  expect(stickers[0].content).toBe("https://example.com/sticker.png");
  expect(stickers[0].nickname).toBe("D");
  expect(stickers[0].context.length).toBe(6); // 前3 + 后3
  expect(stickers[0].context[0].text).toBe("早上好");
  expect(stickers[0].context[5].text).toBe("确实");
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
  expect(stickers[0].context.length).toBe(2); // 前1 + 后1
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

  // 第一次运行
  const r1 = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(r1.newCount).toBe(1);

  // 第二次运行
  const r2 = indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  expect(r2.newCount).toBe(0);

  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].msgId).toBe(2);
});

test("上下文窗口对首条 sticker 正确处理（只取后面）", () => {
  // 第一条消息就是图片
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

  indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].context.length).toBe(2); // 只有后面的 2 条
  expect(stickers[0].context[0].text).toBe("哈哈");
});

test("上下文窗口对末条 sticker 正确处理（只取前面）", () => {
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

  indexSession(SESSION, { rawDir: tmpRaw, stickersDir: tmpStickers });
  const stickers = readStickers(SESSION);
  expect(stickers.length).toBe(1);
  expect(stickers[0].context.length).toBe(2); // 只有前面的 2 条
  expect(stickers[0].context[0].text).toBe("早上好");
});
