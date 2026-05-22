/**
 * batch-transform.ts — 批量应用风格转换器，产出可人工审阅的样本。
 *
 * 读取基线数据，运行 transform()，随机抽取 15 条展示原文→改文对照。
 * 使用固定随机种子确保每次运行结果可复现。
 *
 * 用法: bun run batch-transform
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transform, type TransformResult } from "./style-transformer";

// ── 路径 ────────────────────────────────────────────────

const RIN_OUTBOX = resolve(import.meta.dirname, "../../loop/mailbox/outbox");
const JSONL_DIR = resolve(import.meta.dirname, "../data/baseline");
const DOCS_DIR = resolve(import.meta.dirname, "../docs");

// ── 播种随机数（固定种子确保可复现） ─────────────────

/** 简易 Mulberry32 播种 PRNG，替换 Math.random 用于采样。 */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 读取 ────────────────────────────────────────────────

interface BaselineEntry {
  re: string;
  at: string;
  bodyLength: number;
  to: string;
  hasTask: boolean;
  failed: boolean;
  sourceFile: string;
}

function readLatestJsonl(): BaselineEntry[] {
  const files = readdirSync(JSONL_DIR)
    .filter((f) => f.startsWith("baseline-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error("没有找到基线文件，先跑 collect-baseline");
    process.exit(1);
  }

  const latest = join(JSONL_DIR, files[0]);
  const lines = readFileSync(latest, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((l: string) => JSON.parse(l) as BaselineEntry);
}

function loadBodies(entries: BaselineEntry[]): { sourceFile: string; body: string }[] {
  const result: { sourceFile: string; body: string }[] = [];
  for (const e of entries) {
    if (e.failed) continue;
    const fp = join(RIN_OUTBOX, e.sourceFile);
    try {
      const raw = readFileSync(fp, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (m) {
        const body = m[2]
          .replace(/^【[^】]*】\s*/, "")
          .replace(/\n\n?Rin\s*$/, "")
          .trim();
        if (body.length > 0) result.push({ sourceFile: e.sourceFile, body });
      }
    } catch { /* skip */ }
  }
  return result;
}

// ── Fisher-Yates 洗牌（固定种子） ─────────────────────

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 报告 ────────────────────────────────────────────────

function buildReport(
  samples: { sourceFile: string; original: string; result: TransformResult }[],
  totalCount: number,
  ruleFreq: Record<string, number>,
): string {
  const now = new Date().toISOString();

  let md = `# 风格转换样本（人工审阅用）

**生成时间**: ${now}
**样本量**: ${totalCount} 条（随机展示 ${samples.length} 条）
**规则触发总频次**: ${Object.values(ruleFreq).reduce((a, b) => a + b, 0)} / ${totalCount * Object.keys(ruleFreq).length}

---

`;

  for (let i = 0; i < samples.length; i++) {
    const { sourceFile, original, result } = samples[i];
    const triggered = result.rules.filter((r) => r.triggered);

    md += `## 样本 ${i + 1}\n\n`;
    md += `**来源**: \`${sourceFile}\`\n\n`;
    md += `**原文**\n\n`;
    md += `> ${original.replace(/\n/g, "\n> ")}\n\n`;
    md += `**改文**\n\n`;
    md += `> ${result.transformed.replace(/\n/g, "\n> ")}\n\n`;
    md += `**触发规则**\n\n`;
    if (triggered.length > 0) {
      for (const r of triggered) {
        md += `- ✅ ${r.rule}${r.detail ? ` — ${r.detail}` : ""}\n`;
      }
    } else {
      md += `- （无规则触发）\n`;
    }
    md += `\n---\n\n`;
  }

  // 规则触发总频次
  md += `## 规则触发统计\n\n`;
  md += `| 规则 | 触发次数 | 触发率 |\n`;
  md += `|------|---------|-------|\n`;
  for (const [name, count] of Object.entries(ruleFreq).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalCount) * 100).toFixed(1);
    md += `| ${name} | ${count} / ${totalCount} | ${pct}% |\n`;
  }

  return md;
}

// ── 主流程 ──────────────────────────────────────────────

function main(): void {
  const entries = readLatestJsonl();
  const items = loadBodies(entries);

  if (items.length === 0) {
    console.error("没有可用正文");
    process.exit(1);
  }

  console.log(`批量转换 ${items.length} 条回信...`);

  // 对所有回信运行 transform
  const ruleFreq: Record<string, number> = {};
  const allResults: { sourceFile: string; original: string; result: TransformResult }[] = [];

  for (const { sourceFile, body } of items) {
    const result = transform(body);
    allResults.push({ sourceFile, original: body, result });
    for (const r of result.rules) {
      if (r.triggered) {
        ruleFreq[r.rule] = (ruleFreq[r.rule] || 0) + 1;
      }
    }
  }

  // 固定种子随机抽 15 条
  const rng = seededRandom(42);
  const shuffled = shuffle(allResults, rng);
  const samples = shuffled.slice(0, Math.min(15, shuffled.length));

  // 输出报告
  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(DOCS_DIR, `transform-samples-${stamp}.md`);

  const report = buildReport(samples, allResults.length, ruleFreq);
  writeFileSync(outPath, report, "utf8");

  console.log(`  规则总触发: ${Object.values(ruleFreq).reduce((a, b) => a + b, 0)} 次`);
  console.log(`  已抽取 15 条样本`);
  console.log(`  报告已写入: ${outPath}`);
}

main();
