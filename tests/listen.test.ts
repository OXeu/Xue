/**
 * listen.test.ts — listen.ts 消息解析单元测试
 *
 * 测试 parseMessage 函数对 OneBot 消息数组格式的解析。
 * 不涉及 WS 连接或文件写入（通过环境变量跳过 main 自执行）。
 *
 * runner: bun:test
 */

import { describe, test, expect, beforeAll } from "bun:test";

// 用动态 import 确保环境变量在模块加载前生效。
// ESM 静态 import 会被提升，无法在导入前设 env。
let parseMessage: (msg: string | unknown[]) => ReturnType<typeof import("../src/listen").parseMessage>;
let estimateMsgType: (types: string[], text: string) => string;

beforeAll(async () => {
  process.env.RIN_TEST = "1";
  const mod = await import("../src/listen");
  parseMessage = mod.parseMessage;
  estimateMsgType = mod.estimateMsgType;
});

describe("parseMessage", () => {
  // ── 图片 URL 提取 ──

  test("image 段中的 url 被正确提取到 imageUrls", () => {
    const msg = [{ type: "image", data: { url: "https://example.com/photo.jpg" } }];
    const result = parseMessage(msg);

    expect(result.imageUrls).toEqual(["https://example.com/photo.jpg"]);
    expect(result.segmentTypes).toEqual(["image"]);
    expect(result.text).toBe("");
  });

  test("不含 image 段时 imageUrls 为空数组", () => {
    const msg = [{ type: "text", data: { text: "hello" } }];
    const result = parseMessage(msg);

    expect(result.imageUrls).toEqual([]);
    expect(result.text).toBe("hello");
  });

  test("多条 image 段时全部 url 被收集", () => {
    const msg = [
      { type: "image", data: { url: "https://example.com/1.jpg" } },
      { type: "image", data: { url: "https://example.com/2.png" } },
      { type: "image", data: { url: "https://example.com/3.gif" } },
    ];
    const result = parseMessage(msg);

    expect(result.imageUrls).toEqual([
      "https://example.com/1.jpg",
      "https://example.com/2.png",
      "https://example.com/3.gif",
    ]);
    expect(result.segmentTypes).toEqual(["image", "image", "image"]);
  });

  // ── 非图片段不干扰 ──

  test("text / at / reply 等非图片段不影响 imageUrls", () => {
    const msg = [
      { type: "text", data: { text: "看这张图：" } },
      { type: "image", data: { url: "https://example.com/meme.jpg" } },
      { type: "at", data: { qq: "123456" } },
      { type: "reply", data: { id: "98765" } },
    ];
    const result = parseMessage(msg);

    expect(result.imageUrls).toEqual(["https://example.com/meme.jpg"]);
    expect(result.text).toBe("看这张图：");
    expect(result.atUsers).toEqual([123456]);
    expect(result.replyTo).toBe(98765);
    expect(result.segmentTypes).toEqual(["text", "image", "at", "reply"]);
  });

  // ── string 格式 ──

  test("string 格式消息仍能正确处理", () => {
    const result = parseMessage("hello world");

    expect(result.text).toBe("hello world");
    expect(result.segmentTypes).toEqual(["text"]);
    expect(result.imageUrls).toEqual([]);
  });

  test("string 格式含 [CQ:reply,id=N] 时提取 replyTo 并剥离 CQ 码", () => {
    const result = parseMessage("[CQ:reply,id=12345]这个 logo 怎么样");

    expect(result.replyTo).toBe(12345);
    expect(result.text).toBe("这个 logo 怎么样");
    expect(result.segmentTypes).toEqual(["reply"]);
    expect(result.imageUrls).toEqual([]);
  });

  test("string 格式含 [CQ:at] 时提取 atUsers", () => {
    const result = parseMessage("[CQ:at,qq=3042160393] 你好");

    expect(result.atUsers).toEqual([3042160393]);
    expect(result.text).toBe("你好");
    expect(result.segmentTypes).toEqual(["at"]);
  });

  test("string 格式含 [CQ:image] 时提取 imageUrls 并剥离 CQ 码", () => {
    const result = parseMessage("看这个 [CQ:image,url=https://example.com/img.jpg]");

    expect(result.imageUrls).toEqual(["https://example.com/img.jpg"]);
    expect(result.text).toBe("看这个");
    expect(result.segmentTypes).toEqual(["image"]);
  });

  // ── 边界情况 ──

  test("空数组 → text 空字符串，imageUrls 空数组", () => {
    const result = parseMessage([]);

    expect(result.text).toBe("");
    expect(result.imageUrls).toEqual([]);
    expect(result.segmentTypes).toEqual([]);
  });

  test("image 段不含 url 字段 → imageUrls 不包含", () => {
    const msg = [{ type: "image", data: { file: "local.jpg" } }];
    const result = parseMessage(msg);

    expect(result.imageUrls).toEqual([]);
    expect(result.segmentTypes).toEqual(["image"]);
  });

  test("非法输入（非数组非字符串）→ 空结果", () => {
    const result = parseMessage(null as unknown as unknown[]);

    expect(result.text).toBe("");
    expect(result.imageUrls).toEqual([]);
    expect(result.atUsers).toEqual([]);
  });

  test("@全体成员不被计入 atUsers", () => {
    const msg = [
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: "大家好" } },
    ];
    const result = parseMessage(msg);

    expect(result.atUsers).toEqual([]);
    expect(result.text).toBe("大家好");
  });

  test("混合 text 和多个 at → 文本拼接、at 列表完整", () => {
    const msg = [
      { type: "at", data: { qq: "111" } },
      { type: "text", data: { text: " " } },
      { type: "at", data: { qq: "222" } },
      { type: "text", data: { text: " 看这个" } },
    ];
    const result = parseMessage(msg);

    expect(result.atUsers).toEqual([111, 222]);
    // text 最终被 .trim()，前后空格被去除
    expect(result.text).toBe("看这个");
    expect(result.segmentTypes).toEqual(["at", "text", "at", "text"]);
  });
});

describe("estimateMsgType", () => {
  test("纯文本 → text", () => {
    expect(estimateMsgType(["text"], "hello")).toBe("text");
  });

  test("纯图片 → image", () => {
    expect(estimateMsgType(["image"], "")).toBe("image");
  });

  test("纯表情 → face", () => {
    expect(estimateMsgType(["face"], "")).toBe("face");
  });

  test("文本+表情 → text+face", () => {
    expect(estimateMsgType(["text", "face"], "hi")).toBe("text+face");
  });

  test("图片+文本 → mixed", () => {
    expect(estimateMsgType(["image", "text"], "hi")).toBe("mixed");
  });

  test("空数组 → unknown", () => {
    expect(estimateMsgType([], "")).toBe("unknown");
  });
});
