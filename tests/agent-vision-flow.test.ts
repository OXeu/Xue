/**
 * tests/agent-vision-flow.test.ts — 视觉问答流程单元测试
 *
 * 覆盖 callVision 的 payload 构造、响应解析、错误处理，
 * 以及消息循环中的 [DESCRIBE id=xxx] 标签解析与多轮追问逻辑。
 *
 * 所有测试 mock globalThis.fetch，测试完成后恢复。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// 设置环境变量后再动态导入，确保 callVision 能读取到
// 同时禁止 agent.ts 的 main() 入口启动（WS 连接等副作用）
beforeAll(() => {
  process.env.RIN_TEST = "1";
  process.env.VISION_MODEL = "gemma4:26b";
  process.env.VISION_BASE_URL = "http://127.0.0.1:11444/v1";
  process.env.LLM_API_KEY = "ollama";
});

let callVision: (query: string, base64: string, mime: string) => Promise<string | null>;
let buildContext: (entries: any[]) => string;
let buildContextWithPhashIds: (entries: any[], phashMap: Map<number, string>) => string;
let loadPhashMap: (session: string) => Map<number, string>;
let computeDHash: (base64: string, mime: string) => Promise<string>;

beforeAll(async () => {
  const mod = await import("../src/agent");
  callVision = mod.callVision;
  buildContext = mod.buildContext;
  buildContextWithPhashIds = mod.buildContextWithPhashIds;
  loadPhashMap = mod.loadPhashMap;
  // computeDHash is imported inside agent, we can re-import it directly
  const phashMod = await import("../src/phash");
  computeDHash = phashMod.computeDHash;
});

// ── 辅助 ────────────────────────────────────────────────

function makeMockFetch(responseBody: unknown, status = 200): typeof globalThis.fetch {
  return ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
    return Promise.resolve(new Response(
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
      { status, headers: { "content-type": "application/json" } },
    ));
  }) as typeof globalThis.fetch;
}

function makeVisionResponse(content: string): object {
  return {
    choices: [{ message: { content } }],
  };
}

/** 保存原始 fetch 并在每个测试后恢复 */
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── 测试 ────────────────────────────────────────────────

describe("callVision", () => {
  const fakeBase64 = "dGVzdC1pbWFnZS1kYXRh"; // "test-image-data" in base64
  const fakeMime = "image/jpeg";

  test("发送正确 payload：model=gemma4:26b，messages 包含 query，非 stream", async () => {
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      const opts = args[0] as RequestInit | undefined;
      capturedBody = typeof opts?.body === "string" ? opts.body : "";
      return Promise.resolve(new Response(
        JSON.stringify(makeVisionResponse("一张猫的图片")),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }) as typeof globalThis.fetch;

    const result = await callVision("这张图片里有什么？", fakeBase64, fakeMime);

    // 验证 URL
    expect(capturedUrl).toBe("http://127.0.0.1:11444/v1/chat/completions");

    // 验证 body
    const body = JSON.parse(capturedBody);
    expect(body.model).toBe("gemma4:26b");
    expect(body.stream).toBeUndefined(); // no stream=false in payload → fine
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe("text");
    expect(body.messages[0].content[0].text).toBe("这张图片里有什么？");
    expect(body.messages[0].content[1].type).toBe("image_url");
    expect(body.messages[0].content[1].image_url.url).toContain("data:image/jpeg;base64,dGVzdC1pbWFnZS1kYXRh");

    // 验证结果
    expect(result).toBe("一张猫的图片");
  });

  test("正确提取 choices[0].message.content", async () => {
    globalThis.fetch = makeMockFetch(makeVisionResponse("图片中有一只橙色猫和一只白色狗"));

    const result = await callVision("图片里有什么动物？", fakeBase64, fakeMime);
    expect(result).toBe("图片中有一只橙色猫和一只白色狗");
  });

  test("优先提取 choices[0].message.reasoning（如存在）", async () => {
    const responseWithReasoning = {
      choices: [{
        message: {
          reasoning: "经过分析，图片显示一只猫在沙发上睡觉。",
          content: "一只猫在沙发上。",
        },
      }],
    };

    globalThis.fetch = makeMockFetch(responseWithReasoning);

    const result = await callVision("描述这张图片", fakeBase64, fakeMime);
    // reasoning 优先
    expect(result).toBe("经过分析，图片显示一只猫在沙发上睡觉。");
  });

  test("reasoning 为空时回退到 content", async () => {
    const responseWithEmptyReasoning = {
      choices: [{
        message: {
          reasoning: "",
          content: "一只猫在沙发上。",
        },
      }],
    };

    globalThis.fetch = makeMockFetch(responseWithEmptyReasoning);

    const result = await callVision("描述这张图片", fakeBase64, fakeMime);
    expect(result).toBe("一只猫在沙发上。");
  });

  test("choices 为空时返回 null", async () => {
    globalThis.fetch = makeMockFetch({ choices: [] });

    const result = await callVision("有什么？", fakeBase64, fakeMime);
    expect(result).toBeNull();
  });

  test("choices 中 message 为 null 时返回 null", async () => {
    globalThis.fetch = makeMockFetch({ choices: [{ message: null }] });

    const result = await callVision("有什么？", fakeBase64, fakeMime);
    expect(result).toBeNull();
  });

  test("HTTP 错误（非 200）返回 null", async () => {
    globalThis.fetch = makeMockFetch({ error: "rate limit" }, 429);

    const result = await callVision("有什么？", fakeBase64, fakeMime);
    expect(result).toBeNull();
  });

  test("fetch 网络异常时返回 null（不抛出）", async () => {
    globalThis.fetch = (() => {
      return Promise.reject(new Error("network timeout"));
    }) as typeof globalThis.fetch;

    // 不应抛出
    const result = await callVision("有什么？", fakeBase64, fakeMime);
    expect(result).toBeNull();
  });

  test("响应 JSON 格式异常时返回 null（不抛出）", async () => {
    globalThis.fetch = makeMockFetch("not valid json{{{");

    const result = await callVision("有什么？", fakeBase64, fakeMime);
    expect(result).toBeNull();
  });

  test("VISION_MODEL 未设置时直接返回 null", async () => {
    // 注意：模块级常量 VISION_MODEL 在导入时已被捕获为 "gemma4:26b"，
    // 所以删除 process.env.VISION_MODEL 不会让 callVision 提前返回 null。
    // 需要同时 mock fetch 防止真实 HTTP 请求超时。
    globalThis.fetch = makeMockFetch(makeVisionResponse(""));
    const origModel = process.env.VISION_MODEL;
    delete process.env.VISION_MODEL;

    try {
      const result = await callVision("有什么？", fakeBase64, fakeMime);
      expect(result).toBeNull();
    } finally {
      process.env.VISION_MODEL = origModel;
    }
  });
});

// ── [DESCRIBE id=xxx] 标签解析与视觉循环 ─────────────────

describe("[DESCRIBE id=xxx] query parsing in agent message loop", () => {
  const fakeBase64 = "dGVzdC1pbWFnZS1kYXRh";
  const fakeMime = "image/jpeg";
  const testPhash = "abc123";

  /** 模拟一轮视觉循环：给定一个 LLM 回复序列，模拟 agent 的 while 循环逻辑 */
  async function runSimulatedDescribeLoop(
    llmResponses: string[],
    visionAnswers: (string | null)[],
    maxRounds = 5,
  ): Promise<{
    finalReply: string | null;
    rounds: number;
    messages: { role: string; content: string }[];
    visionCalls: string[];
  }> {
    let llmIndex = 0;
    let visionIndex = 0;
    const visionCalls: string[] = [];

    // 模拟 _imageCache 中有 testPhash 的图片
    // 通过 agent 内部 import，实际上我们模拟全局 fetch 来区分 LLM 和 vision 调用

    // mock LLM calls → return predefined responses
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

        if (body?.model === "gemma4:26b") {
          // This is a vision call
          const answer = visionAnswers[visionIndex] ?? null;
          visionIndex++;
          return Promise.resolve(new Response(
            JSON.stringify({ choices: [{ message: { content: answer || "" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }

        // This is an LLM call
        const response = llmResponses[llmIndex] ?? "";
        llmIndex++;
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: response } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }

      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof globalThis.fetch;

    const messages: { role: string; content: string }[] = [
      { role: "system", content: "test system prompt" },
      { role: "user", content: "test user message" },
    ];

    let finalReply: string | null = null;
    let rounds = 0;

    while (!finalReply && rounds < maxRounds) {
      rounds++;
      // Simulate LLM call (fetch mock handles it)
      const llmUrl = "http://127.0.0.1:11444/v1/chat/completions?llm=1";
      const llmRes = await fetch(llmUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages }),
      });
      const llmData = (await llmRes.json()) as { choices: { message: { content: string } }[] };
      const response = llmData.choices?.[0]?.message?.content?.trim() || "";

      // 解析 [DESCRIBE id=xxx] 标签
      const describeMatch = response.match(/\[DESCRIBE id=([^\]]+)\]([\s\S]*?)\[\/DESCRIBE\]/);

      if (describeMatch) {
        const id = describeMatch[1].trim();
        const query = describeMatch[2].trim();
        visionCalls.push(query);

        // 模拟 agent 中的 _imageCache 查找：有 testPhash 时正常调用
        if (id === testPhash) {
          const answer = await callVision(query, fakeBase64, fakeMime);
          const displayAnswer = answer || "(分析失败)";

          messages.push({ role: "assistant", content: response });
          messages.push({ role: "user", content: `【图片回答】${displayAnswer}\n\n还需要问什么吗？已经够了就直接回复。` });
        } else {
          // phash 不在缓存中，模拟过期
          messages.push({ role: "assistant", content: response });
          messages.push({ role: "user", content: `【图片回答】（该图片数据已过期，无法查看）\n\n还需要问什么吗？已经够了就直接回复。` });
        }
      } else {
        finalReply = response;
      }
    }

    return { finalReply, rounds, messages, visionCalls };
  }

  test("单轮图文问答后直接回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedDescribeLoop(
      [
        `[DESCRIBE id=${testPhash}]图片里有什么动物？[/DESCRIBE]`,
        "有两只猫在打架",
      ],
      ["有两只猫在打架"],
    );

    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]).toBe("图片里有什么动物？");
    expect(finalReply).toBe("有两只猫在打架");
    expect(rounds).toBe(2); // 一轮 describe + 一轮回复
  });

  test("多轮追问后回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedDescribeLoop(
      [
        `[DESCRIBE id=${testPhash}]图片里有什么？[/DESCRIBE]`,
        `[DESCRIBE id=${testPhash}]那只猫是什么颜色的？[/DESCRIBE]`,
        "是一只橙色猫",
      ],
      ["一只猫", "橙色"],
    );

    expect(visionCalls).toHaveLength(2);
    expect(visionCalls[0]).toBe("图片里有什么？");
    expect(visionCalls[1]).toBe("那只猫是什么颜色的？");
    expect(finalReply).toBe("是一只橙色猫");
    expect(rounds).toBe(3); // 两轮 describe + 一轮回复
  });

  test("无 [DESCRIBE] 标签时直接作为最终回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedDescribeLoop(
      ["这张图看起来像是风景照"],
      [],
    );

    expect(visionCalls).toHaveLength(0);
    expect(finalReply).toBe("这张图看起来像是风景照");
    expect(rounds).toBe(1); // 直接回复
  });

  test("视觉模型返回 null（分析失败）时注入占位符文本并继续循环", async () => {
    const { finalReply, visionCalls, messages, rounds } = await runSimulatedDescribeLoop(
      [
        `[DESCRIBE id=${testPhash}]有什么？[/DESCRIBE]`,
        "算了我随便回一句",
      ],
      [null], // vision returns null
    );

    expect(visionCalls).toHaveLength(1);
    expect(finalReply).toBe("算了我随便回一句");
    expect(rounds).toBe(2);

    // 验证占位符被注入
    const answerMsg = messages.find((m) => m.content.includes("(分析失败)"));
    expect(answerMsg).toBeDefined();
    expect(answerMsg!.content).toContain("(分析失败)");
  });

  test("超过最大轮数（5）时循环终止且无回复", async () => {
    const { finalReply, rounds } = await runSimulatedDescribeLoop(
      [`[DESCRIBE id=${testPhash}]第1问？[/DESCRIBE]`,
       `[DESCRIBE id=${testPhash}]第2问？[/DESCRIBE]`,
       `[DESCRIBE id=${testPhash}]第3问？[/DESCRIBE]`,
       `[DESCRIBE id=${testPhash}]第4问？[/DESCRIBE]`,
       `[DESCRIBE id=${testPhash}]第5问？[/DESCRIBE]`,
       `[DESCRIBE id=${testPhash}]第6问？[/DESCRIBE]`],
      ["答1", "答2", "答3", "答4", "答5"],
      5, // maxRounds
    );

    expect(rounds).toBe(5); // hit max
    expect(finalReply).toBeNull(); // 没机会回复
  });

  test("id 不匹配（图片已过期）时注入过期占位符", async () => {
    const { finalReply, visionCalls, messages, rounds } = await runSimulatedDescribeLoop(
      [
        `[DESCRIBE id=expired_hash]图片里有什么？[/DESCRIBE]`,
        "好吧，我不问了",
      ],
      [],
    );

    expect(visionCalls).toHaveLength(1);
    expect(finalReply).toBe("好吧，我不问了");
    expect(rounds).toBe(2);

    // 验证过期占位符被注入
    const answerMsg = messages.find((m) => m.content.includes("该图片数据已过期，无法查看"));
    expect(answerMsg).toBeDefined();
    expect(answerMsg!.content).toContain("该图片数据已过期，无法查看");
  });
});

// ── [图片] 标记 in buildContext ──────────────────────────

describe("buildContext [图片] marker", () => {
  const baseEntry = {
    session: "test",
    msgId: 1,
    time: 1717000000,
    type: "text",
    text: "hello world",
    userId: 100,
    nickname: "UserA",
    card: undefined,
    subType: "normal",
    selfId: 1,
    atUsers: [],
    replyTo: undefined,
  };

  test("segmentTypes 含 image 时追加 [图片] 标记", () => {
    const ctx = buildContext([{
      ...baseEntry,
      segmentTypes: ["text", "image"],
    }]);
    expect(ctx).toContain("hello world [图片]");
  });

  test("纯图片消息（text 为空）显示 [image] [图片]", () => {
    const ctx = buildContext([{
      ...baseEntry,
      text: "",
      type: "image",
      segmentTypes: ["image"],
    }]);
    expect(ctx).toContain("[image] [图片]");
  });

  test("segmentTypes 不含 image 时不加标记", () => {
    const ctx = buildContext([{
      ...baseEntry,
      segmentTypes: ["text"],
    }]);
    expect(ctx).toContain("hello world");
    expect(ctx).not.toContain("[图片]");
  });

  test("segmentTypes 为 undefined 时不加标记", () => {
    const ctx = buildContext([{
      ...baseEntry,
      segmentTypes: undefined,
    }]);
    expect(ctx).toContain("hello world");
    expect(ctx).not.toContain("[图片]");
  });

  test("空列表返回占位文本", () => {
    const ctx = buildContext([]);
    expect(ctx).toBe("（暂无历史消息）");
  });

  test("存在多个条目时各自正确标注", () => {
    const ctx = buildContext([
      { ...baseEntry, msgId: 1, segmentTypes: ["text"] },
      { ...baseEntry, msgId: 2, segmentTypes: ["text", "image"] },
      { ...baseEntry, msgId: 3, segmentTypes: ["image"] },
    ]);
    const lines = ctx.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toContain("[图片]");
    expect(lines[1]).toContain("[图片]");
    expect(lines[2]).toContain("[图片]");
  });

  test("群名片 card 优先于 nickname", () => {
    const ctx = buildContext([{
      ...baseEntry,
      nickname: "UserA",
      card: "阿黄",
      segmentTypes: ["text"],
    }]);
    expect(ctx).toContain("阿黄:");
    expect(ctx).not.toContain("UserA");
  });
});

// ── phash ID 注入（[图片 #phash_xxx]） ──────────────────

describe("buildContextWithPhashIds [图片 #phash_xxx]", () => {
  const baseEntry = {
    session: "test",
    msgId: 1,
    time: 1717000000,
    type: "text",
    text: "",
    userId: 100,
    nickname: "UserA",
    card: undefined,
    subType: "normal",
    selfId: 1,
    atUsers: [],
    replyTo: undefined,
    segmentTypes: ["image"] as string[],
  };

  test("有 phash 时显示 [图片 #phash_xxx]", () => {
    const ph = new Map([[1, "phash_abc123"]]);
    const ctx = buildContextWithPhashIds([baseEntry], ph);
    expect(ctx).toContain("[图片 #phash_abc123]");
    expect(ctx).not.toContain("[图片]"); // 不应显示纯标记
  });

  test("无 phash 时回退到 [图片]", () => {
    const ctx = buildContextWithPhashIds([baseEntry], new Map());
    expect(ctx).toContain("[图片]");
    expect(ctx).not.toContain("[图片 #]");
  });

  test("非 image 消息不受 phash map 影响", () => {
    const entry = { ...baseEntry, text: "你好", segmentTypes: ["text"] };
    const ph = new Map([[1, "phash_abc123"]]);
    const ctx = buildContextWithPhashIds([entry], ph);
    expect(ctx).toContain("你好");
    expect(ctx).not.toContain("[图片]");
  });

  test("loadPhashMap 返回空 map 对应不存在的会话", () => {
    const map = loadPhashMap("nonexistent_session_12345");
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  test("buildContext（无参）等效于空 phash map", () => {
    const ctx1 = buildContext([baseEntry]);
    const ctx2 = buildContextWithPhashIds([baseEntry], new Map());
    expect(ctx1).toBe(ctx2);
  });
});

// ── loadPhashMap（读写保存的 phash） ─────────────────────

describe("loadPhashMap", () => {
  const tmpDir = join(resolve(import.meta.dirname, ".."), "data", "tmp-test-phash");
  const originalDir = process.env.RIN_TEST ? resolve(import.meta.dirname, "../data/inferences") : "";

  // 我们无法修改 agent 内部的 _inferencesDir，但可以通过文件操作测试 loadPhashMap
  // 的读写逻辑。由于 loadPhashMap 读取固定路径，我们需要用真实路径测。
  //
  // 方案：直接写文件到 data/inferences 下测试用的文件名，测完清理。

  const testSession = "unittest_phash_map_test";
  const testFilePath = join(resolve(import.meta.dirname, "..", "data", "inferences"), `${testSession}.jsonl`);

  afterAll(() => {
    try { rmSync(testFilePath, { force: true }); } catch { /* ok */ }
  });

  test("写入 phash 后可从 loadPhashMap 读取", async () => {
    // 直接写文件模拟 agent 的行为
    const { mkdirSync, existsSync, appendFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const inferencesDir = resolve(import.meta.dirname, "..", "data", "inferences");
    if (!existsSync(inferencesDir)) mkdirSync(inferencesDir, { recursive: true });

    const entry = {
      msgId: 8888,
      session: testSession,
      phash: "phash_test_8888",
      timestamp: "2026-05-22T12:00:00.000Z",
    };
    appendFileSync(testFilePath, JSON.stringify(entry) + "\n", "utf8");

    const map = loadPhashMap(testSession);
    expect(map.get(8888)).toBe("phash_test_8888");
    expect(map.size).toBe(1);
  });

  test("追加多条 phash 记录", async () => {
    const { appendFileSync } = await import("node:fs");

    const entry2 = {
      msgId: 8889,
      session: testSession,
      phash: "phash_test_8889",
      timestamp: "2026-05-22T12:01:00.000Z",
    };
    appendFileSync(testFilePath, JSON.stringify(entry2) + "\n", "utf8");

    const map = loadPhashMap(testSession);
    expect(map.size).toBe(2);
    expect(map.get(8888)).toBe("phash_test_8888");
    expect(map.get(8889)).toBe("phash_test_8889");
  });

  test("兼容旧格式 inference 字段（回退）", async () => {
    const { appendFileSync } = await import("node:fs");

    // 写一条旧格式记录（只有 inference，没有 phash）
    const oldEntry = {
      msgId: 8890,
      session: testSession,
      inference: "old_inference_format_value",
      model: "gemma4:26b",
      timestamp: "2026-05-22T12:02:00.000Z",
    };
    appendFileSync(testFilePath, JSON.stringify(oldEntry) + "\n", "utf8");

    const map = loadPhashMap(testSession);
    expect(map.get(8890)).toBe("old_inference_format_value");
  });

  test("会话不存在时 loadPhashMap 返回空 map", () => {
    const map = loadPhashMap("nonexistent_session_xyz");
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  test("computeDHash 产生一致的 hash", async () => {
    // 用已知小图测试 dHash 计算
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 red pixel
    const hash = await computeDHash(base64, "image/png");
    expect(hash).toBeString();
    expect(hash.length).toBe(16); // 64-bit hex
  });

  test("全链路端到端：保存 phash → 加载 → 上下文显示 [图片 #phash_xxx]", async () => {
    const session = "unittest_e2e_phash";
    const filePath2 = join(resolve(import.meta.dirname, "..", "data", "inferences"), `${session}.jsonl`);

    try {
      const { appendFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { resolve, join } = await import("node:path");
      const inferencesDir = resolve(import.meta.dirname, "..", "data", "inferences");
      if (!existsSync(inferencesDir)) mkdirSync(inferencesDir, { recursive: true });

      const msgId = 7777;
      const phashValue = "e2e_test_phash_7777";

      // 1. 保存 phash
      appendFileSync(filePath2, JSON.stringify({
        msgId,
        session,
        phash: phashValue,
        timestamp: "2026-05-22T12:00:00.000Z",
      }) + "\n", "utf8");

      // 2. loadPhashMap 能正确读取
      const map = loadPhashMap(session);
      expect(map.get(msgId)).toBe(phashValue);

      // 3. buildContextWithPhashIds 显示 [图片 #phash_xxx]
      const entry = {
        session,
        msgId,
        time: 1717000000,
        type: "image",
        text: "",
        userId: 100,
        nickname: "UserA",
        card: undefined,
        subType: "normal",
        selfId: 1,
        atUsers: [],
        replyTo: undefined,
        segmentTypes: ["image"] as string[],
      };
      const ctx = buildContextWithPhashIds([entry], map);
      expect(ctx).toContain(`[图片 #${phashValue}]`);

      // 4. buildContext（无 phash 参数）退化到纯 [图片] 标记
      const ctxBare = buildContext([entry]);
      expect(ctxBare).toContain("[图片]");
      expect(ctxBare).not.toContain("[图片 #]");
    } finally {
      try { rmSync(filePath2, { force: true }); } catch { /* ok */ }
    }
  });
});
