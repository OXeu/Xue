import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runAgentTurn, sanitizeAssistantReply } from "../../src/agent/engine";
import type { ListenEntry } from "../../src/shared/types";

describe("sanitizeAssistantReply", () => {
  test("保留正常回复并去掉外层引号/空白", () => {
    expect(sanitizeAssistantReply("  “这得看日志”  ")).toBe("这得看日志");
  });

  test("过滤显式沉默协议和括号沉默旁白", () => {
    expect(sanitizeAssistantReply("SILENT")).toBeNull();
    expect(sanitizeAssistantReply("（沉默）")).toBeNull();
    expect(sanitizeAssistantReply("(不回复)")).toBeNull();
    expect(sanitizeAssistantReply("（看着不说话）")).toBeNull();
    expect(sanitizeAssistantReply(" no reply ")).toBeNull();
  });

  test("不误删普通括号内容", () => {
    expect(sanitizeAssistantReply("（可以）")).toBe("（可以）");
    expect(sanitizeAssistantReply("我也觉得（大概）")).toBe("我也觉得（大概）");
  });

  test("去掉假装感兴趣的蹲个尾巴", () => {
    expect(sanitizeAssistantReply("不知道 没买过 蹲个价")).toBe("不知道 没买过");
    expect(sanitizeAssistantReply("话费也能打折？蹲个路子")).toBe("话费也能打折？");
    expect(sanitizeAssistantReply("蹲个链接")).toBeNull();
    expect(sanitizeAssistantReply("蹲个链接吧")).toBeNull();
  });
});

describe("runAgentTurn silence placeholder filter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeEntry(): ListenEntry {
    return {
      session: "group_1",
      msgId: 1,
      time: 1717000000,
      type: "text",
      text: "你怎么看",
      userId: 100,
      nickname: "UserA",
      card: "阿黄",
      subType: "normal",
      selfId: 3042160393,
      atUsers: [3042160393],
      atAll: false,
      segmentTypes: ["text"],
    };
  }

  test("模型输出（沉默）时不会调用发送回调", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      JSON.stringify({ choices: [{ message: { content: "（沉默）" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))) as typeof globalThis.fetch;

    let sent: string | null = null;
    const entry = makeEntry();
    const result = await runAgentTurn(entry, {
      isPrivate: false,
      rawMessage: entry.text,
      decisionOverride: { should: true, reason: "at-self" },
      skipContinuationTracking: true,
      contextOverride: { recent: [], persistedEntry: null },
      onReply: (reply) => { sent = reply; },
      logger: () => {},
    });

    expect(result.reply).toBeNull();
    expect(result.replySent).toBe(false);
    expect(sent).toBeNull();
  });
});
