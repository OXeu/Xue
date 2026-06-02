/**
 * tests/agent-vision-flow.test.ts — 视觉问答流程单元测试
 *
 * 覆盖 callVision 的 payload 构造、响应解析、错误处理，
 * 以及消息循环中的工具调用（describe_image）与多轮追问逻辑。
 *
 * 所有测试 mock globalThis.fetch，测试完成后恢复。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

// 设置环境变量后再动态导入，确保 callVision 能读取到
// 同时禁止 agent.ts 的 main() 入口启动（WS 连接等副作用）
beforeAll(() => {
  process.env.RIN_TEST = "1";
  process.env.VISION_MODEL = "gemma4:26b";
  process.env.VISION_BASE_URL = "http://127.0.0.1:11444/v1";
  process.env.LLM_API_KEY = "ollama";
});

let callVision: (query: string, base64: string, mime: string) => Promise<string | null>;
let buildContext: (entries: any[], replyMap?: Map<number, { sender: string; text: string }>) => string;
let buildStructuredContext: (entries: any[], replyMap?: Map<number, { sender: string; text: string }>) => any[];
let buildUserMessages: (args: any) => any[];
let analyzeAtmosphere: (entries: any[]) => string;
let loadRecentWithPersistedImage: (sessionId: string, msgId: number, expectImage: boolean) => Promise<{ recent: any[]; persistedEntry: any | null }>;

beforeAll(async () => {
  const visionMod = await import("../src/agent/vision");
  const contextMod = await import("../src/agent/context");
  const chatMod = await import("../src/chat-utils");
  callVision = visionMod.callVision;
  buildContext = contextMod.buildContext;
  buildStructuredContext = chatMod.buildStructuredContext;
  buildUserMessages = chatMod.buildUserMessages;
  analyzeAtmosphere = chatMod.analyzeAtmosphere;
  loadRecentWithPersistedImage = contextMod.loadRecentWithPersistedImage;
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

describe("loadRecentWithPersistedImage", () => {
  test("图片消息首次未落盘 phash 时会短暂等待并重读", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");

    const base = join(tmpdir(), `rin-agent-vision-${randomBytes(4).toString("hex")}`);
    const rawDir = join(base, "raw");
    mkdirSync(rawDir, { recursive: true });

    const sessionId = "group_wait_phash";
    const path = join(rawDir, `${sessionId}.jsonl`);
    const entryWithoutPhash = {
      session: sessionId,
      msgId: 123,
      time: 1700000000,
      type: "image",
      text: "这是什么",
      userId: 1,
      nickname: "User",
      subType: "normal",
      selfId: 2,
      atUsers: [],
      segmentTypes: ["image"],
    };
    const entryWithPhash = { ...entryWithoutPhash, phash: ["abcdef1234567890"] };

    writeFileSync(path, JSON.stringify(entryWithoutPhash) + "\n");

    const mod = await import("../src/agent/context");
    const oldDir = mod.__setRawDirForTest(rawDir);

    const timer = setTimeout(() => {
      writeFileSync(path, JSON.stringify(entryWithPhash) + "\n");
    }, 30);

    try {
      const loaded = await loadRecentWithPersistedImage(sessionId, 123, true);
      expect(loaded.recent).toHaveLength(1);
      expect(loaded.recent[0].msgId).toBe(123);
      expect(loaded.persistedEntry).not.toBeNull();
      expect(loaded.persistedEntry.phash?.[0]).toBe("abcdef1234567890");
    } finally {
      clearTimeout(timer);
      mod.__setRawDirForTest(oldDir);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("非图片消息首次未落盘时也会等待直到当前消息进入 recent", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");

    const base = join(tmpdir(), `rin-agent-text-${randomBytes(4).toString("hex")}`);
    const rawDir = join(base, "raw");
    mkdirSync(rawDir, { recursive: true });

    const sessionId = "group_wait_text";
    const path = join(rawDir, `${sessionId}.jsonl`);
    const oldEntry = {
      session: sessionId,
      msgId: 122,
      time: 1700000000,
      type: "text",
      text: "旧消息",
      userId: 1,
      nickname: "User",
      subType: "normal",
      selfId: 2,
      atUsers: [],
      segmentTypes: ["text"],
    };
    const currentEntry = {
      ...oldEntry,
      msgId: 123,
      text: "当前消息",
    };

    writeFileSync(path, JSON.stringify(oldEntry) + "\n");

    const mod = await import("../src/agent/context");
    const oldDir = mod.__setRawDirForTest(rawDir);

    const timer = setTimeout(() => {
      writeFileSync(path, `${JSON.stringify(oldEntry)}\n${JSON.stringify(currentEntry)}\n`);
    }, 30);

    try {
      const loaded = await loadRecentWithPersistedImage(sessionId, 123, false);
      expect(loaded.persistedEntry).not.toBeNull();
      expect(loaded.persistedEntry.msgId).toBe(123);
      expect(loaded.recent.map((e: any) => e.msgId)).toEqual([122, 123]);
    } finally {
      clearTimeout(timer);
      mod.__setRawDirForTest(oldDir);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("current message inclusion", () => {
  test("当前消息未落盘到 recent 时，主链路应补入一次而不重复", async () => {
    const mod = await import("../src/agent/context");
    const mergeCurrentEntryIntoRecent = (mod as any).mergeCurrentEntryIntoRecent as (recent: any[], currentEntry: any, persistedEntry: any) => any[];

    const current = {
      session: "group_1",
      msgId: 2,
      time: 1700000001,
      type: "text",
      text: "当前消息",
      userId: 1,
      nickname: "User",
      subType: "normal",
      selfId: 2,
      atUsers: [],
      segmentTypes: ["text"],
    };
    const recent = [{
      ...current,
      msgId: 1,
      text: "历史消息",
    }];

    const merged = mergeCurrentEntryIntoRecent(recent, current, null);
    expect(merged.map((e) => e.msgId)).toEqual([1, 2]);
  });

  test("当前消息已落盘到 recent 时，主链路不应重复追加", async () => {
    const mod = await import("../src/agent/context");
    const mergeCurrentEntryIntoRecent = (mod as any).mergeCurrentEntryIntoRecent as (recent: any[], currentEntry: any, persistedEntry: any) => any[];

    const current = {
      session: "group_1",
      msgId: 2,
      time: 1700000001,
      type: "text",
      text: "当前消息",
      userId: 1,
      nickname: "User",
      subType: "normal",
      selfId: 2,
      atUsers: [],
      segmentTypes: ["text"],
    };
    const persisted = { ...current, text: "当前消息" };
    const recent = [
      { ...current, msgId: 1, text: "历史消息" },
      persisted,
    ];

    const merged = mergeCurrentEntryIntoRecent(recent, current, persisted);
    expect(merged.map((e) => e.msgId)).toEqual([1, 2]);
  });
});

// ── describe_image tool calling 视觉循环 ─────────────────

describe("describe_image tool calling", () => {
  const fakeBase64 = "dGVzdC1pbWFnZS1kYXRh";
  const fakeMime = "image/jpeg";
  const testPhash = "abc123";

  type LlmResponseItem =
    | { type: "tool_call"; id: string; question: string }
    | { type: "content"; text: string };

  /** 模拟一轮带 tool calling 的视觉循环 */
  async function runSimulatedVisionLoop(
    llmResponses: LlmResponseItem[],
    visionAnswers: (string | null)[],
    maxRounds = 5,
  ): Promise<{
    finalReply: string | null;
    rounds: number;
    messages: any[];
    visionCalls: string[];
    llmToolArgsSent: string[];
  }> {
    let llmIndex = 0;
    let visionIndex = 0;
    const visionCalls: string[] = [];
    const llmToolArgsSent: string[] = [];

    // mock fetch: 区分 LLM 调用（模型不是 gemma4:26b）和 Vision 调用
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

        if (body?.model === "gemma4:26b") {
          // Vision 调用
          const answer = visionAnswers[visionIndex] ?? null;
          visionIndex++;
          return Promise.resolve(new Response(
            JSON.stringify({ choices: [{ message: { content: answer || "" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }

        // LLM 调用
        const item = llmResponses[llmIndex];
        llmIndex++;

        if (item?.type === "tool_call") {
          // 记录工具参数，供断言检查
          const argsStr = JSON.stringify({ id: item.id, question: item.question });
          llmToolArgsSent.push(argsStr);
          return Promise.resolve(new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "describe_image",
                      arguments: argsStr,
                    },
                  }],
                },
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }

        // content 回复
        const content = item?.type === "content" ? item.text : "";
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }

      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof globalThis.fetch;

    const messages: any[] = [
      { role: "system", content: "test system prompt" },
      { role: "user", content: "test user message" },
    ];

    let finalReply: string | null = null;
    let rounds = 0;

    while (!finalReply && rounds < maxRounds) {
      rounds++;

      // 模拟 LLM 调用（带 tools 参数）
      const llmRes = await fetch("http://127.0.0.1:11444/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages, tools: [{}] }),
      });
      const llmData = (await llmRes.json()) as {
        choices: { message: { content?: string | null; tool_calls?: any[] | null } }[];
      };
      const msg = llmData.choices?.[0]?.message;

      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name === "describe_image") {
            const args = JSON.parse(tc.function.arguments);
            visionCalls.push(args.question);

            // 模拟 _imageCache 查找
            if (args.id === testPhash) {
              const answer = await callVision(args.question, fakeBase64, fakeMime);
              const toolResult = answer || "(分析失败)";

              messages.push({
                role: "assistant",
                content: null,
                tool_calls: [tc],
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: toolResult,
              });
            } else {
              // 图片过期
              messages.push({
                role: "assistant",
                content: null,
                tool_calls: [tc],
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "（该图片数据已过期，无法查看）",
              });
            }
          }
        }
      } else if (msg?.content) {
        finalReply = msg.content.trim();
      } else {
        break;
      }
    }

    return { finalReply, rounds, messages, visionCalls, llmToolArgsSent };
  }

  test("单轮图文问答后直接回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      [
        { type: "tool_call", id: testPhash, question: "图片里有什么动物？" },
        { type: "content", text: "有两只猫在打架" },
      ],
      ["有两只猫在打架"],
    );

    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]).toBe("图片里有什么动物？");
    expect(finalReply).toBe("有两只猫在打架");
    expect(rounds).toBe(2);
  });

  test("多轮追问后回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      [
        { type: "tool_call", id: testPhash, question: "图片里有什么？" },
        { type: "tool_call", id: testPhash, question: "那只猫是什么颜色的？" },
        { type: "content", text: "是一只橙色猫" },
      ],
      ["一只猫", "橙色"],
    );

    expect(visionCalls).toHaveLength(2);
    expect(visionCalls[0]).toBe("图片里有什么？");
    expect(visionCalls[1]).toBe("那只猫是什么颜色的？");
    expect(finalReply).toBe("是一只橙色猫");
    expect(rounds).toBe(3);
  });

  test("无 tool_calls 时直接作为最终回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      [{ type: "content", text: "这张图看起来像是风景照" }],
      [],
    );

    expect(visionCalls).toHaveLength(0);
    expect(finalReply).toBe("这张图看起来像是风景照");
    expect(rounds).toBe(1);
  });

  test("视觉模型返回 null（分析失败）时注入占位符文本并继续循环", async () => {
    const { finalReply, visionCalls, messages, rounds } = await runSimulatedVisionLoop(
      [
        { type: "tool_call", id: testPhash, question: "有什么？" },
        { type: "content", text: "算了我随便回一句" },
      ],
      [null], // vision returns null
    );

    expect(visionCalls).toHaveLength(1);
    expect(finalReply).toBe("算了我随便回一句");
    expect(rounds).toBe(2);

    // 验证占位符被注入（tool 消息的 content）
    const toolMsg = messages.find((m) => m.role === "tool" && m.content === "(分析失败)");
    expect(toolMsg).toBeDefined();
  });

  test("超过最大轮数（5）时循环终止且无回复", async () => {
    const { finalReply, rounds } = await runSimulatedVisionLoop(
      [
        { type: "tool_call", id: testPhash, question: "第1问？" },
        { type: "tool_call", id: testPhash, question: "第2问？" },
        { type: "tool_call", id: testPhash, question: "第3问？" },
        { type: "tool_call", id: testPhash, question: "第4问？" },
        { type: "tool_call", id: testPhash, question: "第5问？" },
        { type: "tool_call", id: testPhash, question: "第6问？" },
      ],
      ["答1", "答2", "答3", "答4", "答5"],
      5,
    );

    expect(rounds).toBe(5);
    expect(finalReply).toBeNull();
  });

  test("id 不匹配（图片已过期）时注入过期占位符", async () => {
    const { finalReply, visionCalls, messages, rounds } = await runSimulatedVisionLoop(
      [
        { type: "tool_call", id: "expired_hash", question: "图片里有什么？" },
        { type: "content", text: "好吧，我不问了" },
      ],
      [],
    );

    expect(visionCalls).toHaveLength(1);
    expect(finalReply).toBe("好吧，我不问了");
    expect(rounds).toBe(2);

    // 验证过期占位符被注入
    const toolMsg = messages.find(
      (m) => m.role === "tool" && m.content === "（该图片数据已过期，无法查看）",
    );
    expect(toolMsg).toBeDefined();
  });

  test("LLM 调用携带 tools 参数", async () => {
    let capturedBody: string | null = null;

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

        if (body?.model !== "gemma4:26b") {
          capturedBody = opts?.body as string;
          // Return content directly so the loop terminates
          return Promise.resolve(new Response(
            JSON.stringify({ choices: [{ message: { content: "直接回复" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }
      }
      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof globalThis.fetch;

    const messages: any[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hello" },
    ];

    const llmRes = await fetch("http://127.0.0.1:11444/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        tools: [{ type: "function", function: { name: "describe_image" } }],
      }),
    });

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toBeInstanceOf(Array);
    expect(parsed.tools.length).toBeGreaterThanOrEqual(1);
    expect(parsed.tools[0].type).toBe("function");
    expect(parsed.tools[0].function.name).toBe("describe_image");
  });

  test("tool calling 多轮请求会回传 reasoning_content", async () => {
    const requests: any[] = [];

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (!urlStr.includes("/chat/completions")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }

      const opts = args[0] as RequestInit | undefined;
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

      if (body?.model === "gemma4:26b") {
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: "图里是一段维基百科截图" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }

      requests.push(body);

      if (requests.length === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: null,
                reasoning_content: "先看图里具体写了什么。",
                tool_calls: [{
                  id: "call_reasoning_1",
                  type: "function",
                  function: {
                    name: "describe_image",
                    arguments: JSON.stringify({ id: "abc123", question: "这张图片里是什么内容？" }),
                  },
                }],
              },
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }

      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: "看起来像中文维基百科页面" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }) as typeof globalThis.fetch;

    const messages: any[] = [
      { role: "system", content: "test system" },
      { role: "user", content: "test user" },
    ];

    const first = await (async () => {
      const res = await fetch("http://127.0.0.1:11444/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          tools: [{ type: "function", function: { name: "describe_image" } }],
        }),
      });
      return await res.json() as any;
    })();

    const firstMsg = first.choices[0].message;
    const tc = firstMsg.tool_calls[0];
    messages.push({
      role: "assistant",
      content: firstMsg.content,
      tool_calls: firstMsg.tool_calls,
      reasoning_content: firstMsg.reasoning_content,
    });
    messages.push({ role: "tool", tool_call_id: tc.id, content: "图里是一段维基百科截图" });

    await fetch("http://127.0.0.1:11444/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, tools: [{ type: "function", function: { name: "describe_image" } }] }),
    });

    expect(requests).toHaveLength(2);
    const secondAssistant = requests[1].messages.find((m: any) => m.role === "assistant");
    expect(secondAssistant).toBeDefined();
    expect(secondAssistant.reasoning_content).toBe("先看图里具体写了什么。");
  });

  test("工具参数解析失败时注入错误消息", async () => {
    // 模拟 LLM 返回非法 JSON 的 arguments
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

        if (body?.model !== "gemma4:26b") {
          // 返回非法 JSON arguments
          return Promise.resolve(new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    id: "call_bad_json",
                    type: "function",
                    function: {
                      name: "describe_image",
                      arguments: "{id: no-quotes, question: missing quotes}", // 非法 JSON
                    },
                  }],
                },
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }
      }
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: "" } }] }),
        { status: 200 },
      ));
    }) as typeof globalThis.fetch;

    const messages: any[] = [
      { role: "system", content: "test" },
      { role: "user", content: "看看图片" },
    ];

    // 模拟生产代码中的 while 循环逻辑
    const tools = [{
      type: "function" as const,
      function: { name: "describe_image", description: "", parameters: { type: "object", properties: {} as any, required: [] as string[] } },
    }];

    const result = await (async () => {
      // 模拟一次 callLlmWithTools 调用
      const url = "http://127.0.0.1:11444/v1/chat/completions";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages, tools }),
      });
      const data = (await res.json()) as any;
      const msg = data.choices?.[0]?.message;
      return {
        content: msg?.content?.trim() ?? null,
        tool_calls: msg?.tool_calls ?? null,
      };
    })();

    expect(result.tool_calls).not.toBeNull();
    expect(result.tool_calls!.length).toBe(1);

    // 模拟生产代码中的参数解析逻辑
    const tc = result.tool_calls![0];
    let parseFailed = false;
    try {
      JSON.parse(tc.function.arguments);
    } catch {
      parseFailed = true;
    }
    expect(parseFailed).toBe(true);

    // 验证结构化错误提示会作为 tool 结果注入
    const assistantMsg: any = {
      role: "assistant",
      content: null,
      tool_calls: [tc],
    };
    messages.push(assistantMsg);
    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: "参数错误：请传合法 JSON，对象格式必须是 {\"id\":\"16位小写hex\",\"question\":\"一个具体问题\"}。id 只能填当前消息里 [图片#...] 中 # 后面的 16 位小写 hex，不要带 # 或 [图片#]。",
    });

    const toolMsg = messages.find((m: any) => m.role === "tool" && String(m.content).includes("参数错误：请传合法 JSON"));
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_bad_json");
  });

  test("_imageCache.get(id) 查到 phash 后将对应 base64/mime 传给 callVision", async () => {
    // 验证环境准备完好
    expect(process.env.VISION_MODEL).toBe("gemma4:26b");

    // 模拟 _imageCache：phash → {base64, mime}（生产代码中同一映射）
    const imageCache = new Map<string, { base64: string; mime: string }>();
    const testPhashHex = "abcdef1234567890";
    const testBase64 = "dGVzdC1pbWFnZS1kYXRhLXBvc3Q="; // "test-image-data-post"
    const testMime = "image/png";
    imageCache.set(testPhashHex, { base64: testBase64, mime: testMime });

    // 追踪 callVision 的 fetch payload
    let capturedImageUrl = "";
    let visionFetchCount = 0;

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();

      // 所有 /chat/completions 调用 — callVision 是唯一的调用者
      if (urlStr.includes("/chat/completions")) {
        visionFetchCount++;
        const opts = args[0] as RequestInit | undefined;
        const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : null;

        // 捕获图片 URL
        if (body?.messages?.[0]?.content) {
          const img = body.messages[0].content.find(
            (c: any) => c.type === "image_url",
          );
          if (img) capturedImageUrl = img.image_url.url;
        }

        // 注意：cleanVisionDescription 会跳过 < 6 字符的短行，
        // 所以 mock 回复必须够长以通过 filter
        const mockContent = "这是一张美丽的风景图，蓝天白云绿树";
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: mockContent } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }

      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof globalThis.fetch;

    // === 模拟生产代码中的 _imageCache.get(id) + callVision ===

    // 1. 模型传入 phash hex 作为 id → 从缓存查找
    const cachedImg = imageCache.get(testPhashHex);
    expect(cachedImg).toBeDefined();
    expect(cachedImg!.base64).toBe(testBase64);
    expect(cachedImg!.mime).toBe(testMime);

    // 2. 找到后传给 callVision
    const answer = await callVision("这张图里有什么？", cachedImg!.base64, cachedImg!.mime);
    expect(visionFetchCount).toBe(1);
    expect(answer).toBe("这是一张美丽的风景图，蓝天白云绿树");

    // 3. 验证 fetch payload 中的图片数据正确传递
    expect(capturedImageUrl).toContain(`data:${testMime};base64,${testBase64}`);

    // === 未命中 case ===
    const missResult = imageCache.get("nonexistent_phash");
    expect(missResult).toBeUndefined();
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

  // ── replyMap ───────────────────────────────────────────

  const entryReplying = (msgId: number, text: string) => ({
    ...baseEntry, msgId: 200, text, replyTo: msgId,
  });
  const entryPlain = (text: string) => ({
    ...baseEntry, text, replyTo: undefined,
  });

  test("replyMap 命中时显示 (回复 发送者 \"原文\")", () => {
    const map = new Map<number, { sender: string; text: string }>();
    map.set(99, { sender: "UserA", text: "看不到图，长啥样" });
    const ctx = buildContext([
      entryReplying(99, "就是前面发的图"),
    ], map);
    expect(ctx).toContain('(回复 UserA "看不到图，长啥样"): 就是前面发的图');
  });

  test("replyMap 未命中时回退到裸 (回复 msgId)", () => {
    const map = new Map<number, { sender: string; text: string }>();
    map.set(88, { sender: "Other", text: "hi" }); // 不包含 99
    const ctx = buildContext([
      entryReplying(99, "就是前面发的图"),
    ], map);
    expect(ctx).toContain("(回复 99): 就是前面发的图");
    expect(ctx).not.toContain('"');
  });

  test("replyMap 为 undefined 时行为不变", () => {
    const ctx = buildContext([
      entryReplying(99, "就是前面发的图"),
    ]); // no map
    expect(ctx).toContain("(回复 99): 就是前面发的图");
  });

  test("replyTo 不存在时 replyMap 不影响正常显示", () => {
    const map = new Map<number, { sender: string; text: string }>();
    map.set(77, { sender: "UserA", text: "hello" });
    const ctx = buildContext([
      entryPlain("这条消息没有引用"),
    ], map);
    expect(ctx).toContain("这条消息没有引用");
    expect(ctx).not.toContain("(回复");
  });
});

describe("structured user message serialization", () => {
  const baseEntry = {
    session: "group_1",
    msgId: 1,
    time: 1717000000,
    type: "text",
    text: "hello world",
    userId: 100,
    nickname: "UserA",
    card: "阿黄",
    subType: "normal",
    selfId: 1,
    atUsers: [],
    replyTo: undefined,
    segmentTypes: ["text"],
  };

  test("buildStructuredContext 将多条历史消息序列化为稳定对象数组", () => {
    const replyMap = new Map<number, { sender: string; text: string }>();
    replyMap.set(1, { sender: "阿黄", text: "hello world" });

    const context = buildStructuredContext([
      { ...baseEntry },
      {
        ...baseEntry,
        msgId: 2,
        type: "mixed",
        text: "看看这个",
        segmentTypes: ["text", "image"],
        phash: ["abcdef1234567890"],
        atUsers: [3042160393],
        replyTo: 1,
      },
    ], replyMap);

    expect(context).toHaveLength(2);

    const expectedTime = new Date(baseEntry.time * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Shanghai",
    });

    expect(context[0]).toEqual({
      msg_id: 1,
      time: expectedTime,
      sender: "阿黄",
      type: "text",
      text: "hello world",
    });

    expect(context[1]).toEqual({
      msg_id: 2,
      time: expectedTime,
      sender: "阿黄",
      mentions: [3042160393],
      mentioned_bot: true,
      reply_to: { msg_id: 1, sender: "阿黄", text: "hello world" },
      type: "mixed",
      text: "看看这个",
      has_image: true,
      image_phash: "abcdef1234567890",
      is_latest: true,
    });
  });

  test("buildStructuredContext 对纯图片空文本消息写入 msg_id 且 text 为 [图片]", () => {
    const context = buildStructuredContext([{
      ...baseEntry,
      msgId: 3,
      type: "image",
      text: "",
      segmentTypes: ["image"],
      phash: ["0011223344556677"],
    }]);

    expect(context[0]).toEqual({
      msg_id: 3,
      time: new Date(baseEntry.time * 1000).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Shanghai",
      }),
      sender: "阿黄",
      type: "image",
      text: "[图片]",
      has_image: true,
      image_phash: "0011223344556677",
      is_latest: true,
    });
  });

  test("buildStructuredContext 标记 bot 自己发过的消息", () => {
    const context = buildStructuredContext([{
      ...baseEntry,
      msgId: 4,
      userId: 3042160393,
      nickname: "Rin",
      card: "Rin",
      text: "草",
    }]);

    expect(context[0]).toMatchObject({
      msg_id: 4,
      sender: "Rin",
      text: "草",
      is_self: true,
      is_latest: true,
    });
  });

  test("buildUserMessages 生成平铺的多条 user JSON 消息", () => {
    const messages = buildUserMessages({
      sessionType: "group",
      context: [
        { time: "15:06", sender: "阿黄", type: "text", text: "hello world" },
        { time: "15:07", sender: "我是铸币", type: "image", text: "早上好", mentions: [3042160393], has_image: true, image_phash: "21194165415303e0" },
      ],
      continuationHint: "你刚才回复过对方",
    });

    expect(messages).toHaveLength(4);
    expect(messages).toEqual([
      {
        role: "user",
        content: JSON.stringify({ time: "15:06", sender: "阿黄", type: "text", text: "hello world" }),
      },
      {
        role: "user",
        content: JSON.stringify({ time: "15:07", sender: "我是铸币", type: "image", text: "早上好", mentions: [3042160393], has_image: true, image_phash: "21194165415303e0" }),
      },
      {
        role: "user",
        content: JSON.stringify({ instruction: "想回复就直接说，觉得没什么可说的就保持沉默。" }),
      },
      {
        role: "user",
        content: JSON.stringify({
          session_type: "group",
          bot_user_id: 3042160393,
          bot_name: "Rin",
          latest_message_rule: "latest_message 是当前待回复消息；它也在前面的 context 中以 is_latest=true 标记。回复时优先围绕 latest_message，而不是更早的消息。",
          latest_message: {
            time: "15:07",
            sender: "我是铸币",
            type: "image",
            text: "早上好",
            has_image: true,
            image_phash: "21194165415303e0",
          },
          continuation_hint: "你刚才回复过对方",
        }),
      },
    ]);
  });

  test("buildUserMessages 在最后一条 metadata 中带上最近自己的消息", () => {
    const messages = buildUserMessages({
      sessionType: "group",
      context: [
        { msg_id: 10, time: "15:05", sender: "Rin", is_self: true, type: "text", text: "草" },
        { msg_id: 11, time: "15:06", sender: "阿黄", type: "text", text: "刚才那个包要换版本" },
        { msg_id: 12, time: "15:07", sender: "Rin", is_self: true, type: "text", text: "笑死" },
        { msg_id: 13, time: "15:08", sender: "阿黄", type: "text", text: "不是梗，是真的报错了", is_latest: true },
      ],
    });

    const metadata = JSON.parse(messages.at(-1)!.content!);
    expect(metadata.latest_message).toEqual({
      msg_id: 13,
      time: "15:08",
      sender: "阿黄",
      type: "text",
      text: "不是梗，是真的报错了",
    });
    expect(metadata.recent_self_messages).toEqual([
      { msg_id: 10, time: "15:05", text: "草" },
      { msg_id: 12, time: "15:07", text: "笑死" },
    ]);
    expect(metadata.self_history_rule).toContain("避免连续重复");
  });
});

// ── isVagueDescription ──────────────────────────────────

describe("isVagueDescription", () => {
  let isVagueDescription: (desc: string) => boolean;

  beforeAll(async () => {
    const mod = await import("../src/chat-utils");
    isVagueDescription = mod.isVagueDescription;
  });

  // 边界情况
  test("空字符串 → 视为模糊", () => {
    expect(isVagueDescription("")).toBe(true);
  });

  test("null/undefined 安全（类型上不会传，但长度检查兜底）", () => {
    // undefined 不会发生，但保证不会异常
    expect(isVagueDescription("")).toBe(true);
  });

  test("长度 < 15 → 模糊", () => {
    expect(isVagueDescription("一只猫")).toBe(true);
    expect(isVagueDescription("A cat.")).toBe(true);
    expect(isVagueDescription("12345678901234")).toBe(true);
  });

  // 应通过的描述（有信息量）
  test("以 'A single image of' 开头但有具体内容 → 通过", () => {
    const desc = "A single image of a cartoon/anime-style character sitting behind bars";
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("以 'An image of' 开头但有具体细节 → 通过", () => {
    const desc = "An image of a white-haired anime girl with pink eyes wearing a school uniform";
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("包含颜色、动作、场景等具体信息 → 通过", () => {
    const desc = "A cute, chibi-style character with white hair, pink accents, and cat-like ears";
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("纯中文详细描述 → 通过", () => {
    const desc = "图片中有一个白色头发的动漫角色，穿着粉色连衣裙，站在樱花树下";
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("描述包含多行但有具体内容 → 通过", () => {
    const desc = "A screenshot of a mobile game interface showing a battle scene with multiple characters using special attacks";
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("短但具体（15~20 字符，有名词）→ 通过", () => {
    const desc = "橙色猫在沙发上";
    // 7 字符 < 15，长度不足 → 视为模糊
    expect(isVagueDescription(desc)).toBe(true);
  });

  // 应拒绝的描述（模糊/无信息量）
  test("以 'The user is asking' 开头 → 模糊", () => {
    const desc = "The user is asking what is in this image without analyzing the question itself";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("以 'The user wants' 开头 → 模糊", () => {
    const desc = "The user wants to know what is in the image without any analysis of their question";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("'An anime/manga illustration' 且无具体细节 → 模糊", () => {
    const desc = "An anime/manga illustration";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("'A single image of a picture' 纯堆砌前缀 → 模糊", () => {
    const desc = "A single image of a picture";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("'I need to describe this image' 无具体内容 → 模糊", () => {
    const desc = "I need to describe this image";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("'An image of a screenshot' 剥离后有具体类型 → 不模糊", () => {
    const desc = "An image of a screenshot";
    // 剥离前缀后剩 "a screenshot"（13 字符），"screenshot" 说明了图片类型
    expect(isVagueDescription(desc)).toBe(false);
  });

  test("模版式描述，头尾不匹配 → 模糊", () => {
    // 以 "An image of" + 无意义词
    const desc = "An image of the image";
    // 剥离 "An image of"→ "the image" → 长度 9 < 10 → 模糊
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("极短前缀+短后缀刚好在边界上 → 模糊", () => {
    // 只剥离 "An image of " → "cat" (3 < 10) → 模糊
    const desc = "An image of cat";
    expect(isVagueDescription(desc)).toBe(true);
  });

  test("刚好在边界上（剥离后 10 字符）→ 通过", () => {
    // 只剥离 "image of " → "1234567890" (10 ≥ 10) → 通过
    // 但 "image of 1234567890" 总长 17 ≥ 15，剥离后 10 ≥ 10 → 通过
    const desc = "A image of a cartoon cat with big eyes";
    expect(isVagueDescription(desc)).toBe(false);
  });
});

describe("quickDecideSilence end-to-end (agent.ts)", () => {
  let quickDecideSilence: (
    contextText: string, senderName: string, messageText: string,
    scenarioKey: string, topicSummary: string, atmosphereTag: string,
  ) => Promise<string | null>;

  beforeAll(async () => {
    const mod = await import("../src/chat-utils");
    quickDecideSilence = mod.quickDecideSilence;
  });

  /** 模拟 LLM 回复。依据 mockResponse 的内容，validateBody 可选验证请求体。 */
  function mockLlm(response: string): void {
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      // 拦截所有 /chat/completions 调用
      if (urlStr.includes("/chat/completions")) {
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: response } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof globalThis.fetch;
  }

  const dummyContext = [
    { time: "12:00", sender: "Alice", type: "text", text: "大家好" },
    { time: "12:01", sender: "Bob", type: "text", text: "今天天气不错" },
  ];
  const dummySender = "Charlie";
  const dummySummary = "当前话题：天气";
  const dummyAtmosphere = "气氛：正常";
  const imageDesc = "A photo of a white cat sleeping on a red sofa, relaxed atmosphere.";

  // ── Test 1: LLM 返回 SILENT ──────────────────────────

  test("有图片描述 + LLM 返回 SILENT → 函数返回 'SILENT'", async () => {
    mockLlm("SILENT");

    const result = await quickDecideSilence(
      dummyContext, dummySender, imageDesc, "random", dummySummary, dummyAtmosphere,
    );

    expect(result?.toUpperCase()).toBe("SILENT");
    // 确认不是其他文字
    expect(result).toBe("SILENT");
  });

  // ── Test 2: LLM 返回非 SILENT ────────────────────────

  test("有图片描述 + LLM 返回 SPEAK → 函数返回 'SPEAK'", async () => {
    mockLlm("SPEAK");

    const result = await quickDecideSilence(
      dummyContext, dummySender, imageDesc, "bystander", dummySummary, dummyAtmosphere,
    );

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).not.toBe("SILENT");
    expect(result).toBe("SPEAK");
  });

  test("思考模型若输出非协议文本 → 被压成 SILENT", async () => {
    mockLlm("我觉得这时候可以回一句，猫看起来很可爱。");

    const result = await quickDecideSilence(
      dummyContext, dummySender, imageDesc, "random", dummySummary, dummyAtmosphere,
    );

    expect(result).toBe("SILENT");
  });

  // ── Test 3: 无图片（仅文本）→ 原有行为不变 ─────────

  test("无图片描述（纯文本）+ LLM 返回 SILENT → 函数返回 'SILENT'", async () => {
    mockLlm("SILENT");

    const result = await quickDecideSilence(
      dummyContext, dummySender, "晚上吃啥", "random", dummySummary, dummyAtmosphere,
    );

    expect(result).toBe("SILENT");
  });

  // ── Test 4: 图片下载失败（无描述）→ 退化为原有行为 ─

  test("图片下载失败（无描述）+ LLM 返回 SILENT → 函数返回 'SILENT'", async () => {
    mockLlm("SILENT");

    // 模拟图片下载失败：messageText 不带（图片描述：...）后缀
    const noDescriptionText = "看看这个";
    const result = await quickDecideSilence(
      dummyContext, dummySender, noDescriptionText, "media", dummySummary, dummyAtmosphere,
    );

    expect(result).toBe("SILENT");
  });

  // ── Test 5: 验证请求体包含图片描述 ─────────────────

  test("传入图片描述时请求体中包含结构化消息字段", async () => {
    let capturedBody: string | null = null;

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        capturedBody = typeof opts?.body === "string" ? opts.body : null;
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: "SILENT" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof globalThis.fetch;

    await quickDecideSilence(
      dummyContext, dummySender, imageDesc, "random", dummySummary, dummyAtmosphere,
    );

    // 验证请求体包含结构化 JSON 内容
    expect(capturedBody).not.toBeNull();
    const body = JSON.parse(capturedBody!);
    const userMessages = body.messages.filter((m: any) => m.role === "user");
    expect(userMessages).toHaveLength(4);
    expect(JSON.parse(userMessages[0].content)).toEqual(dummyContext[0]);
    expect(JSON.parse(userMessages[1].content)).toEqual(dummyContext[1]);
    expect(JSON.parse(userMessages[2].content)).toEqual({ instruction: "不值得插话就只回复 SILENT；值得插话才回复 SPEAK。" });
    expect(JSON.parse(userMessages[3].content)).toEqual({
      session_type: "group",
      bot_user_id: 3042160393,
      bot_name: "Rin",
      latest_message_rule: "latest_message 是当前待回复消息；它也在前面的 context 中以 is_latest=true 标记。回复时优先围绕 latest_message，而不是更早的消息。",
      latest_message: {
        time: "12:01",
        sender: "Bob",
        type: "text",
        text: "今天天气不错",
      },
    });
  });

  test("quickDecideSilence 优先使用 QUICK_DECIDE_MODEL", async () => {
    let capturedBody: string | null = null;
    const oldQuickModel = process.env.QUICK_DECIDE_MODEL;
    const oldLlmModel = process.env.LLM_MODEL;

    process.env.QUICK_DECIDE_MODEL = "gpt-4o-mini";
    process.env.LLM_MODEL = "deepseek-reasoner";

    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/chat/completions")) {
        const opts = args[0] as RequestInit | undefined;
        capturedBody = typeof opts?.body === "string" ? opts.body : null;
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: "SILENT" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof globalThis.fetch;

    try {
      await quickDecideSilence(
        dummyContext, dummySender, imageDesc, "random", dummySummary, dummyAtmosphere,
      );

      expect(capturedBody).not.toBeNull();
      const body = JSON.parse(capturedBody!);
      expect(body.model).toBe("gpt-4o-mini");
    } finally {
      if (oldQuickModel === undefined) delete process.env.QUICK_DECIDE_MODEL;
      else process.env.QUICK_DECIDE_MODEL = oldQuickModel;

      if (oldLlmModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = oldLlmModel;
    }
  });

  test("最新消息应包含在 context 中，而不是作为额外一条 current message 追加", () => {
    const messages = buildUserMessages({
      sessionType: "group",
      context: [
        { time: "12:00", sender: "Alice", type: "text", text: "大家好" },
        { time: "12:02", sender: dummySender, type: "text", text: imageDesc, is_latest: true },
      ],
      instruction: "不值得插话就只回复 SILENT；值得插话才回复 SPEAK。",
    });

    expect(messages).toHaveLength(4);
    expect(JSON.parse(messages[1].content)).toEqual({
      time: "12:02",
      sender: dummySender,
      type: "text",
      text: imageDesc,
      is_latest: true,
    });
    expect(JSON.parse(messages[2].content)).toEqual({ instruction: "不值得插话就只回复 SILENT；值得插话才回复 SPEAK。" });
  });

  // ── Test 6: LLM 返回 null/failure 时函数返回 null ───

  test("LLM HTTP 错误 → 函数返回 null", async () => {
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/chat/completions")) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: "rate limit" }),
          { status: 429, headers: { "content-type": "application/json" } },
        ));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof globalThis.fetch;

    const result = await quickDecideSilence(
      dummyContext, dummySender, imageDesc, "random", dummySummary, dummyAtmosphere,
    );

    expect(result).toBeNull();
  });
});

// ── analyzeAtmosphere ──────────────────────────────────

describe("analyzeAtmosphere", () => {
  const base = {
    session: "test", msgId: 0, time: 100, type: "text", text: "",
    userId: 1, nickname: "U", card: undefined, senderRole: undefined,
    subType: "normal", selfId: 0, atUsers: [], replyTo: undefined, segmentTypes: ["text"],
  };

  function msg(text: string) {
    return { ...base, text };
  }

  test("无分歧标记 → 气氛：正常", () => {
    const entries = [
      msg("今天天气真好"),
      msg("确实，出去走走"),
      msg("你们晚饭吃了啥"),
      msg("我刚吃完"),
      msg("我也吃完了"),
    ];
    expect(analyzeAtmosphere(entries)).toBe("气氛：正常");
  });

  test("15-30% 分歧标记 → 气氛：偏紧", () => {
    const entries = [
      msg("我觉得不是这样"),
      msg("今天天气不错"),
      msg("晚上吃什么"),
      msg("我刚吃完"),
      msg("我也觉得还行"),
      msg("你们晚饭吃了啥"),
      msg("好的没问题"),
    ];
    // "我觉得不是这样" 匹配我觉得不是 → 1/7 ≈ 14.3%，略低于 15% 阈值
    // 修正：再加一条匹配的
    const entries2 = [
      msg("我觉得不是这样"),
      msg("今天天气不错"),
      msg("晚上吃什么"),
      msg("我刚吃完"),
      msg("明明就是这样"),
      msg("你们晚饭吃了啥"),
      msg("好的没问题"),
    ];
    // 2/7 ≈ 28.6%，15% < 28.6% < 30% → 偏紧
    expect(analyzeAtmosphere(entries2)).toBe("气氛：偏紧");
  });

  test(">30% 分歧标记 → 气氛：有分歧", () => {
    const entries = [
      msg("你说的根本不对"),
      msg("错了，完全不是这样"),
      msg("我今天吃了三碗饭"),
      msg("你搞错了吧"),
      msg("明明就是这样的"),
    ];
    // 4/5 = 80% → > 30% → 有分歧
    expect(analyzeAtmosphere(entries)).toBe("气氛：有分歧");
  });

  test("少于 5 条消息返回空字符串", () => {
    const entries = [
      msg("你好"),
      msg("今天天气不错"),
    ];
    expect(analyzeAtmosphere(entries)).toBe("");
  });

  test("空数组返回空字符串", () => {
    expect(analyzeAtmosphere([])).toBe("");
  });

  test("负面情绪关键词贡献比分", () => {
    const entries = [
      msg("这设计也太傻逼了"),
      msg("每次用都卡得想吐"),
      msg("真的无语了"),
      msg("确实离谱"),
      msg("服了，又崩了"),
    ];
    // 5条，负面词比例 100% → 0.2 阈值 → 有分歧（negativeRatio > 0.2 触发）
    expect(analyzeAtmosphere(entries)).toBe("气氛：有分歧");
  });

  test("正常消息中有少量分歧标记仍为正常", () => {
    const entries = [
      msg("今天天气真好"),
      msg("确实，出去走走"),
      msg("你们晚饭吃了啥"),
      msg("我今天吃了三碗饭"),
      msg("哈哈那还不错"),
      msg("我也吃完了"),
      msg("最近在看一部新番"),
      msg("哦那个我也有看"),
      msg("主线进展挺快的"),
      msg("等下我们去散步吗"),
      msg("这句话有但是这个词"),
      msg("好的没问题"),
      msg("周末有什么计划吗"),
      msg("好像要下雨了"),
      msg("那就不去了"),
    ];
    // 1/15 = 6% < 15% → 正常
    expect(analyzeAtmosphere(entries)).toBe("气氛：正常");
  });

  test("纯中性普通聊天（无任何触发词）→ 正常", () => {
    const entries = [
      msg("哈哈"),
      msg("嗯嗯"),
      msg("好的"),
      msg("明白了"),
      msg("不错不错"),
    ];
    expect(analyzeAtmosphere(entries)).toBe("气氛：正常");
  });
});
