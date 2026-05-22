# rin-research-humanize

研究如何让模型在 QQ 群聊中的回复更像真实人类。

## 项目定位

当前的 LLM 群聊 bot 容易在几句话内被识破——不是因为答错，而是因为答得**太完整、太中立、每条都回、从不断句、没有情感节奏**。本项目系统性地研究一套可落地的方法，让 bot 回复在内容正确的前提下，带上人能感知到的"人味"。

## 当前状态

项目已从文档阶段推进到有可运行脚本和数据产出的阶段。

### 数据采集状态

监听器已连接网关并成功收到真实群聊数据：

| 指标 | 数值 |
|------|------|
| 监听器状态 | ✅ 运行中 / 自动重连中 |
| 群聊数 | 2 |
| 已采集消息 | ~35 条 |
| 采样跨度 | ~2 分钟 |
| 首次数据时间 | 2026-05-22T07:06:25 |

> 数据量尚小（两个群聊各 1-3 条），不足以支持 Phase 2 实验，但证明管线端到端贯通——网关→监听器→JSONL 存储→`analyze-raw` 分析全链路正常运作。
> 详细状态：`docs/experiment-logs/data-collection-status.md`

### 项目结构

```
rin-research-humanize/
├── src/
│   ├── collect-baseline.ts       # 提取 Rin outbox 回信元数据 → JSONL
│   ├── analyze-baseline.ts       # 分析基线数据 → 报告
│   ├── analyze-style.ts          # 深度风格分析（句长/标点/语气词/列表）
│   ├── analyze-raw.ts            # 分析群聊监听 JSONL
│   ├── style-transformer.ts      # 风格转换原型（6 条规则将 bot 回复真人化）
│   ├── evaluate-transformer.ts   # 定量评估转换效果 vs 真人参考值
│   ├── batch-transform.ts        # 批量转换产出人工审阅样本
│   ├── listen.ts                 # OneBot 纯监听客户端（只收不发）
│   └── agent.ts                  # 群聊回复 agent（上下文 + LLM + 发送）
├── scripts/
│   ├── start-listen.sh           # 启动监听器（写 PID、日志重定向）
│   ├── stop-listen.sh            # 停止监听器
│   ├── status-listen.sh          # 检查监听器状态与数据量
│   ├── ensure-listen.sh          # 保活脚本（crontab 用）
│   ├── start-agent.sh            # 启动 agent（持久化）
│   ├── stop-agent.sh             # 停止 agent
│   └── status-agent.sh           # 检查 agent 状态
├── data/
│   ├── baseline/                 # 基线 JSONL（已采集 100 条）
│   └── raw/                      # 群聊监听数据（运行时生成，不提交）
├── docs/
│   ├── research-plan.md          # 五个方向的研究计划（已用数据校准）
│   ├── baseline-report.md        # 基线分析报告
│   ├── style-report.md           # 深度风格分析报告
│   ├── eval-transformer-*.md     # 风格转换器评估报告
│   ├── transform-samples-*.md    # 人工审阅样本
│   └── experiment-logs/          # 实地测试记录
├── .env.example                  # 环境变量说明
├── package.json
└── tsconfig.json
```

## 现在能做什么

### 分析与研究

| 命令 | 作用 |
|------|------|
| `bun run collect-baseline` | 扫描 Rin 的 outbox，提取回复元数据到 JSONL |
| `bun run analyze-baseline` | 分析基线 JSONL，产出格式化的分析报告 |
| `bun run analyze-style` | 深度风格分析（句长、标点、语气词、列表、格式化） |
| `bun run analyze-raw` | 分析群聊监听 JSONL 数据 |
| `bun run style-demo` | 运行风格转换器，展示原文→改文对照 |
| `bun run eval-transformer` | 定量评估：转换后 vs 原文 vs 真人参考值对比 |
| `bun run batch-transform` | 批量转换，产出 15 条人工审阅样本 |

### 数据采集

| 命令 | 作用 |
|------|------|
| `bun run start` | 启动监听器（持久化，写 PID 文件） |
| `bun run stop` | 停止监听器 |
| `bun run status` | 检查监听器状态与数据量 |
| `bun run simulate-messages` | 生成 20 条多样化模拟群聊消息到 data/raw/，用于端到端管线验证 |
| `bun run listen` | 前台运行监听器（调试用） |
| `bun run start-agent` | 启动 agent（持久化，后台） |
| `bun run stop-agent` | 停止 agent |
| `bun run status-agent` | 检查 agent 运行状态 |
| `bun run agent` | 前台运行 agent（调试用） |

## 当前进展

Phase 0（基线采集）已完成。Phase 1（群聊观察 + agent 构建）正在进行中。

`agent.ts` 已就位：收到群聊消息后加载上下文 → 调用 LLM → 通过 OneBot 发送回复。当前处于「先让它回，再看哪里不像人」的阶段。详见 `docs/research-plan.md`。

## 研究方向

详见 `docs/research-plan.md`。当前策略是直接构建回复 agent 并迭代，而非分方向并行实验。

1. **采集** — 监听器持续收群聊数据（进行中）
2. **构建** — `agent.ts` 基于真实群聊上下文回复
3. **诊断** — 分析回复哪里不像真人，改架构或 prompt
4. **迭代** — 循环往复
