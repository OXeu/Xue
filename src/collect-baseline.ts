/**
 * collect-baseline.ts
 *
 * 扫描 Rin 主项目的 mailbox/outbox/，提取回信的元数据基线。
 * 输出 JSONL 到 data/baseline/ 下，每条一行 JSON 对象。
 *
 * 用法: bun run collect-baseline
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 路径配置 ────────────────────────────────────────────

/** Rin 主项目的 outbox 目录（相对本仓库或绝对路径均可）。 */
const RIN_OUTBOX = resolve(import.meta.dirname, "../../loop/mailbox/outbox");

/** 本项目的输出目录。 */
const OUT_DIR = resolve(import.meta.dirname, "../data/baseline");

// ── 类型 ────────────────────────────────────────────────

interface BaselineEntry {
  /** 来信文件名（re 字段的值）。 */
  re: string;
  /** 回信时间戳（at 字段的值）。 */
  at: string;
  /** 回复正文长度（字符数，不含 YAML 头）。 */
  bodyLength: number;
  /** 收信人（to 字段的值）。 */
  to: string;
  /** 是否关联了任务（task 字段存在且非空）。 */
  hasTask: boolean;
  /** 是否标记为失败。 */
  failed: boolean;
  /** 原始 outbox 文件名。 */
  sourceFile: string;
}

// ── 解析 ────────────────────────────────────────────────

function parseOutboxFile(filePath: string): BaselineEntry | null {
  const content = readFileSync(filePath, "utf8");

  // 分离 YAML 头与正文
  const headerMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!headerMatch) {
    console.warn(`  ⚠ 跳过无法解析的文件: ${filePath}`);
    return null;
  }

  const headerLines = headerMatch[1];
  const body = headerMatch[2];

  // 解析 YAML 头字段
  const getField = (key: string): string | undefined => {
    const re = new RegExp(`^${key}:\s*(.+)`, "m");
    const m = headerLines.match(re);
    return m ? m[1].trim() : undefined;
  };

  const re = getField("re");
  const at = getField("at");
  const to = getField("to");
  const task = getField("task");
  const status = getField("status");

  if (!re || !at || !to) {
    console.warn(`  ⚠ 跳过缺少必要字段的文件: ${filePath}`);
    return null;
  }

  return {
    re,
    at,
    bodyLength: body.length,
    to,
    hasTask: task !== undefined && task.length > 0,
    failed: status === "失败",
    sourceFile: filePath.split("/").pop() ?? filePath,
  };
}

// ── 主流程 ──────────────────────────────────────────────

function main() {
  console.log(`扫描 outbox 目录: ${RIN_OUTBOX}`);

  if (!existsSync(RIN_OUTBOX)) {
    console.warn(`  ⚠ outbox 目录不存在: ${RIN_OUTBOX}`);
    console.log(`  输出空基线到: ${OUT_DIR}`);

    // 仍然创建输出目录并写出空文件
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(OUT_DIR, `baseline-${stamp}.jsonl`);
    writeFileSync(outPath, "", "utf8");
    console.log(`  已写入空文件: ${outPath}`);
    return;
  }

  // 读取所有 outbox 文件
  const files = readdirSync(RIN_OUTBOX)
    .filter((f) => f.startsWith("re-") && f.endsWith(".md"))
    .sort();

  console.log(`  找到 ${files.length} 封回信`);

  const entries: BaselineEntry[] = [];
  let skipped = 0;

  for (const file of files) {
    const entry = parseOutboxFile(join(RIN_OUTBOX, file));
    if (entry) {
      entries.push(entry);
    } else {
      skipped++;
    }
  }

  // 写出 JSONL
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `baseline-${stamp}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(outPath, lines + "\n", "utf8");

  console.log(`\n完成: 提取 ${entries.length} 条基线, 跳过 ${skipped} 条`);
  console.log(`输出: ${outPath}`);

  // 打印摘要
  if (entries.length > 0) {
    const withTask = entries.filter((e) => e.hasTask).length;
    const failed = entries.filter((e) => e.failed).length;
    const totalLen = entries.reduce((s, e) => s + e.bodyLength, 0);
    const avgLen = (totalLen / entries.length).toFixed(0);

    console.log(`  其中 ${withTask} 条关联工具调用, ${failed} 条失败`);
    console.log(`  平均正文长度: ${avgLen} 字符`);
    console.log(`  时间跨度: ${entries[0].at} ~ ${entries[entries.length - 1].at}`);
  }
}

main();
