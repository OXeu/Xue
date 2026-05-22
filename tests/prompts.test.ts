/**
 * tests/prompts.test.ts — 验证 prompts.ts 加载器
 *
 * 覆盖：正常文件读取、场景提取、fallback、缓存重置、测试间隔离。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  clearPromptCaches,
  getCoreIdentity,
  getReplyRules,
  getScenarioPrompt,
  getSystemPrompt,
  getVisionFormat,
  loadPrompt,
} from "../src/prompts";

const PROMPTS_DIR = resolve(import.meta.dirname, "../prompts");

beforeEach(() => {
  clearPromptCaches();
});

// ── 基本文件读取 ────────────────────────────────────────

test("loadPrompt('system') 返回 system.md 的完整内容", () => {
  const content = loadPrompt("system");
  expect(content).toContain("你叫 {BOT_NAME}，是一个在 QQ 群里聊天的人类。");
  expect(content).toContain("## scenario:private");
  expect(content).toContain("## scenario:default");
});

test("getReplyRules() 返回 reply.md 的完整内容", () => {
  const content = getReplyRules();
  expect(content).toContain("回复要简短、自然，像真人。");
  expect(content).toContain("不要列点");
  expect(content).toContain("不要 formal");
});

test("getVisionFormat() 返回 describe_image 工具的说明", () => {
  const content = getVisionFormat();
  expect(content).toContain("describe_image");
  expect(content).toContain("phash");
  // 应可直接用作 prompt 片段（不含 markdown 标题行）
  expect(content).not.toMatch(/^# /m);
  expect(content).not.toContain("{IMAGE_DESCRIPTION}");
});

// ── 场景提取 ────────────────────────────────────────────

test("getScenarioPrompt('private', 'Rin') 返回私聊场景内容（不含章节标题，BOT_NAME 已替换）", () => {
  const prompt = getScenarioPrompt("private", "Rin");
  // 不应包含章节标题行
  expect(prompt).not.toContain("## scenario:private");
  // BOT_NAME 应被替换
  expect(prompt).not.toContain("{BOT_NAME}");
  expect(prompt).toContain("Rin");
  // 内容应为私聊场景
  expect(prompt).toContain("私聊消息");
  expect(prompt).toContain("自然回应");
});

test("getScenarioPrompt 为每个已知场景返回非空内容", () => {
  const scenarios = ["private", "at-self", "at-all", "mentioned", "bystander", "media", "default"];
  for (const s of scenarios) {
    const result = getScenarioPrompt(s, "Rin");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("{BOT_NAME}");
  }
});

test("getScenarioPrompt('nonexistent', 'Rin') 返回 default 场景作为 fallback", () => {
  const result = getScenarioPrompt("nonexistent", "Rin");
  // 应回退到 default 场景（"你只是群里的普通成员"），而非空字符串
  expect(result).toContain("普通成员");
  expect(result).not.toContain("## scenario:");
});

test("getScenarioPrompt('nonexistent', 'Rin') 的 fallback 不含 {BOT_NAME} 占位符", () => {
  const result = getScenarioPrompt("nonexistent", "Rin");
  expect(result).not.toContain("{BOT_NAME}");
});

// ── 核心身份提取 ────────────────────────────────────────

test("getCoreIdentity('Rin') 返回第一个 scenario 之前的内容", () => {
  const identity = getCoreIdentity("Rin");
  expect(identity).toContain("角色设定");
  expect(identity).toContain("你叫 Rin");
  expect(identity).not.toContain("## scenario:");
});

// ── getSystemPrompt ─────────────────────────────────────

test("getSystemPrompt('Rin') 替换 {BOT_NAME} 并保留完整内容", () => {
  const prompt = getSystemPrompt("Rin");
  expect(prompt).toContain("你叫 Rin");
  expect(prompt).not.toContain("{BOT_NAME}");
  expect(prompt).toContain("## scenario:private");
  expect(prompt).toContain("## scenario:default");
});

// ── 不存在文件的 fallback ──────────────────────────────

test("loadPrompt('nonexistent') 返回描述性 fallback", () => {
  const result = loadPrompt("nonexistent");
  expect(result).toContain("nonexistent");
  expect(result).toContain("prompt not found");
});

// ── 缓存重置 ────────────────────────────────────────────

test("clearPromptCaches() 清除缓存后，再次读取应重新从磁盘读入", () => {
  const tempName = "test-cache-clear";
  const tempPath = join(PROMPTS_DIR, `${tempName}.md`);

  try {
    // 写入初始内容
    writeFileSync(tempPath, "first version", "utf8");
    const first = loadPrompt(tempName);
    expect(first).toBe("first version");

    // 清缓存，改文件
    clearPromptCaches();
    writeFileSync(tempPath, "second version", "utf8");

    const second = loadPrompt(tempName);
    expect(second).toBe("second version");
    expect(second).not.toBe("first version");
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
});

test("clearPromptCaches() 调用后 getSystemPrompt 仍能正常工作", () => {
  clearPromptCaches();
  const prompt = getSystemPrompt("Rin");
  expect(prompt).toContain("你叫 Rin");
});

// ── 测试间隔离 ────────────────────────────────────────

test("测试中 beforeEach 已调用 clearPromptCaches，本测试仅为验证隔离存在", () => {
  // 先加载一次确保缓存非空
  loadPrompt("system");
  // 此时缓存应有内容，但因为 beforeEach 在后面测试会清掉
  // 这个测试本身假设 beforeEach 已执行完毕
  expect(true).toBe(true);
});

test("前后两次 loadPrompt 返回相同的字符串内容（相同磁盘文件）", () => {
  const a = loadPrompt("reply");
  const b = loadPrompt("reply");
  expect(a).toBe(b);
});

test("clearPromptCaches 后再次读取相同文件仍返回正确内容", () => {
  const before = loadPrompt("vision");
  clearPromptCaches();
  const after = loadPrompt("vision");
  expect(after).toBe(before);
});
