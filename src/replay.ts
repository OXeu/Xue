/**
 * replay.ts — 重放历史群聊消息，模拟 agent 回复决策与 LLM 调用
 *
 * 不连接 OneBot。从 JSONL 读取旧消息，按时间顺序逐条回放，
 * 输出每条消息的决策结果和（如果决定回复）LLM 生成的回复。
 *
 * 用于验证改进效果，与 docs/experiment-logs/agent-baseline-before-fix.md 对比。
 *
 * 用法:
 *   LLM_API_KEY=sk-xxx bun run src/replay.ts
 *
 * 环境变量:
 *   LLM_API_KEY    LLM API Key（必填）
 *   LLM_BASE_URL   API 地址，默认 https://api.deepseek.com/v1
 *   LLM_MODEL      模型名，默认 deepseek-v4-flash
 *   BOT_NAME       机器人名称，默认 Rin
 *   BOT_QQ         Bot QQ 号，默认 3042160393
 *   REPLY_CHANCE   回复概率，默认 0.3
 *   SESSION        目标会话，默认 group_313214094
 *   MAX_MSGS       最多处理 N 条消息（从最新往前），默认全部
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 配置 ────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";
const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const SESSION = process.env.SESSION || "group_313214094";
const MAX_MSGS = process.env.MAX_MSGS ? Number(process.env.MAX_MSGS) : Infinity;

const RAW_DIR = resolve(import.meta.dirname, "../data/raw");

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
}

// ── 工具函数（与 agent.ts 一致） ─────────────────────────

function parseAtUsers(raw: string): number[] {
  const ids: number[] = [];
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    ids.push(Number(m[1]));
  }
  return ids;
}

function hasAtAll(raw: string): boolean {
  return /\[CQ:at,qq=all\]/.test(raw);
}

function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
}

function estimateMsgType(raw: string): "text" | "face" | "image" | "mixed" {
  const cqTypes = [...raw.matchAll(/\[CQ:(\w+),/g)].map((m) => m[1]);
  if (cqTypes.length === 0) return "text";
  const stripped = stripCqCodes(raw);
  if (stripped.length > 0) return "mixed";
  if (cqTypes.every((t) => t === "face")) return "face";
  if (cqTypes.every((t) => t === "image")) return "image";
  return "mixed";
}

const STOPWORDS = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "在", "有",
  "不", "就", "也", "都", "还", "这", "那", "什么", "怎么",
  "一个", "这个", "那个", "我们", "你们", "他们", "可以",
  "没有", "因为", "所以", "但是", "如果", "虽然", "不是",
  "就是", "还是", "只是", "可是", "而且", "然后", "之后",
  "之前", "现在", "今天", "明天", "昨天", "晚上", "早上",
  "中午", "那个", "这种", "这样", "那种", "那个", "已经",
  "应该", "可能", "大概", "比较", "非常", "真的", "其实",
  "还是", "就是", "觉得", "知道", "看到", "听到",
  "起来", "出来", "回来", "进去", "过来", "上去", "下来",
  "一下", "一点", "一些", "一个", "这种", "那些", "这些",
  "吗", "啊", "吧", "呢", "哦", "嗯", "哈", "哎", "哟",
  "嘛", "嗯嗯", "哈哈", "hhh", "草", "淦", "靠",
]);

function extractKeywords(entries: ListenEntry[], maxTerms: number): string[] {
  const freq = new Map<string, number>();
  const wordRe = /[\u4e00-\u9fff\w]{2,}/g;
  for (const e of entries) {
    const text = stripCqCodes(e.text);
    const words = text.match(wordRe);
    if (!words) continue;
    for (const w of words) {
      const lower = w.toLowerCase();
      if (lower.length < 2 || STOPWORDS.has(lower)) continue;
      freq.set(lower, (freq.get(lower) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([w]) => w);
}

function buildContext(entries: ListenEntry[]): string {
  if (entries.length === 0) return "（暂无历史消息）";
  return entries
    .map((e) => {
      const name = e.card || e.nickname;
      const time = new Date(e.time * 1000).toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit",
      });
      const at = e.atUsers.length > 0 ? ` @${e.atUsers.join(",")}` : "";
      const reply = e.replyTo ? ` (回复 ${e.replyTo})` : "";
      const text = e.text || `[${e.type}]`;
      return `[${time}] ${name}${at}${reply}: ${text}`;
    })
    .join("\n");
}

function ts(): string {
  return new Date().toISOString();
}

// ── 回复决策 ────────────────────────────────────────────

interface ReplyDecision {
  should: boolean;
  reason: string;
}

function decideReply(
  userId: number, selfId: number, atUsers: number[],
  rawText: string, msgType: string,
): ReplyDecision {
  if (userId === BOT_QQ || selfId === userId) {
    return { should: false, reason: "self" };
  }
  const isAtSelf = atUsers.includes(BOT_QQ);
  const isAtAll = hasAtAll(rawText);
  const isAtOther = atUsers.length > 0 && !isAtSelf && !isAtAll;
  const mentioned = stripCqCodes(rawText).toLowerCase().includes(BOT_NAME.toLowerCase());

  if (isAtSelf || isAtAll) return { should: true, reason: isAtSelf ? "at-self" : "at-all" };
  if (mentioned) return { should: Math.random() < 0.7, reason: "mentioned" };
  if (msgType === "face" || msgType === "image") return { should: Math.random() < 0.1, reason: "media" };
  if (isAtOther) return { should: Math.random() < 0.15, reason: "bystander" };
  return { should: Math.random() < REPLY_CHANCE, reason: "random" };
}

function roleInstruction(reason: string): string {
  switch (reason) {
    case "at-self": return `【消息是发给你的，你被直接 @ 了，请以 ${BOT_NAME} 的身份回应。】`;
    case "at-all": return `【消息 @ 了全体成员，也包括你。请像普通群成员一样自然回应。】`;
    case "mentioned": return `【消息中提到了你的名字（${BOT_NAME}），虽然没 @ 你，但你可以接话。】`;
    case "bystander": return `【这条消息不是发给你的。你只是群里的旁观者，如果实在想说点什么可以接一句，但不要抢话。】`;
    case "media": return `【这是一个表情/图片消息。你可以简单评价一下，也可以忽略。】`;
    default: return `【你只是群里的普通成员，想回就回，不想回就不回。】`;
  }
}

// ── LLM ────────────────────────────────────────────────

async function callLlm(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 300, temperature: 0.8 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
  return data.choices?.[0]?.message?.content?.trim() || "";
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
  decision: ReplyDecision;
  reply?: string;
  contextSize: number;
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

  const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const allEntries: ListenEntry[] = lines.map((l) => JSON.parse(l) as ListenEntry);

  // 按时间排序
  allEntries.sort((a, b) => a.time - b.time);

  const toProcess = MAX_MSGS < Infinity ? allEntries.slice(-MAX_MSGS) : allEntries;
  console.log(`会话: ${SESSION}  |  总消息: ${allEntries.length}  |  本次处理: ${toProcess.length}\n`);

  const results: ReplayResult[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const e = toProcess[i];
    const rawMessage = e.text;
    const cleanText = stripCqCodes(rawMessage);
    const msgType = estimateMsgType(rawMessage);
    const atUsers = parseAtUsers(rawMessage);
    const senderName = e.card || e.nickname;

    // 决策
    const decision = decideReply(e.userId, e.selfId, atUsers, rawMessage, msgType);

    // 上下文（这条消息之前的最新消息）
    const contextEntries = allEntries.slice(
      Math.max(0, allEntries.indexOf(e) - 30),
      allEntries.indexOf(e),
    );

    const result: ReplayResult = {
      index: i,
      time: new Date(e.time * 1000).toISOString().slice(11, 19),
      sender: senderName,
      rawMessage,
      cleanText,
      msgType,
      atUsers,
      decision,
      contextSize: contextEntries.length,
    };

    // 如果决定回复，调 LLM
    if (decision.should) {
      const contextText = buildContext(contextEntries);
      const keywords = extractKeywords(contextEntries, 5);
      const topicSummary = keywords.length > 0 ? `当前话题：${keywords.join("、")}` : "";
      const roleInst = roleInstruction(decision.reason);

      try {
        const reply = await callLlm([
          {
            role: "system",
            content: [
              `你叫${BOT_NAME}，是一个在 QQ 群里聊天的人类。`,
              `回复要简短、自然，像真人。不要列点，不要 formal。`,
              topicSummary,
              `\n下面是这个群最近的消息：`,
              roleInst,
            ].filter(Boolean).join("\n"),
          },
          {
            role: "user",
            content: `【群聊上下文】\n${contextText}\n\n【新消息】${senderName}: ${cleanText}\n\n请以 ${BOT_NAME} 的身份自然回复。`,
          },
        ]);
        result.reply = reply;
        console.log(`[${result.time}] ${result.sender} [${decision.reason}]`);
        console.log(`  触发: ${cleanText.slice(0, 60)}`);
        console.log(`  回复: ${reply.slice(0, 120)}`);
        console.log(`  话题: ${topicSummary || "(无)"}`);
        console.log();
      } catch (err) {
        console.error(`  LLM error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // 跳过的不打印（太多），除非调试
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

main().catch(console.error);
