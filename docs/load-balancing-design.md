# 多节点负载均衡设计（粘性任务路由 v1）

- 文档状态：设计定稿，待实现
- 决策记录：[ADR-013 负载均衡采用粘性任务路由与最少在途选择](./adr/013-load-balancing-sticky-routing.md)
- 关联文档：[软件功能说明书](./software-functional-specification.md)、[模块设计](./module-design.md)、[ADR-011 保存配置时复用监听器](./adr/011-listener-reuse-on-config-save.md)
- 设计来源：DeepSeek 与 Qwen 方案评审后的合并版本

## 1. 决策摘要

本功能在一个 proxy pair 内，把同一模型的多个等价 target 组成负载均衡组。新 task 按节点负载选择落点；已经建立亲和关系的 task 固定回到原节点，以复用 vLLM 或其他引擎实例上的 KV/prefix cache。

v1 采用以下行为作为稳定契约：

1. **粘性优先于负载。** 命中亲和绑定后直接使用原节点，不因为另一节点更空闲而迁移。
2. **新 task 使用确定性的负载排序。** 先避开 KV 高压节点，再比较 `max(代理在途, 上游 running + waiting)`，最后用最近分派时间和配置顺序裁决平票。
3. **组内模型名直通。** 命中负载均衡组后，组成员 target 自己的 `model_mappings` 不参与选择，也不改写该请求的模型名。
4. **负载指标只改善选择，不决定转发可用性。** `/metrics` 不可用或采样过期时，退化到代理侧在途计数，仍然可以转发。
5. **连接期只允许一次失败切换。** 只有在尚未向客户端写出响应头或响应字节时，才可以改投组内其他节点。
6. **命中组但没有可用节点时返回 503。** 不静默回落到普通模型映射，避免请求被送到语义不同的模型或错误地址。
7. **亲和表跨配置 reload 保留。** 它挂在 pair 的 runtime entry 上，不挂在每一代 pipeline 上。
8. **v1 不做亲和持久化和主动 spill。** 代理进程重启、绑定淘汰、节点被移除或故障切换时，task 可能换节点；这些行为必须在日志和用户文档中可见。

这份文档是实现规格。ADR-013 记录决策背景和取舍；两份评审草稿保留为设计过程材料，不再作为实现依据。

## 2. 背景与现实依据

当前一个 pair 可以配置多个转发地址，但路由只有两种行为：请求模型命中某个 target 的 `model_mappings`，或者使用 `default_target_id`。这不能表达“同一个模型有多个等价副本”。

本次设计针对的实际部署包含两个本地引擎端口：`9393` 和 `9394`。评审期间的只读检查得到以下事实：

- 两个端口都暴露根路径 `/metrics`，而 `/v1/metrics` 不可用；
- 两个引擎都提供相同的请求模型名；
- 9394 当前没有承载历史流量，且现有模型映射曾把模型改写成该引擎并未提供的名称；
- 近期 Responses 流量大多数带有 session 信息或 `prompt_cache_key`；
- 现有流量的 prefix cache 命中率较高，把长会话切换到另一张卡会产生数秒级的冷 prefill；
- 两张卡的 KV 容量相近，但单卡同时承载多个长上下文会话会增加排队和抢占风险。

这些事实决定了本功能必须优先保证 task 亲和，然后才均衡新 task。简单轮询不能看到长时间运行的 decode、引擎内部排队、KV 压力和节点故障；只看代理在途也无法看到绕过代理的外部负载。因此 v1 同时使用代理计数和上游指标，但不把指标采集放进请求热路径。

## 3. 需求与边界

### 3.1 功能需求

| 编号 | 需求 | 设计响应 |
| --- | --- | --- |
| R1 | 同一 task 的后续请求固定到同一节点 | 内存亲和表；命中后不比较负载 |
| R2 | 新 task 按实际负载选择节点 | 代理在途、上游 running/waiting、KV 分档 |
| R3 | 复用已有 target 配置 | 节点使用已有 URL、Key、Headers、日志、脱敏、价格等配置 |
| R4 | 组内模型名保持一致 | 组命中时屏蔽成员 `model_mappings`，透传请求模型 |
| R5 | 提供可配置的负载均衡组 | pair 内卡片、模型 pattern、节点勾选、策略和开关 |
| R6 | 能解释路由结果 | `model_route`、状态 API、节点实时负载和冷却状态 |
| R7 | 配置保存不打断活跃 task | `LoadBalancer` 在 `reloadPair()` 前后复用 |
| R8 | 节点故障时尽快恢复 | 连接期失败冷却并切换一次，避免链式重试 |

### 3.2 v1 非目标

- 不做跨节点 KV 迁移、KV transfer 或外部 prefix cache 控制器；
- 不做代理侧排队、准入控制、丢弃或限流；
- 不做跨 pair 的负载合并；
- 不做异构显卡权重、prompt token 精确加权或复杂 β 评分；
- 不做主动的饱和迁移（spill）；已建立亲和的 task 默认不迁移；
- 不做代理重启后的持久化亲和回填；
- 不改变未命中负载均衡组时的现有 `selectTargetByModel` 语义；
- 不增加 traffic database schema。

## 4. 核心语义

### 4.1 负载均衡组

负载均衡组属于一个 pair，由以下内容组成：

- 一个模型匹配模式 `model_pattern`；
- 一个或多个本 pair 内的 target；
- `least_load` 或 `round_robin` 策略；
- 指标采样和失败切换开关。

组匹配沿用现有模型 pattern 的通配规则，按配置顺序执行，第一个启用且匹配的组生效。一个请求只由一个组接管。

组成员可以只有一个 target。此时它等价于“把匹配模型固定到该 target”，UI 必须显示“只有一个节点，无法均衡”的提示，但后端行为仍然有效。

### 4.2 task 亲和的例外

“同一 task 固定同一节点”允许以下明确例外：

1. 亲和绑定超过 TTL 或被容量上限淘汰；
2. 节点被删除、禁用或移出该组；
3. 原节点发生连接期失败，触发一次失败切换；
4. 代理进程重启，v1 内存亲和表丢失；
5. 请求的 kind、endpoint、模型或静态边界发生变化，路由身份被判定为新 task。

KV 高压本身不会触发已有 task 的迁移。这样可以避免同一 task 在两个节点之间来回移动并在两边重复 prefill。

### 4.3 日志目录约束

同一负载均衡组的节点必须使用相同的**解析后** `log_root`。如果节点不记录日志，则组内节点都必须关闭日志。

现有运行时按 `log_root + redact_logs` 复用日志服务和 SQLite 数据库。若同一 task 的请求被写进不同数据库，历史 task 会被拆开，节点分布、上下文链接和后续亲和回填也无法保持一致。配置校验必须拒绝解析后日志目录不一致的组；normalizer 不得静默删除或修正未知 target 引用。

### 4.4 价格冻结约束

请求定价在 target 选择后通过该 target 的 `model_prices` 冻结。负载均衡不会自动合并不同节点的价格配置，因此同一组的节点必须使用相同的价格规则；否则同一 task 在普通亲和命中、失败切换或下一轮请求后，可能出现价格变化或整条记录变成 `unpriced`。

v1 采用最容易验证的约束：组成员的完整 `model_prices` 数组规范化后必须相同，包括规则顺序、模型 pattern 和所有价格字符串。所有成员都为空时表示该组不计费，不能只有部分节点为空。后续如果需要不同节点使用不同价格，再引入组级价格配置并重新定义历史口径。

配置保存时由后端拒绝不一致的价格规则，UI 同时显示差异。集成测试必须覆盖同一 task 在两个节点之间失败切换后仍保留相同的 pricing snapshot。

### 4.5 组内模型映射

命中负载均衡组后：

- 组成员 target 的 `model_mappings` 不参与本次 target 选择；
- `upstream_model` 等于请求原始模型名；
- target 的 URL、API key、headers、strip/inject、日志、脱敏和价格配置继续生效；
- 未被该组 pattern 覆盖的其他模型，仍然使用 target 自己的普通模型映射。

这样同一个 task 在不同节点间发生失败切换时，发给引擎的模型名仍然一致。

## 5. 配置模型

### 5.1 配置结构

在 `proxyPairSchema` 中增加：

```ts
load_balancers: z.array(loadBalancerGroupSchema).default([])
```

组结构为：

```ts
const loadBalancerGroupSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string(),
  enabled: z.boolean().default(true),
  model_pattern: z.string().trim().min(1),
  node_target_ids: z.array(z.string().trim().min(1)).min(1),
  strategy: z.enum(["least_load", "round_robin"]).default("least_load"),
  metrics_enabled: z.boolean().default(true),
  failover_enabled: z.boolean().default(true),
});
```

v1 不把 TTL、容量、KV 阈值和轮询间隔暴露为每组配置。它们使用统一常量，避免用户在首版中面对大量互相影响的旋钮：

```ts
const AFFINITY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BINDINGS_PER_GROUP = 4096;
const MAX_BUCKET_SIZE = 32;
const MAX_BUCKET_SCAN = 16;
const KV_SOFT_LIMIT = 0.9;
const METRICS_POLL_INTERVAL_MS = 5000;
const METRICS_TIMEOUT_MS = 4000;
const METRICS_STALE_AFTER_MS = 15000;
```

### 5.2 配置校验

`superRefine` 必须检查：

- pair 内的组 `id` 唯一；
- `node_target_ids` 都存在于同一个 pair；
- `node_target_ids` 不重复；
- `model_pattern` 完全相同的组不允许同时存在；可部分重叠的 pattern 允许保存，但 UI 必须给出顺序匹配警告；
- 组成员解析后的 `log_root` 必须一致；所有成员为空时表示该组关闭日志；
- 组成员的 `model_prices` 必须完全一致，包括规则顺序和价格字符串；如果所有成员都为空，则表示该组明确不计费；
- 组至少有一个 target；单节点组允许保存并显示提示；
- 目标 target 已禁用时允许保存，但运行时不参与选择；
- `load_balancers` 缺失时按空数组处理，旧配置行为不变。

未知 target ID 必须保留到 schema 校验阶段并返回带路径的错误，例如：

```text
pairs.0.load_balancers.1.node_target_ids.0:
load balancer node target not found in pair
```

normalizer 可以补齐缺失的 `id`、`name` 和默认字段，但不能静默丢弃未知成员或未知值。

实现落地（LB-01）补充了三条可验证细节：

- `log_root` 一致性比较的是词法归一化后的键（分隔符统一为 `/`、去掉 `.` 与多余分隔符、按 `..` 回退），大小写敏感。把两个不同的 Linux 目录当成同一个会静默拆开 task，所以宁可让 Windows 上的大小写差异变成一次可见的拒绝。
- 价格一致性比较的是数值（`整数 × 1e6 + 小数补齐`），所以 `1` 与 `1.0` 等价；规则顺序、pattern 和可选倍率仍要求逐项一致，长度不同直接拒绝。
- `single_node`、`disabled_member`、`overlapping_pattern` 三种提示由 `collectLoadBalancerWarnings(pair)` 计算，不是 schema 错误；LB-09 与 LB-10 负责把它们送进状态接口和界面。两个 pattern 是否可能重叠由 `modelPatternsMayOverlap` 判定：前缀、后缀或必需中间段互相矛盾时判为不相交。

管理端 400 响应现在带 `error.issues`（`{code, message, path}` 数组），否则界面只能看到“有 N 个字段错误”，无法定位到具体节点。

### 5.3 模型一致性校验

保存配置不主动请求上游。代理页提供“校验节点模型”操作，调用：

```text
POST /api/load-balancer/verify-models
```

服务端对组内节点读取模型列表，比较请求模型或组级预期模型是否存在，并返回每个节点的模型列表和匹配结果。网络失败只显示为校验失败，不改变保存结果。

这是一个预检工具，不代替运行时的模型直通规则。组命中后仍然使用请求模型名；如果用户忽略失败校验，真实请求会按普通上游错误处理。

## 6. 运行时架构

### 6.1 模块

新增模块建议如下：

| 模块 | 职责 |
| --- | --- |
| `src/proxy/task-identity.ts` | 从 body、headers、kind 和 endpoint 提取亲和证据；与 `TaskMatcher` 共用纯投影函数 |
| `src/proxy/load-affinity.ts` | 精确键、前缀桶、TTL、LRU 和绑定清理 |
| `src/proxy/load-balancer.ts` | 组匹配、节点选择、预留、释放、冷却和失败切换状态 |
| `src/proxy/load-metrics.ts` | Prometheus 文本解析和指标别名 |
| `src/proxy/load-monitor.ts` | 周期采样、超时、单飞、新鲜度和停止清理 |

`task-identity.ts` 中提取出的边界和消息投影由日志 `TaskMatcher` 复用。两边不能各自维护字段清单和规范化规则。

### 6.2 runtime 生命周期

`ProxyRuntimeEntry` 增加：

```ts
loadBalancer: LoadBalancer | undefined;
loadMonitor: LoadMonitor | undefined;
```

生命周期如下：

| 时机 | 行为 |
| --- | --- |
| `startPair` | 创建负载均衡器和指标监视器 |
| `reloadPair` | 原地 `reconfigure(groups, targets)`，保留仍有效的绑定和计数 |
| `stopPair` | 停止采样器、清空绑定、释放定时器 |
| pipeline drain | 旧 pipeline 的释放回调仍指向同一个 runtime balancer |

`LoadBalancer` 只返回 `targetId` 和一次性选择计划，不持有完整 target 对象，避免和 pipeline 产生循环依赖。pipeline 再根据自己的 target 视图获取 URL、认证和转换配置。

亲和绑定使用 pair 内稳定的 `targetId`。指标采样、单飞请求和物理上游负载汇总如果需要使用 URL 身份，必须使用 `canonicalNodeKey`，不能直接拼接原始 target URL。规范化至少包括 scheme、大小写、默认端口、IPv6 方括号、末尾斜杠和 base path；当前本地部署中的 `localhost` 与 `127.0.0.1` 要归一为同一类本地地址。不同 base path 不能合并，任意 DNS 名称也不能仅凭字符串替换强行合并。v1 不跨 pair 合并负载，但从第一版开始使用规范化函数，避免后续加入共享监视器时重新解释节点身份。

落地说明（LB-04）：

- `src/proxy/node-identity.ts` 提供 `canonicalNodeKey` 和 `tryCanonicalNodeKey`。回环集合是 `localhost`、`127.0.0.1`、`::1`，全部归为 `127.0.0.1`；非回环的 IPv6 字面量保留方括号。默认端口省略，末尾斜杠剪掉，query 和 fragment 忽略。base path 的大小写保留，HTTP 路径本身就是大小写敏感的。
- 亲和一律走 `targetId`；canonical key 只用来把同一台引擎的多个 target 归在一起。
- `LoadBalancer` 在 pair 内存活。`reconfigure` 复用旧 node 对象，所以重新保存配置不会把在飞计数洗掉。
- 在飞计数存在一张以 `targetId` 为键的 pair 账本上，不属于任何 pipeline。reload 后旧请求的释放回调仍然指向同一个 `LoadBalancer`，因此不会被计入新旧两份账本。
- `clear()` 释放绑定和在飞计数，但保留 node 视图；`stopPair` 会把整个对象从 runtime entry 上摘掉。
- `LoadMonitor` 是唯一碰定时器的地方。现在它只做每 5 分钟的亲和过期清理，定时器 `unref()`，不会自己拖住进程。LB-08 把采样接进同一个定时器。
- runtime registry 在 `startPair` 创建、`reloadPair` 原地 reconfigure、`stopPair` 停表并清空。`loadBalancer(pairId)` 和 `loadMonitor(pairId)` 是读取入口，LB-09 的状态 API 会直接用。
- 当前偏差：监视器还只会清理亲和，上游采样是 LB-08 的活；`LoadBalancer` 还不选人，选路是 LB-05 的活。

### 6.3 请求处理流程

```text
读取完整请求 body
  → 解析请求模型
  → 查找第一个匹配的启用负载均衡组
  → 提取 task 亲和证据
  → 命中绑定：使用绑定节点
  → 未命中：按负载排序选择节点并同步建立绑定
  → 立即增加节点 inFlight 预留
  → 以请求模型名转发，应用该 target 的其他配置
  → 打开上游连接
  → 连接期失败：释放预留，必要时切换一次并重新绑定
  → 转发响应并记录指标
  → finally 释放 inFlight
  → 响应完成后登记 response id 关联
```

`plan()` 必须同步完成查找、建绑和预留。Node 单线程保证两个同时到达的请求不会在同一个 miss 窗口内重复建绑到不同节点，也保证连续的新 task 能看到前一个请求已经增加的预留。

负载均衡器内部错误应记录并回退到原有路由；明确的“组内无可用节点”除外，该错误必须返回 503，不能静默绕过组。

### 6.4 多 target 的日志时序与 pending 刷新

现有 pipeline 只有在 `targets.length === 1` 时，才能在读取 body 前写入 `request_received`。多 target 请求必须先读取完整 body 才能确定模型、负载均衡组和最终 target，因此其第一条持久化记录发生在选路之后：

```text
单 target：request_received（读 body 前）→ 读 body → request_pending_response
多 target/LB：读 body → 选 target → request_received → request_pending_response
```

这意味着多 target/LB 请求在 body 读取和选路期间还没有数据库 record，`GET /api/logs/records?ids=...` 也没有可查询的行。选路后的 `request_received` 写入成功后，批量接口可以正常返回该行；body 列被转存到 `body_chunks` 后为空是现有存储契约，不是本问题的根因。

v1 必须明确这一时序，不能声称多 target 具备单 target 的早期在途可见性。pending sweep 只能刷新已经进入日志列表的 record。若产品要求在读取大 body 期间也显示该请求，后续应增加 pair/runtime 级 pending registry 和对应的管理端数据源；不能把未知最终 target 的占位行随意写入某个 target 的日志库。

落地说明（LB-06）：

- 本任务只验证现有行为，不改产品代码；单 target 的早期写入保持原样：`request_received` 先于读 body，带空 body 占位和 `body_pending: true`，没模型也没路由。
- 多 target/LB 在 body 读完、节点选定之前确实一条 record 都没有；`request_received` 和 `request_pending_response` 随后用同一 record ID 和同一选中 target 写入。
- record 一旦存在，`GET /api/logs/records?ids=` 就能取到不展开 body 的 pending 行；body 列为空是转存后的存储契约，详情接口仍读得到正文。
- v1 没有 runtime pending registry，所以不承诺“读大 body 期间也能查到该请求”。
- pricing 在选定节点后冻结，用的是那个节点的 `model_prices`；组内价格已由保存时校验一致，所以切换节点只换快照里的 target 名字，金额和费用状态不变。

## 7. task 亲和与路由身份

### 7.1 证据结构

```ts
interface TaskEvidence {
  readonly kind: EndpointKind;
  readonly endpoint: string;
  readonly model: string;
  readonly boundary: Record<string, string>;
  readonly boundaryWithoutUser: Record<string, string>;
  readonly userHashes: readonly string[];
  readonly contentFingerprint: string;
  readonly exactKeys: readonly string[];
}
```

精确键按以下来源提取：

- `previous_response_id` 对应的 response id；
- `conversation`、`conversation.id`、`conversation_id`、`thread_id`；
- `metadata` 中的 conversation、thread、session 标识；
- `prompt_cache_key`；
- `x-claude-code-session-id` 及现有 matcher 支持的 session header。

路由键不保存用户消息原文，只保存短哈希。认证信息和请求内容不能进入亲和状态、状态 API 或路由日志。

### 7.2 查找顺序

```text
1. 依次查 exactKeys
2. 检查 kind、endpoint、model 和静态 boundary 是否兼容
3. 查同一 boundary 的前缀桶，最多扫描 MAX_BUCKET_SCAN 条
4. 比较 userHashes 前缀和 continuation/content fingerprint
5. 命中则刷新 lastSeenAt，否则创建新绑定
```

每个前缀桶最多保存 `MAX_BUCKET_SIZE` 条绑定，超过后按 `lastSeenAt` 淘汰桶内最旧项；全局 `MAX_BINDINGS_PER_GROUP` 仍然独立生效。桶上限用于防止大量同构探测请求占满一个桶并挤掉其他 task，`MAX_BUCKET_SCAN` 用于限制单次查找工作量。

精确 response 链可以忽略 `first_user`，以支持后续请求只携带 `previous_response_id` 的 Responses API。前缀桶用于没有稳定显式 session key 的客户端。完全相同请求体的短时间重试可以命中原绑定，但两个独立的基准请求如果 body 完全相同，也可能共享一次绑定；这是“宁可少分散，不可多换节点”的有意退化。

`userHashes` 最多保留 64 条。对超大 body 或极多消息必须设置工作上限，避免在请求热路径中进行无界哈希；超过上限时使用已有精确键和边界证据，无法可靠识别时按新 task 处理。

当前 `TaskMatcher` 还读取顶层 `record["prompt_cache_key"]`、`record["client_metadata"]`。现有 `src/` 数据面没有这些字段的生产者：请求 body 中的 `prompt_cache_key` 是可达的，但顶层字段和 `client_metadata` 不是路由时可用的输入。因此 v1 的共享身份契约只覆盖请求 body、请求 headers、kind、endpoint、模型和边界投影；不能把不可达的历史字段也宣称为路由判定的证据。

实现时抽出 `requestContextKeys(payload, headers)` 供路由和 `TaskMatcher` 共用。`TaskMatcher` 可以保留上述顶层字段作为旧数据或导入数据的兼容 fallback，但路由不依赖它们；集成测试必须分别验证运行时可达字段和兼容 fallback。所谓“路由判定是 matcher 的超集”只对共享的运行时可达证据成立。

落地说明（LB-02）：

- 唯一入口是 `src/proxy/task-identity.ts`；`TaskMatcher` 现在从这个模块拿键提取、边界比较、用户消息前缀比较和 continuation 判定，不再自己写一份。`src/proxy/records.ts` 里的指纹函数仍是唯一的原始投影。
- 上限是 `MAX_TASK_USER_HASHES = 64` 和 `MAX_TASK_USER_MESSAGES = 4096`。超 64 条时 `bounded` 为真，超 4096 条时 `oversize` 为真；两者只截断哈希列表，不改变 matcher 的判定。
- 键值只接受字符串。数字型 `prompt_cache_key` 不会变成键，否则路由会比 matcher 多出键。
- matcher 的历史列键（`prompt_cache_key`、`client_metadata`）由 `mergeLegacyContextKeys` 插在 `claude_session` 之前，顺序与原来一致。
- `TASK_MATCH_STRATEGY_VERSION` 仍为 6。matcher 行为不变，15 个现有用例全绿。
- `test-node/logging/task-identity-boundary.test.ts` 把超集方向写成断言：matcher 合并时证据差集只能出现在 `content` 和 `userHashes`；matcher 因模型、指令或首轮用户拆分时，证据差集必须包含对应维度。

### 7.3 绑定结构和生命周期

```ts
interface Binding {
  groupId: string;
  targetId: string;
  kind: string;
  endpoint: string;
  model: string;
  boundary: Record<string, string>;
  userHashes: readonly string[];
  contentFingerprint: string;
  createdAt: number;
  lastSeenAt: number;
  keys: string[];
}
```

绑定命中时刷新时间和必要的 continuation 信息。新绑定登记所有精确键和前缀键。响应 body 中提取到的 response id 在响应完成后登记到同一绑定。

绑定超过 24 小时未使用时惰性清理，并由每 5 分钟一次的清理任务回收；每组最多保留 4096 条绑定，超出后按 `lastSeenAt` 淘汰。每个前缀桶还受 `MAX_BUCKET_SIZE` 限制，桶内淘汰不应影响其他桶。组、节点或模型 pattern 重新配置时，只清理失效节点和失效组的绑定，其他绑定保留。

落地说明（LB-03）：

- 入口是 `src/proxy/load-affinity.ts` 的 `LoadAffinityTable`：`lookup`、`bind`、`rebind`、`attachResponseIds`、`remove`、`pruneTargets`、`clear`、`sweepExpired`、`snapshot`。
- 绑定只存 kind、endpoint、model、`boundaryWithoutUser` 和 `userHashes`。上面 `Binding` 草图中的 `contentFingerprint` 没有存入：桶内判定只看用户哈希前缀，存指纹不会改变结果，只会多占内存。
- 桶键是 `hash(kind, model, boundaryWithoutUser)`。同模型同边界的 task 同桶，不同边界或不同模型自然分开。
- endpoint 规则与 matcher 一致：存下的 endpoint 为空时任何 endpoint 都兼容，否则必须相等。
- 精确键被别的 task 抢走时只摘键，不删绑定。原 task 仍能从自己的桶找回原节点，亲和不会因为键被抢而丢失。
- `bind` 默认不把绑定改到新 target；只有失败切换传 `allowRebind: true`。这是 LB-05 的接口。
- 全局淘汰在超限时线性扫描全表，扫描上限就是 4096。实测 4097 次绑定约耗时 170 ms。
- `test-node/proxy/load-affinity.test.ts` 共 20 例，覆盖 LB03-01 到 LB03-07，包括真实 4096 上限和“请求原文不得进入亲和状态”的断言。

路由判定必须是日志 `TaskMatcher` 在**共享运行时证据**上的超集。对于当前数据面不能产生的 `record.prompt_cache_key` 和 `record.client_metadata`，只能保留 matcher 的历史兼容行为，不能把它们计入路由契约。这样即使路由把两个独立 task 合并到同一节点，也只是流量略偏；如果路由比共享 matcher 证据更严格，就可能把同一个历史 task 分到两个节点，破坏 KV 亲和。共享纯函数和集成测试共同保证这一方向。

## 8. 新 task 的节点选择

### 8.1 节点状态

每个节点维护：

```ts
interface LoadBalancerNodeState {
  targetId: string;
  enabled: boolean;
  inFlight: number;
  lastDispatchedAt: number | undefined;
  failures: number;
  cooldownUntil: number | undefined;
  sample: LoadSample | undefined;
}

interface LoadSample {
  sampledAt: number;
  running: number;
  waiting: number;
  kvUsage: number | undefined;
  source: string;
  awake?: boolean; // 只有 vLLM 报这个
}
```

`inFlight` 在选择成功后立即增加，在响应结束、客户端中止或上游异常时通过 `finally` 释放。它覆盖整个上游响应生命周期，包括长时间 SSE decode。

落地说明（LB-08）：

- `LoadMonitor` 是唯一碰定时器的人。一个 `setInterval` 每 5 秒采一次样，亲和清理只在过了 5 分钟时才跑。
- 定时器 `unref()`。负载均衡永远不能把进程吊住。`stop()` 清掉定时器，也清掉采样中和失败中的状态。
- 直接复用 `fetchTargetMetrics`，认证、base path 和根路径回退跟管理页的 metrics 视图完全一样。超时 4 秒。
- 节点上只存数字。metrics 原文、API key 和请求 body 都不进监视器状态。
- 一个 canonical key 只发一次 HTTP 请求。同一块 GPU 的两种拼法采一次，两边共用数字。
- 失败日志只在某个 key 开始失败时记一条，恢复时记一条，不是每个 tick 都刷。
- running、waiting、KV 三个都没解析出来时清空节点样本。没测过的节点只看 `inFlight`，绝不拿臆造的 0 当负载。
- vLLM 睡眠：`vllm:engine_sleep_state` 里 `sleep_state="awake"` 为 1 是醒着，别的状态出现 1 就是睡了。睡眠判断只在样本没过期为时有效。
- 真机验证：`http://127.0.0.1:9393/v1` 和 `9394/v1` 走根路径 `/metrics` 回退，12–28 毫秒返回，解析出 vLLM 的 running、waiting、KV。

### 8.2 `least_load`

候选节点先过滤掉禁用节点和仍在冷却中的节点。如果所有节点都在冷却，则使用全部启用节点，保证短暂故障不会永久拒绝服务；失败请求仍会再次更新冷却状态。

对每个候选节点计算：

```text
kvTier = freshSample.kvUsage >= 0.9 ? 1 : 0
metricLoad = freshSample ? freshSample.running + freshSample.waiting : 0
load = max(inFlight, metricLoad)
```

按以下升序排序：

```text
kvTier
load
lastDispatchedAt
freshSample.kvUsage（缺失视为 1）
组内配置顺序
```

指标缺失或过期时，`load` 只使用 `inFlight`；缺失的 KV 指标不会把节点错误地判定为高压。`lastDispatchedAt` 使两台节点其他条件相同且都空闲时自然交替，但不会压过真实负载。

`running` 已经包含引擎看到的代理请求，因此不把 `inFlight` 和 `running` 相加。使用 `max` 可以同时覆盖指标采样延迟和指标已经包含本地请求的情况。

### 8.3 `round_robin`

该策略仍然遵守 task 亲和和故障冷却，但新 task 不使用 `/metrics` 和 KV 分档，只按 `lastDispatchedAt` 选择最久未分派的节点。它用于没有可靠指标端点、或用户明确需要严格交替的部署。

### 8.4 复杂度

节点选择不查数据库、不等待网络请求。常规两节点部署中，单次选择包含一次已有请求解析、有限数量的哈希、最多 16 条桶扫描和一次节点线性排序。指标请求完全由后台监视器执行。

v1 不根据 prompt 长度估算 token，也不对异构 GPU 做权重。长 prompt 和异构节点的精细负载模型属于后续版本。

落地说明（LB-05）：

- `LoadBalancer.matchGroup` 按配置顺序返回第一个启用且模式匹配的组。模式匹配复用 `modelPatternMatches`，所以组模式和普通 `model_mappings` 的行为一致。
- `plan()` 同步完成查找、建绑和预留。记录的 `load` 是选中节点在选择前的负载，不含本次刚刚增加的预留。
- 亲和命中可以使用处于冷却或睡眠的节点；新 task 不会去那种节点。把会话搬走的代价高于多等一会儿。
- `release()` 只减一次。客户端中止和 `finally` 同时到达也不会把计数减成负数。
- `markDispatched()` 在向下游发前先调，所以连续同步到达的新 task 能正确交替。
- pipeline 命中组后 `upstreamModel` 等于请求模型，成员 mapping 不生效。`model_route` 增加 `route_mode: "load_balance"` 和短的 `load_balance` 对象；逐候选明细只留在运行时状态里。
- 响应写完后把 response id 补到绑定上；预留的释放在 `finally` 里，覆盖成功、上游异常和客户端中止。
- 没有可用节点时抛 `LoadBalancerExhaustedError`，pipeline 回 503 带 `retry-after`。 `no_healthy_node` 的记录由 LB-07 补上。
- 当前偏差：runtime registry 传的 `loadSamples` 还是 `EMPTY_LOAD_SAMPLES`，LB-08 接上真实采样后才有 `running`/`waiting`/`kvUsage`。

## 9. 上游指标采样

### 9.1 采样规则

每个 pair 为被启用组引用的节点建立一个 `LoadMonitor`。默认每 5 秒采样一次，单次超时 4 秒，同一节点不会有重叠请求。定时器必须 `unref()`，pair 停止时必须清理。

采样复用现有 `fetchTargetMetrics` 的认证、base path 和根路径回退能力。对当前 vLLM、SGLang 和 llama.cpp 支持集中在别名表中：

| 语义 | vLLM | SGLang | llama.cpp |
| --- | --- | --- | --- |
| running | `vllm:num_requests_running` | `sglang:num_running_reqs` | `llamacpp:requests_processing` |
| waiting | `vllm:num_requests_waiting` | `sglang:num_queue_reqs` | `llamacpp:requests_deferred` |
| KV 占用 | `vllm:kv_cache_usage_perc`，回退 `gpu_cache_usage_perc` | `sglang:token_usage` | `llamacpp:kv_cache_usage_ratio` |

同一指标有多个 label set 时求和。`NaN`、`Inf`、负数和无法解析的文本视为缺失。vLLM 的 sleep 状态如果明确表示引擎不处于 awake 状态，则该节点不参与新 task 选择。

### 9.2 新鲜度和失败

采样超过 15 秒视为过期。过期采样不参与负载和 KV 分档，但不会直接禁用节点。采样失败只记录一次进入失败和一次恢复日志，避免后台日志刷屏；转发仍然可用。

状态 API 中：

- `metrics: null` 表示未启用、尚未成功、采样失败或已过期；
- `source` 表示使用的引擎指标族；
- `sampled_at` 用于界面显示新鲜度；
- 采样状态不能包含 API key、请求 body 或完整指标原文。

## 10. 失败处理

### 10.1 连接期失败切换

仅以下条件同时满足时切换：

- 错误属于连接或建立响应期错误，例如 `ECONNREFUSED`、`ECONNRESET`、`EHOSTUNREACH`、`ENETUNREACH`、DNS 失败或连接超时；
- 上游响应头尚未交给客户端；
- 组启用了 `failover_enabled`；
- 组内仍有其他可用节点。

处理顺序：

1. 释放失败节点的 inFlight 预留；
2. 增加失败计数并进入指数冷却，最长 60 秒；
3. 排除失败节点重新选择一次；
4. 释放旧绑定并把当前 task 重新绑定到成功节点；
5. 更新 request route 元信息，写入 `decision: "failover"` 和 `failover_from`；
6. 不再链式重试。

上游已经返回 4xx/5xx 时不切换，因为这通常是模型、请求或认证错误。响应头或首字节已经发送后绝不切换，否则会造成响应内容混杂。客户端中止和上游异常都必须执行最终释放，避免 inFlight 永久增加。

落地说明（LB-07）：

- `ProxyRequestPipeline.#tryFailover` 只跑一次：连接期错误 + 未发响应头 + 组启用 failover + 组内还有可用节点。
- `markFailure` 指数冷却，上限 60 秒；上游连上了就调 `noteSuccess`，清掉失败计数和冷却。
- 客户端走开不算节点的错：`signal.aborted` 时不记失败，也不冷却。
- `plan` 的 `exclude` 同时屏蔽亲和命中。不然重选会直接被刚绑到死节点的绑定拉回去，切换等于没发生。
- 切换成功后重写 record 的 `target` 块和 `model_route`：`decision: "failover"`、`failover_from` 和新的 `target_id`。pricing 快照里的 target 名字保持原样，因为组内价格已经校过一致。
- 无可用节点时回 503，并往组内第一个配置节点的日志库写一条 `request_finished`，带 `decision: "no_healthy_node"`、错误原因和 `logged_by`。流量日志按 target 存储，没别的库可写。组里一个配置节点都没有时没有日志库可用，只剩 503。

### 10.2 无可用节点

如果组没有启用节点，或组匹配成功但没有可选择的节点，返回 HTTP 503，并写入一条带错误原因的 `request_finished` 记录。不能回落到普通 `model_mappings` 或 pair 默认 target。

## 11. 可观测性

### 11.1 路由记录

不新增数据库列，在现有 `request.model_route` JSON 中追加：

```json
{
  "requested_model": "Qwen3.8-Flash-Next",
  "upstream_model": "Qwen3.8-Flash-Next",
  "target_id": "target-9394",
  "target_name": "GPU-2",
  "route_mode": "load_balance",
  "load_balance": {
    "group_id": "lb-qwen-dual",
    "group_name": "Qwen x2",
    "decision": "new_task",
    "strategy": "least_load",
    "load": 0,
    "kv_usage": 0.18,
    "metrics_source": "vllm",
    "failover_from": null
  }
}
```

`decision` 至少包括：

- `new_task`：新建绑定并按负载选择；
- `affinity`：命中已有绑定；
- `failover`：连接期失败后重新绑定；
- `no_healthy_node`：组匹配成功但无法选择节点，并返回 503。

组被禁用或请求没有匹配任何启用组时，不写 `load_balance` 对象，直接使用现有普通路由并保留既有的 route metadata 语义。

记录中只保存短字段和数值，不保存完整候选列表、用户内容、认证信息或完整亲和键。`model_route_json` 参与 FTS 搜索，因此逐候选明细和长字符串只能存在于运行时状态或调试日志中。

### 11.2 状态 API

新增只读接口：

```text
GET /api/load-balancer/status
```

返回结构：

```json
{
  "pairs": [
    {
      "pair_id": "default",
      "running": true,
      "groups": [
        {
          "id": "lb-qwen-dual",
          "name": "Qwen x2",
          "model_pattern": "Qwen3.8-Flash-Next",
          "strategy": "least_load",
          "bindings": 3,
          "nodes": [
            {
              "target_id": "target-9393",
              "name": "GPU-1",
              "enabled": true,
              "in_rotation": true,
              "in_flight": 1,
              "bindings": 2,
              "failures": 0,
              "cooldown_until": null,
              "last_dispatched_at": "2026-10-13T10:00:00+08:00",
              "metrics": {
                "sampled_at": "2026-10-13T09:59:58+08:00",
                "running": 1,
                "waiting": 0,
                "kv_usage": 0.42,
                "source": "vllm"
              }
            }
          ]
        }
      ]
    }
  ]
}
```

接口只读取内存，不做数据库或上游网络请求。服务存在时注册路由；没有负载均衡服务时保持既有的 404 约定。路由装配必须加入 `test-node/app/runtime.test.ts` 的 assembled-app 冒烟测试。

## 12. 管理 UI

### 12.1 结构

负载均衡区放在每个 pair 的 target 卡片下方。每张组卡片包含：

- 组名、启用开关、删除按钮；
- 请求模型 pattern；
- 本 pair target 的勾选列表；
- `least_load` / `round_robin` 选择；
- 指标采样和失败切换开关；
- 匹配预览输入框；
- 每个节点的启用状态、inFlight、waiting、KV、绑定数和冷却状态；
- 模型一致性校验按钮和结果。

v1 不在卡片上展示 β、spill、父子 session 选择、TTL、容量和复杂负载权重。模型 pattern 重叠时按配置顺序显示警告。

被组引用的 target 的模型映射区域显示“该模型由负载均衡组接管”的提示，但仍保留原字段。取消引用后，原模型映射恢复普通作用。

### 12.2 状态刷新与持久化

proxy 页面可见时每 2 秒请求一次状态接口，页面不可见时停止轮询。状态更新只替换数字和状态文本，不整块重绘组卡片，避免打断输入框、焦点和拖拽。

组卡片展开状态和内部 details 状态放在 `localStorage`，不能写进 pair 配置。配置保存只收集真实的 `load_balancers` 字段；zod 往返不会因为 UI 私有字段而改变配置。

删除 target 时，前端同步从组成员列表中删除该 target；后端仍然执行完整 schema 校验，不能依赖前端清理保证正确性。

### 12.3 视觉基线

UI 修改必须：

1. 重录中文和英文代理页基线；
2. 检查完整尺寸图片，确认英文无中文、节点列表无截断；
3. 更新视觉基线文档中的完整 SHA-256；
4. 对未修改的其他页面确认像素差为 0；
5. 运行 `npx prettier --check .`。

## 13. 测试计划

### 13.1 单元测试

- `task-identity`：四类 endpoint 的边界和消息投影、精确键、response 链、前缀增长、相同请求重试、空 body、非 JSON body、工作上限、运行时可达字段与 matcher 兼容 fallback 的边界；
- `load-affinity`：命中刷新、TTL、LRU、节点删除、组删除、桶扫描限制、单桶 `MAX_BUCKET_SIZE` 淘汰、response id 回填；
- `load-balancer`：组匹配顺序、同步预留、亲和优先、KV 分档、`max(inFlight, running + waiting)`、采样过期、冷却、全冷却降级、两种策略、canonical node key；
- `load-metrics`：vLLM/SGLang/llama.cpp 别名、多 label 求和、缺失指标、非法数值、sleep 状态和非 Prometheus 响应；
- `load-monitor`：采样不重叠、超时、过期、关闭后无定时器；
- 配置：默认空数组、未知 target、重复 id、重复成员、重复 pattern、日志目录不一致、价格规则不一致、单节点组、默认值；
- 记录：`model_route` 的嵌套结构、短字段限制、失败切换信息和禁用组不写 `load_balance`；
- pricing：组内 target 价格快照一致、全为空的明确不计费组、缺失价格规则被拒绝。

### 13.2 pipeline 集成测试

使用两个 stub 上游和真实 pipeline 覆盖：

1. 四个新 task 在两节点间按负载交替或按最少负载分布；
2. 同一个 chat 会话持续增长时始终命中原节点；
3. Responses 的 `previous_response_id` 后续请求命中原节点；
4. 组成员存在冲突的模型映射时，上游收到原始请求模型；
5. 连接期失败切换一次，下一条同 task 请求固定到新节点；
6. 上游已经发出响应头后断开时不切换；
7. 组内无可用节点返回 503，并写入错误记录；
8. 客户端中止和上游异常后 inFlight 回到 0；
9. `reloadPair()` 后绑定仍然存在；
10. 删除或禁用节点后只清理相关绑定；
11. pair 停止后监视器和定时器全部关闭；
12. 多 target 请求在 body 读取前没有持久化 record，选路后的 `request_received` 能被 `?ids=` 批量接口取到；
13. 失败切换后 pricing snapshot 与原节点一致。

### 13.3 管理 API 和 UI 测试

- `PUT /api/pairs` 的配置往返；
- 非法节点、日志目录和价格规则错误的路径定位；
- `GET /api/load-balancer/status` 的空状态、过期指标、冷却节点和多 pair 结构；
- 模型校验接口的成功、模型不存在、上游不可达；
- 新增组、勾选节点、保存、刷新后恢复；
- 删除 target 后组引用同步清理；
- 中英文案和英文视觉基线；
- proxy 页状态刷新不会重建输入框。

### 13.4 真实环境验收

使用独立测试实例或只读方式验证，不修改用户正在运行的实例：

1. 开启均衡组后，9394 的真实请求和 token 计数开始增长；
2. 同一会话的所有记录 `target_id` 相同；
3. 四个并发新会话能根据 inFlight 和 `/metrics` 分布到两张卡；
4. 停止其中一个引擎后，新请求最多经历一次连接失败并切换成功；
5. 任务历史中能看到 `decision: "failover"` 和来源节点；
6. 保存无关配置后，活跃会话仍回到原节点；
7. 读取 `/metrics` 时确认指标根路径和 API key 处理正确；
8. 通过实际 prefix cache 命中和 prefill 指标确认亲和带来的效果。

## 14. 分阶段实施

### P1：配置、核心路由和最小 UI

- schema、normalizer、日志目录和价格规则校验以及配置往返；
- `task-identity` 与 `TaskMatcher` 共享运行时可达投影，明确 legacy fallback 边界；
- 精确键、边界和有界前缀亲和，包含单桶容量限制；
- canonical node key 和 targetId 的身份边界；
- `least_load`、`round_robin`、同步预留、跨 reload 绑定；
- pipeline 接线、request_received 时序和 `model_route` 记录；
- 负载均衡组 UI、i18n 和基础测试；
- 命中组无节点时的 503 和一次失败切换。

验收重点是 R1、R3、R4、R7，以及关闭负载均衡后既有路由行为完全不变。

### P2：负载指标和运行时观测

- Prometheus 指标解析和后台采样；
- KV 分档、指标新鲜度、冷却状态；
- `/api/load-balancer/status`；
- UI 实时负载、模型一致性校验和代理页视觉基线；
- vLLM、SGLang 和 llama.cpp 兼容测试。

### P3：上线验证与文档收尾

- 两个真实节点的协议级验证；
- 真实流量下的 task 粘性、故障切换和 KV 命中验证；
- README、软件功能说明书和 ADR 同步；
- `npm run check`、UI 基线检查和 portable 构建。

## 15. 已知限制与后续版本

### 15.1 进程重启丢失亲和

v1 只保存内存绑定。引擎未重启而代理重启时，活跃会话的下一条请求可能换节点并重新 prefill。后续版本可以利用共享日志目录中的 `context_links` 和最后一条 `records.target_id` 做一次性回填，但必须先解决数据库只读连接生命周期、历史记录竞争和错误匹配问题，不能直接把数据库查询放进每个请求的热路径。

### 15.2 prompt 长度和异构节点

v1 把一个长 prompt 和一个短 prompt 都计为一次在途请求，也不提供 GPU 权重。后续可在已有指标稳定后加入受限的 prompt 大小估算和显式 `weight`，并通过实际吞吐验证，而不是仅凭字符数推断。

### 15.3 KV 饱和迁移

v1 只对新 task 避开 KV 高压节点，不迁移已有 task。后续如果要支持 spill，必须把它作为显式策略，并证明迁移后不会在新旧节点之间抖动；默认仍应关闭。

### 15.4 更精细的缓存感知

v1 不订阅 KV event、不建立字符级 radix tree，也不使用 β 打分。引擎没有提供可靠的跨节点 KV 状态时，代理只能把 task 亲和作为缓存复用的近似。后续需要新的引擎或控制器能力后再评估。

### 15.5 同构请求碰撞

没有稳定 session 标识且边界、首条用户消息完全相同的两个独立请求，可能共享一个绑定。该退化只会降低新 task 的分散程度，不会把同一 task 拆到多个节点。需要严格区分时，应使用客户端 session 标识或 response 链。

## 16. 最终验收标准

实现完成后必须同时满足：

- 关闭所有负载均衡组时，现有路由和日志行为不变；
- 同一 task 在正常情况下不会跨节点；
- 新 task 的选择能看到代理在途和新鲜的上游指标；
- 组内模型映射不会改写命中组的请求模型；
- 组内 target 的价格规则一致，失败切换不造成 pricing snapshot 漂移；
- 连接期故障只重试一次，响应开始后绝不切换；
- 组内无可用节点返回 503，不绕过组；
- 多 target 的 pending 记录时序和 `?ids=` 刷新行为符合文档；
- 前缀桶受独立容量上限约束；
- 配置 reload 不会清空仍有效的亲和绑定；
- 日志能解释每次新建绑定、亲和命中和失败切换；
- 状态 API 不泄露请求内容和认证信息；
- UI 中英文、配置往返、视觉基线和 assembled-app 路由测试全部通过；
- `npm run check` 和项目要求的 portable 构建通过。
