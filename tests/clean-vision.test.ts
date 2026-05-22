/**
 * clean-vision.test.ts — cleanVisionDescription 单元测试
 *
 * runner: bun:test（Bun 内置）
 */

import { describe, test, expect } from "bun:test";
import { cleanVisionDescription } from "../src/clean-vision";

describe("cleanVisionDescription", () => {
  // ── 基础场景（reasoning 字段的标准 gemma4 输出） ──

  test("Subject 行优先于 Input 行", () => {
    const raw = `*   Input: A black and white image of grass/plants.
    *   Task: Describe the content of the image in one short sentence (in Chinese).
    
    *   Subject: Grass, blades of grass, vegetation.
    *   St`;

    expect(cleanVisionDescription(raw)).toBe("Grass, blades of grass, vegetation.");
  });

  test("无 Subject 行且 Input 行描述的是 prompt 本身 → null", () => {
    const raw = `*   Input: An image and a prompt in Chinese ("用一句话简短描述这张图片的内容" - "Describe the content of this image in one short sentence").
`;

    expect(cleanVisionDescription(raw)).toBeNull();
  });

  test("Subject 行与 Input 行内容一致时取 Subject", () => {
    const raw = `*   Input: A young woman.
    *   Task: Describe the content of the image in one short sentence (in Chinese).
    *   Subject: A young woman.
    *   St`;

    expect(cleanVisionDescription(raw)).toBe("A young woman.");
  });

  // ── 中文标签 ──

  test("全角冒号 + 中文标签", () => {
    const raw = `*   输入：一张黑白照片，画面中是草地和植物。
    *   任务：用中文一句话描述这张图片。
    *   主题：草地、草叶、植被。`;

    expect(cleanVisionDescription(raw)).toBe("草地、草叶、植被。");
  });

  // ── content 字段（无 reasoning 结构） ──

  test("直接传入纯描述文本（content 字段落地情况）", () => {
    const raw = "一张黑白照片，画面中是草地和植物。";
    expect(cleanVisionDescription(raw)).toBe("一张黑白照片，画面中是草地和植物。");
  });

  // ── 空 / 无效输入 ──

  test("空字符串 → null", () => {
    expect(cleanVisionDescription("")).toBeNull();
  });

  test("仅含泛泛描述（无实际内容）→ null", () => {
    const raw = `*   Input: The user's prompt asking to describe the image.
    *   Task: Describe the content.
    *   Subject: The image.`;

    expect(cleanVisionDescription(raw)).toBeNull();
  });

  // ── 新增边界场景 ──

  test("纯空白字符串 → null", () => {
    expect(cleanVisionDescription("   ")).toBeNull();
    expect(cleanVisionDescription("\n\n  \n")).toBeNull();
  });

  test("纯标点符号 → null", () => {
    expect(cleanVisionDescription("!!! ... ???")).toBeNull();
    expect(cleanVisionDescription("。，！？")).toBeNull();
  });

  test("Input image: 变体 → 正确提取", () => {
    const raw = `*   Input image: A landscape photo showing mountains/cliffs.
    *   Task: Describe the content.
    *   Subject: Mountains, cliffs, pine trees.`;

    expect(cleanVisionDescription(raw)).toBe("Mountains, cliffs, pine trees.");
  });

  test("Input image: 变体且无 Subject → 从 Input image 提取", () => {
    const raw = `*   Input image: A snowy mountain peak under a clear blue sky.
    *   Task: Describe the content of the image.`;

    expect(cleanVisionDescription(raw)).toBe("A snowy mountain peak under a clear blue sky.");
  });

  test("Input: 变体不带星号前缀 → 正常处理", () => {
    const raw = `Input: A cat sitting on a windowsill.
Task: Describe the content.
Subject: A cat on a windowsill.`;

    expect(cleanVisionDescription(raw)).toBe("A cat on a windowsill.");
  });

  test("全角冒号混用 + Input 变体 → 正常处理", () => {
    const raw = `*   Input image：夕阳下的海面，波光粼粼。
    *   任务：用一句话描述图片内容。`;

    expect(cleanVisionDescription(raw)).toBe("夕阳下的海面，波光粼粼。");
  });

  test("多 Subject 行取最后一个", () => {
    const raw = `*   Subject: Blurry image.
    *   Input: A group of people at a party.
    *   Subject: A group of people laughing at a birthday party.`;

    expect(cleanVisionDescription(raw)).toBe("A group of people laughing at a birthday party.");
  });

  // ── labelPattern 兜底（catch-all 分支 strip） ──

  test("未匹配 Input/Subject 的标签前缀 → 从 catch-all 剥离", () => {
    // Description: 不在 Input 或 Subject 的正则中，应被 catch-all 的 labelPattern 剥离
    const raw = `Description: A red sports car on a race track.`;
    expect(cleanVisionDescription(raw)).toBe("A red sports car on a race track.");
  });
});
