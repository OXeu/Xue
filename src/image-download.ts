/**
 * image-download.ts — 图片下载工具函数
 *
 * HTTP GET 下载图片，返回 base64 编码和 MIME 类型。
 * 10 秒超时，网络错误或 HTTP 非 200 返回 null。
 * 响应无 Content-Type 时回退到 image/jpeg。
 */

const TIMEOUT_MS = 10_000;
const FALLBACK_MIME = "image/jpeg";

export interface DownloadedImage {
  base64: string;
  mime: string;
}

/**
 * 从 URL 下载图片，返回 base64 + mime。
 * 失败（网络错误、非 200、空响应）返回 null。
 */
export async function downloadImage(url: string): Promise<DownloadedImage | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    const mime = res.headers.get("content-type") || FALLBACK_MIME;
    return { base64: Buffer.from(buf).toString("base64"), mime };
  } catch {
    return null;
  }
}

/**
 * 如果图片是 GIF 格式，用 sharp 转为 JPEG（第一帧）。
 * Gemma4 等模型不支持 GIF 输入。
 */
export async function gifToJpeg(base64: string, mime: string): Promise<DownloadedImage> {
  if (mime !== "image/gif") return { base64, mime };
  try {
    const sharp = (await import("sharp")).default;
    const buf = Buffer.from(base64, "base64");
    const jpeg = await sharp(buf).jpeg({ quality: 85 }).toBuffer();
    return { base64: jpeg.toString("base64"), mime: "image/jpeg" };
  } catch {
    return { base64, mime };
  }
}
