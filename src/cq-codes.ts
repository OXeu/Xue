/**
 * cq-codes.ts — CQ 码（CoolQ / OneBot 消息码）解析工具
 *
 * 提供从 OneBot raw_message 中提取 @ 列表、检测 @全体、
 * 剥离 CQ 码提取纯文本、以及估算消息类型的函数。
 */

/** 从 OneBot raw_message 中提取被 @ 的 QQ 列表 */
export function parseAtUsers(raw: string): number[] {
  const ids: number[] = [];
  const re = /\[CQ:at,qq=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    ids.push(Number(m[1]));
  }
  return ids;
}

/** 检查是否 @全体成员 */
export function hasAtAll(raw: string): boolean {
  return /\[CQ:at,qq=all\]/.test(raw);
}

/** 剥离 CQ 码，提取纯文本内容 */
export function stripCqCodes(raw: string): string {
  return raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
}

/** 粗略判断消息类型：纯文本 / 纯表情 / 纯图片 / 混合 */
export function estimateMsgType(raw: string): "text" | "face" | "image" | "mixed" {
  const cqTypes = [...raw.matchAll(/\[CQ:(\w+),/g)].map((m) => m[1]);
  if (cqTypes.length === 0) return "text";

  // 如果有 CQ 码之外的文字内容，不可能是 pure face/image
  const stripped = stripCqCodes(raw);
  if (stripped.length > 0) return "mixed";

  if (cqTypes.every((t) => t === "face")) return "face";
  if (cqTypes.every((t) => t === "image")) return "image";
  if (cqTypes.every((t) => t === "face" || t === "image")) return "mixed";
  return "mixed";
}
