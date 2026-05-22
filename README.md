# rin-research-humanize

研究如何让模型在 QQ 群聊中的回复更像真实人类。

## 项目定位

当前的 LLM 群聊 bot 容易在几句话内被识破——不是因为答错，而是因为答得**太完整、太中立、每条都回、从不断句、没有情感节奏**。本项目系统性地研究一套可落地的方法，让 bot 回复在内容正确的前提下，带上人能感知到的"人味"。

## 当前状态

项目已从文档阶段推进到有可运行脚本和数据产出的阶段。

```
rin-research-humanize/
├── src/
│   ├── collect-baseline.ts    # 提取 Rin outbox 回信元数据 → JSONL
│   ├── analyze-baseline.ts    # 分析基线数据 → 报告
│   └── listen.ts              # OneBot 纯监听客户端（只收不发）
├── data/
│   └── baseline/              # 基线 JSONL（已采集 100 条）
├── docs/
│   ├── research-plan.md       # 五个方向的研究计划（已用基线数据校准）
│   └── baseline-report.md     # 基线分析报告
└── package.json
```

## 现在能做什么

| 命令 | 作用 |
|------|------|
| `bun run collect-baseline` | 扫描 Rin 的 outbox，提取回复元数据到 JSONL |
| `bun run analyze-baseline` | 分析基线 JSONL，产出格式化的分析报告 |
| `bun run listen` | 启动 OneBot 纯监听客户端，采集群聊数据到 `data/raw/` |

## 基线发现（简要）

基于 100 封 outbox 回信的分析：

- **回复偏长**：中位数 250 字，P75 达 820 字（真人约 30-150 字）
- **间隔过密**：相邻回复中位间隔仅 34 秒（真人通常以分钟计）
- **结构化明显**：长回复多为"分点论述"式排版，一眼 bot
- **开头单一**：确认性开头仅 2%（"好的/好/嗯"等），低于真人水平

详见 `docs/baseline-report.md`，完整基线指标对照表见 `docs/research-plan.md` 的「基线状态」节。

## 研究方向

详见 `docs/research-plan.md`。五个方向均已校准基线数据，并标明了数据缺口。

1. **群聊节奏感** — 等群聊数据到位后重点优化回复间隔和选择性回复
2. **风格指纹** — 回复长度收敛、开头多样性、去结构化
3. **上下文接地** — 群内黑话、社交关系感知（依赖群聊数据）
4. **不完美设计** — 引入可控的表达瑕疵
5. **评估方法论** — 盲测工坊 + QC 评测集
