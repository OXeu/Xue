/**
 * tests/agent/continuation.test.ts — 对话延续逻辑测试
 *
 * 覆盖：
 * - 同一用户同一会话 60 秒内 → 延续
 * - 同一用户不同会话 → 不延续
 * - 不同用户同一会话 → 不延续
 * - 超过 60 秒后 → 不延续
 * - setLastBotReply 更新 tracker
 * - clearLastBotReply 清除 tracker
 */

import { describe, test, expect, beforeEach } from "bun:test";

const mod = await import("../../src/agent/engine");
const {
  isConversationContinuation,
  setLastBotReply,
  clearLastBotReply,
} = mod;

describe("isConversationContinuation", () => {
  const T0 = 1_000_000_000; // 固定基准时间 (ms)

  beforeEach(() => {
    clearLastBotReply();
  });

  test("同一用户同一会话在 60 秒内 → 延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(100, "group_a", T0 + 30_000)).toBe(true);
  });

  test("同一用户不同会话 → 不延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(100, "group_b", T0 + 10_000)).toBe(false);
  });

  test("不同用户同一会话 → 不延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(200, "group_a", T0 + 10_000)).toBe(false);
  });

  test("超过 60 秒后同一用户同一会话 → 不延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(100, "group_a", T0 + 61_000)).toBe(false);
  });

  test("正好 60 秒边界 → 延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(100, "group_a", T0 + 60_000)).toBe(true);
  });

  test("超过 60 秒边界 1ms → 不延续", () => {
    setLastBotReply(100, "group_a", T0);
    expect(isConversationContinuation(100, "group_a", T0 + 60_001)).toBe(false);
  });

  test("tracker 未设置时返回 false", () => {
    clearLastBotReply();
    expect(isConversationContinuation(100, "group_a", T0)).toBe(false);
  });
});

describe("setLastBotReply", () => {
  test("更新后同用户同会话在窗口内返回 true", () => {
    clearLastBotReply();
    setLastBotReply(42, "group_x");
    // 不用 now 参数，用真实时间，因此只验证基本功能
    const result = isConversationContinuation(42, "group_x");
    expect(result).toBe(true);
  });

  test("再次调用更新为新用户新会话", () => {
    clearLastBotReply();
    const T = 1_000_000_000;
    setLastBotReply(10, "group_a", T);
    setLastBotReply(20, "group_b", T);
    expect(isConversationContinuation(10, "group_a", T + 30_000)).toBe(false);
    expect(isConversationContinuation(20, "group_b", T + 30_000)).toBe(true);
  });
});

describe("clearLastBotReply", () => {
  test("清除后任何组合都不延续", () => {
    const T = 1_000_000_000;
    setLastBotReply(100, "group_a", T);
    clearLastBotReply();
    expect(isConversationContinuation(100, "group_a", T + 10_000)).toBe(false);
    expect(isConversationContinuation(200, "group_b", T + 10_000)).toBe(false);
  });
});
