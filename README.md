# rin-research-humanize

研究如何让模型在 QQ 群聊中的回复更像真实人类。

## 项目定位

当前的 LLM 群聊 bot 容易在几句话内被识破——不是因为答错，而是因为答得**太完整、太中立、每条都回、从不断句、没有情感节奏**。本项目系统性地研究一套可落地的方法，让 bot 回复在内容正确的前提下，带上人能感知到的"人味"。

## 当前状态

项目已从文档阶段推进到有可运行脚本和数据产出的阶段。

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
│   └── listen.ts                 # OneBot 纯监听客户端（只收不发）
├── scripts/
│   ├── start-listen.sh           # 启动监听器（写 PID、日志重定向）
│   ├── stop-listen.sh            # 停止监听器
│   ├── status-listen.sh          # 检查监听器状态与数据量
│   └── ensure-listen.sh          # 保活脚本（crontab 用）
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
| `bun run listen` | 前台运行监听器（调试用） |

## 实验进展

### style-transformer 原型评估（2026-05-22）

基于 80 条 outbox 回信的定量评估，6 条转换规则的效果：

| 指标 | 原文 | 改文 | 真人参考 | 结果 |
|------|------|------|---------|------|
| 平均句长 | 86.5 字 | **30.8 字** | 10~25 字 | ⬇ 接近 |
| 长句比例(≥50字) | 57.3% | **14.6%** | ≤5% | ⬇ 接近 |
| 列表行占比 | 28.5% | **0%** | ≤1% | ✅ 达标 |
| 感叹号/回信 | 0 | **1.1** | 0.5~3 | ✅ 达标 |
| 省略号/回信 | 0 | **1.6** | 0.5~3 | ✅ 达标 |
| 语气词密度 | 0‰ | **8.9‰** | 15~40‰ | ⬇ 接近 |

**结论：10 个维度缩小差距，0 个恶化。** 列表消除和标点替换效果最稳，长句截断大幅拉低了句长。详见 `docs/eval-transformer-*.md`。

### 风格基线分析

详见 `docs/style-report.md`。Rin 的回复风格接近技术文档而非群聊：平均句长 88 字（真人 10~25 字），短句仅 3.8%（真人 30~50%），语气词密度为零。这些差距已被校准到 `docs/research-plan.md` 的基线状态表中。

## 研究方向

详见 `docs/research-plan.md`。五个方向均已校准基线数据，并标明了数据缺口。

1. **群聊节奏感** — 等群聊数据到位后重点优化回复间隔和选择性回复
2. **风格指纹** — 回复长度收敛、开头多样性、去结构化
3. **上下文接地** — 群内黑话、社交关系感知（依赖群聊数据）
4. **不完美设计** — 引入可控的表达瑕疵
5. **评估方法论** — 盲测工坊 + QC 评测集
