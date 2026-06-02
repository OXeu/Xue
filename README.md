<h1 align="center">Xue</h1>
<p align="center"><b>QQ 群聊/私聊 agent，带上下文记忆和图片理解</b><br>通过 OneBot 监听消息，维护会话上下文，并按 prompt、配置和概率策略决定是否回复。</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/language-TypeScript-blue?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/protocol-OneBot-green" alt="OneBot">
  <img src="https://img.shields.io/badge/status-private-lightgrey" alt="Private">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#development">Development</a>
</p>

---

> 群聊 agent 的难点不只是“能不能回复”，而是“什么时候该沉默、什么时候该补充上下文、什么时候图片需要先看清楚”。Xue 把消息采集、上下文构建、回复决策和模型调用拆开，让每一步都能被模拟、重放和测试。

## Install

### Requirements

- Bun
- OneBot 正向 WebSocket 网关
- OpenAI-compatible 文本模型接口
- OpenAI-compatible 视觉模型接口（图片理解需要）

### From Source

```bash
bun install
cp .env.example .env
```

编辑 `.env`，填写 OneBot 连接信息、bot 身份和模型配置。

## Quickstart

### Collect Context

先启动监听器，让 Xue 记录群聊/私聊消息并异步缓存图片。

```bash
bun run listen
```

监听器会写入运行时数据：

- `data/prod/raw/`：消息 JSONL
- `data/prod/images/`：图片缓存

### Evaluate Prompts

改 prompt 后先用零成本模拟筛选效果。

```bash
bun run simulate
```

需要看真实模型输出时，再用历史消息重放。

```bash
LLM_API_KEY=sk-xxx bun run replay
```

### Run Agent

前台调试：

```bash
bun run agent
```

后台运行：

```bash
bun run start-agent
bun run status-agent
```

默认 `DRY_RUN=true`，未在 `config/session-config.json` 显式开启的会话只打印 dry-run 日志。确认行为收敛后，再按会话设置 `reply: true` 或全局设置 `DRY_RUN=false`。

## Features

### Context-Aware Replying

Xue 从历史消息中提取会话级特征，并把群聊气氛、消息长度、语气词、问句比例等轻量风格信号注入 prompt。目标是让回复更贴近当前上下文，而不是脱离对话做总结。

### Reply Decision Policy

非 @ 场景下默认按概率控制发言频率，减少误入和刷屏。

| 场景 | 默认概率 | 行为 |
|------|----------|------|
| @自己 / @全体 | `1.0` | 必回 |
| 提到名字 | `0.7` | 大概率回 |
| 纯表情/图片 | `0.1` | 低概率 |
| 旁观（@别人） | `0.05` | 极低概率 |
| 其他消息 | `0.3` | 由 `REPLY_CHANCE` 或会话配置覆盖 |

### Vision Loop

当消息包含图片时，agent 可以主动决定要问视觉模型什么，而不是固定让视觉模型“一句话描述图片”。

```text
[VISION]这张图里有几个人？[/VISION]
```

系统会拦截 `[VISION]...[/VISION]`，调用视觉模型，把结果以 `【图片回答】...` 注入回上下文。agent 可以继续追问，也可以直接回复。

- 每轮最多 5 次视觉问答
- 视觉失败时注入 `(分析失败)`
- replay 可复用已缓存的图片描述，降低重复成本

### Image Cache

图片下载和缓存由 `src/image-download.ts`、`src/image-cache.ts` 复用。`src/phash.ts` 使用 dHash 做相似图片去重，默认阈值为 `3`，用于处理不同分辨率下的重复图。

### Prompt Surface

回复约束集中在 `prompts/reply.md`，并在每轮回复时作为 system prompt 注入。主要约束包括：

- 控制回复长度和频率
- 避免重复对方原话
- 避免离开上下文做总结或推断
- 信息不足时保持保守
- 图片消息先通过视觉工具补充信息

## Configuration

### Environment

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | LLM API Key | - |
| `LLM_BASE_URL` | 文本模型 API 地址 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 文本模型 | `deepseek-v4-flash` |
| `VISION_MODEL` | 视觉模型 | `gemma4:26b` |
| `VISION_BASE_URL` | 视觉 API 地址 | `http://127.0.0.1:11444/v1` |
| `ONEBOT_WS_URL` | OneBot 正向 WS 网关 | `ws://localhost:6700` |
| `ONEBOT_ACCESS_TOKEN` | OneBot 鉴权 token | - |
| `BOT_NAME` | Bot 名称 | - |
| `BOT_QQ` | Bot QQ 号 | - |
| `DRY_RUN` | 仅模拟不发送 | `true` |

### Session Config

`config/session-config.json` 可按会话覆盖回复开关和概率。该文件已被 `.gitignore` 排除，适合保存本地私有配置。

```json
{
  "probabilities": {
    "mentioned": 0.7,
    "media": 0.1,
    "bystander": 0.05
  },
  "group_A": {
    "reply": true,
    "probabilities": {
      "mentioned": 0.5,
      "media": 0.05,
      "bystander": 0.02
    },
    "replyChance": 0.2
  },
  "group_B": {
    "reply": false
  }
}
```

优先级：

```text
会话级 probabilities -> 全局 probabilities -> 代码默认值 (0.7 / 0.1 / 0.05)
会话级 replyChance  -> 环境变量 REPLY_CHANCE -> 0.3
DRY_RUN=false       -> 所有会话真实回复
DRY_RUN=true        -> 只有 session reply=true 的会话真实回复
```

字段说明：

| 路径 | 类型 | 说明 |
|------|------|------|
| `probabilities` | `object` | 全局回复概率默认值 |
| `probabilities.mentioned` | `number` | 被提到名字时的回复概率 |
| `probabilities.media` | `number` | 纯表情/图片消息的回复概率 |
| `probabilities.bystander` | `number` | 旁观（@ 别人）时的回复概率 |
| `{session_id}.reply` | `boolean` | 会话级真实回复开关 |
| `{session_id}.probabilities` | `object` | 会话级回复概率覆盖 |
| `{session_id}.replyChance` | `number` | 会话级 random 场景回复概率 |

## Commands

| 命令 | 作用 |
|------|------|
| `bun run listen` | 前台运行监听器 |
| `bun run agent` | 前台运行 agent |
| `bun run simulate` | 模拟重放，不调用 LLM |
| `bun run replay` | 历史消息重放，调用 LLM |
| `bun run start` | 后台启动监听器 |
| `bun run stop` | 停止监听器 |
| `bun run status` | 检查监听器状态 |
| `bun run start-agent` | 后台启动 agent |
| `bun run stop-agent` | 停止 agent |
| `bun run status-agent` | 检查 agent 状态 |
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |

## Development

### Project Layout

```text
Xue/
├── config/
│   └── session-config.json
├── prompts/
│   ├── reply.md
│   ├── silence.md
│   ├── system.md
│   └── vision.md
├── scripts/
│   ├── start-agent.sh
│   ├── start-listen.sh
│   ├── status-agent.sh
│   ├── status-listen.sh
│   ├── stop-agent.sh
│   └── stop-listen.sh
├── src/
│   ├── agent/          # 上下文、决策、OneBot 发送、视觉循环
│   ├── listen/         # OneBot 消息监听和图片异步缓存
│   ├── shared/         # 共享事件和类型
│   ├── chat-utils.ts   # replay/agent 共享工具
│   ├── image-cache.ts  # 图片缓存
│   ├── image-download.ts
│   ├── phash.ts
│   ├── replay.ts
│   └── simulate.ts
├── tests/
├── .env.example
├── package.json
└── tsconfig.json
```

### Test

```bash
bun test
bun run typecheck
```
