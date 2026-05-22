/**
 * infer-stickers.ts — 批量推理原型：对索引中的表情包图片调用视觉模型分析含义。
 *
 * 读取 data/stickers/ 中的索引条目（type: image），对每条：
 * 1. 优先检查 data/test-images/ 本地缓存
 * 2. 无缓存时尝试从 CDN URL 即时下载
 * 3. 计算感知哈希（dHash），与已推理图片对比去重（汉明距离 ≤ 3 视为重复）
 * 4. 调用视觉模型分析含义
 * 5. 结果写入 data/inferences/{session}.jsonl
 *
 * 已推理的条目（msgId）自动跳过，除非传入 --reindex 强制重新推理。
 *
 * 运行模式：
 *   bun run infer-stickers                              # 全量（跳过已推理）
 *   bun run infer-stickers --reindex                   # 全量 + 重新推理
 *   SESSION=group_313214094 bun run infer-stickers      # 指定会话
 *   MAX_STICKERS=5 bun run infer-stickers              # 限制处理条数
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getStickerContext, StickerEntry } from "./index-stickers";
import { cleanVisionDescription } from "./clean-vision";
import { hasCache, getCachedImage, saveCachedImage } from "./image-cache";
import { computeDHash, isDuplicate } from "./phash";

const STICKERS_DIR = resolve(import.meta.dirname, "../data/stickers");
const RAW_DIR = resolve(import.meta.dirname, "../data/raw");
const INFERENCES_DIR = resolve(import.meta.dirname, "../data/inferences");

// ── 配置 ────────────────────────────────────────────────

const VISION_MODEL = process.env.VISION_MODEL || "gemma4:26b";
const VISION_BASE_URL = (process.env.VISION_BASE_URL || "http://127.0.0.1:11444/v1").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const MAX_STICKERS = Number(process.env.MAX_STICKERS || Infinity);
const REINDEX = process.argv.includes("--reindex");

// ── 类型 ────────────────────────────────────────────────

export interface InferenceEntry {
  msgId: number;
  time: number;
  session: string;
  userId: number;
  nickname: string;
  card?: string;
  type: "image" | "face";
  /** 图片 URL 或 face ID */
  content: string;
  /** 该消息的纯文本内容 */
  text: string;
  /** 反查的上下文（前后各 3 条） */
  context: { time: number; nickname: string; text: string }[];
  /** 模型返回的含义分析，失败时为 null */
  inference: string | null;
  /** 推理时间戳（ISO） */
  timestamp: string;
  /** 感知哈希（dHash），用于相似图片去重 */
  phash?: string;
}

export interface SessionSummary {
  total: number;
  success: number;
  fail: number;
  /** CDN 过期跳过 */
  skipped: number;
}

// ── 持久化 ──────────────────────────────────────────────

let _stickersDir = STICKERS_DIR;
let _rawDir = RAW_DIR;
let _inferencesDir = INFERENCES_DIR;

/** 重设 stickers 索引目录（供测试使用）。返回旧目录以便恢复。 */
export function setStickersDir(dir: string): string {
  const old = _stickersDir;
  _stickersDir = dir;
  return old;
}

/** 重设 raw 目录（供测试使用）。返回旧目录以便恢复。 */
export function setRawDir(dir: string): string {
  const old = _rawDir;
  _rawDir = dir;
  return old;
}

/** 重设推理结果目录（供测试使用）。返回旧目录以便恢复。 */
export function setInferencesDir(dir: string): string {
  const old = _inferencesDir;
  _inferencesDir = dir;
  return old;
}

function ensureInferencesDir(): void {
  if (!existsSync(_inferencesDir)) mkdirSync(_inferencesDir, { recursive: true });
}

/** 加载某会话已有的推理结果 msgId 集合 */
export function loadInferredIds(session: string): Set<number> {
  const path = join(_inferencesDir, `${session}.jsonl`);
  if (!existsSync(path)) return new Set();
  const ids = new Set<number>();
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as InferenceEntry;
      ids.add(entry.msgId);
    } catch { /* skip */ }
  }
  return ids;
}

/** 追加一条推理结果到磁盘 */
export function saveInference(entry: InferenceEntry): void {
  const path = join(_inferencesDir, `${entry.session}.jsonl`);
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ── 统计 ────────────────────────────────────────────────

let total = 0;
let success = 0;
let fail = 0;
let dedupSkipped = 0;
let cdnSkipped = 0;

// ── 图片获取 ────────────────────────────────────────────

/** 获取图片 base64：优先使用本地缓存，无缓存时从 URL 即时下载。
 *  CDN 链接有时效，若本地无缓存且下载失败则返回 null（表明图片已不可用）。 */
async function getImageBase64(
  imageUrl: string, session: string, msgId: number,
): Promise<{ base64: string; mime: string } | null> {
  // 1) 优先本地缓存
  if (hasCache(session, msgId)) {
    const cached = getCachedImage(session, msgId);
    if (cached) {
      console.log(`    [cache hit] ${session}_${msgId}`);
      return cached;
    }
  }

  // 2) 从原始 URL 下载（listen 阶段已检查过的 CDN 链接在此时间窗口内应仍有效）
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const mime = res.headers.get("content-type") || "image/jpeg";
      const base64 = Buffer.from(buf).toString("base64");
      saveCachedImage(session, msgId, base64, mime, "(pending)", imageUrl);
      console.log(`    [downloaded + cached] ${session}_${msgId}`);
      return { base64, mime };
    }
  } catch { /* no picsum fallback — 随机风景图对群聊含义是误导性的 */ }

  return null;
}

/** 调用视觉模型分析图片含义（图片 base64 由调用方提供） */
async function inferStickerMeaning(
  base64: string, mime: string, contextText: string,
): Promise<string | null> {
  const dataUri = `data:${mime};base64,${base64}`;
  try {
    const res = await fetch(`${VISION_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY || "ollama"}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `这是一张群聊中出现的表情包图片。附近的消息上下文如下：\n---\n${contextText}\n---\n请用一句话推断这张表情包在对话中表达了什么含义或情绪。直接说结论，不要分析过程。`,
              },
              {
                type: "image_url",
                image_url: { url: dataUri },
              },
            ],
          },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`    [error] HTTP ${res.status}: ${body.slice(0, 150)}`);
      return null;
    }

    const json = (await res.json()) as {
      choices: { message: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;
    const raw = msg?.reasoning || msg?.content || "";
    return raw.trim() || null;
  } catch (err) {
    console.error(`    [error] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 将 context 消息列表整理成可读文本 */
function formatContext(
  ctx: { time: number; nickname: string; text: string }[],
): string {
  if (ctx.length === 0) return "（无上下文）";
  return ctx.map((c) => `${c.nickname}: ${c.text}`).join("\n");
}

/** 处理单个会话的 sticker 索引：读取、推理、持久化。导出以供测试直接调用。
 *  返回该会话的三类统计摘要。 */
export async function processSession(
  session: string,
  options?: { reindex?: boolean; maxStickers?: number },
): Promise<SessionSummary> {
  const reindex = options?.reindex ?? REINDEX;
  const maxStickers = options?.maxStickers ?? MAX_STICKERS;

  const stickerPath = join(_stickersDir, `${session}.jsonl`);
  if (!existsSync(stickerPath)) return { total: 0, success: 0, fail: 0, skipped: 0 };

  const lines = readFileSync(stickerPath, "utf8").trim().split("\n").filter(Boolean);
  const stickers: StickerEntry[] = [];
  for (const l of lines) {
    try {
      stickers.push(JSON.parse(l) as StickerEntry);
    } catch { /* skip corrupt lines */ }
  }

  // 加载已有推理结果的 msgId 集合和 pHash 列表
  const inferredIds = reindex ? new Set<number>() : loadInferredIds(session);
  const knownPhashes: string[] = [];

  if (!reindex) {
    const infPath = join(_inferencesDir, `${session}.jsonl`);
    if (existsSync(infPath)) {
      const lines = readFileSync(infPath, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as InferenceEntry;
          if (entry.phash) knownPhashes.push(entry.phash);
        } catch { /* skip corrupt lines */ }
      }
    }
  }

  for (const sticker of stickers) {
    if (total >= maxStickers) return { total, success, fail, skipped: cdnSkipped };
    if (sticker.type !== "image") continue;

    // 跳过已推理的条目
    if (inferredIds.has(sticker.msgId)) {
      dedupSkipped++;
      continue;
    }

    total++;

    const ctx = getStickerContext(sticker.msgId, sticker.session, 3, { rawDir: _rawDir });
    const sender = sticker.card || sticker.nickname;

    console.log(`\n--- [${total}] ${sticker.session} ---`);
    if (sticker.content.includes("multimedia")) {
      console.log(`  ℹ QQ CDN 图片，若有本地缓存则直接读取`);
    }
    console.log(`  发送者: ${sender}`);
    console.log(`  图片: ${sticker.content}`);
    console.log(`  上下文:`);
    for (const c of ctx) {
      console.log(`    ${c.nickname}: ${c.text}`);
    }

    // 尝试获取图片（本地缓存优先）
    const img = await getImageBase64(sticker.content, sticker.session, sticker.msgId);
    if (!img) {
      console.log(`  ⏭ 跳过（CDN 已过期，无本地缓存）`);
      cdnSkipped++;
      continue;
    }

    // 计算感知哈希，与已有结果去重
    let phash: string | undefined;
    try {
      phash = await computeDHash(img.base64, img.mime);
    } catch {
      // 哈希计算失败（如图片损坏），仍继续推理
    }

    if (phash && isDuplicate(phash, knownPhashes)) {
      console.log(`  ⏭ 跳过（与已有图片相似，phash 距离 ≤ 3）`);
      dedupSkipped++;
      continue;
    }

    console.log(`  分析中...`);
    const raw = await inferStickerMeaning(img.base64, img.mime, formatContext(ctx));
    const inference = raw ? cleanVisionDescription(raw) : null;

    if (inference) {
      console.log(`  含义: ${inference}`);
      success++;

      // 持久化推理结果（仅成功时写入）
      const entry: InferenceEntry = {
        msgId: sticker.msgId,
        time: sticker.time,
        session: sticker.session,
        userId: sticker.userId,
        nickname: sticker.nickname,
        card: sticker.card,
        type: sticker.type,
        content: sticker.content,
        text: sticker.text,
        context: ctx,
        inference,
        timestamp: new Date().toISOString(),
        phash,
      };
      saveInference(entry);
      if (phash) knownPhashes.push(phash);
    } else {
      console.log(`  含义: (分析失败)`);
      fail++;
    }
  }

  // 会话摘要
  console.log(`\n  ── ${session} 完成 ──`);
  console.log(`  成功: ${success} | 分析失败: ${fail} | CDN 跳过: ${cdnSkipped} | 去重跳过: ${dedupSkipped}`);
  return { total, success, fail, skipped: cdnSkipped };
}

async function main(): Promise<void> {
  if (!existsSync(_stickersDir)) {
    console.log("data/stickers/ does not exist. Run 'bun run index-stickers' first.");
    process.exit(1);
  }

  ensureInferencesDir();

  const target = process.env.SESSION;
  const allFiles = readdirSync(_stickersDir).filter((f) => f.endsWith(".jsonl"));

  const sessions = target
    ? allFiles.filter((f) => f === `${target}.jsonl`)
    : allFiles;

  if (sessions.length === 0) {
    console.log(`No sticker index found${target ? ` for session: ${target}` : ""}.`);
    process.exit(1);
  }

  const mode = REINDEX ? "（强制重新推理）" : "（跳过已推理）";
  console.log(`Inferring sticker meanings... ${mode}`);
  console.log(`Model: ${VISION_MODEL} @ ${VISION_BASE_URL}`);

  for (const f of sessions) {
    const session = f.replace(/\.jsonl$/, "");
    await processSession(session, { reindex: REINDEX, maxStickers: MAX_STICKERS });
    if (total >= MAX_STICKERS) break;
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`处理完成`);
  console.log(`  成功: ${success}`);
  console.log(`  分析失败: ${fail}`);
  console.log(`  CDN 跳过: ${cdnSkipped}`);
  console.log(`  去重跳过: ${dedupSkipped}`);
  console.log(`  总计处理: ${total}`);
  console.log(`  输出: ${_inferencesDir}/`);
}

main().catch(console.error);
