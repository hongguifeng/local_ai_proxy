# Task 路由观测、手动迁移与自动再均衡设计

- 状态：已收敛的设计规格，功能尚未实现。
- 实现权威：本文。两份独立研究稿仅保留为研究过程，不作为实现依据：[DeepSeek 研究](./task-routing-study-deepseek.md)、[Qwen 研究](./task-routing-study-qwen.md)。
- 代码基线：`1c983a10751aaf102a55e223a92e09c1b74e6391`。
- 关联现行材料：[现行架构](./current-architecture.md)、[ADR-013](./adr/013-load-balancing-sticky-routing.md)、[负载均衡设计](./load-balancing-design.md)。

## 1. 决策摘要

1. 用户看到的“task”与代理实际能移动的 affinity binding 不保证一一对应。
2. 迁移只改变后续请求的落点，不能搬运已经发给上游的请求或 KV 缓存。
3. 首版提供按节点查看当前 binding、关联历史 task 和手动迁移；迁移在零在途请求的安全边界应用。
4. 自动再均衡先提供失衡观测和候选建议，默认不自动改绑。
5. 自动执行必须使用与手动迁移相同的改绑入口，并通过真实引擎对照实验后才允许开启。
6. 运行态迁移默认不持久化；跨重启固定节点属于后续独立设计。

## 2. 用户目标与成功标准

用户希望处理两类现象：

- 一个节点上的已有会话已经很少继续请求，另一个节点仍承受多个持续会话；
- 用户需要看见每个节点上有哪些可识别的会话或 task，并手动把某个路由落点改到另一个节点。

成功标准不是让绑定数量看起来平均，而是：

| 编号  | 可验证需求                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| TR-01 | 管理端能按负载均衡组和节点列出当前仍存在的路由 binding，并显示它是否有在途请求、最近何时请求以及关联 task 的覆盖范围。 |
| TR-02 | 页面分开显示在途请求数、当前 binding 数和历史最后服务信息，不把它们统称为“正在运行的 task”。                           |
| TR-03 | 用户发起迁移时，服务端明确说明动作影响的是整个 binding 还是唯一可识别的 task；共享 binding 不得伪装成单 task 操作。    |
| TR-04 | 手动迁移不会打断在途请求；目标校验、版本冲突、配置变化、失败切换和重启行为都有明确结果。                               |
| TR-05 | 同一操作的网络重试不会重复改绑；两个管理页面同时修改同一 binding 时，旧版本提交必须冲突。                              |
| TR-06 | 自动模式只有在指标完整、新鲜、目标可用、候选安全且同组兼容时才产生动作；缺少证据时只给建议或不动作。                   |
| TR-07 | 自动或手动迁移后的实际落点可通过请求路由记录核对，且不泄露请求正文、会话原文、身份键或密钥。                           |
| TR-08 | 迁移收益用整个工作负载的完成时间、尾延迟、吞吐、错误率和额外计算成本评价，不用单个 TTFT 或节点均匀度替代。             |

### v1 非目标

- 不迁移或重放已经交给上游的请求。
- 不传输 KV、不共享跨节点 prefix cache、不引入外部 KV 控制器。
- 不跨负载均衡组或跨 pair 迁移。
- 不替客户端补全上下文，不保证上游保存的 response、conversation 或节点本地资源可以跨节点使用。
- 不做跨重启的人工固定，不把固定规则写入 `proxies.json` 或 traffic 数据库。
- 不做代理侧排队、限流、准入控制或自动回迁。
- 不按“最小上下文”直接推断剩余轮次，不引入 tokenizer 作为首版依赖。
- 不改变未命中负载均衡组时的现有路由行为。

## 3. 现状与需要改变的合同

### 3.1 当前请求路径

当前请求在 `src/proxy/proxy-request-pipeline.ts` 中经过以下步骤：读取请求体、建立 `TaskIdentity`、调用 `LoadBalancer.plan()`、建立 reservation、连接上游、转发响应，最后释放 reservation。`plan()` 在 `src/proxy/load-balancer.ts` 中命中 affinity 后直接返回原目标；负载只参与新 binding 的选择。

响应转发期间，reservation 覆盖整个上游响应，包括长 SSE 解码；`finally` 中才释放目标的在途计数。连接阶段失败可以触发一次排除原节点的 failover，但响应头已经发送后不会切换。

因此迁移的实际语义是：

```text
管理动作或自动建议
        ↓
更新 binding 的未来落点
        ↓
下一次请求到达 plan()
        ↓
重新验证目标与协议条件
        ↓
在安全边界应用并为新目标建立 reservation
```

已经通过 `plan()` 的请求继续使用它当时捕获的 target；移动 binding 不会改变这条请求的上游连接或释放账本。

### 3.2 当前状态的权威边界

| 对象              | 当前权威                                  | 能回答的问题                                   | 不能回答的问题                         |
| ----------------- | ----------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| 生效配置          | `ProxyManager.config`                     | 哪些 target 属于哪个 group、目标地址和转换规则 | 当前某个会话是否在跑                   |
| affinity binding  | `LoadAffinityTable`                       | 下一次匹配请求会去哪个 target                  | 用户认为的 task 名称、上游是否保存状态 |
| proxy reservation | `LoadBalancer`                            | 本代理经过的请求当前是否在途                   | 绕过本代理的上游请求                   |
| 引擎采样          | `LoadMonitor`                             | 聚合 running、waiting、KV 和 awake             | 哪个 task 占用了哪些 KV、任务是否完成  |
| traffic 数据库    | `TaskMatcher`、`TaskStore`、`RecordStore` | 历史 task、记录落点、usage 和 pending 事件     | 实时活动锁、下一请求一定会去哪         |
| 管理 UI           | `/api/load-balancer/status`               | 内存状态的投影                                 | 任何未被服务端提供的 task 关系         |

当前 `AffinityBinding` 保存 `kind`、endpoint、model、边界指纹、用户消息哈希和 exact keys。它没有日志 `task_id`。日志 task ID 由 `TaskMatcher` 在记录写入时生成，路由 binding ID 是每组表内的自增整数，二者没有外键。

`LoadAffinityTable.lookup()` 会 touch `lastSeenAt` 和 `requestCount`，所以列表查询不能通过 `lookup()` 收集条目；必须增加无副作用的投影方法。`bind(..., { allowRebind: true })` 和 `rebind()` 都可能改变目标，失败切换也会改变目标，所有这些入口必须统一更新版本和审计状态。

### 3.3 当前可观测性的限制

- `inFlight` 是每个 target 的请求数，不是 task 数。
- `bindings` 包含已经长时间没有请求的 binding；24 小时 TTL、单桶 32 条和每组 4096 条上限会淘汰 binding，但不会告诉代理 task 是否完成。
- traffic 日志在请求早期会写入 received 和 pending 事件，但写入经过异步队列，写失败也不会改变已经发送的响应，因此 pending 行不能当作实时锁。
- `LoadMonitor` 的 `toLoadSample()` 当前把缺失的 running/waiting 转成 0。新设计必须保留字段缺失状态，否则只有 KV 指标的新鲜样本会被误判为“节点空闲”。
- 多个 target 可能通过 `canonicalKey` 指向同一物理引擎；采样时按物理引擎去重，目标选择和迁移时也必须排除同物理引擎迁移。
- group 成员被校验为共用日志根和价格规则，但成员 `model_id` 可以不同。迁移到不同 `model_id` 可能改变 `proxy-request-pipeline.ts` 中的 `upstreamModel`，不能假设模型名相同。

## 4. 设计对象与生命周期

### 4.1 Binding 是迁移对象

每个 group 的 binding 增加一个只读运行引用：

```ts
interface BindingRef {
  readonly runtimeEpoch: string;
  readonly groupId: string;
  readonly bindingId: number;
  readonly routingRevision: number;
}
```

- `runtimeEpoch` 在 pair 启动时生成，在同一 pair 的 listener 不变 reload 中保持不变；pair 停止、重启或进程重启后更换。
- `bindingId` 只在当前 affinity table 内有效，不能单独作为管理端标识。
- `routingRevision` 在初次绑定后，每次手动迁移、自动迁移或连接期 failover 改变目标时递增。
- 旧 binding 被 TTL、容量、节点删除或 group 删除清理后，迟到的 reservation 只能释放创建时记录的 target reservation，不得更新新表中恰好复用的数字 ID。

### 4.2 Binding 活动账本

活动状态由 `LoadBalancer` 持有，不写 traffic 数据库，不保存正文或身份键：

| 字段                   | 语义                                                       | 更新入口                                     |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `inFlight`             | 此 binding 通过本代理正在处理的请求数                      | `plan()` 预留时加一，reservation 释放时减一  |
| `lastRequestStartedAt` | 最近一次真正进入请求处理的时间                             | 预留成功时更新                               |
| `lastResponseEndedAt`  | 最近一次 reservation 释放的时间                            | reservation 释放时更新                       |
| `recentRequestStarts`  | 有界的最近请求时间环，用于显示多轮活跃，不用于推断剩余轮次 | 预留成功时追加                               |
| `lastInputTokens`      | 最近完成请求的 normalized input token，附来源和时间        | usage 完成后回填                             |
| `lastCacheReadTokens`  | 最近完成请求的 cache read token，若上游提供                | usage 完成后回填                             |
| `lastRequestBytes`     | 最近请求体字节数，只作无 tokenizer 时的粗略成本信号        | 选路时更新                                   |
| `manualProtection`     | 人工改绑后自动策略保护状态                                 | 手动操作时设置，用户取消或生命周期失效时清除 |

活动账本与 binding 对象分开管理。binding 被淘汰时，仍在途的 reservation 保留自己的 binding incarnation 和 target ID；释放后不能复活已删除 binding。

### 4.3 Task 与 binding 的关联

关联分三个等级：

1. **精确关联**：binding 的 exact key 在对应日志根的 `context_links` 或 `response_links` 中指向 task。
2. **候选关联**：边界指纹和有限用户消息哈希与 task 行匹配，但存在同桶多个 binding 时只能标记为候选，并显示歧义。
3. **无关联**：只有 binding 或只有历史 task，服务端必须如实返回未知。

列表和迁移的权威对象始终是 binding。历史 task 只提供标签、最近记录和关联置信度，不能把历史推断结果当成唯一迁移目标。一个 binding 关联多个 task 时，界面只显示一个迁移操作，并列出受影响 task 数和关联覆盖范围。

## 5. 共用的安全迁移服务

手动和自动策略都调用 `moveBinding()`，禁止各自直接赋值 `targetId` 或分别调用 `rebind()`。

### 5.1 迁移前置条件

以下条件在提交和真正应用两个时点都要检查：

| 条件                                                 | 手动                           | 自动       |
| ---------------------------------------------------- | ------------------------------ | ---------- |
| binding 仍属于给定 `runtimeEpoch`、group 和 revision | 必须                           | 必须       |
| 目标是当前 group 的 enabled 成员                     | 必须                           | 必须       |
| 目标不在连接失败 cooldown                            | 必须                           | 必须       |
| 目标没有被指标明确报告为 asleep                      | 必须                           | 必须       |
| 目标与源是不同 canonical physical key                | 必须                           | 必须       |
| 成员 `model_id` 相同，或 group 有显式兼容域声明      | v1 必须相同                    | 必须       |
| 当前 binding `inFlight === 0`                        | 立即应用必须；否则转 pending   | 必须       |
| 指标完整且新鲜                                       | 手动可允许未知，但 UI 必须警告 | 必须       |
| 请求依赖的服务端状态可跨目标访问                     | 未知则拒绝                     | 未知则拒绝 |

v1 对 `previous_response_id` 依赖采取保守策略：检测到该依赖且 group 没有明确的共享 response 状态声明时拒绝迁移。`conversation`、thread 或 session 头本身可以只是客户端身份线索，不能单独证明服务端状态存在；如果请求没有完整上下文且运行环境无法证明状态共享，同样拒绝。

目标指标过期不会阻止用户查看列表，但自动执行必须停止；手动操作可以在目标“状态未知”时提交，但服务端应返回警告并在应用前再次确认目标没有明确不可用状态。目标禁用、移出 group、明确 asleep 或 cooldown 时拒绝，不允许写入一个下一次 reload 就会被清掉的目标。

### 5.2 迁移状态机

```text
requested
   ├─ 目标与版本校验失败 → rejected
   ├─ 当前无在途请求     → applied
   └─ 当前有在途请求       → pending_boundary

pending_boundary
   ├─ 用户取消             → cancelled
   ├─ runtime/group/target/revision 变化 → expired
   ├─ binding 在 TTL/LRU 中消失 → expired
   └─ 后续请求到达且 inFlight=0 → applied

applied
   ├─ 下一次请求实际使用新 target → observed
   └─ binding 在下一次请求前失效 → expired_after_apply
```

`applied` 只表示内存路由已改；`observed` 表示至少有一条后续请求的路由记录证实使用了新 target；它不表示上游业务成功。把请求计划或预约到目标不算证实：证实要等到那条请求真的连上了目标并拿到目标的响应头或状态行，4xx 与 5xx 同样算。目标连不上时 failover 先把 `applied` 变成 `expired_after_apply`，从别的节点答复的请求不能把它复活。若没有下一次请求，操作停在 `applied` 或过期，不把它计为已经支付了冷 prefill。

应用 pending 操作的顺序固定为：读取当前 binding 和 revision → 验证目标与协议条件 → 同步改变目标并递增 revision → 为本次请求建立 reservation。单事件循环保证这段同步操作不被另一个 `plan()` 插入。

### 5.3 并发、幂等和迟到回调

- 管理请求带 `expectedRoutingRevision` 和 `expectedSourceTargetId`；任何不匹配返回 409，不允许后写覆盖。
- 管理请求带 `idempotencyKey`。同一 runtimeEpoch、参数摘要和幂等键重试返回第一次的提交回执；同一键携带不同参数返回 409。回执由幂等键与参数摘要一起绑定，`already_there` 这种没有写记录的答复同样绑定（`operationId` 为 `null`），所以换一个目的地复用同一键不能移动路由。幂等记录只在当前 runtimeEpoch 内保留，重启后的旧请求返回 409 或 404。给出成功答复之前必须先确认这个键还存得下：记录索引与回执索引同样受限，但是两个独立索引，回执索引里只剩仍可能移动的操作的回答时，`already_there` 这种不写记录的答复以 503 `migration_backlog_full` 拒绝且不写任何东西；存储装不下的拒绝不享受这条，因为它不是成功，后来按新状态重新评估。这条幂等保证的作用域是当前 runtime 内、回执仍在容量与保留窗口里的那些键；503 背压没有接受这次提交，也就什么都没写，因此它不被记住，空间腾出后同键按新状态重新评估沿用既有口径，不需要新的授权或新的状态。回执与记录共用同一个保留时钟，各自只用自己的起算点：记录从 `endedAt` 起保留一个窗口，独立回执从 `answeredAt` 起保留一个窗口，附在记录上的回执随记录一起释放，而仍活着的操作的回执不按时间清除。交给调用方的答复与记录都是副本，调用方改自己手里那份不影响以后的重放。
- `POST` 的答复是提交回执，不是状态查询：`state`、`effect`、`inFlightAtRequest` 和 `routingRevision` 冻结在第一次答复被决定的那一刻，之后 `applied`、`observed`、`cancelled`、`expired` 都不改写它，读不到的证据也不会被伪造成 0；被拒绝的提交重放仍是同一状态码、同一 `code` 和同一句话。操作当前走到哪一步由第 6.1 节的列表读给出（TRI-09），不由这条 `POST` 给出。
- 连接期 failover 是可用性动作，优先于 pending 人工或自动动作。failover 改变 revision，并使尚未应用的迁移意图失效；后续请求重新建立新的意图。
- 配置 reload 如果保留 group 和 target，binding 与 pending 操作继续有效，但执行时仍检查 group revision 和目标配置摘要。目标 URL、模型名、请求转换规则或日志根发生实质变化时递增 group revision，使旧操作失效。
- pair 停止、重启、group 删除、目标删除和 binding 淘汰会使未应用操作失效。pair 停止清空 binding；运行态迁移不恢复。
- 日志写入失败不改变已应用的路由状态。管理 API 的结果以运行态迁移结果为准，路由记录是事后观测，不是事务锁。

## 6. 手动分配功能

### 6.1 列表权威与返回内容

新增管理端读取接口：

```http
GET /api/load-balancer/tasks?pairId=p1&groupId=g1&targetId=node-a&limit=50&offset=0
```

返回内容以当前 binding 为主：

```json
{
  "now": 1764557100000,
  "pairId": "p1",
  "groupId": "g1",
  "targetFilter": "node-a",
  "runtimeEpoch": "opaque-epoch",
  "groupRevision": 12,
  "totalBindings": 1,
  "limit": 50,
  "offset": 0,
  "hasMore": false,
  "nextOffset": 0,
  "migration": "unavailable",
  "nodes": [
    {
      "targetId": "node-a",
      "canonicalKey": "http://engine-a:8000",
      "enabled": true,
      "inRotation": true,
      "bindings": 1,
      "inFlight": 1,
      "failures": 0,
      "cooldownRemainingMs": 0,
      "lastDispatchedAt": 1764557000000,
      "metrics": {
        "source": "vllm",
        "sampleSequence": 41,
        "sampledAt": 1764557099000,
        "freshness": "fresh",
        "completeness": "complete",
        "awake": true,
        "running": 3,
        "waiting": 1,
        "kvUsage": 0.93,
        "usableForLoadJudgement": true
      }
    },
    {
      "targetId": "node-b",
      "canonicalKey": "http://engine-b:8000",
      "enabled": true,
      "inRotation": true,
      "bindings": 0,
      "inFlight": 0,
      "failures": 2,
      "cooldownRemainingMs": 30000,
      "lastDispatchedAt": null,
      "metrics": {
        "source": null,
        "sampleSequence": null,
        "sampledAt": null,
        "freshness": "never_sampled",
        "completeness": "no_load_numbers",
        "awake": null,
        "running": null,
        "waiting": null,
        "kvUsage": null,
        "usableForLoadJudgement": false
      }
    }
  ],
  "items": [
    {
      "bindingId": 7,
      "incarnation": 3,
      "routingRevision": 3,
      "targetId": "node-a",
      "model": "Qwen3.8-Flash-Next",
      "endpointKind": "responses",
      "endpoint": "/v1/responses",
      "requestCount": 14,
      "lastSeenAt": 1764557000000,
      "lastBoundAt": 1764556900000,
      "lastRequestStartedAt": 1764557000000,
      "lastResponseEndedAt": 1764557005000,
      "recentRequestStarts": [1764557000000],
      "inFlight": 1,
      "activity": "in_flight",
      "context": {
        "source": "normalized_usage",
        "inputTokens": 18400,
        "cacheReadTokens": 12000,
        "requestBytes": null,
        "observedAt": 1764557005000
      },
      "associations": {
        "confidence": "high",
        "ambiguous": false,
        "taskIds": ["task-opaque"],
        "tasks": [
          {
            "taskId": "task-opaque",
            "level": "high",
            "exactKeyMatches": 1,
            "kind": "responses",
            "endpoint": "/v1/responses",
            "model": "Qwen3.8-Flash-Next",
            "requestCount": 1,
            "pendingRequestOnly": false,
            "lastSeenAt": "2026-07-18T09:00:00.000+08:00",
            "lastResponseAt": "2026-07-18T09:00:05.000+08:00",
            "historyTargetNode": "same"
          }
        ],
        "reasons": ["exact_key_links"],
        "coverage": {
          "state": "available",
          "failure": null,
          "logWriteMayBePending": false,
          "latestStoredRecordAt": "2026-07-18T09:30:00.000+08:00",
          "exactKeysRequested": 2,
          "exactKeysExamined": 2,
          "exactKeysLinked": 1,
          "exactKeysOmitted": 0,
          "exactKeysWithoutLink": 1,
          "exactLinkRowsRead": 1,
          "linkedTasksRead": 1,
          "candidateScanLimit": 100,
          "candidateRowsRead": 0,
          "returnedTaskLimit": 50,
          "historyRowsRead": 100,
          "historyTruncated": false
        }
      },
      "movable": {
        "ok": false,
        "reasons": ["migration_unavailable", "in_flight"]
      }
    }
  ]
}
```

实际实现与初稿草图的四处偏离已经收敛，理由如下：

1. 一行代表一个 binding，字段平铺而不嵌 `binding` 对象；行上直接带 `incarnation` 与
   `routingRevision`，因为第 5.3 节的乐观并发需要一个完整的 `BindingRef`，少一个字段就得再发
   一次读。
2. coverage 是每个 binding 一份，放在 `associations.coverage` 里，不是一份顶层 coverage；查询以
   binding 的 exact key 为输入，一次 binding 一次读，被略过的 key 数和扫描行数也只有按行报才真
   说得清（TRI-04 的口径）。
3. 顶层 `nodes` 报整个组的节点状态，包括指标新鲜度、完整性、awake、cooldown 和是否在轮换；
   `targetId` 过滤只筛 `items`，节点计数保持整组口径，客户端才不会把“这里没有 binding”读成
   “这个节点空闲”。
4. 没有 `lastServedTargetId`，只有每个历史 task 的 `historyTargetNode`（`same`、`different`、
   `unknown`）；成本信号的名字跟账本一致，是 `normalized_usage`、`request_bytes`、`none`。

`migration` 现在只有一个取值 `unavailable`，`movable.ok` 因此一律为 `false`（理由
`migration_unavailable`，有在途请求时再加 `in_flight`）。TRI-08 只新增迁移接口，不动这份列表；
把列表接到 TRI-07 的迁移服务上是 TRI-09 的工作，因为 TRI-06 的按钮先于提交逻辑存在，先放开
`movable.ok` 会交给用户一个能点、点了无效的按钮。TRI-09 接线后这个字段会变成可用，
`movable.reasons` 改用迁移服务的拒绝码命名，前端仍然只看服务端给的 `movable`，不自己判断。
TRI-06 已经落地，而它交付的正是这个约定：节点行下的列表读这份投影，行尾的迁移按钮一律按
`movable.ok` 渲染，所以在当前装配下它始终禁用，旁边写的就是服务端给的 `migration_unavailable`
原句；按钮上没有提交路径，也没有目标选择器，`POST` 与 `DELETE` 两条迁移路由在 UI 里仍然零调用。

响应禁止包含 exact key、session ID、请求正文、用户消息哈希、认证信息和 target API key。`taskIds` 可以使用已有日志 task ID；如果关联不确定，返回多个候选和 `ambiguous: true`，不返回一个伪造的代表 task。

列表的实时字段全部来自内存投影；历史关联由管理查询按需读取对应日志根的现有 `context_links`、`response_links`、`tasks` 和 `records`。查询不能进入 proxy 热路径，也不能调用会 touch binding 的 `lookup()`。历史-only task 可以作为只读附加行显示，但没有当前 binding 时不可直接迁移。

服务端返回以下状态的分开字段：

| 字段                   | 含义                                                 |
| ---------------------- | ---------------------------------------------------- |
| `inFlight`             | 当前通过本代理的在途请求数                           |
| `activity`             | `in_flight`、`idle` 或 `unknown`；不表示 task 已完成 |
| `lastRequestStartedAt` | 最近一次请求进入代理的时间                           |
| `lastResponseEndedAt`  | 最近一次 reservation 释放时间                        |
| `historyTargetNode`    | 历史落点与本节点：`same`/`different`/`unknown`      |
| `context.source`       | 仅说明成本信号来源                                  |

`context.source` 的取值是 `normalized_usage`、`request_bytes`、`none`，只说明成本信号的来源，不代表上游计费正确。

### 6.2 手动迁移接口

提交迁移意图：

```http
POST /api/load-balancer/task-moves
Content-Type: application/json

{
  "pairId": "p1",
  "groupId": "g1",
  "groupRevision": 12,
  "runtimeEpoch": "opaque-epoch",
  "bindingId": 7,
  "incarnation": 3,
  "expectedRoutingRevision": 3,
  "expectedSourceTargetId": "node-a",
  "destinationTargetId": "node-b",
  "idempotencyKey": "opaque-operation-key",
  "reason": "离开正在排队的节点"
}
```

成功返回：

```json
{
  "operationId": "opaque-operation-id",
  "state": "applied",
  "effect": "next_request",
  "bindingId": 7,
  "fromTargetId": "node-a",
  "toTargetId": "node-b",
  "routingRevision": 4,
  "inFlightAtRequest": 0,
  "runtimeEpoch": "opaque-epoch",
  "groupRevision": 12
}
```

请求体是闭集的，而且每一项版本都得由客户端自己带来，服务端不推导：`groupRevision` 与
`incarnation` 跟 `runtimeEpoch`、`expectedRoutingRevision`、`expectedSourceTargetId` 一起进
幂等摘要，缺任一项就要让客户端先发一次列表读才能提交；而“同一个幂等键只改
`groupRevision`” 必须是 409 `idempotency_conflict` 而不是 replay，客户端看不到这个字段就
验证不了它。这一条是实现相对本节初稿示例的偏离，已经在实现清单的 TRI-08 完成记录里写明，
本节现在与代码一致。`reason` 可选、上限 200 字，超长当参数错误拒绝，不被静默截断。响应带
`runtimeEpoch` 与 `groupRevision`，客户端据此判断自己是不是已经落在另一个运行时上；
`already_there` 不写记录，所以 `operationId` 是 `null`。

`POST` 的答复体是这次提交的回执，不是这条操作的当前状态。同一键重放时答复逐字段
等于第一次的答复：`state`、`effect`、`inFlightAtRequest` 与 `routingRevision` 停在第一次
被决定的那一刻，之后的 `applied`、`observed`、`cancelled`、`expired` 都不改写它，绑定
消失了也不会被读成 0。被拒绝的提交重放拿回同一份拒绝，所以状态码、`code` 与句子
都和第一次一致，网络重试不会把一次 422 报成 `rejected` 状态的 200。操作现在走到
哪一步属于第 6.1 节列表读的字段（TRI-09）；这条 `POST` 从不报 `observed`、
`expired`、`expired_after_apply` 或 `cancelled`。

如果 binding 有在途请求，返回 `202` 和 `state: "pending_boundary"`；如果已经在目标节点，使用同一幂等合同返回 `200` 的 `already_there`。错误合同如下：

| HTTP | code                   | 场景                                                 |
| ---- | ---------------------- | ---------------------------------------------------- |
| 400  | `invalid_request`      | 参数、范围或分页参数非法                             |
| 404  | `binding_not_found`    | pair、group、runtimeEpoch 或 binding 不存在          |
| 409  | `binding_stale`        | revision、源 target 或 group revision 不匹配         |
| 409  | `idempotency_conflict` | 同一幂等键携带不同参数                               |
| 409  | `target_not_eligible`  | 目标被删除、禁用、cooldown、asleep 或不在 group      |
| 409  | `operation_expired`    | pending 操作已被 reload、failover 或生命周期事件失效 |
| 422  | `state_not_migratable` | 服务端状态、模型兼容或节点本地资源无法证明安全       |

`migration_backlog_full` 走 503：它说的是这个运行时的迁移意图存储已经装不下新工作，稍后重试
即可，不是用户参数错误，也不算 409 冲突。取消一个已经 `applied` 的操作走 409
`operation_already_applied`，告知用户只能反向迁移，不能把已改的路由伪装成取消。

三类 404 定位在问回执之前完成：pair、runtime 与 `runtimeEpoch` 都要先对上现存的运行时，
因为运行时没了或被换掉就没有回执可答，停机与换 epoch 仍是各自的 404。第四类 `group` 只对
本运行时从未答过的键查：同一 runtime 内已经答过的键必须先匹配或冲突，即使那个 group 已经
离开配置也答第一次的回执，同键只改成一个不存在的 groupId 是 409 `idempotency_conflict`；只
有新键第一次问一个不存在的 group 才走 404。服务层不另立回执权威，也不自己算摘要。

取消尚未应用的操作：

```http
DELETE /api/load-balancer/task-moves/:operationId
```

已经 applied 的操作不能伪装成被取消；取消返回冲突并告知用户可以提交一次反向迁移。当前版本不提供持久化固定节点，因此页面明确显示“仅当前运行实例有效，重启后失效”。

### 6.3 UI 设计

功能放在现有负载均衡状态卡片内，不新建全局页面：

```text
负载均衡组 Qwen
  节点 A   在途 2 · binding 5 · running 3 · waiting 1 · KV 93%
    [展开路由]
      绑定 #7  Qwen /responses  最近请求 8 秒前  在途 0
        关联 task：1 个，置信度高，成本：18.4k input token
        [迁移到节点 B]
      绑定 #9  /messages  最近请求 2 分钟前  在途 1
        关联 task：3 个，共享同一落点；当前请求结束后才可迁移
        [登记迁移到节点 B]
  节点 B   在途 0 · binding 1 · 指标未知
    目标状态未知，手动操作需要再次确认；自动策略不执行
```

按钮文案必须说明“只影响下一次请求”。

- `inFlight > 0`：按钮可以登记 pending 操作，但不能显示“已迁移”。
- `applied`：显示“路由已更新，等待下一次请求”。
- `observed`：显示“已观察到下一次请求使用目标节点”。
- 关联多 task：显示全部关联数量和置信度，只有一个 binding 级操作。
- 目标状态 unknown：显示警告；明确不可用时禁用提交。
- 冲突：保留用户输入，刷新该行并显示“状态已变化，请重新提交”。

前端只根据服务端的 `movable` 和状态字段决定按钮，不自行判断 task 是否可迁移。UI 模块继续使用 `src/admin/static/modules/` 的 ES module 图，修改后必须重生成相关视觉基线。

TRI-06 已经落地的部分（现行事实，与上面的草图不同处已标明）：

- 列表在用户按下节点行的“路由绑定”后才读一次，关闭的面板从不被问；已开的面板跟着已有的状态
  轮询刷新，不新增计时器或监听。一次读取最多 200 行，面板也最多 200 行：追加只问剩下的空间，
  满了就不再发起，服务端答得比要得多也会被裁到上限。
- 一个面板只认它那一代：`runtimeEpoch` 或 `groupRevision` 换了就整代丢掉并从 offset 0 重读，
  重复出现的 `bindingId + incarnation` 只列一次；翻页进度取服务端的 `nextOffset`，不是本地行数。
- 列表被关掉、页面被切走、surface 被 dispose 或节点离开卡片时，在途读取会被主动取消，且不写成
  查询失败；面板留着已经显示的行。
- 行里写的是绑定自己的编号、模型、端点与三行事实，加关联 task 行与置信度；一个 binding 连到多个
  task 仍是一行一个操作。历史覆盖状态、截断与日志可能未写入各自单独标记，历史读失败与“没有
  traffic.db”“没有日志根”是三句话，不合并成一个空态。
- 草图里的 `[迁移到节点 B]` 与 `[登记迁移到节点 B]` 尚未存在：现行画面只有一个始终禁用的
  “迁移此绑定 / Move this binding”按钮和服务端给的原因。`inFlight > 0` 的 pending 登记、
  `applied` / `observed` 的文案、冲突后的重新提交与目标选择器都属于 TRI-09。

## 7. 自动再均衡功能

### 7.1 模式与所有权

在 `LoadBalancerGroup` 增加：

```ts
rebalance_mode: "off" | "advise" | "auto";
```

默认值为 `off`。`ConfigRepository`、normalizer、schema 和配置保存合同必须同步更新。模式属于 group，因为不同模型组的上下文成本和节点兼容性可能不同。

- `off`：不计算自动动作，不改变现有路由。
- `advise`：持续计算失衡和候选，只在状态 API 与日志中给建议。
- `auto`：允许在请求边界通过共用迁移服务应用一个自动意图，但仍受所有安全门、预算和冷却限制。

自动策略状态由 `LoadMonitor` 和独立的纯判定模块持有。定时器仍由现有 `LoadMonitor` 管理，不新增 UI 依赖；其 timer 已使用 `unref()`，停止 pair 时清理 sampling 和 advisor 状态。

### 7.2 失衡判定

自动策略只在以下信息同时满足时判定：

1. group 至少有两个不同的 canonical physical key。
2. `metrics_enabled` 开启，源和候选目标都有同一采样序号下的完整 `running` 与 `waiting` 字段。
3. 样本时间不超过现有 `METRIC_FRESH_WINDOW_MS`，且 awake 状态没有明确为 false。
4. 源节点持续满足“有明显排队或高并发”条件，目标节点持续满足 `running = 0`、`waiting = 0`，且目标本地 `inFlight = 0`。
5. 同一源/目标组合在多个不同采样序号中成立；重复读取同一样本不能增加稳定次数。
6. 至少存在一个当前 binding 满足安全迁移门槛。

“目标长期空闲”本身不触发迁移。新 task 已经会按 `least_load` 使用空闲节点；自动迁移只有在源节点存在持续压力、且候选 task 仍可能发下一请求时才有实验价值。

running、waiting 缺失时不得补零参与自动判定。多个 target 共享一个 canonical key 时，引擎采样只算一次；本地 reservation 按 target 分开维护，物理节点决策使用去重后的聚合口径。

稳定样本数、源节点忙阈值、目标静默时长、每组迁移速率和候选上下文上限都是待校准参数。它们不得从现有 `5s` 采样间隔、`15s` 新鲜窗口或 `0.9` KV 分档阈值直接推导。未完成真机校准时，`auto` 的运行状态为 `advise`，状态接口返回 `disabledReason: "not_calibrated"`，不得执行自动改绑。

### 7.3 候选选择

候选必须满足：

- `inFlight === 0`；
- 最近确实有请求活动，但没有证据显示它已经永久结束；
- 源、目标同一 group，目标 enabled、非 cooldown、非 asleep；
- 源和目标不同 physical key；
- model ID 和协议兼容；
- 没有未声明的 server-side response、conversation 或本地资源依赖；
- 没有人工保护；
- 上次上下文成本有可靠来源，或成本未知时不超过实验允许的保守范围；
- 未超过 binding 冷却、group 速率和自动迁移次数预算。

排序优先级：可靠成本信号升序 → 最近多轮活动证据 → 较久未开始下一请求 → 配置顺序。可靠成本信号优先使用最近完成请求的 normalized input token；缺失时可使用请求体字节数作为标注为估算的排序信号；不能把字节数宣称为 token，也不能把 `requestCount` 当作真实轮次。

候选不应只取“上下文最小”的 binding。小上下文可能已经结束，迁移不会缓解源节点压力；长上下文迁移代价较高但可能仍有多轮收益。自动执行需要在“迁移成本”和“后续可观测活动”之间做保守筛选，并把不能证明的部分留给实验。

### 7.4 自动动作时机

advisor 可以在采样 tick 中产生 `suggestion`，但不在后台直接改掉一个长期空闲 binding。自动动作只在该 binding 的下一次请求进入 `plan()` 时应用：

1. 重新验证 suggestion、binding revision、group revision 和 runtimeEpoch。
2. 检查当前 `inFlight` 仍为零、目标仍可用、指标和协议门仍满足。
3. 用本轮真实请求重新计算 identity、模型和上下文成本。
4. 通过 `moveBinding()` 原子改绑，并为本次请求在目标节点建立 reservation。
5. 将 `movedBy: "auto"`、源 target、目标 target、suggestion ID 和成本信号写入该请求的 `model_route.load_balance`。

如果没有下一次请求，不支付冷 prefill，不把 suggestion 算作成功或失败；只记录 `unused`。如果目标在下一次请求到达前变忙或不可用，取消 suggestion，不强行迁移。

### 7.5 防回摆和熔断

自动策略必须有：

- 单 binding 冷却；
- group 每时间窗口的迁移预算；
- 同一 episode 最多一次实际迁移；
- 目标待迁入承诺上限，防止多个候选同时追向同一节点；
- A→B 后在冷却内禁止自动 B→A；
- 连续迁移没有改善源节点排队或整体任务完成时间时暂停该 group，进入 `advise`；
- 用户关闭 auto 后停止新动作，但不自动回迁已经应用的 binding。

这些阈值都是配置参数，首版实现必须把测量来源和校准结果写入设计变更记录；不能把未经真机验证的示例数值直接当产品常量。

### 7.6 自动效果评价

每次自动候选记录以下状态，但不立即调参：

- `suggested`、`applied`、`observed`、`unused`、`rejected` 的数量；
- 迁移前后源节点 waiting/running 的变化；
- 迁移后第一条请求的 input token、cache read token、TTFT 和错误；
- 被迁移 binding 后续实际请求轮数；
- 被迁移 task 的端到端完成时间和尾延迟；
- 留在源节点的其它任务的尾延迟和生成吞吐；
- 目标节点新增排队、KV 压力和错误率。

单个 TTFT 变快、cache read 变少或节点计数更均匀都不能单独证明自动策略成功。自动模式的开启门槛是相同客户端脚本、相同上下文档位、相同轮次和并发条件下，至少完成“不迁移、手动边界迁移、自动策略”三组可复验对照，并在整体完成时间和尾延迟上达到预先约定的收益，同时错误率和额外计算成本没有超出约束。

## 8. 管理 API、服务装配与模块边界

管理端改动必须同时覆盖：

| 位置                                           | 责任                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `src/proxy/load-affinity.ts`                   | 无副作用 binding 投影、binding incarnation 和版本字段                |
| `src/proxy/load-balancer.ts`                   | 活动账本、reservation 生命周期、统一 `moveBinding()`、版本和目标校验 |
| `src/proxy/load-rebalance.ts`                  | 纯失衡判定、候选排序、suggestion 状态机；不直接碰网络或数据库        |
| `src/proxy/load-monitor.ts`                    | 采样完整性、物理节点去重、advisor tick 和停止清理                    |
| `src/proxy/proxy-request-pipeline.ts`          | 在 plan 边界应用 pending suggestion，回填 usage 和迁移路由元信息     |
| `src/proxy/load-balancer-admin.ts`             | 状态和 task/binding 投影服务，不在请求热路径查询数据库               |
| `src/admin/routes/load-balancer.ts`            | 注册列表、提交、查询、取消迁移路由                                   |
| `src/admin/admin-schemas.ts`                   | 所有新增响应和请求 DTO 的闭集 schema、长度与分页上限                 |
| `src/admin/admin-contracts.ts`                 | 扩展 admin service 合同                                              |
| `src/app/admin-services.ts`                    | 生产服务装配、`REQUIRED_ADMIN_SERVICES` 方法登记                     |
| `src/admin/static/modules/load-balancing.js`   | 节点任务展开、状态机、迁移反馈和文案                                 |
| `src/admin/static/app.css` 或归属组件块        | 新增布局，按 CSS cascade 审计规则归属                                |
| `test-node/admin/api-contract.test.ts`         | 路由表、响应顶层键和空配置行为                                       |
| `test-node/proxy/*`、`test-node/logging/*`     | binding、活动、迁移、身份关联和失败路径                              |
| `test-node/ui/admin-ui-load-balancing.test.ts` | UI 行为和迁移反馈                                                    |

历史关联查询应由现有日志查询/持久化边界提供只读能力；proxy transport 不得反向导入 admin 或 maintenance。新增运行时导入后执行 `npm run check:modules`。

v1 不新增 traffic 数据库表和 schema 版本。迁移原因写入现有开放的 `request.model_route.load_balance`，管理员操作的结构化审计写入 `StructuredLogger`。如果后续需要跨重启固定，必须另写持久化设计并处理敏感身份证据、原子写入、版本迁移和删除语义。

## 9. 实施阶段与出口

| 阶段        | 交付                                                                            | 出口                                                                               |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A：观测基础 | binding 无副作用投影、活动账本、runtimeEpoch/revision、采样完整性和物理节点去重 | 旧路由行为不变；并发请求、释放、TTL/LRU、reload、failover 和缺失指标测试通过       |
| B：只读列表 | 节点 binding 列表、历史 task 有界关联、三态展示、目标状态和可迁移原因           | 不泄露敏感信息；共享 binding、无日志、历史 pending 和歧义均有明确显示；UI 基线更新 |
| C：手动迁移 | pending boundary、统一 moveBinding、版本/幂等、目标校验、审计和实际落点观测     | 手动集成测试证明长 SSE 不受影响，下一请求到目标，冲突和生命周期测试通过            |
| D：自动建议 | `rebalance_mode=advise`、失衡检测、候选排序、建议原因、unused/rejected 统计     | 指标缺失、旧样本重复、同物理节点、人工保护和无下一请求不产生动作                   |
| E：自动执行 | 完成真机校准后启用 `auto`，共用安全入口，加入冷却、预算和熔断                   | 三组真实对照实验满足收益门槛；否则保持 `advise`                                    |

阶段 A 到 C 是本次用户需求的最小完整交付。阶段 D 让用户能看见“如果允许自动处理，会选择什么”；阶段 E 才真正自动改绑。

## 10. 数值与证据

| 数值或结论                                 | 类别         | 来源与限制                                                               |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------ |
| 指标采样间隔 5 秒                          | 现有常量     | `src/proxy/load-monitor.ts`；只描述当前采样节奏                          |
| 指标新鲜窗口 15 秒                         | 现有常量     | `src/proxy/load-balancer.ts`；不是自动稳定窗口                           |
| 指标超时 4 秒                              | 现有常量     | `src/proxy/load-monitor.ts`                                              |
| affinity TTL 24 小时、单桶 32、全组 4096   | 现有常量     | `src/proxy/load-affinity.ts`；不等于活跃 task 数                         |
| 用户消息哈希最多 64 条，超大保护 4096 条   | 现有常量     | `src/proxy/protocol/task-identity.ts`；不能作为完整上下文长度            |
| KV 高压分档 0.9                            | 现有常量     | `src/proxy/load-balancer.ts`；只能作压力信号，不能证明 task 活跃         |
| 193207 token 请求 TTFT 约 41.2 秒          | 历史记录     | `docs/load-balancing-design.md`；单次历史真机记录，不是通用 prefill 速率 |
| 1628 token 前缀冷/热 TTFT 528/325 ms       | 历史记录     | 同上；不能单独证明迁移收益                                               |
| 4096 binding 内存 snapshot 约 0.13–0.15 ms | 本轮合成实测 | 仅证明内存扫描局部成本；不是代理吞吐或真实任务收益                       |
| 10000 task/60000 record 的合成查询约 34 ms | 本轮合成实测 | 只代表夹具 schema、规模和分布；不代表用户真实数据库                      |
| 自动稳定窗口、上下文上限、迁移预算和冷却   | 待校准假设   | 必须通过真实工作负载实验后才能进入 `auto` 默认参数                       |

关键证据必须保留可复跑脚本、输入规模、引擎版本、缓存初始条件和对照结果。禁止使用单次 TTFT、合成 SQLite 查询或内存扫描成本直接推导用户收益。

## 11. 验证计划

### 逻辑与集成测试

| 编号 | 需求         | 验证                                                                                                                            |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| V-01 | TR-01、TR-02 | 两 target、多个 binding、无日志和共享身份时，列表正确区分 binding、inFlight、历史关联和歧义；读取不 touch `requestCount` 或 TTL |
| V-02 | TR-03        | 一个 binding 关联多个 task 时只显示一个 binding 级移动入口，并返回完整覆盖范围                                                  |
| V-03 | TR-04        | 长 SSE 在途期间提交迁移，旧请求完整结束；下一请求才使用新 target                                                                |
| V-04 | TR-05        | 两个旧 revision 同时提交，一个成功、一个 409；同幂等键重放返回原结果，参数不同返回冲突                                          |
| V-05 | TR-06        | 缺失/过期 running、waiting、awake、同 physical key、目标 cooldown 和无兼容模型时自动不动作                                      |
| V-06 | TR-07        | 迁移后的请求 `model_route.load_balance` 包含原因和源目标；响应不含正文、会话键或密钥                                            |
| V-07 | TR-04、TR-05 | reload、failover、目标禁用、group 删除、pair 重启和迟到 reservation release 不误写新 binding                                    |
| V-08 | TR-06        | advisor 读取相同旧样本不会累积稳定次数；每 episode 至多一个动作；冷却和熔断有效                                                 |
| V-09 | TR-08        | 记录迁移后的实际轮次、TTFT、usage、错误和整体任务完成时间；没有下一请求的 suggestion 标为 unused                                |
| V-10 | 工程合同     | 更新 admin 路由表、schema、服务装配、UI API 合同；`npm run check:modules` 通过                                                  |

### 真实引擎实验

使用隔离实例和固定客户端脚本，不接触用户正在运行的实例。至少运行：

1. 不迁移基线；
2. 在安全请求边界手动迁移；
3. 自动建议/执行策略。

每组固定模型、上下文档位、轮次数、并发、目标配置和缓存初始条件，并重复多轮。记录整体完成时间、任务级尾延迟、TTFT、生成吞吐、错误率、input/cache token、源节点 waiting、目标节点 waiting、迁移后实际轮数和 unused 比例。只有在整体收益与风险门槛同时满足时，阶段 E 才能启用；否则保留阶段 D。

### UI 与交付验证

UI 修改必须运行 `npm run regen:ui-baselines`，检查全尺寸截图、哈希行和英文捕获的中文残留；随后运行 `npm run check`。任务结束前运行 `npm run package:electron:portable`、`npm run smoke:delivery` 和 `npm run abi:node` 恢复 Node ABI。验证命令不停止或修改用户实例。

## 12. 开放问题

| 问题                                                                   | 推荐处理                                         | 替代                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| 一个用户 task 关联多个 binding 或一个 binding 关联多个 task 时如何命名 | UI 明确以 binding 为操作对象，显示 task 覆盖范围 | 引入客户端稳定 task ID 并重做身份协议          |
| 上游是否保存 `previous_response_id` 对应对象                           | 未证明共享前拒绝迁移                             | 允许用户强制迁移，风险是请求失败，不纳入 v1    |
| 目标指标过期时手动是否允许                                             | 可提交但二次校验，显示 unknown 警告；自动禁止    | 一律拒绝，安全更高但人工处理能力下降           |
| 是否跨重启保留人工目标                                                 | v1 不保留，另立 pin 设计                         | 将哈希或会话键落盘，存在隐私、误匹配和迁移问题 |
| 自动收益门槛是多少                                                     | 由三组真实对照实验预先约定，当前不填拍脑袋常量   | 永久保持建议模式                               |
| 是否按上下文 token 计算迁移收益                                        | 只用作成本信号，最终看任务完成时间               | 引入 tokenizer，成本和模型适配复杂度更高       |

## 13. 验收清单

- [ ] 本文作为唯一实现权威，旧研究稿明确保持为过程材料。
- [ ] 当前 binding、proxy reservation、历史 task 和上游指标的权威边界已在代码和测试中保持一致。
- [ ] 列表查询无副作用，不把 binding 数、inFlight 或 pending 行错误称为 task 完成状态。
- [ ] 一个 binding 关联多个 task 时，UI 和 API 显示完整影响范围。
- [ ] 迁移接口带 runtimeEpoch、binding revision、group revision 和幂等键。
- [ ] 有在途请求时只能登记 pending boundary，不能立即改绑；旧请求释放不误写新对象。
- [ ] 目标禁用、cooldown、asleep、不同物理引擎和不兼容模型均被正确处理。
- [ ] `previous_response_id` 或未知 server-side 状态依赖在未声明共享能力时拒绝迁移。
- [ ] reload、failover、目标删除、group 删除、pair 重启和 TTL/LRU 清理均有状态定义与测试。
- [ ] 手动迁移后的下一请求使用新节点，已有请求完整结束；路由元信息能够解释迁移原因。
- [ ] `rebalance_mode` 默认 `off`；`advise` 不修改 binding；`auto` 未校准时不能执行。
- [ ] 自动策略使用完整新鲜样本、物理节点去重、稳定窗口、候选成本、冷却、预算和熔断。
- [ ] 自动收益由真实引擎三组对照证明，未达门槛时保留建议模式。
- [ ] UI 基线、admin API 合同、模块边界、全量测试、便携打包、交付冒烟和 ABI 恢复全部通过。
