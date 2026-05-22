# rin-research-humanize

QQ 群聊/私聊 agent — 监听群聊和私聊消息，带视觉理解能力（gemma4:26b via Ollama），通过 OneBot 协议回复。

## 项目结构

```
rin-research-humanize/
├── src/
│   ├── agent.ts            # 主 agent：WS 监听 → 上下文 → LLM → 回复
│   ├── listen.ts           # 消息监听器（只收不发，记录 JSONL 作为上下文和历史）
│   ├── clean-vision.ts     # 清洗视觉模型的 reasoning 输出，提取纯文本描述
│   ├── image-cache.ts      # 图片描述缓存（data/test-images/），供 replay 复用
│   └── replay.ts           # 重放历史消息，模拟 agent 决策与回复
├── scripts/
│   ├── start-agent.sh      # 后台启动 agent（写 PID、日志重定向）
│   ├── stop-agent.sh       # 停止 agent
│   └── status-agent.sh     # 检查 agent 状态
├── tests/
│   ├── clean-vision.test.ts
│   ├── image-cache.test.ts
│   └── listen.test.ts
├── data/
│   ├── raw/                # 监听器 JSONL（运行时生成）
│   └── test-images/        # 图片缓存（确定性 seed，版本控制中）
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

# 2. 启动监听器（提供上下文数据）
bun src/listen.ts

# 3. 启动 agent（处理消息并回复）
bun run start-agent    # 后台持久化
bun src/agent.ts       # 前台调试
```

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
| `bun run agent` | 前台运行 agent |
| `bun run listen` | 前台运行监听器 |
| `bun run replay` | 重放历史消息 |
| `bun run start-agent` | 后台启动 agent |
| `bun run stop-agent` | 停止 agent |
| `bun run status-agent` | 检查 agent 状态 |
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |
