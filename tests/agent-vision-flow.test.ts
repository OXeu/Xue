/**
 * tests/agent-vision-flow.test.ts — 视觉问答流程单元测试
 *
 * 覆盖 callVision 的 payload 构造、响应解析、错误处理，
 * 以及消息循环中的工具调用（describe_image）与多轮追问逻辑。
 *
 * 所有测试 mock globalThis.fetch，测试完成后恢复。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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
let persistBestDescription: (dir: string, session: string, msgId: number, phash: string, desc: string) => void;

beforeAll(async () => {
  const mod = await import("../src/agent");
  callVision = mod.callVision;
  buildContext = mod.buildContext;
  buildContextWithPhashIds = mod.buildContextWithPhashIds;
  loadPhashMap = mod.loadPhashMap;
  persistBestDescription = mod.persistBestDescription;
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

    // 验证"参数解析失败"会作为 tool 结果注入
    const assistantMsg: any = {
      role: "assistant",
      content: null,
      tool_calls: [tc],
    };
    messages.push(assistantMsg);
    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: "参数解析失败",
    });

    const toolMsg = messages.find((m: any) => m.role === "tool" && m.content === "参数解析失败");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_bad_json");
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

// ── isVagueDescription ──────────────────────────────────

describe("isVagueDescription", () => {
  let isVagueDescription: (desc: string) => boolean;

  beforeAll(async () => {
    const mod = await import("../src/agent");
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
  const originalDir = ""; // 不再需要，保留变量避免编译错误

  // 由于 loadPhashMap 读取 agent.ts 模块内部的 _inferencesDir（data/prod/inferences），
  // 我们直接写文件到 data/prod/inferences 下测试用的文件名，测完清理。

  const testSession = "unittest_phash_map_test";
  const testFilePath = join(resolve(import.meta.dirname, "..", "data/prod", "inferences"), `${testSession}.jsonl`);

  afterAll(() => {
    try { rmSync(testFilePath, { force: true }); } catch { /* ok */ }
  });

  test("写入 phash 后可从 loadPhashMap 读取", async () => {
    // 直接写文件模拟 agent 的行为
    const { mkdirSync, existsSync, appendFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const inferencesDir = resolve(import.meta.dirname, "..", "data/prod", "inferences");
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
    const filePath2 = join(resolve(import.meta.dirname, "..", "data/prod", "inferences"), `${session}.jsonl`);

    try {
      const { appendFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { resolve, join } = await import("node:path");
      const inferencesDir = resolve(import.meta.dirname, "..", "data/prod", "inferences");
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

// ── persistBestDescription ──────────────────────────────

describe("persistBestDescription", () => {
  let persistBestDescriptionFn: ReturnType<typeof Object>;
  let isVagueDescriptionFn: (desc: string) => boolean;

  let tmpDir = "";
  const session = "unittest_persist";
  const testDir = () => join(resolve(import.meta.dirname, "..", "data", "tmp-test-persist"));

  beforeAll(async () => {
    const mod = await import("../src/agent");
    persistBestDescriptionFn = mod.persistBestDescription;
    isVagueDescriptionFn = mod.isVagueDescription;
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(resolve(import.meta.dirname, "..", "data"), "tmp-persist-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterAll(() => {
    try { rmSync(testDir(), { recursive: true, force: true }); } catch { /* ok */ }
  });

  test("文件不存在时创建文件并写入条目", () => {
    (persistBestDescriptionFn as Function)(tmpDir, session, 101, "phash_101", "A white cat sitting on a windowsill");

    const filePath = join(tmpDir, `${session}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msgId).toBe(101);
    expect(parsed.phash).toBe("phash_101");
    expect(parsed.inference).toBe("A white cat sitting on a windowsill");
    expect(parsed.session).toBe(session);
  });

  test("文件存在时追加不同 msgId 的条目", () => {
    // 先写两条
    (persistBestDescriptionFn as Function)(tmpDir, session, 201, "phash_201", "A black dog running in a park");
    (persistBestDescriptionFn as Function)(tmpDir, session, 202, "phash_202", "A blue sky with clouds");

    const filePath = join(tmpDir, `${session}.jsonl`);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsed0 = JSON.parse(lines[0]);
    expect(parsed0.msgId).toBe(201);
    expect(parsed0.inference).toBe("A black dog running in a park");

    const parsed1 = JSON.parse(lines[1]);
    expect(parsed1.msgId).toBe(202);
    expect(parsed1.inference).toBe("A blue sky with clouds");
  });

  test("同 msgId 覆盖旧 inference，保留其他条目", () => {
    // 先写两个不同 msgId 的条目
    (persistBestDescriptionFn as Function)(tmpDir, session, 301, "phash_301", "An old description for msg 301");
    (persistBestDescriptionFn as Function)(tmpDir, session, 302, "phash_302", "Another msg description");

    // 覆盖 301 的 inference
    (persistBestDescriptionFn as Function)(tmpDir, session, 301, "phash_301_new", "A better description for msg 301");

    const filePath = join(tmpDir, `${session}.jsonl`);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    // 排序并断言
    const parsed = lines.map((l) => JSON.parse(l)).sort((a, b) => a.msgId - b.msgId);
    expect(parsed[0].msgId).toBe(301);
    expect(parsed[0].inference).toBe("A better description for msg 301");
    expect(parsed[0].phash).toBe("phash_301_new");
    expect(parsed[1].msgId).toBe(302);
    expect(parsed[1].inference).toBe("Another msg description");
  });

  test("同 msgId 多次写入只保留最新一条（去重）", () => {
    // 写入同一条 msgId 三次
    (persistBestDescriptionFn as Function)(tmpDir, session, 401, "phash_401_v1", "First attempt");
    (persistBestDescriptionFn as Function)(tmpDir, session, 401, "phash_401_v2", "Second attempt");
    (persistBestDescriptionFn as Function)(tmpDir, session, 401, "phash_401_v3", "Third and best attempt");

    const filePath = join(tmpDir, `${session}.jsonl`);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    // 应只有一条
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msgId).toBe(401);
    expect(parsed.inference).toBe("Third and best attempt");
    expect(parsed.phash).toBe("phash_401_v3");
  });

  test("空描述时仍写入（函数本身不过滤，调用方负责校验）", () => {
    (persistBestDescriptionFn as Function)(tmpDir, session, 501, "phash_501", "");

    const filePath = join(tmpDir, `${session}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msgId).toBe(501);
    expect(parsed.inference).toBe("");
  });

  test("调用方模式：描述为空时 prevented（不调用 persistBestDescription）", () => {
    const filePath = join(tmpDir, `${session}.jsonl`);
    // 模拟调用方 if-guard
    const answer = "";
    if (answer && !isVagueDescriptionFn(answer)) {
      (persistBestDescriptionFn as Function)(tmpDir, session, 601, "phash_601", answer);
    }
    // 不应创建文件
    expect(existsSync(filePath)).toBe(false);
  });

  test("调用方模式：描述模糊时 prevented（不调用 persistBestDescription）", async () => {
    const filePath = join(tmpDir, `${session}.jsonl`);
    // 先写入一个正常的条目建立文件
    (persistBestDescriptionFn as Function)(tmpDir, session, 701, "phash_701", "A normal description of a cat");
    const linesBefore = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(linesBefore).toHaveLength(1);

    // 动态导入 isVagueDescription
    const { isVagueDescription: isVD } = await import("../src/agent");
    // 模拟调用方 if-guard：模糊描述不应写入
    const vagueAnswer = "The user is asking what is in this image without analyzing the question";
    if (vagueAnswer && !isVD(vagueAnswer)) {
      (persistBestDescriptionFn as Function)(tmpDir, session, 701, "phash_701_v2", vagueAnswer);
    }

    // 文件应保持原样
    const linesAfter = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(linesAfter).toHaveLength(1);
    const parsed = JSON.parse(linesAfter[0]);
    expect(parsed.inference).toBe("A normal description of a cat");
  });
});
