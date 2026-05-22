# listen.ts 代码审查

审查时间：2026-05-22
审查依据：静态代码审查 + 对照 Rin 本体 `src/onebot/client.ts`

---

## 1. 纯监听确认

**结论：✅ 无任何发送操作**

grep 检查了 `ws.send`、`sendAction`、`send`、`send_` 等关键词，listen.ts 中不存在任何向 WebSocket 写入的操作。脚本只做 `appendFileSync`（写文件）和 `console.log`（控制台输出），符合纯监听定位。

---

## 2. 消息解析覆盖度

| 场景 | 是否覆盖 | 说明 |
|------|----------|------|
| 纯文本 | ✅ | array 格式逐段拼接 text，string 格式直接使用 |
| 纯表情 | ✅ | 识别为 `face` 类型，记录 segmentTypes |
| 图文混合 | ✅ | 识别为 `text+face` 或 `mixed` |
| @ 某人 | ✅ | 提取 `at` 段中的 qq，排除 `@all` |
| 回复引用 | ✅ | 提取 `reply` 段中的 id |
| **转发消息**（forward） | ⚠️ 记录类型但不解析内容 | 转发的嵌套消息需要额外 API 调用才能展开，当前方案正确——只记录 `segmentType: "forward"`，但不解析内部的子消息。分析阶段需注意大量转发消息表现为"空文本"条目。 |
| **匿名消息**（anonymous） | ⚠️ 未处理 | 群聊匿名消息会在事件中附加 `anonymous` 字段。当前代码完全不感知匿名状态，匿名发言者的 `user_id` 固定为 80000000，不会导致崩溃，但无法区分"匿名用户 A"和"匿名用户 B"。可以作为后续优化。 |
| **表情文字**（face 的 text 属性） | ⚠️ 缺 | OneBot 的 `face` 段除 `id` 外有时还带 `text`（表情的文字描述，如 `/微笑`），当前代码不提取此字段。对分析群聊表情习惯有影响。 |

### 对比 Rin 本体的消息处理

Rin 的 `handleMessage` 入口只用了 `data.raw_message` 作为 complete() 的输入，没有对 message 结构做多层解析。listen.ts 的解析粒度（提取 atUsers、replyTo、segmentTypes）实际上**比 Rin 本体更细**，因为 listen 的职责是记录分析数据，而 Rin 只需要文本内容去回复。

---

## 3. 断线重连逻辑

**结论：✅ 已修复**（见 commit `edf84a3`）

### 3.1 无指数退避 ✅ 已修复

~~`listen.ts` 的重连延迟固定 3 秒：~~

改为模块级 `reconnectDelay` 变量，连接成功后重置为 1s，断开后 `Math.min(delay * 2, 30000)`，按 1s → 2s → 4s → ... → 30s 封顶递增。

### 3.2 未清理旧连接监听器 ✅ 已修复

~~`connect()` 每次创建一个新的 `WebSocket` 赋值给局部常量 `ws`...~~

改为模块级 `ws` 变量，每次 `connect()` 开头先清除旧连接的四个监听器（`ws.onopen = null` 等）并 `ws.close()`，再创建新连接。

### 3.3 缺少优雅关闭接口

Rin 本体暴露了 `{ close() }` 接口，可外部停止重连并清理连接。listen.ts 的 `main()` 只处理了 `SIGINT/SIGTERM` 的 `process.exit()`，没有提供程序化停止监听的能力。测试和集成场景下需要进程级终止。

---

## 4. 并发写入竞争

**结论：✅ 安全**

`appendFileSync` 是同步系统调用，在主线程中串行执行。Node.js 单线程模型保证同一时刻只有一个 `appendFileSync` 在执行，即使多条消息同时抵达（`ws.onmessage` 回调在事件循环中排队）。

对比 Rin 本体对 transcript 写入采用的是异步 `appendMessage` + session 队列（`enqueueSession`）的串行化机制，是因为异步 IO 确实需要队列保护。listen.ts 用 `Sync` 方法后这个顾虑自然消除。

**注意**：`appendFileSync` 会在写入前打开文件、写入、关闭文件，开销比异步的流式写入大。在活跃群（每秒数条消息）场景下可能是性能瓶颈，但按当前用量（纯记录、不回复）完全够用。

---

## 5. 边缘情况与遗漏字段

### 5.1 `sub_type` 未记录 ✅ 已修复

已加入 `ListenEntry.subType` 字段，写入 JSONL。

### 5.2 `sender.role` 未记录 ✅ 已修复

已加入 `ListenEntry.senderRole` 字段，写入 JSONL。

### 5.3 `self_id` 未记录 ✅ 已修复

已加入 `ListenEntry.selfId` 字段，写入 JSONL。

### 5.4 非 JSON 帧的坠落处理 ✅ 已修复

之前 `JSON.parse` 失败时直接 `return`（静默忽略），已改为 `console.warn` 输出前 200 字符到 stderr。心跳帧（`{"status": {...}}`）仍被正常忽略（`post_type !== "message"` 分支），属于正确过滤。

---

## 改进建议汇总

| 优先级 | 问题 | 状态 |
|--------|------|------|
| P1 | 重连无指数退避 | ✅ 已修复 — 模块级变量 + 翻倍退避 1s→30s |
| P1 | 重连时未清理旧连接监听器 | ✅ 已修复 — connect() 前清 onopen/onmessage/onclose/onerror 并 close() |
| P2 | 未记录 `sub_type` | ✅ 已修复 — ListenEntry 中新增 subType 字段 |
| P2 | 未记录 `sender.role` | ✅ 已修复 — ListenEntry 中新增 senderRole 字段 |
| P3 | 未记录 `self_id` | ✅ 已修复 — ListenEntry 中新增 selfId 字段 |
| P3 | 无优雅关闭接口 | ⚠️ 待评估 — 当前 sigint 方式在独立进程中够用 |
| P3 | JSON 解析失败静默忽略 | ✅ 已修复 — 改为 console.warn 输出前 200 字符 |
| P4 | face 段的 text 属性未提取 | ⚠️ 待评估 — 后续优化

## 总结

listen.ts 核心正确：**纯监听、无发送、竞态安全**。审查发现的 P1（断线重连）和 P2（遗漏字段）问题已在 commit `edf84a3` 中修复。剩余待评估项为优雅关闭接口和 face 文字提取，不影响核心功能。严重问题 0 个。
