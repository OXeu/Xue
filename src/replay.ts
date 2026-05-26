/**
 * replay.ts — 重放历史群聊消息，模拟 agent 回复决策与 LLM 调用
 *
 * 不连接 OneBot。从 JSONL 读取旧消息，按时间顺序逐条回放。
 * 图片消息处理采用 tool calling 模式（与 agent.ts 一致）：
 *   收到图片 → 计算 pHash → 在上下文中显示 [图片#phash] 标记
 *   → Agent 通过工具调用（describe_image）询问图片内容
 *   → 系统执行工具调用视觉模型 → 工具结果注入对话 → Agent 可继续追问或直接回复
 *   （每消息最多 5 轮问答）
 *
 * 用法:
 *   LLM_API_KEY=sk-xxx bun run src/replay.ts
 *
 * 环境变量:
 *   LLM_API_KEY           LLM API Key（必填）
 *   LLM_BASE_URL          API 地址，默认 https://api.deepseek.com/v1
 *   LLM_MODEL              模型名，默认 deepseek-v4-flash
 *   BOT_NAME               机器人名称，默认 Rin
 *   BOT_QQ                 Bot QQ 号，默认 3042160393
 *   REPLY_CHANCE           回复概率，默认 0.3
 *   SESSION                目标会话，默认 group_313214094
 *   MAX_MSGS               最多处理 N 条消息（从最新往前），默认全部
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ListenEntry } from "./shared/types";
import { stripCqCodes } from "./cq-codes";
import {
  loadRecentMessages,
} from "./chat-utils";
import { runAgentTurn } from "./agent/engine";
import { __setRawDirForTest } from "./agent/context";

// ── 配置 ────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";
const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const SESSION = process.env.SESSION || "group_313214094";
const MAX_MSGS = process.env.MAX_MSGS ? Number(process.env.MAX_MSGS) : Infinity;

const RAW_DIR = resolve(import.meta.dirname, "../data/prod/raw");

__setRawDirForTest(RAW_DIR);

// ListenEntry 类型由 shared/types.ts 提供

function ts(): string {
  return new Date().toISOString();
}

// ── 主流程 ──────────────────────────────────────────────

interface ReplayResult {
  index: number;
  time: string;
  sender: string;
  rawMessage: string;
  cleanText: string;
  msgType: string;
  atUsers: number[];
  decision: { should: boolean; reason: string };
  reply?: string;
  contextSize: number;
  displayText?: string;
}

async function main(): Promise<void> {
  if (!LLM_API_KEY) {
    console.error("请设置 LLM_API_KEY 环境变量");
    process.exit(1);
  }

  const filePath = join(RAW_DIR, `${SESSION}.jsonl`);
  if (!existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(1);
  }

  const allEntries = loadRecentMessages(RAW_DIR, SESSION, Number.MAX_SAFE_INTEGER) as ListenEntry[];

  // 按时间排序
  allEntries.sort((a, b) => a.time - b.time);

  const toProcess = MAX_MSGS < Infinity ? allEntries.slice(-MAX_MSGS) : allEntries;
  console.log(`会话: ${SESSION}  |  总消息: ${allEntries.length}  |  本次处理: ${toProcess.length}\n`);

  const results: ReplayResult[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const e = toProcess[i];
    const rawMessage = e.text;
    const cleanText = stripCqCodes(rawMessage);
    const msgType = e.type;
    const atUsers = e.atUsers;
    const senderName = e.card || e.nickname;

    // 上下文（这条消息之前的最新消息）
    const index = allEntries.indexOf(e);
    const contextEntries = allEntries.slice(Math.max(0, index - 30), index + 1);

    const turn = await runAgentTurn(e as any, {
      isPrivate: SESSION.startsWith("private_"),
      rawMessage,
      contextOverride: {
        recent: contextEntries,
        persistedEntry: e,
      },
      decisionOverride: e.userId === BOT_QQ || e.selfId === e.userId
        ? { should: false, reason: "self" }
        : { should: true, reason: "replay-all" },
      skipContinuationTracking: true,
      logger: (msg) => console.log(`[${ts()}] [replay-agent] ${msg}`),
    });

    const result: ReplayResult = {
      index: i,
      time: new Date(e.time * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }),
      sender: senderName,
      rawMessage,
      cleanText,
      msgType,
      atUsers,
      decision: turn.decision,
      contextSize: contextEntries.length,
      displayText: turn.displayText,
    };

    if (turn.decision.should) {
      if (!turn.reply) {
        console.log(`[${result.time}] ${result.sender} [silent] ${cleanText.slice(0, 60)}`);
      } else {
        result.reply = turn.reply;
        console.log(`[${result.time}] ${result.sender} [${turn.decision.reason}]`);
        console.log(`  触发: ${turn.displayText.slice(0, 60) || "(图片)"}`);
        console.log(`  回复: ${turn.reply.slice(0, 120)}`);
        console.log();
      }
    }

    results.push(result);
  }

  // 汇总
  const decided = results.filter((r) => r.decision.should);
  const replied = results.filter((r) => r.reply);

  console.log(`─".repeat(40)`);
  console.log(`汇总:`);
  console.log(`  总消息: ${results.length}`);
  console.log(`  决定回复: ${decided.length}`);
  console.log(`  实际回复 (LLM): ${replied.length}`);
  console.log(`  决策分布:`);
  const dist: Record<string, number> = {};
  for (const d of decided) {
    dist[d.decision.reason] = (dist[d.decision.reason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}`);
  }
}

// 仅在直接运行时调用 main()，被测试 import 时不自动执行
const isDirectRun = import.meta.path === Bun.main;
if (isDirectRun) {
  main().catch(console.error);
}
