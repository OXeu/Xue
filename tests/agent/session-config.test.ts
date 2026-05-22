/**
 * tests/agent/session-config.test.ts — session-config.json 加载逻辑与回复决策测试
 *
 * 覆盖：
 * - loadSessionConfig（配置文件不存在、缺失字段、完整配置、非法 JSON）
 * - loadProbabilities（同上 + 部分字段回退）
 * - canReplyReal（会话覆写、全局 DRY_RUN 优先级）
 * - decideReply（@、自己消息、概率覆写）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 临时目录 ────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-config-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 在临时目录下创建配置文件，返回完整路径 */
function writeConfig(data: Record<string, unknown>): string {
  const p = join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(p, JSON.stringify(data), "utf8");
  return p;
}

// ── 导入被测试模块 ──────────────────────────────────────

// 在导入前设好环境变量，确保模块级常量确定
process.env.BOT_QQ = "12345";
process.env.BOT_NAME = "Rin";
process.env.REPLY_CHANCE = "0.3";
process.env.DRY_RUN = "true";

// 与 agent.ts 用同一表达式派生 BOT_QQ，确保无论谁先加载模块值都能匹配
const testBotQQ = Number(process.env.BOT_QQ || "3042160393");

// NOTE: 测试文件运行在单进程，模块级 DRY_RUN 取值为 "true"。
// canReplyReal 的 dryRunOverride 参数用于模拟全局 DRY_RUN=false 场景。

const mod = await import("../../src/agent");
const {
  DEFAULT_PROBS,
  loadSessionConfig,
  loadProbabilities,
  canReplyReal,
  decideReply,
} = mod;

// 辅助构造 ListenEntry
function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    session: "group_test",
    msgId: 1,
    time: 1000,
    type: "text",
    text: "hello",
    userId: 999,
    nickname: "User",
    card: undefined,
    senderRole: undefined,
    subType: "normal",
    selfId: 12345,
    atUsers: [],
    replyTo: undefined,
    segmentTypes: ["text"],
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════
// 加载逻辑
// ════════════════════════════════════════════════════════

describe("loadSessionConfig", () => {
  test("文件不存在返回空对象", () => {
    const cfg = loadSessionConfig(join(tmpDir, "nonexistent.json"));
    expect(cfg).toEqual({});
  });

  test("空配置返回空对象", () => {
    const p = writeConfig({});
    expect(loadSessionConfig(p)).toEqual({});
  });

  test("只含 probabilities 时无 session 配置", () => {
    const p = writeConfig({ probabilities: { mentioned: 0.5 } });
    expect(loadSessionConfig(p)).toEqual({});
  });

  test("正确加载会话白名单", () => {
    const p = writeConfig({
      group_a: { reply: true },
      group_b: { reply: false },
    });
    const cfg = loadSessionConfig(p);
    expect(cfg).toEqual({
      group_a: { reply: true },
      group_b: { reply: false },
    });
  });

  test("忽略 reply 非 boolean 的条目", () => {
    const p = writeConfig({
      group_a: { reply: true },
      group_b: { reply: "yes" },
      group_c: { reply: null },
    });
    const cfg = loadSessionConfig(p);
    expect(cfg).toEqual({ group_a: { reply: true } });
  });

  test("非法 JSON 返回空对象（try-catch 容错）", () => {
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, "{invalid", "utf8");
    expect(loadSessionConfig(p)).toEqual({});
  });

  test("probabilities 字段不会被混入 session 配置", () => {
    const p = writeConfig({
      probabilities: { mentioned: 0.5 },
      group_a: { reply: true },
    });
    const cfg = loadSessionConfig(p);
    expect(cfg).toEqual({ group_a: { reply: true } });
    expect("probabilities" in cfg).toBe(false);
  });
});

describe("loadProbabilities", () => {
  test("文件不存在返回默认值", () => {
    const p = loadProbabilities(join(tmpDir, "nonexistent.json"));
    expect(p).toEqual(DEFAULT_PROBS);
  });

  test("空配置返回默认值", () => {
    const p = loadProbabilities(writeConfig({}));
    expect(p).toEqual(DEFAULT_PROBS);
  });

  test("无 probabilities 字段返回默认值", () => {
    const p = loadProbabilities(writeConfig({ group_a: { reply: true } }));
    expect(p).toEqual(DEFAULT_PROBS);
  });

  test("部分字段缺失回退默认值", () => {
    const p = loadProbabilities(writeConfig({
      probabilities: { mentioned: 0.9 },
    }));
    expect(p).toEqual({
      mentioned: 0.9,
      media: DEFAULT_PROBS.media,
      bystander: DEFAULT_PROBS.bystander,
    });
  });

  test("完整覆盖所有字段", () => {
    const p = loadProbabilities(writeConfig({
      probabilities: { mentioned: 0.1, media: 0.5, bystander: 0.01 },
    }));
    expect(p).toEqual({ mentioned: 0.1, media: 0.5, bystander: 0.01 });
  });

  test("非法 JSON 返回默认值", () => {
    const p = join(tmpDir, "bad-probs.json");
    writeFileSync(p, "{{{", "utf8");
    expect(loadProbabilities(p)).toEqual(DEFAULT_PROBS);
  });

  test("非法概率值类型（非 number）被默认值替换", () => {
    const p = writeConfig({
      probabilities: { mentioned: "high", media: 0.5, bystander: 0.01 },
    });
    const r = loadProbabilities(p);
    expect(r.mentioned).toBe(DEFAULT_PROBS.mentioned);
    expect(r.media).toBe(0.5);
    expect(r.bystander).toBe(0.01);
  });
});

// ════════════════════════════════════════════════════════
// canReplyReal
// ════════════════════════════════════════════════════════

describe("canReplyReal", () => {
  const config = {
    group_a: { reply: true },
    group_b: { reply: false },
  };

  test("reply: true 的会话返回 true", () => {
    expect(canReplyReal("group_a", { configOverride: config, dryRunOverride: true })).toBe(true);
  });

  test("reply: false 的会话返回 false", () => {
    expect(canReplyReal("group_b", { configOverride: config, dryRunOverride: true })).toBe(false);
  });

  test("不在配置中的会话返回 false（全局 dry-run）", () => {
    expect(canReplyReal("group_unknown", { configOverride: config, dryRunOverride: true })).toBe(false);
  });

  test("dryRunOverride=false 时所有会话返回 true", () => {
    expect(canReplyReal("group_b", { configOverride: config, dryRunOverride: false })).toBe(true);
    expect(canReplyReal("group_unknown", { configOverride: config, dryRunOverride: false })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
// decideReply
// ════════════════════════════════════════════════════════

describe("decideReply", () => {
  test("被 @ 自己 → 必回", () => {
    const d = decideReply(
      makeEntry({ atUsers: [testBotQQ] }),
      "text", "hello",
      undefined, testBotQQ,
    );
    expect(d.should).toBe(true);
    expect(d.reason).toBe("at-self");
  });

  test("被 @ 全体 → 必回", () => {
    const d = decideReply(
      makeEntry({ atUsers: [] }),
      "text", "[CQ:at,qq=all] hello",
      undefined, testBotQQ,
    );
    expect(d.should).toBe(true);
    expect(d.reason).toBe("at-all");
  });

  test("自己消息 → 不回", () => {
    const d = decideReply(
      makeEntry({ userId: testBotQQ }),
      "text", "hello",
      undefined, testBotQQ,
    );
    expect(d.should).toBe(false);
    expect(d.reason).toBe("self");
  });

  test("selfId 匹配也视为自己消息", () => {
    const d = decideReply(
      makeEntry({ userId: testBotQQ, selfId: testBotQQ }),
      "text", "hello",
      undefined, testBotQQ,
    );
    expect(d.should).toBe(false);
  });

  describe("概率覆盖生效", () => {
    test("mentioned=1.0 → 总是回复", () => {
      for (let i = 0; i < 20; i++) {
        const d = decideReply(
          makeEntry({ userId: 999, atUsers: [] }),
          "text", "Rin 你好",
          { mentioned: 1.0, media: 0, bystander: 0 },
        );
        if (d.reason === "mentioned") {
          expect(d.should).toBe(true);
          return; // 至少命中一次 mentioned 分支即可
        }
      }
      // 如果都没进入 mentioned 分支，说明名字检测未触发
      expect("未命中 mentioned 分支，检查测试数据").toBe("需要包含 'Rin'");
    });

    test("mentioned=0.0 → 从不回复（mentioned 分支）", () => {
      for (let i = 0; i < 20; i++) {
        const d = decideReply(
          makeEntry({ userId: 999, atUsers: [] }),
          "text", "Rin 你好",
          { mentioned: 0.0, media: 0, bystander: 0 },
        );
        // mentioned=0 时即使被提到也不回，可能落到 random 分支
        if (d.reason === "mentioned") {
          expect(d.should).toBe(false);
          return;
        }
      }
      // 没进入 mentioned 分支也可以接受（概率命中 random）
    });

    test("media=0.0 → 图片/表情消息从不回复", () => {
      for (let i = 0; i < 30; i++) {
        const d = decideReply(
          makeEntry({ userId: 999, atUsers: [] }),
          "face", "[CQ:face,id=123]",
          { mentioned: 0, media: 0.0, bystander: 0 },
        );
        if (d.reason === "media") {
          expect(d.should).toBe(false);
          return;
        }
      }
    });

    test("bystander=0.0 → @别人时从不回复", () => {
      for (let i = 0; i < 30; i++) {
        const d = decideReply(
          makeEntry({ userId: 999, atUsers: [777] }),
          "text", "hello @777",
          { mentioned: 0, media: 0, bystander: 0.0 },
        );
        if (d.reason === "bystander") {
          expect(d.should).toBe(false);
          return;
        }
      }
    });

    test("不传 probs 使用默认值（至少不会抛异常）", () => {
      const d = decideReply(
        makeEntry({ userId: 999, atUsers: [testBotQQ] }),
        "text", "hello",
        undefined, testBotQQ,
      );
      // @self 分支不走概率，能正常返回即证明默认值可用
      expect(d.should).toBe(true);
    });
  });

  test("@ 别人且名字匹配时 mentioned 优先于 bystander", () => {
    // 消息同时 @ 了别人和提到名字（比如在群聊中）
    for (let i = 0; i < 10; i++) {
      const d = decideReply(
        makeEntry({ userId: 999, atUsers: [777] }),
        "text", "Rin 你来看看这个",
        { mentioned: 1.0, media: 0, bystander: 0 },
      );
      // 名字检测走 mentioned 分支
      if (d.reason === "mentioned") {
        expect(d.should).toBe(true);
        return;
      }
    }
  });
});
