/**
 * replay.ts — 重放历史群聊消息，模拟 agent 回复决策与 LLM 调用
 *
 * 不连接 OneBot。从 JSONL 读取旧消息，按时间顺序逐条回放。
 * 图片消息优先使用 data/test-images/ 中的缓存描述，
 * 未缓存时从 picsum.photos 用固定种子下载后描述并写入缓存。
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
import { cleanVisionDescription } from "./clean-vision";
import { getCachedDescription, saveCachedImage } from "./image-cache";
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
  segmentTypes?: string[];
  imageUrls?: string[];
}

// ── 工具函数 ────────────────────────────────────────────

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

function isImageMsg(e: ListenEntry): boolean {
  return e.type === "image" || (e.segmentTypes?.includes("image") ?? false);
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

/**
 * 从 buildSessionProfile 的输出中解析风格行，生成语气指导。
 *
 * 映射规则（基于 style-report 中真人基线校准）：
 * - 短句偏多 → 回复请尽量控制在 20 字以内
 * - 短句适中 → 回复尽量简短
 * - 短句偏少 → 回复可适当展开，但避免长篇大论
 * - 语气词偏多 → 少用语气词（哈/嘛/嗯/哦）
 * - 语气词适中 → 语气自然即可
 * - 语气词偏少 → 保持简洁语气
 * - 问句偏多 → 可适度用问句
 * - 问句适中 → 可适当使用问句
 * - 问句偏少 → 减少问句
 */
function styleGuidance(profile: string): string {
  if (!profile.includes("风格：")) return "";

  const guide: string[] = [];

  if (profile.includes("短句偏多")) guide.push("回复请尽量控制在 20 字以内");
  else if (profile.includes("短句适中")) guide.push("回复尽量简短");
  else if (profile.includes("短句偏少")) guide.push("回复可适当展开，但避免长篇大论");

  if (profile.includes("语气词偏多")) guide.push("少用语气词（哈/嘛/嗯/哦）");
  else if (profile.includes("语气词适中")) guide.push("语气自然即可");
  else if (profile.includes("语气词偏少")) guide.push("保持简洁语气");

  if (profile.includes("问句偏多")) guide.push("可适度用问句");
  else if (profile.includes("问句适中")) guide.push("可适当使用问句");
  else if (profile.includes("问句偏少")) guide.push("减少问句");

  if (guide.length === 0) return "";
  return `【语气指导】${guide.join("，")}`;
}

/** 从历史消息中提取群聊特征词和风格特征。读取最近 200 条消息。 */
function buildSessionProfile(sessionId: string): string {
  if (sessionId.startsWith("private_")) return "";
  const entries = loadRecentMessages(sessionId, 200);
  if (entries.length < 10) return "";
  const keywords = extractKeywords(entries, 10);
  const lines: string[] = [];
  if (keywords.length > 0) lines.push(`群聊特征：${keywords.join("、")}`);
  const style = analyzeStyle(entries);
  if (style) lines.push(style);
  return lines.join("\n");
}

/**
 * 分析消息历史中的说话风格特征。
 *
 * 阈值说明（基于 style-report 中真人基线校准）：
 * - 短句（≤15 字）：真人 30~50%。>60% 短平快消息为主（群聊常态）；
 *   30~60% 适中；<30% 偏少（群内长文讨论多）。
 * - 问句（以？结尾或含吗/呢/么/吧）：>30% 偏多，15~30% 适中，<15% 偏少。
 * - 语气词（哈/嘛/嗯/哦/草/靠/淦 等）：>0.3 次/条 偏多，0.1~0.3 适中，
 *   <0.1 偏少（偏严肃群聊）。
 */
function analyzeStyle(entries: ListenEntry[]): string {
  if (entries.length < 10) return "";

  let shortCount = 0;
  let questionCount = 0;
  let toneCount = 0;
  let totalMessages = 0;

  const toneRe = /[哈嘛嗯哦哟草靠淦]/g;

  for (const e of entries) {
    const text = stripCqCodes(e.text).trim();
    if (!text) continue;
    totalMessages++;
    if (text.length <= 15) shortCount++;
    if (text.includes("？") || text.endsWith("?") || /[吗呢么吧]/.test(text)) {
      questionCount++;
    }
    const match = text.match(toneRe);
    if (match) toneCount += match.length;
  }

  if (totalMessages === 0) return "";

  const shortRatio = shortCount / totalMessages;
  const questionRatio = questionCount / totalMessages;
  const tonePerMsg = toneCount / totalMessages;

  // 阈值：短句 60%/30%，问句 30%/15%，语气词 0.3/0.1
  const shortLabel = shortRatio > 0.6 ? "短句偏多" : shortRatio > 0.3 ? "短句适中" : "短句偏少";
  const questionLabel = questionRatio > 0.3 ? "问句偏多" : questionRatio > 0.15 ? "问句适中" : "问句偏少";
  const toneLabel = tonePerMsg > 0.3 ? "语气词偏多" : tonePerMsg > 0.1 ? "语气词适中" : "语气词偏少";

  return `风格：${shortLabel} | ${toneLabel} | ${questionLabel}`;
}

function loadRecentMessages(sessionId: string, limit: number): ListenEntry[] {
  const path = join(RAW_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as ListenEntry);
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
  if (isAtOther) return { should: Math.random() < 0.05, reason: "bystander" };
  return { should: Math.random() < REPLY_CHANCE, reason: "random" };
}

function roleInstruction(reason: string, imgDesc?: string): string {
  if (imgDesc) {
    return `【消息中包含一张图片，描述如下：${imgDesc}。回复时可以结合图片内容。】`;
  }
  // 从 prompts/system.md 提取场景指令，找不到时 fallback 到 default
  const prompt = getScenarioPrompt(reason, BOT_NAME);
  return prompt ? `【${prompt}】` : `【${getScenarioPrompt("default", BOT_NAME)}】`;
}

// ── 图片描述 ────────────────────────────────────────────

/** 下载图片并 base64 编码 */
async function downloadImage(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    return { base64: Buffer.from(buf).toString("base64"), mime };
  } catch {
    return null;
  }
}

/** 用视觉模型描述图片，返回纯描述文本 */
async function describeImage(
  url: string,
  session: string,
  msgId: number,
): Promise<string | null> {
  // 查缓存
  const cached = getCachedDescription(session, msgId);
  if (cached) return cached;

  if (!VISION_MODEL) return null;

  const img = await downloadImage(url);
  if (!img) return null;

  const dataUri = `data:${img.mime};base64,${img.base64}`;

  try {
    const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY || "ollama"}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "用一句话简短描述这张图片的内容" },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 100,
        temperature: 0.5,
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices: { message: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;

    const rawReasoning = msg?.reasoning?.trim();
    if (rawReasoning) {
      const clean = cleanVisionDescription(rawReasoning);
      if (clean) {
        try { saveCachedImage(session, msgId, img.base64, img.mime, clean, url); } catch {}
        return clean;
      }
    }
    const rawContent = msg?.content?.trim();
    if (rawContent) {
      const clean = cleanVisionDescription(rawContent);
      if (clean) {
        try { saveCachedImage(session, msgId, img.base64, img.mime, clean, url); } catch {}
        return clean;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 获取图片消息的描述：优先用原始 URL，否则用 picsum 固定种子 */
async function getImageDescription(e: ListenEntry): Promise<string | null> {
  // 1) 查缓存
  const cached = getCachedDescription(e.session, e.msgId);
  if (cached) return cached;

  // 2) 有原始 URL 则用原始 URL
  if (e.imageUrls && e.imageUrls.length > 0) {
    return describeImage(e.imageUrls[0], e.session, e.msgId);
  }

  // 3) 用 picsum 固定种子（保证每次重放相同）
  const seed = `replay-${e.session}-${e.msgId}`;
  const fallbackUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/300`;
  const desc = await describeImage(fallbackUrl, e.session, e.msgId);
  return desc;
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
  imageDescription?: string;
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
      time: new Date(e.time * 1000).toISOString().slice(11, 19),
      sender: senderName,
      rawMessage,
      cleanText,
      msgType,
      atUsers,
      decision,
      contextSize: contextEntries.length,
    };

    // 获取图片描述（仅图片消息）
    let imageDescription: string | null = null;
    if (isImageMsg(e) && decision.should) {
      imageDescription = await getImageDescription(e);
      if (imageDescription) {
        result.imageDescription = imageDescription;
      }
    }

    // 如果决定回复，调 LLM
    if (decision.should) {
      const contextText = buildContext(contextEntries);
      const keywords = extractKeywords(contextEntries, 5);
      const topicSummary = keywords.length > 0 ? `当前话题：${keywords.join("、")}` : "";
      const roleInst = roleInstruction(decision.reason, imageDescription ?? undefined);

      try {
        const reply = await callLlm([
          {
            role: "system",
            content: [
              getSystemPrompt(BOT_NAME),
              getReplyRules(),
              buildSessionProfile(SESSION),
              styleGuidance(buildSessionProfile(SESSION)),
              topicSummary,
              `\n下面是这个群最近的消息：`,
              roleInst,
            ].filter(Boolean).join("\n"),
          },
          {
            role: "user",
            content: `【群聊上下文】\n${contextText}\n\n【新消息】${senderName}: ${cleanText || "[图片]"}\n\n请以 ${BOT_NAME} 的身份自然回复。`,
          },
        ]);
        result.reply = reply;
        console.log(`[${result.time}] ${result.sender} [${decision.reason}]`);
        console.log(`  触发: ${cleanText.slice(0, 60) || "(图片)"}`);
        if (imageDescription) console.log(`  图片: ${imageDescription.slice(0, 80)}`);
        console.log(`  回复: ${reply.slice(0, 120)}`);
        console.log(`  话题: ${topicSummary || "(无)"}`);
        console.log();
      } catch (err) {
        console.error(`  LLM error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    results.push(result);
  }

  // 汇总
  const decided = results.filter((r) => r.decision.should);
  const replied = results.filter((r) => r.reply);
  const withImg = results.filter((r) => r.imageDescription);

  console.log(`─".repeat(40)`);
  console.log(`汇总:`);
  console.log(`  总消息: ${results.length}`);
  console.log(`  决定回复: ${decided.length}`);
  console.log(`  实际回复 (LLM): ${replied.length}`);
  console.log(`  含图片描述: ${withImg.length}`);
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
