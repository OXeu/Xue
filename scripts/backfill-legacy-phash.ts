/**
 * scripts/backfill-legacy-phash.ts — 一次性存量回填脚本
 *
 * 扫描 data/prod/raw/ 下所有 JSONL 文件，对包含 imageUrls 但没有 phash
 * 的条目尝试 CDN 下载 → 计算 pHash → 写入本地缓存 → 追加 phash 字段。
 *
 * CDN URL 过期后下载会失败，这类条目会静默跳过。
 *
 * 用法:
 *   bun run scripts/backfill-legacy-phash.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { downloadImage } from "../src/image-download";
import { computeDHash } from "../src/phash";
import { saveCachedImage, setCacheDir } from "../src/image-cache";

const RAW_DIR = resolve(import.meta.dirname, "../data/prod/raw");

const CACHE_DIR_DEFAULT = resolve(import.meta.dirname, "../data/prod/images");
if (!existsSync(CACHE_DIR_DEFAULT)) {
  // data/prod/images 可能还不存在（从未下载过图片时）
  // saveCachedImage 内部会创建目录，无需提前创建
}

// 确保缓存目录被正确设置（脚本独立运行，不依赖 listen.ts 的初始化）
setCacheDir(CACHE_DIR_DEFAULT);

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
  raw_message?: string;
  segments?: unknown[];
}

function ts(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  if (!existsSync(RAW_DIR)) {
    console.log(`[${ts()}] data/prod/raw 不存在，无数据可处理`);
    return;
  }

  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".jsonl"));
  console.log(`[${ts()}] 扫描到 ${files.length} 个会话文件`);

  let totalScanned = 0;
  let totalBackfilled = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const file of files) {
    const filePath = join(RAW_DIR, file);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    const session = file.replace(".jsonl", "");

    if (lines.length === 0) continue;

    const newLines: string[] = [];
    let fileBackfilled = 0;
    let fileSkipped = 0;
    let fileFailed = 0;

    totalScanned += lines.length;

    for (const line of lines) {
      let entry: ListenEntry;
      try {
        entry = JSON.parse(line) as ListenEntry;
      } catch {
        newLines.push(line); // 保留损坏行
        continue;
      }

      // 只处理有 imageUrls 但无 phash 的条目
      if (!entry.imageUrls || entry.imageUrls.length === 0 || (entry.phash && entry.phash.length > 0)) {
        newLines.push(line);
        continue;
      }

      // 尝试为第一个图片 URL 下载、算 phash、存缓存
      const url = entry.imageUrls[0];
      const downloaded = await downloadImage(url);

      if (!downloaded) {
        // CDN 已过期，跳过
        newLines.push(line);
        fileSkipped++;
        continue;
      }

      try {
        const phash = await computeDHash(downloaded.base64, downloaded.mime);
        saveCachedImage(phash, downloaded.base64, downloaded.mime);

        // 追加 phash 字段
        entry.phash = [phash];
        newLines.push(JSON.stringify(entry));
        fileBackfilled++;

        console.log(`[${ts()}] [${session}] msgId=${entry.msgId} → phash=${phash}`);
      } catch (err) {
        // 计算或保存失败，保留原行
        newLines.push(line);
        fileFailed++;
        console.error(`[${ts()}] [${session}] msgId=${entry.msgId} 处理失败: ${err}`);
      }
    }

    // 只有真正有变动时才重写文件
    if (fileBackfilled > 0 || fileFailed > 0) {
      writeFileSync(filePath, newLines.join("\n") + "\n", "utf8");
    }

    totalBackfilled += fileBackfilled;
    totalSkipped += fileSkipped;
    totalFailed += fileFailed;

    if (fileBackfilled > 0 || fileFailed > 0) {
      console.log(`[${ts()}] ${file}: +${fileBackfilled} backfilled, ${fileSkipped} skipped (expired), ${fileFailed} failed`);
    }
  }

  console.log(`\n[${ts()}] 完成`);
  console.log(`  扫描:  ${totalScanned} 条消息`);
  console.log(`  回填:  ${totalBackfilled} 条（已写入 phash + 本地缓存）`);
  console.log(`  跳过:  ${totalSkipped} 条（CDN 已过期）`);
  console.log(`  失败:  ${totalFailed} 条（计算异常）`);
}

main().catch((err) => {
  console.error(`[${ts()}] 脚本异常退出:`, err);
  process.exit(1);
});
