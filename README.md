# rin-research-humanize

QQ 群聊/私聊 agent — 监听群聊和私聊消息，带视觉理解能力（gemma4:26b via Ollama），通过 OneBot 协议回复。

核心思路：bot 在群聊里像狼人杀里的狼人——目标是模仿真人，而不是证明自己最聪明。每次回复都基于群聊的真实风格特征做约束。

## 项目结构

```
rin-research-humanize/
├── src/
│   ├── agent.ts            # 主 agent：WS 监听 → 上下文 → 视觉问答 → LLM → 回复
│   ├── listen.ts           # 消息监听器：记录 JSONL + 异步缓存图片到 images/
│   ├── index-stickers.ts   # 表情包索引器：扫描 data/raw/，记录 msgId/session/type/content
│   ├── infer-stickers.ts   # 批量推理：扫描索引 → pHash 去重 → 视觉模型推理 → 写入 data/inferences/，含 --reindex
│   ├── phash.ts            # 感知哈希（dHash），用于不同分辨率下的相似图片去重（阈值 3）
│   ├── simulate.ts         # 模拟重放：不调 LLM，只输出决策和 prompt，零成本评估
│   ├── replay.ts           # 重放历史消息：调 LLM 生成实际回复，用于验证
│   ├── clean-vision.ts     # 清洗视觉模型的 reasoning 输出，提取纯文本描述
│   └── image-cache.ts      # 图片缓存（data/images/），供 infer-stickers / replay 复用
├── scripts/
│   ├── start-agent.sh      # 后台启动 agent（写 PID、日志重定向）
│   ├── stop-agent.sh       # 停止 agent
│   └── status-agent.sh     # 检查 agent 状态
├── tests/
│   ├── clean-vision.test.ts
│   ├── image-cache.test.ts
│   ├── listen.test.ts
│   ├── listen-image-cache.test.ts
│   ├── index-stickers.test.ts
│   ├── phash.test.ts
│   └── agent/group-profile.test.ts   # 群聊特征 + 风格分析测试
├── data/
│   ├── raw/                # 监听器 JSONL（运行时生成）
│   ├── images/             # 图片缓存（listen 异步下载，供 infer-stickers 复用）
│   └── inferences/         # 推理结果持久化（由 infer-stickers 生成）
├── docs/
│   └── experiment-logs/    # 实验记录
├── .env                    # 配置（参考 .env.example）
├── package.json
└── tsconfig.json
```

## 快速开始

```bash
# 1. 配置
cp .env.example .env
# 编辑 .env 填写 LLM_API_KEY、OneBot 连接信息

# 2. 启动监听器（积累上下文数据）
bun src/listen.ts

# 3. 先用 simulate 快速评估 prompt 效果（零成本）
bun run simulate

# 待评估通过后，再用 replay 看实际 LLM 回复
LLM_API_KEY=sk-xxx bun run replay

# 4. 启动 agent（处理实时消息并回复）
bun run start-agent    # 后台持久化
bun src/agent.ts       # 前台调试
```

## 五项核心机制

### 1. 群聊特征分析
（同前）
### 2. 风格分析
（同前）
### 3. 语气指导
（同前）

### 4. 视觉问答（Agent 自主提问）

当消息中包含图片时，Agent 不再使用固定的「用一句话简短描述」提示词。

系统会在 system prompt 中加入指令，告诉 Agent 它可以**自己决定问什么**。
格式是用 `[VISION]你的问题[/VISION]` 包裹问题文本，例如：

```
[VISION]这张图里有几个人？[/VISION]
```

系统拦截到这个标签后，会调用视觉模型（gemma4:26b）回答问题，
然后把答案以「【图片回答】...」的形式注入回对话上下文。
Agent 看到答案后，可以继续追问（再发一个 `[VISION]`），
也可以直接输出回复。

- 每轮最多 5 次问答
- 每次问什么完全由 Agent 根据当前对话上下文自主决定
- 视觉模型返回失败时会注入 `(分析失败)` 占位符

### 5. 回复规则
回复约束，配置在 `prompts/reply.md`，每次回复时注入 system prompt：

- 不要列点，不要 formal
- 使用口语化的表达
- 不要使用 emoji（😄😂😅等）
- 不要重复对方的话，直接问或直接说
- 一句话能说完就不要写两句
- 不要做结论性总结（"确实，xxx是关键"、"xxx明显"一类的话听起来像懂哥）
- 不确定怎么回就回"草"、"乐"、"？"之类的一两个字，或者不接。但不要连续多次都用同一个词，偶尔换着来。
- 回复前先确认自己理解了当前话题的进展。如果没跟上上下文的变化（比如别人已经纠正过的事你还不知道），就问或保持沉默，不要做猜测性结论。
- 如果不确定上下文或对话题没有足够了解，不要强行接话。不知道就保持沉默，不必每句话都回应。
- 遇到不认识的网络梗/生僻表达/特定名词时，直接问「XX 是什么」或保持沉默，不要用模糊反应（如「什么情况」、「这啥」）来掩饰。
- 遇到抽象的表达或可能是昵称/内部梗的内容，优先直接问清楚，不要试着去"接"。

### 5. 回复决策
非 @ 场景下分级控制回复概率：
| 场景 | 回复概率 | 说明 |
|------|---------|------|
| @自己 / @全体 | 100% | 必回 |
| 提到名字 | 70% | 大概率回 |
| 纯表情/图片 | 10% | 低概率 |
| 旁观（@别人） | 5% | 极低概率，减少误入 |
| 其他 | 30% | 默认随机 |

## 快速评估工作流

```bash
# 1. 改完 prompt 后，先用 simulate 筛：
bun run simulate

# 2. 找到你想关注的消息，用 replay 看实际回复：
LLM_API_KEY=sk-xxx MAX_MSGS=22 bun run replay

# 3. 观察回复是否收敛（短句、少语气词、自然）
```

## 表情包索引

从历史消息中识别图片/表情消息，建立可检索的索引。

```bash
bun run index-stickers                    # 全量索引所有会话
SESSION=group_313214094 bun run index-stickers  # 指定会话
```

索引文件位于 `data/stickers/{session}.jsonl`，每条记录只存 msgId、session、type、content、昵称，**不存上下文**。上下文在需要时通过 `getStickerContext()` 从 `data/raw/` 反查：

```ts
import { getStickerContext } from "./src/index-stickers";

// 前后各 3 条
const ctx = getStickerContext(msgId, session);

// 自定义窗口大小（前后各 5 条）
const ctx5 = getStickerContext(msgId, session, 5);
```

窗口大小可在使用时动态调整，无需重新索引。

### 图片缓存

`listen.ts` 在收到图片消息时，会**异步**（fire-and-forget，不阻塞消息处理）将图片下载到 `data/images/` 目录：

1. 消息写入 JSONL 后，后台启动下载
2. 通过 `hasCache()` 检查是否已缓存，避免重复下载
3. 下载失败时静默跳过（QQ CDN 需要鉴权，部分旧图片可能无法下载）
4. 已缓存的图片可被 `infer-stickers` 直接读取，无需网络请求

> ⚠ 仅从改动生效后新收到的图片才能成功缓存。已有索引中的旧图片（QQ CDN 链接）大概率已过期，会被静默跳过。

### 推理持久化与图片去重

`infer-stickers` 获取图片时先查本地缓存，无缓存时尝试从 CDN 即时下载。若均失败则跳过该条目的推理，不在结果文件中写入误导性含义。

推理结果持久化到 `data/inferences/{session}.jsonl`，包含完整上下文和模型分析结果。已推理的条目自动跳过，加 `--reindex` 可强制重新推理。

**图片去重**：`infer-stickers` 在调用视觉模型前会计算图片的感知哈希（dHash，`src/phash.ts`），与同一会话已推理的图片对比。汉明距离 ≤ 3 时视为重复，跳过推理。同一张表情包经过不同压缩/分辨率后仍能被识别为重复。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | LLM API Key | — |
| `LLM_BASE_URL` | API 地址 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 文本模型 | `deepseek-v4-flash` |
| `VISION_MODEL` | 视觉模型 | `gemma4:26b` |
| `VISION_BASE_URL` | 视觉 API 地址 | `http://127.0.0.1:11444/v1` |
| `ONEBOT_WS_URL` | OneBot 正向 WS 网关 | `ws://localhost:6700` |
| `ONEBOT_ACCESS_TOKEN` | WS 鉴权 token | — |
| `BOT_NAME` | 名字 | `Rin` |
| `BOT_QQ` | Bot QQ 号 | `3042160393` |
| `DRY_RUN` | 仅模拟不发送 | `true`（调试用） |

## 命令

| 命令 | 作用 |
|------|------|
| `bun run agent` | 前台运行 agent（含视觉问答循环：`[VISION]` 自主提问） |
| `bun run listen` | 前台运行监听器 |
| `bun run simulate` | 模拟重放（零成本评估 prompt） |
| `bun run index-stickers` | 扫描并索引表情包到 data/stickers/ |
| `bun run infer-stickers` | 扫描索引，pHash 去重后调用视觉模型推理，结果写入 data/inferences/，含 --reindex 选项 |
| `bun run replay` | 重放历史消息并调 LLM（视觉消息使用固定「一句话描述」缓存，非实时问答） |
| `bun run start-agent` | 后台启动 agent |
| `bun run stop-agent` | 停止 agent |
| `bun run status-agent` | 检查 agent 状态 |
| `bun test` | 运行测试（132 例） |
| `bun run typecheck` | TypeScript 类型检查 |
