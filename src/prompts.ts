/**
 * prompts.ts — 加载 prompts/ 目录下的 markdown prompt 文件
 *
 * 所有 prompt 文件在首次引用时通过 readFileSync 加载并缓存，
 * 后续不走磁盘。测试可通过 clearPromptCaches() 重置缓存。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROMPTS_DIR = resolve(import.meta.dirname, "../prompts");

// ── 缓存 ────────────────────────────────────────────────

const cache = new Map<string, string>();

/** 读取并缓存一个 prompt 文件（不含扩展名） */
function load(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8").trim();
  cache.set(name, content);
  return content;
}

/** 重置所有 prompt 缓存（供测试使用） */
export function clearPromptCaches(): void {
  cache.clear();
}

// ── 公共 API ────────────────────────────────────────────

/** 获取完整的 system.md 内容，{BOT_NAME} 已替换为 botName */
export function getSystemPrompt(botName: string): string {
  return load("system").replace(/\{BOT_NAME\}/g, botName);
}

/** 从 system.md 中提取指定场景的单条指令，{BOT_NAME} 已替换 */
export function getScenarioPrompt(scenario: string, botName: string): string {
  const base = load("system");
  const re = new RegExp(
    `##\\s*scenario:${escapeRegex(scenario)}\\s*\\n([^#]+)`,
  );
  const match = base.match(re);
  return match
    ? match[1].trim().replace(/\{BOT_NAME\}/g, botName)
    : "";
}

/** 获取 reply.md 内容（回复风格要求） */
export function getReplyRules(): string {
  return load("reply");
}

/** 获取 vision.md 内容（图片描述注入格式） */
export function getVisionFormat(): string {
  return load("vision");
}

// ── 工具 ────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
