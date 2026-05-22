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

**结论：⚠️ 有三处待改进**

### 3.1 无指数退避

`listen.ts` 的重连延迟固定 3 秒：
```ts
setTimeout(() => connect(wsUrl, accessToken), 3000);
```

Rin 本体使用指数退避（1s → 2s → 4s → ... → 30s 封顶），连接成功后重置。固定 3 秒在网关短暂抖动时合理，但如果网关长时间不可用，3 秒一次的连接尝试会在日志中产生大量噪音。

### 3.2 未清理旧连接监听器

`connect()` 每次创建一个新的 `WebSocket` 赋值给局部常量 `ws`。如果上一个 WebSocket 因网络问题还在 pending（例如 DNS 解析慢），新连接创建后旧连接不会被清理：

- 旧连接的 `onclose` 仍可能触发，导致另一次 `connect()` 调用（重复重连）
- 旧连接的 `onmessage` 仍可能触达，处理过时的消息

Rin 本体的做法：
```ts
if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
}
ws = new WebSocket(url);
```

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

### 5.1 `sub_type` 未记录

Rin 本体未使用 `sub_type`，但 listen.ts 作为分析工具应该记录——它区分"好友私聊"和"临时会话私聊"（`sub_type: "group"` 的私聊），以及群聊中"正常消息"vs"匿名消息"（`sub_type: "anonymous"`）。

### 5.2 `sender.role` 未记录

`sender.role` 表示发送者的群角色（owner / admin / member），对分析社交关系和回复模式有参考价值。当前未记录。

### 5.3 `self_id` 未记录

多账号场景下同一个网关可能对应多个 bot QQ，`self_id` 标识收到消息的机器人账号。当前未记录，不影响单 bot 场景。

### 5.4 非 JSON 帧的坠落处理

当前在 `ws.onmessage` 中 `JSON.parse` 失败时直接 `return`（静默忽略）。建议至少加一行 debug 日志到 stderr，避免排查问题时无从下手。心跳帧（`{"status": {...}}`）也属于被静默忽略的范畴，目前无问题但日后若 OneBot 实现有变化可能会造成困惑。

---

## 改进建议汇总

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P1 | 重连无指数退避 | 引入 `reconnectDelay` 变量，连接成功后重置为 1s，失败后 `Math.min(delay * 2, 30000)` |
| P1 | 重连时未清理旧连接监听器 | 创建新 WebSocket 前清除旧连接的 `onopen/onmessage/onclose/onerror` 并 `close()` |
| P2 | 未记录 `sub_type` | 在 `ListenEntry` 和 JSONL 输出中加入 `subType` 字段 |
| P2 | 未记录 `sender.role` | 在 `ListenEntry` 中加入 `role` 字段 |
| P3 | 未记录 `self_id` | 在 `ListenEntry` 中加入 `selfId` 字段（多 bot 场景需要） |
| P3 | 无优雅关闭接口 | 可重构为返回 `{ close() }` 结构（但当前 sigint 方式够用） |
| P3 | JSON 解析失败静默忽略 | 加一行 `console.warn` 写入 stderr |
| P4 | face 段的 text 属性未提取 | 在 face 处理分支中提取 `data.text` 用于分析表情习惯 |

## 总结

listen.ts 核心正确：**纯监听、无发送、竞态安全**。消息解析覆盖了群聊的主流场景（文本、表情、@、回复引用），缺的主要是转发消息的内容穿透（需 API 调用，属于工程决策而非 bug）和几个辅助字段的遗漏。

最值得优先修的是**断线重连逻辑**（指数退避 + 旧连接清理），这在实际部署中直接影响数据完整性。其余属于信息丰富度提升，不影响核心功能。严重问题 0 个。
