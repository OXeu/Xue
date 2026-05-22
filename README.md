# rin-research-humanize

QQ 群聊/私聊 agent — 监听群聊和私聊消息，带视觉理解能力（gemma4:26b via Ollama），通过 OneBot 协议回复。

核心思路：bot 在群聊里像狼人杀里的狼人——目标是模仿真人，而不是证明自己最聪明。每次回复都基于群聊的真实风格特征做约束。

## 项目结构

```
rin-research-humanize/
├── src/
│   ├── agent.ts            # 主 agent：WS 监听 → 上下文 → LLM → 回复
│   ├── listen.ts           # 消息监听器（只收不发，记录 JSONL 作为上下文和历史）
│   ├── simulate.ts         # 模拟重放：不调 LLM，只输出决策和 prompt，零成本评估
│   ├── replay.ts           # 重放历史消息：调 LLM 生成实际回复，用于验证
│   ├── clean-vision.ts     # 清洗视觉模型的 reasoning 输出，提取纯文本描述
│   └── image-cache.ts      # 图片描述缓存（data/test-images/），供 replay 复用
├── scripts/
│   ├── start-agent.sh      # 后台启动 agent（写 PID、日志重定向）
│   ├── stop-agent.sh       # 停止 agent
│   └── status-agent.sh     # 检查 agent 状态
├── tests/
│   ├── clean-vision.test.ts
│   ├── image-cache.test.ts
│   ├── listen.test.ts
│   └── agent/group-profile.test.ts   # 群聊特征 + 风格分析测试
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

## 四项核心机制

### 1. 群聊特征分析
（同前）
### 2. 风格分析
（同前）
### 3. 语气指导
（同前）

### 4. 回复规则
回复约束，配置在 `prompts/reply.md`，每次回复时注入 system prompt：

- 不要列点，不要 formal
- 使用口语化的表达
- 不要使用 emoji（😄😂😅等）
- 不要重复对方的话，直接问或直接说
- 一句话能说完就不要写两句
- 不要做结论性总结（"确实，xxx是关键"、"xxx明显"一类的话听起来像懂哥）
- 不确定怎么回就回"草"、"乐"、"？"之类的一两个字，或者不接
- 如果不确定上下文或对话题没有足够了解，不要强行接话。不知道就保持沉默，不必每句话都回应。
- 遇到不认识的网络梗/生僻表达/特定名词时，直接问「XX 是什么」或保持沉默，不要用模糊反应（如「什么情况」、「这啥」）来掩饰。

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
| `bun run simulate` | 模拟重放（零成本评估 prompt） |
| `bun run replay` | 重放历史消息并调 LLM |
| `bun run start-agent` | 后台启动 agent |
| `bun run stop-agent` | 停止 agent |
| `bun run status-agent` | 检查 agent 状态 |
| `bun test` | 运行测试（71 例） |
| `bun run typecheck` | TypeScript 类型检查 |
