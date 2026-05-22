/**
 * infer-stickers.ts — 批量推理原型：对索引中的表情包图片调用视觉模型分析含义。
 *
 * 读取 data/stickers/ 中的索引条目（type: image），对每条：
 * 1. 从 data/raw/ 反查前后各 3 条上下文
 * 2. 调用视觉模型（gemma4:26b via Ollama）分析图片含义
 * 3. 输出到终端
 *
 * 运行模式：
 *   bun run src/infer-stickers.ts                     # 全量推理
 *   SESSION=group_313214094 bun run src/infer-stickers.ts  # 指定会话
 *   MAX_STICKERS=5 bun run src/infer-stickers.ts           # 限制处理条数
 *
 * 环境变量（复用 .env 配置）：
 *   VISION_MODEL、VISION_BASE_URL、LLM_API_KEY
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getStickerContext, StickerEntry } from "./index-stickers";
import { cleanVisionDescription } from "./clean-vision";
import { hasCache, getCachedImage, saveCachedImage } from "./image-cache";

const STICKERS_DIR = resolve(import.meta.dirname, "../data/stickers");
const RAW_DIR = resolve(import.meta.dirname, "../data/raw");

// ── 配置 ────────────────────────────────────────────────

const VISION_MODEL = process.env.VISION_MODEL || "gemma4:26b";
const VISION_BASE_URL = (process.env.VISION_BASE_URL || "http://127.0.0.1:11444/v1").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const MAX_STICKERS = Number(process.env.MAX_STICKERS || Infinity);

// ── 统计 ────────────────────────────────────────────────

let total = 0;
let success = 0;
let fail = 0;

/** 获取图片 base64：优先使用本地缓存，无缓存时从 URL 下载（并缓存结果） */
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

  // 2) 从原始 URL 下载
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const mime = res.headers.get("content-type") || "image/jpeg";
      const base64 = Buffer.from(buf).toString("base64");
      // 下载成功后写入缓存，后续直接命中
      saveCachedImage(session, msgId, base64, mime, "(pending)", imageUrl);
      console.log(`    [downloaded + cached] ${session}_${msgId}`);
      return { base64, mime };
    }
  } catch { /* fall through */ }

  // 3) QQ CDN 图片通常无法下载，用 picsum fallback
  try {
    const seed = `sticker-${session}-${msgId}`;
    const fallbackUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/300`;
    const res = await fetch(fallbackUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    return { base64: Buffer.from(buf).toString("base64"), mime };
  } catch {
    return null;
  }
}

/** 调用视觉模型分析图片含义 */
async function inferStickerMeaning(imageUrl: string, contextText: string, session: string, msgId: number): Promise<string | null> {
  const img = await getImageBase64(imageUrl, session, msgId);
  if (!img) {
    console.error("    [error] 所有图片来源均失败（无缓存、CDN 不可用、picsum fallback 也失败）");
    return null;
  }
  const dataUri = `data:${img.mime};base64,${img.base64}`;
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

async function processSession(session: string): Promise<void> {
  const stickerPath = join(STICKERS_DIR, `${session}.jsonl`);
  if (!existsSync(stickerPath)) return;

  const lines = readFileSync(stickerPath, "utf8").trim().split("\n").filter(Boolean);
  const stickers: StickerEntry[] = lines.map((l) => JSON.parse(l) as StickerEntry);

  for (const sticker of stickers) {
    if (total >= MAX_STICKERS) return;
    if (sticker.type !== "image") continue;

    total++;

    const ctx = getStickerContext(sticker.msgId, sticker.session, 3, { rawDir: RAW_DIR });
    const contextText = formatContext(ctx);
    const sender = sticker.card || sticker.nickname;

    console.log(`\n--- [${total}] ${sticker.session} ---`);
    const isCdnUrl = sticker.content.includes("multimedia");
    if (isCdnUrl) {
      console.log(`  ℹ QQ CDN 图片，若有本地缓存则直接读取，否则 picsum fallback`);
    }
    console.log(`  发送者: ${sender}`);
    console.log(`  图片: ${sticker.content}`);
    console.log(`  上下文:`);
    for (const line of contextText.split("\n")) {
      console.log(`    ${line}`);
    }

    console.log(`  分析中...`);
    const raw = await inferStickerMeaning(sticker.content, contextText, sticker.session, sticker.msgId);
    const meaning = raw ? cleanVisionDescription(raw) : null;

    if (meaning) {
      console.log(`  含义: ${meaning}`);
      success++;
    } else {
      console.log(`  含义: (分析失败)`);
      fail++;
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(STICKERS_DIR)) {
    console.log("data/stickers/ does not exist. Run 'bun run index-stickers' first.");
    process.exit(1);
  }

  const target = process.env.SESSION;
  const allFiles = readdirSync(STICKERS_DIR).filter((f) => f.endsWith(".jsonl"));

  const sessions = target
    ? allFiles.filter((f) => f === `${target}.jsonl`)
    : allFiles;

  if (sessions.length === 0) {
    console.log(`No sticker index found${target ? ` for session: ${target}` : ""}.`);
    process.exit(1);
  }

  console.log(`Inferring sticker meanings...`);
  console.log(`Model: ${VISION_MODEL} @ ${VISION_BASE_URL}`);

  for (const f of sessions) {
    const session = f.replace(/\.jsonl$/, "");
    await processSession(session);
    if (total >= MAX_STICKERS) break;
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`处理完成`);
  console.log(`  总计: ${total}`);
  console.log(`  成功: ${success}`);
  console.log(`  失败: ${fail}`);
}

main().catch(console.error);
