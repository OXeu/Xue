/**
 * phash.ts — 感知哈希（pHash）工具，用于图片去重。
 *
 * 实现 dHash（差值哈希）算法：
 * 1. 缩放到 9×8 灰度图
 * 2. 比较相邻像素：左 > 右 = 1，否则 = 0
 * 3. 产生 64 位 hash，以 16 进制字符串表示
 *
 * 阈值 3 意味着两张图片的汉明距离 ≤ 3 时视为重复。
 */

import sharp from "sharp";

/** 从图片 Buffer 计算 dHash。 */
export async function computeDHashFromBuffer(buffer: Buffer): Promise<string> {
  // 缩放到 9×8 灰度，取原始像素值
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 比较相邻像素：每行 9 个像素产生 8 个 bit，共 8 行 = 64 bit
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      if (left > right) {
        const bitPos = BigInt(row * 8 + col);
        hash |= (1n << bitPos);
      }
    }
  }

  // 转 16 进制，补零到 16 字符
  return hash.toString(16).padStart(16, "0");
}

/** 计算两个 hex dHash 的汉明距离（不同 bit 数）。 */
export function hammingDistance(a: string, b: string): number {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  let dist = 0;
  for (let i = 0; i < bufA.length; i++) {
    const xor = bufA[i] ^ bufB[i];
    // 逐 bit 计数
    dist += popcount(xor);
  }
  return dist;
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** 检查候选 hash 是否与已知 hash 列表中的任意一个相似（距离 ≤ threshold）。 */
export function isDuplicate(candidate: string, known: string[], threshold = 3): boolean {
  for (const hash of known) {
    if (hammingDistance(candidate, hash) <= threshold) {
      return true;
    }
  }
  return false;
}
