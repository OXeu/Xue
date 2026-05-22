# 视觉功能集成状态

**日期**: 2026-05-22
**agent 版本**: commit `201c66b`
**状态**: ✅ 代码已部署，因模型不支持视觉暂为 fallback 模式

---

## 架构

```
[消息含 CQ:image] → parseFirstImageUrl() → downloadImage() → describeImage() → 注入 prompt
                         ❌ 无 url              ❌ 失败        ❌ 模型不支持     → fallback 到"看不到图片"
```

三步骤各自独立容错，任何一步失败返回 `null`，agent 按原有逻辑处理（不假装看到图片）。

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

- `VISION_MODEL` — 视觉模型名，可独立于文本模型
- `VISION_BASE_URL` — 视觉 API 端点，默认回退到 `LLM_BASE_URL`
- Auth header 按需发送（有 `LLM_API_KEY` 才带，Ollama 不用）

## 当前限制

**gemma4:26b 不支持视觉。** 模型文件检查确认：

- 只有 `RENDERER gemma4`，无 `mmproj`（视觉编码器）
- Ollama 原生 API 返回"请提供图片"但未实际理解
- OpenAI 兼容 API 报 `image: unknown format`

本地其他模型（qwen3.5:27b、glm-ocr:latest 等）同样无视觉能力。

## 验证

管线三步骤端到端测试通过：

```
Step 1 parseFirstImageUrl: ✅  从 CQ 码提取 url
Step 2 downloadImage:      ✅  下载 → base64（27KB JPEG）
Step 3 describeImage:      ❌  模型不支持，返回 null → graceful fallback
```

agent 运行正常（PID 1414265），启动日志确认配置加载：

```
vision: gemma4:26b @ http://127.0.0.1:11444/v1
```

## 下一步

安装一个支持视觉的模型即可启用：

```bash
ollama pull llama3.2-vision:11b   # 推荐，支持良好
ollama pull qwen2.5-vl:7b         # 中文理解强
ollama pull minicpm-v:8b          # 轻量
```

装好后改 `.env` 中的 `VISION_MODEL`，重启 agent，无需改代码。
