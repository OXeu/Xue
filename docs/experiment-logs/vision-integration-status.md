# 视觉功能集成状态

**日期**: 2026-05-22
**agent 版本**: commit `281ff6e`
**状态**: ✅ 已启用（gemma4:26b via Ollama，auth + reasoning 修复后）

---

## 架构

```
[消息含 CQ:image] → parseFirstImageUrl() → downloadImage() → describeImage() → 注入 prompt
                         ❌ 无 url              ❌ 失败        ❌ API 异常     → fallback 到"看不到图片"
```

三步骤各自独立容错，任何一步失败返回 `null`，agent 按原有逻辑处理。

## 实现

| 组件 | 文件 | 说明 |
|------|------|------|
| `parseFirstImageUrl(raw)` | `agent.ts` | 正则提取第一个 `[CQ:image,...,url=...,...]` 中的 url |
| `downloadImage(url)` | `agent.ts` | `fetch` 下载 → `arrayBuffer` → `base64`，10 秒超时 |
| `describeImage(cqMatch)` | `agent.ts` | 视觉 LLM API 调用，OpenAI 兼容格式 |
| prompt 注入 | `agent.ts` | 成功时 `【消息中包含一张图片，描述如下：xxx】`，覆盖角色指令 |
| fallback | `agent.ts` | 失败时维持 `【你看不到图片内容，不要假装看到了】` |

## 配置

```
# .env
VISION_MODEL=gemma4:26b
VISION_BASE_URL=http://127.0.0.1:11444/v1
```

- Auth: 始终发送 `Authorization: Bearer ${LLM_API_KEY || "ollama"}`。无 API Key 时默认用 `ollama`（Ollama 接受任意 Bearer token）
- 响应解析: gemma4 是推理模型，描述内容在 `reasoning` 字段。代码优先读 `reasoning`，回退到 `content`

## 验证结果

**测试条件**: 构造模拟 CQ 码 `[CQ:image,url=https://picsum.photos/400/300]`，走完整管线

```
Step 1 parseFirstImageUrl ✅ url: https://picsum.photos/400/300...
Step 2 downloadImage      ✅ image/jpeg 35KB
Step 3 describeImage      ✅ 
  原始: Input: A black and white image of grass/plants...
  描述: Grass, blades of grass, vegetation.
```

**结论**: `describeImage` 返回非空描述，视觉管线端到端正常。prompt 中将注入 `【消息中包含一张图片，描述如下：Grass, blades of grass, vegetation。回复时可以结合图片内容。】`

## 关键修复历程

| 问题 | 修复 | commit |
|------|------|--------|
| auth header 缺失（Ollama 需要 Bearer token） | 始终发送 `Bearer ${LLM_API_KEY \|\| "ollama"}` | `281ff6e` |
| gemma4 是推理模型，content 为空 | 从 `reasoning` 字段提取描述 | `281ff6e` |
| VISION_MODEL 默认值为误导的 deepseek-v4-flash | 改为空（禁用），显式配置后才启用 | `fc6a570` |
| reasoning 含 "Input:"、"Task:"、"Subject:" 标签污染 | `cleanVisionDescription()` 提取纯描述，去标签，过滤泛泛描述 | `HEAD` |

## 描述清洗效果

引入 `cleanVisionDescription(raw)` 后的实际测试结果：

```
Index 49 — 原始: * Input: An image showing a mountainous landscape...
           清洗后: Mountains, clouds/mist, prayer flags, trees.

Index 50 — 原始: * Input image: A landscape photo showing mountains/cliffs...
           清洗后: Mountains, specifically a large rock formation (Half Dome style).

Index 56 — 原始: * Input: An image showing a white bowl containing...
           清洗后: A white bowl.
```

注入 prompt 时不再出现 "Input:"、"Task:"、"Subject:" 等指令文本。

## 重放稳定性

引入图片缓存系统（`image-cache.ts`）后，重放管线端到端稳定：

- 图片描述写入 `data/images/` 后不再变动
- 每次重放相同会话和消息 ID 时返回完全一致的描述
- LLM 回复基于确定的描述生成，不会因 picsum 随机图导致质量波动

**两条验证 (索引 49, 50, 56)：**

```
Index 49 (Paul, 07:38:59)
  缓存描述: A person in a white dress (or a woman in a white dress).
  两次读取: ✅ 完全相同
  LLM 回复: "哈哈，这白裙子有点灵异啊，是不是headless终于有身子了？"

Index 50 (Paul, 07:39:00)
  缓存描述: Yellow leaves (autumn leaves).
  两次读取: ✅ 完全相同
  LLM 回复: "哦，这叶子挺好看嘛，突然从供电门切换到秋景，画风转变也太大了hh"

Index 56 (Paul, 07:43:21)
  缓存描述: A prominent, pointed, snow-covered mountain peak.
  两次读取: ✅ 完全相同（缓存命中）
  LLM 回复: "这雪山图好漂亮啊，是实拍吗？"
```

**说明**: 由于历史消息的原始图片 URL 在 CQ 码剥离时已丢失，上述缓存来自 picsum 固定种子图片。真正的原始图片 URL 自 commit `88ca1c0` 起会被 listen.ts 保存到 JSONL，未来消息的回放将使用真实图片。

## 当前 agent 状态

- **PID**: 1423307
- **启动日志**: `vision: gemma4:26b @ http://127.0.0.1:11444/v1`
- **dry-run**: 自重启后无新消息流入，尚未产生带图片描述的 dry-run 回复

## 后续方向

- 图片描述来自 reasoning 字段，原始输出含分析过程。后续可优化提取逻辑，只取第一句有效描述
- 等待群聊图片消息自然流入，观察实际场景中的描述质量
