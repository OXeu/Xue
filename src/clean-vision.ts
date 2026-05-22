/**
 * clean-vision.ts — 清洗视觉模型原始输出，提取纯描述内容
 *
 * gemma4 等推理模型将描述写在 reasoning 字段中，夹杂 Input:、Task:、Subject:
 * 等标记行。此模块去除标签和模板文本，只保留实际描述句。
 */

/** 太泛的"描述"不被视为有效描述 */
const vagueDescs = /^(the image|this image|an image|a picture|the picture|image|picture|the photo|a photo|photo|场景|画面)\.?$/i;

/** 已知的标签前缀（冒号前后可选空格、全角/半角冒号） */
const labelPattern = /^(Input\s*(?:image)?|输入|Image\s*content|Subject|主题|Task|Objective|Goal|Output|Result|Answer|Summary|Description|Analysis|任务|目标|输出|结果|答案|总结|分析)[:：]/i;

/**
 * 清洗视觉模型的原始输出，提取纯描述内容。
 *
 * 处理策略（按优先级）:
 * 1. `Subject:` / `主题:` 行 → gemma4 的答案，直接取
 * 2. `Input:` / `输入:` / `Input image:` / `Image content:` 行 → 如果描述的是图片内容而非 prompt 本身则取
 * 3. 非标签的独立短句（content 字段直接传入时）→ 保持原样
 * 4. 上述都不满足 → 返回 null（让上游走 fallback）
 *
 * @param raw 视觉模型返回的原始文本（reasoning 或 content 字段）
 * @returns 纯描述文本，或 null（无有效描述时）
 */
export function cleanVisionDescription(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;

  const lines = raw.split("\n");
  let bestDesc: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 去掉行首标记符（* - • · 等）
    const clean = trimmed.replace(/^[\*\-•·]\s*/, "").trim();
    if (!clean) continue;

    // Subject / 主题 —— gemma4 的"答案"行
    const subjectMatch = clean.match(/^(Subject|主题)[:：]\s*(.+)/i);
    if (subjectMatch) {
      const val = subjectMatch[2].trim();
      if (val.length >= 15 || !vagueDescs.test(val)) {
        bestDesc = val;
      }
      continue;
    }

    // Input / 输入 / Input image / Image content —— 图片内容的描述行
    const inputMatch = clean.match(/^(Input\s*(?:image)?|输入|Image\s*content)[:：]\s*(.+)/i);
    if (inputMatch) {
      const val = inputMatch[2].trim();
      // 跳过描述 prompt 本身的行
      if (
        val.length > 5 &&
        !/prompt|task|describe|一句话|image and a prompt|用户要求|请用/i.test(val) &&
        !vagueDescs.test(val)
      ) {
        if (!bestDesc) bestDesc = val;
      }
      continue;
    }

    // 跳过任务/结构标签行（Description 不在此跳过——它可能包含有用内容，交给 catch-all 剥离前缀）
    if (/^(Task|Objective|Goal|Output|Result|Answer|Summary|Analysis|任务|目标|输出|结果|答案|总结|分析)[:：]/i.test(clean)) continue;
    if (clean.length < 6) continue;

    // 其他正文句（content 字段直接进来，或未匹配到已知标签的描述行）
    // 去掉遗留的标签前缀（如 "Input image:"、"Description:"），防止漏网
    const stripped = clean.replace(labelPattern, "").trim();
    if (!bestDesc && stripped.length > 5 && !vagueDescs.test(stripped) && /[\w\u4e00-\u9fff]/.test(stripped)) {
      bestDesc = stripped;
    }
  }

  return bestDesc && bestDesc.length > 5 && !vagueDescs.test(bestDesc) && /[\w\u4e00-\u9fff]/.test(bestDesc) ? bestDesc : null;
}
