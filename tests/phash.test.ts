/**
 * phash.test.ts — phash 单元测试
 *
 * runner: bun:test
 * 测试 dHash 计算、汉明距离、相似图片判定。
 * 使用 sharp 生成已知图片数据，不调网络。
 */

import { describe, test, expect } from "bun:test";
import sharp from "sharp";
import { computeDHashFromBuffer, hammingDistance, isDuplicate } from "../src/phash";

/** 生成一个纯色图片 buffer（给定 RGB 值） */
async function makeSolidImage(r: number, g: number, b: number, w = 50, h = 50): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = r;
    raw[i * 3 + 1] = g;
    raw[i * 3 + 2] = b;
  }
  return await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .toBuffer();
}

describe("phash", () => {
  test("相同图片产生相同 hash", async () => {
    const buf = await makeSolidImage(128, 128, 128);
    const h1 = await computeDHashFromBuffer(buf);
    const h2 = await computeDHashFromBuffer(buf);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16); // 16 hex chars = 64 bits
  });

  test("不同图片产生不同 hash", async () => {
    // 黑底白点在不同位置 → 不同的 dHash
    function makeDot(w: number, h: number, cx: number, cy: number): Buffer {
      const raw = Buffer.alloc(w * h * 3, 0);
      for (let y = Math.max(0, cy - 6); y < Math.min(h, cy + 6); y++) {
        for (let x = Math.max(0, cx - 6); x < Math.min(w, cx + 6); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= 36) {
            const idx = (y * w + x) * 3;
            raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255;
          }
        }
      }
      return raw;
    }
    const bufTL = await sharp(makeDot(100, 100, 10, 10), { raw: { width: 100, height: 100, channels: 3 } })
      .jpeg().toBuffer();
    const bufBR = await sharp(makeDot(100, 100, 90, 90), { raw: { width: 100, height: 100, channels: 3 } })
      .jpeg().toBuffer();
    const hTL = await computeDHashFromBuffer(bufTL);
    const hBR = await computeDHashFromBuffer(bufBR);
    expect(hTL).not.toBe(hBR);
    // 确实不同
    expect(hammingDistance(hTL, hBR)).toBeGreaterThan(5);
  });

  test("不同尺寸的相同内容图片 hash 相似", async () => {
    // 生成一个简单图案：上半白，下半黑
    function makeHalfHalf(w: number, h: number): Buffer {
      const raw = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 3;
          const val = y < h / 2 ? 255 : 0;
          raw[idx] = val;
          raw[idx + 1] = val;
          raw[idx + 2] = val;
        }
      }
      return raw;
    }

    const small = await sharp(makeHalfHalf(20, 20), { raw: { width: 20, height: 20, channels: 3 } })
      .jpeg().toBuffer();
    const large = await sharp(makeHalfHalf(200, 200), { raw: { width: 200, height: 200, channels: 3 } })
      .jpeg().toBuffer();

    const hSmall = await computeDHashFromBuffer(small);
    const hLarge = await computeDHashFromBuffer(large);
    const dist = hammingDistance(hSmall, hLarge);

    // 不同分辨率下同一图案的 dHash 应该非常接近
    expect(dist).toBeLessThanOrEqual(5);
  });

  test("hammingDistance 计算正确", () => {
    // 相同 hash → 距离 0
    expect(hammingDistance("aabb", "aabb")).toBe(0);
    // 全反（0xff vs 0x00）→ 每 byte 8 bits
    expect(hammingDistance("ff", "00")).toBe(8);
    expect(hammingDistance("ffff", "0000")).toBe(16);
    // 相差 1 bit
    expect(hammingDistance("01", "00")).toBe(1);
    expect(hammingDistance("80", "00")).toBe(1);
  });

  test("isDuplicate 在阈值内返回 true", () => {
    const candidate = "001000181a1a1a1a";
    const similar = "001000181a1a1a1b"; // 仅差 1 bit
    expect(isDuplicate(candidate, [similar], 3)).toBeTrue();
  });

  test("isDuplicate 超出阈值返回 false", () => {
    const candidate = "001000181a1a1a1a";
    const far = "ffffffffffffffff";
    expect(isDuplicate(candidate, [far], 3)).toBeFalse();
  });

  test("空已知列表时判定为非重复", () => {
    expect(isDuplicate("abc", [], 3)).toBeFalse();
  });
});
