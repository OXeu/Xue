/**
 * analyze-raw.ts — 分析 data/raw/ 下采集的群聊 JSONL 数据。
 *
 * 用法: bun run analyze-raw
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 路径 ────────────────────────────────────────────────

const RAW_DIR = resolve(import.meta.dirname, "../data/raw");
const DOCS_DIR = resolve(import.meta.dirname, "../docs");

// ── 类型 ────────────────────────────────────────────────

interface ListenEntry {
  session: string;
  msgId: number;
  time: number;
  type: string;
  text: string;
  userId: number;
  nickname: string;
  card?: string;
  senderRole?: string;
  subType: string;
  selfId: number;
  atUsers: number[];
  replyTo?: number;
  segmentTypes: string[];
}

interface SessionStats {
  session: string;
  total: number;
  startTime: string;
  endTime: string;
  spanHours: number;
  density: number;         // 条/小时
  uniqueUsers: number;
  senderRoles: Record<string, number>;
  typeDist: Record<string, number>;
  atCount: number;
  replyCount: number;
  avgBodyLen: number;
}

// ── 读取 ────────────────────────────────────────────────

function loadAllSessions(): Map<string, ListenEntry[]> {
  const sessions = new Map<string, ListenEntry[]>();

  if (!existsSync(RAW_DIR)) return sessions;

  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    const lines = readFileSync(join(RAW_DIR, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as ListenEntry);
    sessions.set(sessionId, entries);
  }

  return sessions;
}

// ── 统计 ────────────────────────────────────────────────

function analyzeSession(entries: ListenEntry[]): SessionStats {
  const timestamps = entries.map((e) => e.time).sort((a, b) => a - b);
  const startTs = timestamps[0];
  const endTs = timestamps[timestamps.length - 1];
  const spanSeconds = endTs - startTs;
  const spanHours = spanSeconds > 0 ? spanSeconds / 3600 : 1;

  const users = new Set(entries.map((e) => e.userId));
  const roles: Record<string, number> = {};
  const typeDist: Record<string, number> = {};
  let atCount = 0;
  let replyCount = 0;
  let totalLen = 0;

  for (const e of entries) {
    // 角色分布
    if (e.senderRole) roles[e.senderRole] = (roles[e.senderRole] || 0) + 1;

    // 类型分布
    typeDist[e.type] = (typeDist[e.type] || 0) + 1;

    // @计数
    if (e.atUsers.length > 0) atCount++;

    // 回复引用计数
    if (e.replyTo !== undefined) replyCount++;

    // 正文总长度
    totalLen += e.text.length;
  }

  return {
    session: entries[0].session,
    total: entries.length,
    startTime: new Date(startTs * 1000).toISOString(),
    endTime: new Date(endTs * 1000).toISOString(),
    spanHours: Math.round(spanHours * 10) / 10,
    density: Math.round((entries.length / spanHours) * 10) / 10,
    uniqueUsers: users.size,
    senderRoles: roles,
    typeDist,
    atCount,
    replyCount,
    avgBodyLen: Math.round(totalLen / entries.length),
  };
}

// ── 输出 ────────────────────────────────────────────────

function fmtPct(n: number, total: number): string {
  if (total === 0) return "0.0";
  return ((n / total) * 100).toFixed(1);
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function buildReport(sessions: Map<string, ListenEntry[]>): string {
  if (sessions.size === 0) return "";

  const now = new Date().toISOString();
  const lines: string[] = [
    `# 群聊数据汇总`,
    `\n**生成时间**: ${now}`,
    `**会话数**: ${sessions.size}`,
    `\n---\n`,
  ];

  // 按消息总数降序排序
  const sorted = [...sessions.entries()]
    .map(([id, entries]) => ({ id, entries, stats: analyzeSession(entries) }))
    .sort((a, b) => b.stats.total - a.stats.total);

  const totalMsgs = sorted.reduce((s, x) => s + x.stats.total, 0);

  lines.push(`## 总览\n`);
  lines.push(`| 指标 | 数值 |`);
  lines.push(`|------|------|`);
  lines.push(`| 总消息数 | ${totalMsgs} |`);
  lines.push(`| 总会话数 | ${sessions.size} |`);
  lines.push(`| 总发送者（去重） | ${new Set([...sessions.values()].flat().map((e) => e.userId)).size} |`);
  lines.push(``);

  // 逐会话表格
  lines.push(`## 逐会话统计\n`);
  lines.push(`| 会话 | 消息数 | 发送者 | 时间跨度(h) | 密度(条/h) | 平均长度 | @次数 | 回复次数 | 主要类型 |`);
  lines.push(`|------|--------|--------|-------------|------------|----------|-------|----------|----------|`);

  for (const { id, stats } of sorted) {
    const topType = Object.entries(stats.typeDist).sort((a, b) => b[1] - a[1]);
    const typeSummary = topType.slice(0, 3).map(([t, c]) => `${t} ${c}(${fmtPct(c, stats.total)}%)`).join(" ");

    lines.push(
      `| ${id} ` +
      `| ${stats.total} ` +
      `| ${stats.uniqueUsers} ` +
      `| ${stats.spanHours} ` +
      `| ${stats.density} ` +
      `| ${stats.avgBodyLen} ` +
      `| ${stats.atCount} ` +
      `| ${stats.replyCount} ` +
      `| ${typeSummary} |`,
    );
  }

  lines.push(``);
  lines.push(`## 逐会话详情\n`);

  for (const { id, stats } of sorted) {
    const topType = Object.entries(stats.typeDist).sort((a, b) => b[1] - a[1]);

    lines.push(`### ${id}`);
    lines.push(``);
    lines.push(`- **消息数**: ${stats.total}`);
    lines.push(`- **时间跨度**: ${stats.startTime} ～ ${stats.endTime}（${stats.spanHours}h）`);
    lines.push(`- **密度**: ${stats.density} 条/小时`);
    lines.push(`- **发送者（去重）**: ${stats.uniqueUsers}`);
    lines.push(`- **平均正文长度**: ${stats.avgBodyLen} 字符`);
    lines.push(`- **@次数**: ${stats.atCount}`);
    lines.push(`- **回复引用次数**: ${stats.replyCount}`);
    lines.push(``);
    lines.push(`**消息类型分布：**`);
    lines.push(``);
    lines.push(`| 类型 | 数量 | 占比 |`);
    lines.push(`|------|------|------|`);
    for (const [t, c] of topType) {
      lines.push(`| ${t} | ${c} | ${fmtPct(c, stats.total)}% |`);
    }

    if (Object.keys(stats.senderRoles).length > 0) {
      lines.push(``);
      lines.push(`**发送者角色分布：**`);
      lines.push(``);
      lines.push(`| 角色 | 数量 |`);
      lines.push(`|------|------|`);
      for (const [role, c] of Object.entries(stats.senderRoles).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${role} | ${c} |`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ── 控制台输出 ──────────────────────────────────────────

function printSummary(sessions: Map<string, ListenEntry[]>): void {
  if (sessions.size === 0) {
    console.log("data/raw 为空，跳过");
    return;
  }

  const sorted = [...sessions.entries()]
    .map(([id, entries]) => ({ id, entries, stats: analyzeSession(entries) }))
    .sort((a, b) => b.stats.total - a.stats.total);

  const total = sorted.reduce((s, x) => s + x.stats.total, 0);
  const allUsers = new Set([...sessions.values()].flat().map((e) => e.userId));

  console.log(`\n  总消息数: ${total}  |  会话数: ${sessions.size}  |  发送者(去重): ${allUsers.size}\n`);
  console.log(`  ${"会话".padEnd(30)} ${"消息".padEnd(6)} ${"发送者".padEnd(7)} ${"跨度(h)".padEnd(8)} ${"密度".padEnd(10)} ${"平均长".padEnd(7)} 主要类型`);
  console.log(`  ${"─".repeat(30)} ${"─".repeat(6)} ${"─".repeat(7)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(7)}  ${"─".repeat(30)}`);

  for (const { id, stats } of sorted) {
    const topType = Object.entries(stats.typeDist).sort((a, b) => b[1] - a[1]);
    const typeSummary = topType.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(" ");
    console.log(`  ${id.padEnd(30)} ${String(stats.total).padEnd(6)} ${String(stats.uniqueUsers).padEnd(7)} ${String(stats.spanHours).padEnd(8)} ${String(stats.density).padEnd(10)} ${String(stats.avgBodyLen).padEnd(7)} ${typeSummary}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const sessions = loadAllSessions();

  if (sessions.size === 0) {
    console.log("data/raw 为空，跳过");
    return;
  }

  const report = buildReport(sessions);

  // 控制台输出
  printSummary(sessions);

  // 写入文档
  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(DOCS_DIR, `raw-summary-${stamp}.md`);
  writeFileSync(outPath, report, "utf8");
  console.log(`\n  详细报告已写入: ${outPath}`);
}

main();
