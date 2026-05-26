/**
 * agent/vision.ts — 视觉问答相关逻辑
 *
 * 从 agent.ts 拆出：callVision、DESCRIBE_IMAGE_TOOL。
 */

import { cleanVisionDescription } from "../clean-vision";
import { gifToJpeg } from "../image-download";

export const DESCRIBE_IMAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "describe_image",
    description:
      "询问某张图片的内容。id 必须是当前消息文本里已经出现过的 [图片#...] 中 # 后面的 16 位小写 hex 字符串；question 必须是一个具体、单一的问题。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "图片的 pHash ID。只填 16 位小写 hex，如 abcdef1234567890；不要带 [图片#]、不要带 #、不要传不存在的 id。",
        },
        question: {
          type: "string",
          description: "你想问这张图片的一个具体问题。一次只问一个问题，例如“图里有几个人？”、“主要文字写了什么？”。",
        },
      },
      required: ["id", "question"],
    },
  },
};

/** 调用视觉模型回答一个问题，返回回答文本，失败返回 null */
export async function callVision(query: string, base64: string, mime: string): Promise<string | null> {
  const VISION_MODEL = process.env.VISION_MODEL || "";
  const defaultVISION_BASE_URL = (process.env.VISION_BASE_URL || process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const visionModel = process.env.VISION_MODEL || VISION_MODEL || "";
  if (!visionModel) return null;

  const visionBaseUrl = (process.env.VISION_BASE_URL || defaultVISION_BASE_URL).replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "ollama";

  const converted = await gifToJpeg(base64, mime);
  const dataUri = `data:${converted.mime};base64,${converted.base64}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    const res = await fetch(`${visionBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: query },
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

    const rawReasoning = msg?.reasoning?.trim();
    if (rawReasoning) {
      const clean = cleanVisionDescription(rawReasoning);
      if (clean) return clean;
    }

    const rawContent = msg?.content?.trim();
    if (rawContent) {
      const clean = cleanVisionDescription(rawContent);
      if (clean) return clean;
    }

    return null;
  } catch {
    return null;
  }
}
