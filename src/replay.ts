/**
 * replay.ts — 重放历史群聊消息，模拟 agent 回复决策与 LLM 调用
 *
 * 不连接 OneBot。从 JSONL 读取旧消息，按时间顺序逐条回放。
 * 图片消息处理采用 tool calling 模式（与 agent.ts 一致）：
 *   收到图片 → 计算 pHash → 在上下文中显示 [图片] 标记
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
 *   VISION_MODEL           视觉模型名（默认 gemma4:26b）
 *   VISION_BASE_URL        视觉 API 地址（默认 http://127.0.0.1:11444/v1）
 *   BOT_NAME               机器人名称，默认 Rin
 *   BOT_QQ                 Bot QQ 号，默认 3042160393
 *   REPLY_CHANCE           回复概率，默认 0.3
 *   SESSION                目标会话，默认 group_313214094
 *   MAX_MSGS               最多处理 N 条消息（从最新往前），默认全部
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeDHash } from "./phash";
import { cleanVisionDescription } from "./clean-vision";
import { downloadImage, gifToJpeg } from "./image-download";
import { getCachedImage } from "./image-cache";
import { parseAtUsers, stripCqCodes, estimateMsgType } from "./cq-codes";
import {
  extractKeywords,
  analyzeAtmosphere,
  isVagueDescription,
  quickDecideSilence,
} from "./chat-utils";
import {
  getSystemPrompt,
  getScenarioPrompt,
  getReplyRules,
} from "./prompts";

// ── 配置 ────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";
const VISION_MODEL = process.env.VISION_MODEL || "gemma4:26b";
const VISION_BASE_URL = (process.env.VISION_BASE_URL || "http://127.0.0.1:11444/v1").replace(/\/+$/, "");
const BOT_NAME = process.env.BOT_NAME || "Rin";
const BOT_QQ = Number(process.env.BOT_QQ || "3042160393");
const REPLY_CHANCE = parseFloat(process.env.REPLY_CHANCE || "0.3");
const SESSION = process.env.SESSION || "group_313214094";
const MAX_MSGS = process.env.MAX_MSGS ? Number(process.env.MAX_MSGS) : Infinity;

const RAW_DIR = resolve(import.meta.dirname, "../data/prod/raw");

/** 临时图片缓存：pHash → base64 + mime */
const _imageCache = new Map<string, { base64: string; mime: string }>();

const DESCRIBE_IMAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "describe_image",
    description: "询问某张图片的内容。图片 ID（pHash）在消息头中以 #phash_xxx 形式标注。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片的 pHash ID（来自消息头中的 #phash_xxx）" },
        question: { type: "string", description: "你想问这张图片的具体问题" },
      },
      required: ["id", "question"],
    },
  },
};

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LlmResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  /** 原始 message 对象（含 reasoning_content 等额外字段） */
  rawMessage?: Record<string, unknown>;
}

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
  segmentTypes?: string[];
  imageUrls?: string[];
  phash?: string[];
}

// ── 工具函数 ────────────────────────────────────────────

function isImageMsg(e: ListenEntry): boolean {
  return e.type === "image" || (e.segmentTypes?.includes("image") ?? false);
}

function buildContext(entries: ListenEntry[], replyMap?: Map<number, { sender: string; text: string }>): string {
  if (entries.length === 0) return "（暂无历史消息）";
  return entries
    .map((e) => {
      const name = e.card || e.nickname;
      const time = new Date(e.time * 1000).toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
      });
      const at = e.atUsers.length > 0 ? ` @${e.atUsers.join(",")}` : "";
      const reply = e.replyTo
        ? (replyMap?.has(e.replyTo)
            ? ` (回复 ${replyMap.get(e.replyTo)!.sender} "${replyMap.get(e.replyTo)!.text}")`
            : ` (回复 ${e.replyTo})`)
        : "";
      const text = e.text || `[${e.type}]`;
      const imgMark = e.segmentTypes?.includes("image") ? " [图片]" : "";
      return `[${time}] ${name}${at}${reply}: ${text}${imgMark}`;
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
  // replay 模式下回复所有消息（跳过机器人自己的消息）
  if (userId === BOT_QQ || selfId === userId) {
    return { should: false, reason: "self" };
  }
  return { should: true, reason: "replay-all" };
}

function roleInstruction(reason: string): string {
  const prompt = getScenarioPrompt(reason, BOT_NAME);
  return prompt ? `【${prompt}】` : `【${getScenarioPrompt("default", BOT_NAME)}】`;
}

// ── 图片描述 ────────────────────────────────────────────

/** 用视觉模型描述图片（从 base64），返回纯描述文本 */
async function describeImageFromBase64(question: string, base64: string, mime: string): Promise<string | null> {
  if (!VISION_MODEL) return null;
  // GIF → JPEG 转换（Gemma4 等模型不支持 GIF）
  const converted = await gifToJpeg(base64, mime);
  const dataUri = `data:${converted.mime};base64,${converted.base64}`;
  try {
    // Ollama 的 auth 是 "Bearer ollama"，OpenAI 兼容则用真正的 API key
    const visionKey = VISION_BASE_URL.includes("127.0.0.1") || VISION_BASE_URL.includes("localhost") ? "ollama" : (process.env.LLM_API_KEY || "");
    const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${visionKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices: { message: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;
    const raw = (msg?.reasoning || msg?.content || "").trim();
    const clean = raw ? cleanVisionDescription(raw) : null;
    return clean;
  } catch {
    return null;
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

/** 支持工具调用的 LLM 请求 */
async function callLlmWithTools(
  messages: any[],
  tools?: typeof DESCRIBE_IMAGE_TOOL[],
): Promise<LlmResponse> {
  const url = `${LLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${LLM_API_KEY}`,
  };
  const body: Record<string, unknown> = {
    model: LLM_MODEL,
    messages,
    max_tokens: 300,
    temperature: 0.8,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices: { message: Record<string, unknown> }[];
  };
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: (typeof msg.content === "string" ? msg.content.trim() : null) ?? null,
    tool_calls: (msg.tool_calls as ToolCall[] | null) ?? null,
    rawMessage: msg,
  };
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
  const allEntries: ListenEntry[] = [];
  for (const l of lines) {
    try {
      allEntries.push(JSON.parse(l) as ListenEntry);
    } catch { /* skip corrupt lines */ }
  }

  // 按时间排序
  allEntries.sort((a, b) => a.time - b.time);

  const toProcess = MAX_MSGS < Infinity ? allEntries.slice(-MAX_MSGS) : allEntries;
  console.log(`会话: ${SESSION}  |  总消息: ${allEntries.length}  |  本次处理: ${toProcess.length}\n`);

  const results: ReplayResult[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const e = toProcess[i];
    const rawMessage = e.text;
    const cleanText = stripCqCodes(rawMessage);
    const msgType = isImageMsg(e) ? "image" : estimateMsgType(rawMessage);
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
      time: new Date(e.time * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }),
      sender: senderName,
      rawMessage,
      cleanText,
      msgType,
      atUsers,
      decision,
      contextSize: contextEntries.length,
    };

    // 如果决定回复，做快速沉默检查（附带图片描述，如有）
    if (decision.should) {
      const ctxEntries = allEntries.slice(
        Math.max(0, allEntries.indexOf(e) - 30),
        allEntries.indexOf(e),
      );
      // 构建 replyTo 查找表：msgId → { sender, text }
      const replyMap = new Map<number, { sender: string; text: string }>();
      for (const ce of ctxEntries) {
        if (ce.msgId) {
          replyMap.set(ce.msgId, {
            sender: ce.card || ce.nickname,
            text: (ce.text || "").slice(0, 80),
          });
        }
      }
      const ctxText = buildContext(ctxEntries, replyMap);
      const kws = extractKeywords(ctxEntries, 5);
      const summary = kws.length > 0 ? `当前话题：${kws.join("、")}` : "";
      const atmosphereTag = analyzeAtmosphere(ctxEntries);

      // 如果是图片消息，先尝试从本地缓存加载（phash），再回退到 CDN 下载
      let imageDesc = "";
      if (isImageMsg(e)) {
        let downloaded: { base64: string; mime: string } | null = null;
        let phash: string | null = null;

        // 优先用 entry.phash 查找本地缓存
        if (e.phash?.[0]) {
          const cached = getCachedImage(e.phash[0]);
          if (cached) {
            downloaded = cached;
            phash = e.phash[0];
          }
        }

        // 本地缓存未命中，回退到 CDN URL 下载
        if (!downloaded) {
          const imgUrl = e.imageUrls?.[0] ?? null;
          if (imgUrl) {
            downloaded = await downloadImage(imgUrl);
            if (downloaded) {
              phash = await computeDHash(downloaded.base64, downloaded.mime);
            }
          }
        }

        if (downloaded && phash) {
          _imageCache.set(phash, downloaded);
          if (VISION_MODEL) {
            const answer = await describeImageFromBase64("用一条简短的自然语句描述这张图片的核心内容：主体是什么、情绪或氛围如何、是否包含文字。不要模板化的描述。", downloaded.base64, downloaded.mime);
            if (answer && !isVagueDescription(answer)) {
              imageDesc = answer;
            }
          }
        }
      }

      const displayText = imageDesc
        ? `${cleanText}（图片描述：${imageDesc.slice(0, 80)}）`
        : cleanText;

      const quickReply = await quickDecideSilence(ctxText, senderName, displayText, decision.reason, summary, atmosphereTag);
      if (!quickReply || quickReply.toUpperCase() === "SILENT") {
        console.log(`[${result.time}] ${result.sender} [silent] ${cleanText.slice(0, 60)}`);
      } else {
        result.reply = quickReply;
        console.log(`[${result.time}] ${result.sender} [${decision.reason}]`);
        console.log(`  触发: ${displayText.slice(0, 60) || "(图片)"}`);
        console.log(`  回复: ${quickReply.slice(0, 120)}`);
        console.log(`  话题: ${summary || "(无)"}`);
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
