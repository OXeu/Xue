/**
 * tests/agent-vision-flow.test.ts — 视觉问答流程单元测试
 *
 * 覆盖 callVision 的 payload 构造、响应解析、错误处理，
 * 以及消息循环中的 [VISION] 标签解析与多轮追问逻辑。
 *
 * 所有测试 mock globalThis.fetch，测试完成后恢复。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";

// 设置环境变量后再动态导入，确保 callVision 能读取到
// 同时禁止 agent.ts 的 main() 入口启动（WS 连接等副作用）
beforeAll(() => {
  process.env.RIN_TEST = "1";
  process.env.VISION_MODEL = "gemma4:26b";
  process.env.VISION_BASE_URL = "http://127.0.0.1:11444/v1";
  process.env.LLM_API_KEY = "ollama";
});

let callVision: (query: string, base64: string, mime: string) => Promise<string | null>;

beforeAll(async () => {
  const mod = await import("../src/agent");
  callVision = mod.callVision;
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
    // 临时清除 env，callVision 会读取 process.env 并 fallback
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

// ── [VISION] 标签解析与视觉循环 ─────────────────────────

describe("[VISION] query parsing in agent message loop", () => {
  const fakeBase64 = "dGVzdC1pbWFnZS1kYXRh";
  const fakeMime = "image/jpeg";
  const fakeImg = { base64: fakeBase64, mime: fakeMime };

  /** 模拟一轮视觉循环：给定一个 LLM 回复序列，模拟 agent 的 while 循环逻辑 */
  async function runSimulatedVisionLoop(
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

    // mock LLM calls → return predefined responses
    globalThis.fetch = ((url: string | URL | Request, ...args: any[]): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/chat/completions")) {
        // Determine if this is LLM or vision by checking the body
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

      const visionMatch = response.match(/\[VISION\]([\s\S]*?)\[\/VISION\]/);

      if (visionMatch && fakeImg) {
        const query = visionMatch[1].trim();
        visionCalls.push(query);

        const answer = await callVision(query, fakeImg.base64, fakeImg.mime);
        const displayAnswer = answer || "(分析失败)";

        messages.push({ role: "assistant", content: response });
        messages.push({ role: "user", content: `【图片回答】${displayAnswer}\n\n还需要问什么吗？已经够了就直接回复。` });
      } else {
        finalReply = response;
      }
    }

    return { finalReply, rounds, messages, visionCalls };
  }

  test("单轮视觉问答后直接回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      [
        "[VISION]图片里有什么动物？[/VISION]",
        "有两只猫在打架",
      ],
      ["有两只猫在打架"],
    );

    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]).toBe("图片里有什么动物？");
    expect(finalReply).toBe("有两只猫在打架");
    expect(rounds).toBe(2); // 一轮 vision + 一轮回复
  });

  test("多轮追问后回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      [
        "[VISION]图片里有什么？[/VISION]",
        "[VISION]那只猫是什么颜色的？[/VISION]",
        "是一只橙色猫",
      ],
      ["一只猫", "橙色"],
    );

    expect(visionCalls).toHaveLength(2);
    expect(visionCalls[0]).toBe("图片里有什么？");
    expect(visionCalls[1]).toBe("那只猫是什么颜色的？");
    expect(finalReply).toBe("是一只橙色猫");
    expect(rounds).toBe(3); // 两轮 vision + 一轮回复
  });

  test("无 [VISION] 标签时直接作为最终回复", async () => {
    const { finalReply, visionCalls, rounds } = await runSimulatedVisionLoop(
      ["这张图看起来像是风景照"],
      [],
    );

    expect(visionCalls).toHaveLength(0);
    expect(finalReply).toBe("这张图看起来像是风景照");
    expect(rounds).toBe(1); // 直接回复
  });

  test("视觉模型返回 null（分析失败）时注入占位符文本并继续循环", async () => {
    const { finalReply, visionCalls, messages, rounds } = await runSimulatedVisionLoop(
      [
        "[VISION]有什么？[/VISION]",
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
    // 无限 vision 问答，永不回复
    const { finalReply, rounds } = await runSimulatedVisionLoop(
      ["[VISION]第1问？[/VISION]",
       "[VISION]第2问？[/VISION]",
       "[VISION]第3问？[/VISION]",
       "[VISION]第4问？[/VISION]",
       "[VISION]第5问？[/VISION]",
       "[VISION]第6问？[/VISION]"], // 6 responses for 6 rounds (max 5)
      ["答1", "答2", "答3", "答4", "答5"],
      5, // maxRounds
    );

    expect(rounds).toBe(5); // hit max
    expect(finalReply).toBeNull(); // 没机会回复
  });
});
