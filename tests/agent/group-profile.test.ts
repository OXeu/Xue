/**
 * tests/agent/group-profile.test.ts — 验证 buildSessionProfile()
 *
 * 覆盖：正常关键词提取、数据不足时返回空、私聊场景、空历史、边界行为。
 * 使用临时 JSONL 文件写入 data/raw/，测试后清理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildSessionProfile } from "../../src/agent";

const RAW_DIR = resolve(import.meta.dirname, "../../data/raw");

/** 写入一行到 JSONL 文件 */
function appendLine(sessionId: string, text: string): void {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  const entry = {
    session: sessionId,
    msgId: Date.now() + Math.floor(Math.random() * 10000),
    time: Math.floor(Date.now() / 1000),
    type: "text",
    text,
    userId: 10001,
    nickname: "TestUser",
    subType: "normal",
    selfId: 3042160393,
    atUsers: [],
    segmentTypes: ["text"],
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", { flag: "a" });
}

/** 写多条相同内容的行 */
function writeLines(sessionId: string, lines: string[]): void {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  const entries = lines.map((text, i) => ({
    session: sessionId,
    msgId: 1000000 + i,
    time: 1700000000 + i,
    type: "text",
    text,
    userId: 10001,
    nickname: "TestUser",
    subType: "normal",
    selfId: 3042160393,
    atUsers: [],
    segmentTypes: ["text"],
  }));
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** 删除测试文件（如果有） */
function cleanFile(sessionId: string): void {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  if (existsSync(path)) unlinkSync(path);
}

// 确保 data/raw 存在
if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── 测试 ────────────────────────────────────────────────

test("buildSessionProfile 从包含高频词的消息中正确提取关键词", () => {
  const session = "test_profile_keywords";
  cleanFile(session);

  try {
    // 15 条消息，其中"Web开发"相关出现 8 次，"产品设计"6 次
    const msgs: string[] = [];
    for (let i = 0; i < 8; i++) msgs.push("我们社团的 Web开发项目需要改进");
    for (let i = 0; i < 6; i++) msgs.push("产品设计方面有什么新想法");
    msgs.push("秋招招了将近 300 人");
    writeLines(session, msgs);

    const result = buildSessionProfile(session);
    expect(result).toContain("群聊特征：");
    // 高频短语应出现在结果中（关键词提取返回连续中文字词序列）
    expect(result).toContain("web开发项目需要改进");
    expect(result).toContain("产品设计方面有什么新想法");
  } finally {
    cleanFile(session);
  }
});

test("消息少于 10 条时返回空字符串", () => {
  const session = "test_profile_few_msgs";
  cleanFile(session);

  try {
    for (let i = 0; i < 5; i++) {
      appendLine(session, `测试消息 ${i}`);
    }
    const result = buildSessionProfile(session);
    expect(result).toBe("");
  } finally {
    cleanFile(session);
  }
});

test("正好 10 条消息时返回非空结果", () => {
  const session = "test_profile_exactly_10";
  cleanFile(session);

  try {
    for (let i = 0; i < 10; i++) {
      appendLine(session, `关于 Web开发的话题 ${i}`);
    }
    const result = buildSessionProfile(session);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("群聊特征：");
  } finally {
    cleanFile(session);
  }
});

test("私聊 session 返回空字符串", () => {
  const session = "private_12345";
  const result = buildSessionProfile(session);
  expect(result).toBe("");
});

test("不存在的 session 返回空字符串", () => {
  const result = buildSessionProfile("test_profile_nonexistent");
  expect(result).toBe("");
});

test("所有消息内容相同时仍能提取出关键词", () => {
  const session = "test_profile_identical";
  cleanFile(session);

  try {
    const msgs = Array(15).fill("每天都在写代码调试 bug");
    writeLines(session, msgs);

    const result = buildSessionProfile(session);
    expect(result).toContain("群聊特征：");
    // 关键词提取返回连续中文字词序列，较长短语会被整体匹配
    expect(result).toContain("每天都在写代码调试");
    expect(result).toContain("bug");
  } finally {
    cleanFile(session);
  }
});

test("消息仅含停用词时返回空字符串", () => {
  const session = "test_profile_stopwords";
  cleanFile(session);

  try {
    const msgs = Array(15).fill("的 了 是 我 你 他 在 有 不 就 也 都");
    writeLines(session, msgs);

    const result = buildSessionProfile(session);
    expect(result).toBe("");
  } finally {
    cleanFile(session);
  }
});

test("消息含 CQ 码时被正确剥离，关键词提取不受影响", () => {
  const session = "test_profile_cqcode";
  cleanFile(session);

  try {
    const msgs = Array(12).fill("[CQ:at,qq=12345] 项目架构需要重构");
    writeLines(session, msgs);

    const result = buildSessionProfile(session);
    expect(result).toContain("群聊特征：");
    // CQ 码被剥离后，纯文本被正确提取
    expect(result).toContain("项目架构需要重构");
    expect(result).not.toContain("CQ");
  } finally {
    cleanFile(session);
  }
});

test("多次调用不污染缓存或影响生产数据", () => {
  const session = "test_profile_side_effect";
  cleanFile(session);

  try {
    const msgs = Array(12).fill("数据分析和可视化");
    writeLines(session, msgs);

    // 调用两次，结果应一致
    const r1 = buildSessionProfile(session);
    const r2 = buildSessionProfile(session);
    expect(r1).toBe(r2);

    // 验证文件未被修改
    const path = join(RAW_DIR, `${session}.jsonl`);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("数据分析和可视化");
  } finally {
    cleanFile(session);
  }
});
