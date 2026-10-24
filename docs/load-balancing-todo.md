# 多节点负载均衡开发 TODO

创建日期：2026-10-22。当前进度：9 / 13 项完成。

设计依据：[多节点负载均衡设计（粘性任务路由 v1）](./load-balancing-design.md)。决策记录：[ADR-013](./adr/013-load-balancing-sticky-routing.md)。本清单供后续开发、测试、验收和逐项提交使用。设计发生变化时，必须同时更新设计文档和本清单，不能只改代码。

## 1. 执行规则

按依赖顺序实施。依赖未完成时，后续任务不能标记为完成。每个任务是一个可独立验证的提交单元，允许在同一任务内修复测试发现的问题，但不要把多个任务攒到最后一次提交。

每项任务必须完成以下闭环：

1. 将进度表中的任务改为“进行中”，实现功能和对应自动化测试。
2. 测试正常路径、边界和失败路径。修复问题时先添加能复现问题的回归测试。测试验证外部行为，不能只匹配源码字符串，也不能调用被测函数生成期望值。
3. 运行本任务相关的单元、集成、类型和构建检查，记录实际命令、结果以及测试文件或用例名称。测试未运行、被跳过或失败时，不能标记完成。
4. 更新本清单的任务状态、验收记录和相关设计文档。说明实际行为、迁移影响和任何设计偏差；没有偏差也要写明。
5. 改动 UI 的任务必须在该任务提交前运行 `npm run regen:ui-baselines`，更新代理页中英文基线及 `docs/refactoring/ui-visual-baseline.md` 的完整 SHA-256，并检查完整图片和英文文案。
6. 检查本次 diff，只提交本任务的代码、测试、文档和必要截图。提交标题包含唯一任务 ID，例如 `feat(load-balancing): [LB-01] add group configuration`。
7. 提交成功后使用 `git show --stat HEAD` 核对内容，并记录实际提交 SHA。提交失败时任务仍未完成。
8. 每个任务完成后确认没有遗留定时器、临时数据库、临时 `.mts`、浏览器进程或其他临时文件。

本项目要求在任务完成后执行 portable 构建：

```text
npm run build
npm run rebuild:electron
npx electron-builder -w portable --publish never
```

`npm run build` 会先重建 Node ABI。执行 `npm run rebuild:electron` 后不要再运行 Node 侧的 `npm rebuild better-sqlite3`，也不要在 Electron ABI 状态下运行需要普通 Node ABI 的测试。若需要运行 Node 测试，应在 Electron 重建前完成，或重新执行项目规定的 ABI 顺序。

## 2. 必须保持的产品约束

- 负载均衡组只属于一个 proxy pair，不跨 pair 合并负载。
- 同一 task 命中亲和绑定后直接回原节点，不因为其他节点更空闲而迁移。
- 只有新 task 才使用负载排序；v1 不做 spill、弱亲和、`balance_only`、β 评分或 prompt 长度加权。
- v1 只提供 `least_load` 和 `round_robin` 两种策略。
- `least_load` 的排序顺序固定为：KV 分档、`max(inFlight, running + waiting)`、最近分派时间、KV 占用、组内配置顺序。
- `/metrics` 采样失败或过期时退化到代理侧 inFlight，不影响普通转发。
- 命中组但没有可用节点时返回 503，不回落到普通 `model_mappings` 或 pair 默认 target。
- 连接期错误只允许在响应头和响应字节发送前切换一次；4xx/5xx 不触发切换；响应开始后绝不切换。
- 负载均衡组成员必须属于同一个 pair，并使用相同的解析后 `log_root`。
- 负载均衡组成员的完整 `model_prices` 规范化后必须一致；所有成员都为空才表示明确不计费。
- 命中组后屏蔽成员的 `model_mappings`，上游模型名使用请求原始模型名；其他 target 配置继续生效。
- 亲和绑定挂在 pair runtime entry 上，`reloadPair()` 不能清空有效绑定。
- 亲和使用 `targetId`；URL 身份用于采样或物理节点汇总时必须使用 canonical node key。
- 每个前缀桶最多 32 条绑定，全局每组最多 4096 条绑定；查找最多扫描 16 条。
- `TaskMatcher` 的运行时共享契约只包含请求 body、请求 headers、kind、endpoint、模型和边界投影；`record.prompt_cache_key` 与 `record.client_metadata` 只能作为历史兼容 fallback。
- 多 target/LB 请求在完整 body 和选路完成前没有数据库 record；`?ids=` 批量刷新只能读取已经持久化的 record。
- v1 不增加 traffic database schema，不做代理重启后的亲和回填。

## 3. 进度总表

状态填写“未开始 / 进行中 / 待验收 / 完成”。完成时勾选复选框，并在第 5 节追加执行记录。

| 完成 | ID | 任务 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [x] | LB-01 | 配置 schema、normalizer 和 pair 校验 | 无 | 完成 |
| [x] | LB-02 | 共享 task identity 与 matcher 边界 | LB-01 | 完成 |
| [x] | LB-03 | 亲和表与桶容量限制 | LB-02 | 完成 |
| [x] | LB-04 | canonical node key 与 runtime 生命周期 | LB-01 | 完成 |
| [x] | LB-05 | 新 task 选路与 pipeline 预留 | LB-02、LB-03、LB-04 | 完成 |
| [x] | LB-06 | request_received 时序与 pricing 一致性 | LB-01、LB-05 | 完成 |
| [x] | LB-07 | 连接期失败切换与 503 | LB-05、LB-06 | 完成 |
| [x] | LB-08 | 上游 metrics 采样与负载快照 | LB-04、LB-05 | 完成 |
| [x] | LB-09 | 路由记录与状态/模型校验 API | LB-05～LB-08 | 完成 |
| [ ] | LB-10 | 管理 UI、i18n 和视觉基线 | LB-01、LB-08、LB-09 | 未开始 |
| [ ] | LB-11 | 端到端、reload、pending 和价格回归 | LB-02～LB-10 | 未开始 |
| [ ] | LB-12 | 真实节点验收与性能检查 | LB-11 | 未开始 |
| [ ] | LB-13 | 文档收尾、全量检查和交付构建 | LB-12 | 未开始 |

## 4. 逐项实施与验收

### LB-01：配置 schema、normalizer 和 pair 校验

实现功能：

- 在 `src/config/config-schema.ts` 为 `proxyPairSchema` 增加 `load_balancers`；
- 实现 `id`、`name`、`enabled`、`model_pattern`、`node_target_ids`、`strategy`、`metrics_enabled` 和 `failover_enabled`；
- 在 `src/config/config-normalizer.ts` 补齐缺失 id、name 和默认字段；未知 target ID 不得被静默删除；
- 在 `superRefine` 中校验组 id、成员 id、组 pattern、pair 归属、日志目录和价格规则；
- 允许单节点组，并返回 UI 可显示的提示；
- 保持旧配置缺少 `load_balancers` 时的行为不变；
- 组成员的解析后 `log_root` 必须一致；所有成员为空时表示明确关闭日志；
- 组成员完整 `model_prices` 规范化后必须一致。规范化至少保留规则顺序、pattern 和四种价格字符串；
- 不修改 Fastify pairs schema 的既有兼容行为，确认新增字段不会被接口层剥掉。

测试用例：

- `LB01-01`：旧配置加载后 `load_balancers` 为 `[]`，保存和重新加载不改变其他字段；
- `LB01-02`：组 id 重复、target id 重复、未知 target、跨 pair target、重复 pattern 都返回带具体路径的错误；
- `LB01-03`：单节点组通过校验；禁用节点可以保存但运行时不轮转；空成员拒绝；
- `LB01-04`：解析后 `log_root` 不一致拒绝，空日志组全部为空才通过；
- `LB01-05`：成员价格数组顺序、pattern 或价格字符串不一致时拒绝；全部为空时通过；
- `LB01-06`：部分重叠 pattern 可以保存，并产生 UI 警告；完全相同 pattern 拒绝；
- `LB01-07`：配置往返确认 `strategy`、开关和 target 顺序没有丢失。

测试落点：扩展 `test-node/config/config-schema.test.ts`、`config-normalizer` 相关测试、`test-node/admin/pairs.test.ts` 和 `test-node/proxy/proxy-manager-apply.test.ts`。

验收标准：配置 API 往返通过；未知值不被静默吞掉；校验路径准确；旧配置回归通过。提交定位：`[LB-01]`。

### LB-02：共享 task identity 与 matcher 边界

实现功能：

- 新增 `src/proxy/task-identity.ts`；
- 抽取 kind、endpoint、model、request boundary、user message 和 continuation 的纯投影；
- 提供 `requestContextKeys(payload, headers)`，供路由和 `TaskMatcher` 共用；
- 支持 `previous_response_id`、conversation/thread/session、`prompt_cache_key` 和现有 Claude session header；
- 不保存用户原文，只保存短哈希；
- 明确 `record.prompt_cache_key` 和 `record.client_metadata` 没有当前数据面生产者；可以保留 matcher 的历史/导入兼容 fallback，但路由不能依赖它们；
- 让“路由判定是 matcher 超集”只适用于共享的运行时可达证据；
- 对超大 body、超过 4096 条消息或过长消息列表设置有界处理，不能让身份提取在热路径无界增长。

测试用例：

- `LB02-01`：四类 endpoint 的 boundary 和 user message 投影与现有 matcher 一致；
- `LB02-02`：精确键优先级覆盖 response、conversation、session 和 prompt cache；
- `LB02-03`：Responses 后续请求只有 `previous_response_id` 和新 input 时仍能命中原 task；
- `LB02-04`：消息增长、内容分叉、相同 body 重试和静态边界变化分别得到正确结果；
- `LB02-05`：body 为空、非 JSON、超大 body 和消息数超限都有确定的降级结果；
- `LB02-06`：运行时请求 body/header 生成的 context key 被 matcher 和路由同时使用；
- `LB02-07`：使用 fixture 人工填充的 `record.prompt_cache_key` / `client_metadata` 只影响 matcher fallback，不会被路由假定为可用输入。

测试落点：新增 `test-node/proxy/task-identity.test.ts`，扩展 `test-node/logging/task-matcher.test.ts` 和相关 records 测试。

验收标准：共享投影没有第二套字段清单；运行时可达字段的 matcher 与路由语义一致；兼容字段边界在测试和文档中明确。提交定位：`[LB-02]`。

### LB-03：亲和表与前缀桶容量限制

实现功能：

- 新增 `src/proxy/load-affinity.ts`；
- 实现 exact key 索引、boundary prefix bucket、绑定创建、刷新、删除和重配置裁剪；
- 使用 `AFFINITY_TTL_MS = 24h`、`MAX_BINDINGS_PER_GROUP = 4096`、`MAX_BUCKET_SIZE = 32`、`MAX_BUCKET_SCAN = 16`；
- 每个前缀桶独立 LRU，单桶超过 32 条时只淘汰该桶最旧项；
- 全局 LRU 只在每组绑定超过 4096 条时工作；
- 保留 exact key 和 bucket 的反向索引，删除绑定时不能留下悬空 key；
- response id 在响应完成后登记到当前绑定；
- 节点、组或 pattern 被移除时只清理相关绑定；
- affinity hit 只刷新绑定，不能重新比较负载；
- 失败切换时释放旧绑定并重新登记新节点。

测试用例：

- `LB03-01`：exact key 命中、刷新时间和 targetId 正确；
- `LB03-02`：boundary bucket 命中、user hash 前缀匹配、消息增长和内容分叉正确；
- `LB03-03`：同一桶超过 32 条时按 LRU 淘汰，其他桶不受影响；
- `LB03-04`：全局超过 4096 条时按 LRU 淘汰，淘汰后 exact key 反向索引同步清除；
- `LB03-05`：bucket 扫描最多 16 条，不因桶内数据量增长而无界扫描；
- `LB03-06`：TTL 到期、组删除、节点禁用和节点移除只清除应清除的绑定；
- `LB03-07`：response id 回填、失败切换 rebind 和 reload 保留绑定。

测试落点：新增 `test-node/proxy/load-affinity.test.ts`。

验收标准：桶和全局容量都有独立上限；所有索引删除对称；没有用户请求内容进入绑定状态。提交定位：`[LB-03]`。

### LB-04：canonical node key 与 runtime 生命周期

实现功能：

- 新增 canonical node key 函数，不能直接把原始 target URL 作为物理节点键；
- 规范化 scheme、host 大小写、默认端口、IPv6 方括号、末尾斜杠和 base path；
- 在当前本地语义下将 `localhost` 与 `127.0.0.1` 归一；不同 base path 不合并，任意 DNS 名称不做强制 IP 合并；
- affinity 仍使用 pair 内稳定 `targetId`，canonical key 只用于指标采样、单飞和物理上游汇总；
- 在 `ProxyRuntimeEntry` 中添加 `LoadBalancer` 和 `LoadMonitor`；
- `startPair` 创建，`reloadPair` 原地 reconfigure，`stopPair` 清理；
- 旧 pipeline drain 时释放回调继续指向同一个 balancer；
- 不在 v1 引入跨 pair 共享负载账本。

测试用例：

- `LB04-01`：`http://localhost:9393/v1` 和 `http://127.0.0.1:9393/v1` 生成相同 canonical key；
- `LB04-02`：默认端口、IPv6、尾斜杠、大小写和不同 base path 的结果符合约定；
- `LB04-03`：两个不同 targetId 可以拥有独立 affinity，即使 canonical key 相同；
- `LB04-04`：start/reload/stop 的对象复用和清理行为正确；
- `LB04-05`：reload 后旧请求 release 不会计入新旧两份账本。

测试落点：新增 canonical key 单元测试，扩展 `test-node/proxy/proxy-runtime-registry.test.ts`。

验收标准：canonical identity 和 affinity identity 没有混用；reload 后绑定、inFlight 和监视器生命周期正确。提交定位：`[LB-04]`。

### LB-05：新 task 选路与 pipeline 预留

实现功能：

- 在 `src/proxy/load-balancer.ts` 实现组匹配和选择计划；
- 组按 pair 配置顺序匹配，第一个启用且匹配的组接管请求；
- `least_load` 按 `kvTier → load → lastDispatchedAt → kvUsage → configIndex` 排序；
- 使用 `load = max(inFlight, running + waiting)`；
- 新 task 在同步选择段中建立 binding 并增加 inFlight；
- affinity hit 不比较负载；
- `round_robin` 只使用冷却和最近分派时间，不使用 metrics/KV；
- 指标缺失时只使用 inFlight；
- 禁用节点和冷却节点不参与选择；全部节点冷却时使用启用节点作为最后降级；
- 只返回 targetId 和 release/complete 计划，不把完整 target 对象塞进 balancer；
- 未命中 LB 组时保持现有 `selectTargetByModel` 行为；
- 命中组时 upstream model 使用请求原始模型名。

测试用例：

- `LB05-01`：第一个匹配组生效，禁用组跳过，未命中组走旧路由；
- `LB05-02`：四个新 task 在平票时按 lastDispatchedAt 交替；
- `LB05-03`：inFlight、running、waiting、KV tier 和配置顺序分别影响正确的排序层级；
- `LB05-04`：running 已包含代理请求时不会把 inFlight 与 running 重复相加；
- `LB05-05`：连续同步选择不会把多个新 task 扎堆到同一节点；
- `LB05-06`：同一 task 命中 binding 时即使另一个节点更空闲也不迁移；
- `LB05-07`：round_robin 忽略 metrics/KV，但仍遵守 affinity 和 cooldown；
- `LB05-08`：客户端中止、上游异常和正常响应都会释放 inFlight；
- `LB05-09`：LB 命中时不会应用成员 target 的 model mapping。

测试落点：新增 `test-node/proxy/load-balancer.test.ts`，扩展 `test-node/proxy/routing.test.ts` 和 pipeline 测试。

验收标准：关闭 LB 后路由回归完全通过；新 task 选择、affinity 和 inFlight 计数符合设计；选择路径无数据库和网络 I/O。提交定位：`[LB-05]`。

### LB-06：request_received 时序与 pricing 一致性

实现功能：

- 保留单 target 在读取 body 前写 `request_received` 的既有行为；
- 明确多 target/LB 的第一条 record 只能在 body 读取、选路和 pricing freeze 后写入；
- `request_received` 和 `request_pending_response` 必须使用同一 record ID 和 selected target；
- 不把未知最终 target 的早期占位记录随意写进某个 target 日志库；
- 如果 v1 不实现 runtime pending registry，明确不承诺 body 读取期间的 `?ids=` 刷新；
- 通过选中 target 的 `model_prices` 冻结 pricing；
- 组成员价格配置必须在保存时已经校验一致；
- pricing snapshot 包含 targetId、targetName、匹配规则、价格和冻结时间；
- 失败切换后新 record 使用同一组等价价格规则，不出现无依据的 `unpriced`；
- 不修改 traffic database schema 和现有 body chunk 存储行为。

测试用例：

- `LB06-01`：单 target 仍在读 body 前写 `request_received`；
- `LB06-02`：多 target/LB 在读 body 前没有数据库 record；选路后 `request_received` 和 `request_pending_response` 都能写入；
- `LB06-03`：record 写入后 `GET /api/logs/records?ids=...` 能取到 body-free pending 行；body 列为空时仍可通过既有 detail/body loader 获取正文；
- `LB06-04`：selected target 的 pricing snapshot 写入 pending record，并在 finished 时复用；
- `LB06-05`：组内价格不一致无法保存；全部为空的组保持明确 unpriced 行为；
- `LB06-06`：同一 task 失败切换后，价格快照和费用状态不漂移。

测试落点：扩展 `test-node/proxy/proxy-listener.test.ts`、`test-node/admin/logs.test.ts`、`test-node/pricing/request-pricing.test.ts`、`test-node/logging/traffic-log-service.test.ts`。

验收标准：实现和测试明确区分“早期没有 record”和“body JSON 列为空”；没有向错误日志目录写占位记录；价格不会因 target 切换而无故丢失。提交定位：`[LB-06]`。

### LB-07：连接期失败切换与 503

实现功能：

- 识别 `ECONNREFUSED`、`ECONNRESET`、`EHOSTUNREACH`、`ENETUNREACH`、DNS 失败和连接超时等连接期错误；
- 只有响应头/字节未发送时才能 failover；
- 失败节点递增 failure，使用指数 cooldown，最长 60 秒；
- 释放旧 reservation，排除失败节点重选一次；
- 成功后把 task binding 更新到新节点；
- 不链式重试；4xx/5xx 不切换；响应开始后不切换；
- 组匹配成功但没有可用节点时返回 503，不回落到普通 mapping/default target；
- `no_healthy_node` 记录错误原因和 group 信息；
- 所有异常路径都释放 inFlight。

测试用例：

- `LB07-01`：连接拒绝时一次切换成功，客户端只收到一次响应头和一份 body；
- `LB07-02`：两节点都失败时不链式重试，返回 502/503 的既定错误语义；
- `LB07-03`：上游返回 4xx/5xx 不触发切换和 cooldown；
- `LB07-04`：响应头已发送后断开不切换；
- `LB07-05`：失败切换后同 task 下一请求固定到新节点；
- `LB07-06`：全部节点禁用、全部节点不可选和组内无节点分别返回 503；
- `LB07-07`：失败、超时、客户端中止后 inFlight 和 cooldown 状态符合预期。

测试落点：扩展 `test-node/proxy/proxy-listener.test.ts`、upstream forwarder 测试和新的 LB pipeline 集成 fixture。

验收标准：只允许一次安全切换；没有响应混杂；无健康节点不绕过组；失败状态在状态 API 和路由记录中可见。提交定位：`[LB-07]`。

### LB-08：上游 metrics 采样与负载快照

实现功能：

- 新增 `src/proxy/load-metrics.ts` 和 `src/proxy/load-monitor.ts`；
- 复用 `fetchTargetMetrics` 的认证、base path 和根路径回退；
- 支持 vLLM、SGLang 和 llama.cpp 的 running/waiting/KV 指标别名；
- 多 label set 求和；NaN、Inf、负数、HTML 和非法 exposition 视为缺失；
- 支持明确的 vLLM sleep 状态，sleep 节点不参与新 task 选择；
- 默认 5 秒采样、4 秒超时、15 秒过期；同一 canonical node key 不能并发采样；
- 采样定时器 unref，pair stop 时清理；
- 采样失败只影响负载精度，不影响普通转发；
- 监视器只能保留解析后的短快照，不能保留完整 metrics 原文、API key 或请求 body。

测试用例：

- `LB08-01`：vLLM/SGLang/llama.cpp 指标别名解析；
- `LB08-02`：多 model/engine label 求和；
- `LB08-03`：missing、NaN、Inf、负数、HTML、截断响应和非法文本降级；
- `LB08-04`：sleep 状态和过期状态；
- `LB08-05`：canonical node key 相同的 target 不重复采样；
- `LB08-06`：请求超时、采样不重叠、失败恢复日志和 close 清理；
- `LB08-07`：metrics 缺失时 `least_load` 只使用 inFlight，普通转发仍成功。

测试落点：新增 `test-node/proxy/load-metrics.test.ts`、`load-monitor.test.ts`，扩展 `target-metrics` 测试。

验收标准：metrics 采样完全在后台；过期/失败不阻断转发；状态快照没有敏感数据；真实 9393/9394 的根路径采样验证通过。提交定位：`[LB-08]`。

### LB-09：路由记录、状态 API 和模型校验 API

实现功能：

- 在现有 `request.model_route` 中写入 `route_mode: "load_balance"` 和短字段 `load_balance`；
- decision 只使用 `new_task`、`affinity`、`failover` 和 `no_healthy_node`；
- 组被禁用或未匹配时不写 `load_balance`，继续使用普通路由 metadata；
- 不写候选列表、用户内容、API key 或完整 affinity key，避免污染 FTS；
- 新增 `GET /api/load-balancer/status`，只读内存，不做数据库/上游 I/O；
- 返回 pair、group、binding 数、节点 inFlight、失败/cooldown、last dispatch 和 metrics 快照；
- 新增 `POST /api/load-balancer/verify-models`，读取组内节点模型列表并返回匹配结果；
- 服务缺失时遵守既有可选服务 404 约定；
- 在 `test-node/app/runtime.test.ts` assembled-app smoke 中加入新路由存在性和响应形状断言。

测试用例：

- `LB09-01`：new task、affinity、failover、no healthy node 的 record 结构；
- `LB09-02`：禁用组和普通路由不产生 `load_balance` / `fallback_disabled`；
- `LB09-03`：状态 API 返回空组、多个 group、过期 metrics、cooldown 节点和多 pair；
- `LB09-04`：状态接口不触发数据库或上游请求，不泄露请求内容和认证信息；
- `LB09-05`：模型校验 API 对成功、模型不存在、上游 404/超时、不同 base path 返回明确结果；
- `LB09-06`：assembled app 路由注册和可选服务缺失 404。

测试落点：扩展 `test-node/admin/logs.test.ts` 或新建 LB admin service 测试，扩展 `test-node/app/runtime.test.ts`。

验收标准：历史 record 可解释路由；状态接口稳定且只读；禁用组没有伪造的 fallback decision；API schema 和装配测试通过。提交定位：`[LB-09]`。

### LB-10：管理 UI、i18n 和视觉基线

实现功能：

- 在每个 pair target 卡片下增加负载均衡组区域；
- 支持新增/删除组、组名、模型 pattern、启用、策略、metrics、failover 和 target 勾选；
- 只显示当前 pair 的 target；单节点组显示无法均衡提示；
- target 被组接管的模型映射显示说明但不删除字段；
- 提供匹配预览和模型一致性校验按钮；
- 展示节点 enabled、inFlight、waiting、KV、bindings、cooldown 和指标来源；
- proxy 页面可见时轮询 status，不可见时停止；只更新状态文本，不整块重绘输入控件；
- UI 私有展开状态使用 localStorage，不写配置；
- 删除 target 时同步清理组引用，同时依赖后端校验兜底；
- 中英文翻译完整，英文基线不能出现中文；
- 避免复用会继承统计页样式的通用类，检查 `<header>`、`<dialog>`、输入宽度和窄布局。

测试用例：

- `LB10-01`：新增组、勾选两个 target、保存、刷新后配置和勾选保持；
- `LB10-02`：单节点提示、禁用节点提示、重叠 pattern 警告、价格差异提示和 log_root 错误；
- `LB10-03`：删除 target 后组成员同步删除；后端非法响应能定位到字段；
- `LB10-04`：状态轮询更新数字但不丢失输入焦点和展开状态；页面不可见时停止请求；
- `LB10-05`：模型校验结果成功、失败和模型缺失显示明确；
- `LB10-06`：中英文切换、英文无中文、窄 viewport、键盘操作和长名称布局；
- `LB10-07`：代理页中英文截图完整检查，其他基线像素差为 0。

测试落点：扩展 `test-node/ui/admin-ui.test.ts`，必要时新增 LB 专用 UI fixture。

验收标准：配置交互和状态展示可用；UI 状态不污染配置；中英文基线通过。提交前必须运行 `npm run regen:ui-baselines` 并更新视觉基线哈希。提交定位：`[LB-10]`。

### LB-11：端到端、reload、pending 和价格回归

实现功能：

- 使用两个 stub 上游和真实 `ProxyRequestPipeline` 组装完整链路；
- 覆盖新 task 分布、同 task 亲和、Responses response chain、模型直通、失败切换、503、reload 保留绑定和 stop 清理；
- 覆盖多 target `request_received` 时序和 `GET /api/logs/records?ids=`；
- 覆盖组内价格一致、pricing snapshot、失败切换后的价格稳定性；
- 覆盖 canonical node key、单桶容量、matcher runtime/legacy 边界；
- 验证 LB 关闭时所有既有 routing、logging、pricing 测试不变；
- 不依赖真实用户实例、真实 API key 或付费外部服务。

测试场景：

- `LB11-01`：四个新 task 按策略分布到两节点；
- `LB11-02`：多轮 chat 和 Responses `previous_response_id` 始终回同一节点；
- `LB11-03`：成员 model mapping 冲突时两个上游收到原始模型名；
- `LB11-04`：一个连接期错误切换一次，下一条同 task 固定新节点；
- `LB11-05`：响应头后断开不切换，客户端不会收到重复响应；
- `LB11-06`：组内无健康节点返回 503，不落到默认 target；
- `LB11-07`：保存无关配置触发 reload 后 affinity、inFlight release 和监视器状态正确；
- `LB11-08`：多 target 在 body 读取前没有 record，选路后 pending 行可由 ids 接口读取；
- `LB11-09`：同一组价格一致，失败切换后 pricing snapshot 和费用状态不漂移；
- `LB11-10`：重复同构请求受 bucket 上限控制，matcher fallback 不被路由依赖；
- `LB11-11`：客户端 abort、上游 error 和 stopPair 后没有残留资源。

测试落点：新增或扩展 `test-node/proxy/` 的 pipeline 集成测试、`test-node/admin/logs.test.ts`、`test-node/app/runtime.test.ts` 和 pricing 回归测试。

验收标准：完整测试矩阵通过；关闭 LB 的既有测试无行为变化；无未解释的设计偏差。提交定位：`[LB-11]`。

### LB-12：真实节点验收与性能检查

实现功能：

- 使用独立配置、独立数据目录和空闲端口验证，不修改用户正在运行的实例；
- 从配置读取 9393/9394 的 URL 和认证信息时不得打印 API key；
- 使用真实 `/metrics` 验证根路径、认证、running/waiting/KV 解析和过期行为；
- 使用真实流量验证新 task 分布、同 task 粘性、prefix cache 命中和 prefill 指标；
- 停止一个引擎验证冷却和一次 failover；
- 保存无关配置验证 reload 不清空绑定；
- 验证任务历史中的 `target_id`、`model_route` 和 `failover_from`；
- 测量请求热路径新增成本，确认选路不查库、不等待 metrics 网络请求；
- 验证大 body 时多 target pending 的已知时序，不把“暂无 record”误判成批量 API 回归。

验收清单：

- [ ] LB 开启后 9394 的请求和 token 计数从 0 开始增长；
- [ ] 一个会话的记录保持同一 `target_id`；
- [ ] 四个并发新会话能根据真实负载分布；
- [ ] 9394 停止后新请求最多一次连接失败即可成功切换；
- [ ] 历史记录出现 `decision: "failover"` 和来源节点；
- [ ] 无关配置保存后活跃会话仍在原节点；
- [ ] metrics 采样失败不阻断普通转发；
- [ ] 价格快照和费用状态没有因节点变化而变成无依据的 `unpriced`；
- [ ] canonical node key 对本地地址别名稳定；
- [ ] 真实节点验证没有打印敏感信息。

测试落点：仓库根目录临时 `.mts` 或独立测试脚本，验证后删除；必要时使用 Python stdlib `sqlite3` 读取日志，不在 Electron ABI 状态下加载普通 Node 的 native module。

验收标准：真实节点行为符合设计，数据和敏感信息安全；性能和时序限制有记录。提交定位：`[LB-12]`。

### LB-13：文档收尾、全量检查和交付构建

实现功能：

- 更新 README 中的负载均衡配置、粘性例外、价格规则、日志目录和故障切换说明；
- 更新 `docs/module-design.md`、软件功能说明书和 ADR-013 的实现链接/状态；
- 在本 TODO 第 5 节记录每个任务的测试命令、实际结果、提交 SHA 和设计偏差；
- 检查最终设计文档、TODO、API 示例、配置 schema、UI 文案和代码字段名称一致；
- 检查 `fallback_disabled` 等已删除语义没有重新出现；
- 检查所有新增 API 都有 assembled-app smoke coverage；
- 运行全量格式、类型、lint、测试、构建和 UI 基线检查；
- 按项目要求构建 portable executable，并检查构建产物中的 static 资源。

最终命令：

```text
npx prettier --check .
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run rebuild:electron
npx electron-builder -w portable --publish never
```

如果项目脚本没有 `format:check`、`typecheck` 或 `test` 中的某个命令，记录实际可用命令和原因，不要伪造通过结果。Electron ABI 重建后不要重新运行普通 Node native-module 测试。

验收标准：代码、测试、文档、视觉基线和 portable 产物一致；所有已知限制和未实现的 v2 能力都有记录。提交定位：`[LB-13]`。

## 5. 执行记录

### LB-01

- 状态：完成
- 实际变更：`src/config/config-schema.ts` 新增 `loadBalancerGroupSchema`、`load_balancers`（默认 `[]`）与 `proxyConfigFileSchema.superRefine` 里的组归属、重复 id、重复成员、完全相同 pattern、日志目录和价格一致性校验；新增 `collectLoadBalancerWarnings`、`modelPatternsMayOverlap`、`sameResolvedLogRoot`、`sameModelPriceRules`。`src/config/config-normalizer.ts` 新增 `normalizeLoadBalancerGroups`（补 id/name/开关，保留未知 target id 和未知 strategy 文本交给 schema 报错）。`src/config/defaults.ts` 与 `src/config/index.ts` 同步。`src/admin/admin-server.ts` 的 400 响应增加 `error.issues`，让校验路径能被界面定位。
- 测试命令：`npx vitest run test-node/config/ test-node/admin/pairs.test.ts test-node/admin/errors.test.ts test-node/proxy/proxy-manager-apply.test.ts test-node/proxy/proxy-manager.test.ts test-node/app/runtime.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：全量 91 个测试文件 / 801 个用例全部通过；类型、lint、格式检查通过。新增用例覆盖 LB01-01～LB01-07（`config-schema.test.ts`、`config-normalizer.test.ts`、`pairs.test.ts`、`proxy-manager-apply.test.ts`）
- UI 基线：未涉及
- 设计偏差：见设计文档 §5.2 新增的实现说明（价格按数值比较、`log_root` 词法归一化且大小写敏感、三种警告由 `collectLoadBalancerWarnings` 计算并等待 LB-09/LB-10 运输）。另：`ProxyPair` 因此多了一个必填字段，6 处测试夹具补齐 `load_balancers: []`。
- 提交标题：`feat(load-balancing): [LB-01] add group configuration and pair validation`
- 提交 SHA：`8b5d317`
- 备注：运行 Node 测试前先执行了 `npm rebuild better-sqlite3`（此前 native 模块是 Electron ABI 143）。

### LB-02

- 状态：完成
- 实际变更：新增 `src/proxy/task-identity.ts`（`taskIdentity`、`requestContextKeys`、`taskExactKeys`、`boundaryWithoutUser`、`userMessageHashes`、`contentFingerprint`、`userMessagesPrefixMatches`、`userHashPrefixMatches`、`hasContinuationEvidence`、`mergeLegacyContextKeys`），并在 `src/proxy/index.ts` 导出。`src/logging/task-matcher.ts` 改为复用这些共享投影：删除自带的 `nestedValue`/`firstString`/`headerValue`/键拼接、`delete first_user` 比较和用户消息/continuation 实现，历史列键走 `mergeLegacyContextKeys`。
- 测试命令：`npx vitest run test-node/proxy/task-identity.test.ts test-node/logging/`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 `test-node/proxy/task-identity.test.ts` 12 例、`test-node/logging/task-identity-boundary.test.ts` 4 例；原有 `task-matcher.test.ts` 15 例、`traffic-log-service.test.ts` 10 例全绿；全量 93 文件 / 817 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：`TASK_MATCH_STRATEGY_VERSION` 保持 6（行为未变）。键提取只接受字符串，数字型 `prompt_cache_key` 不生成键（与 matcher 原行为一致）。新增 `bounded`/`oversize` 标记，LB-05 才能据此在大 conversation 上退回精确键。
- 提交标题：`refactor(load-balancing): [LB-02] share task identity projections with the task matcher`
- 提交 SHA：`e1741b5`
- 备注：临时目录清理加了 `maxRetries`（Windows 上 `traffic.db` 刚关闭时会短暂 EBUSY）。

### LB-03

- 状态：完成
- 实际变更：新增 `src/proxy/load-affinity.ts`（`LoadAffinityTable`：精确键索引 + 前缀桶 + LRU + TTL + 响应 id 回填 + rebind + prune/clear/sweep/snapshot），并在 `src/proxy/index.ts` 导出。常量 `AFFINITY_TTL_MS`、`MAX_BINDINGS_PER_GROUP`、`MAX_BUCKET_SIZE`、`MAX_BUCKET_SCAN` 与设计一致。
- 测试命令：`npx vitest run test-node/proxy/load-affinity.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 20 例（LB03-01 到 LB03-07 加验收例）全部通过；全量 94 文件 / 837 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §7.3 落地说明——绑定不存 `contentFingerprint`（桶内判定只看哈希前缀）；endpoint 为“存下为空则兼容、否则严格相等”；精确键被抢时只摘键不删绑定；全局淘汰在超限时线性扫描全表（上限 4096，实测 4097 次绑定约 170 ms）。
- 提交标题：`feat(load-balancing): [LB-03] add affinity table with bounded buckets`
- 提交 SHA：`07763f4`
- 备注：无。

### LB-04

- 状态：完成
- 实际变更：新增 `src/proxy/node-identity.ts`（`canonicalNodeKey` / `tryCanonicalNodeKey`）、`src/proxy/load-balancer.ts`（`LoadBalancer`：node 表、每组一张亲和表、`reconfigure`、在飞账本、`clear`、`snapshot`）、`src/proxy/load-monitor.ts`（`LoadMonitor`：每 5 分钟清理过期绑定，定时器 `unref`）。`src/proxy/proxy-runtime-registry.ts` 的 `ProxyRuntimeEntry` 新增 `loadBalancer` / `loadMonitor`：`startPair` 创建，`reloadPair` 原地 reconfigure，`stopPair` 停表并清空；新增 `loadBalancer(pairId)` / `loadMonitor(pairId)` 读取入口。`src/proxy/index.ts` 导出。
- 测试命令：`npx vitest run test-node/proxy/node-identity.test.ts test-node/proxy/load-balancer.test.ts test-node/proxy/proxy-runtime-registry.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 `node-identity.test.ts` 9 例、`load-balancer.test.ts` 11 例、registry 新增 LB04-04/05 共 1 例；全量 96 文件 / 858 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §6.2 落地说明——监视器现在只做亲和清理（LB-08 接采样进同一个定时器）；`LoadBalancer` 还不选路（LB-05）；`clear()` 保留 node 视图，runtime entry 在 stop 时把对象摘掉；在飞计数放在以 `targetId` 为键的 pair 账本上，不属于任何 pipeline。
- 提交标题：`feat(load-balancing): [LB-04] add canonical node identity and runtime lifecycle`
- 提交 SHA：`5ccd081`
- 备注：无。

### LB-05

- 状态：完成
- 实际变更：`src/proxy/load-balancer.ts` 增加 `matchGroup`、`plan`、`markDispatched`、`markFailure`、`noteSuccess`、`markCooldown`、`cooldownRemaining` 和内部排序；新增 `LoadSample`、`LoadBalancerDecision`、`LoadBalancerReservation`、`METRIC_FRESH_WINDOW_MS`、`KV_TIER_THRESHOLD`、`MAX_COOLDOWN_MS`、`EMPTY_LOAD_SAMPLES`。`src/proxy/proxy-request-pipeline.ts` 接入：新增 `loadBalancer`/`loadSamples` 选项、`LoadBalancerExhaustedError`、命中组时用请求模型转发、`model_route` 增加 `route_mode` 与 `load_balance`、响应 id 回写绑定、`finally` 释放预留、无可用节点时回 503。`src/proxy/proxy-runtime-registry.ts` 在 `startPair`/`reloadPair` 把 balancer 传给 pipeline。`src/proxy/index.ts` 导出。
- 测试命令：`npx vitest run test-node/proxy/load-balancer-selection.test.ts test-node/proxy/load-balancer-pipeline.test.ts test-node/proxy/load-balancer.test.ts test-node/proxy/proxy-listener.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 `load-balancer-selection.test.ts` 8 例（LB05-01～07、LB05-10）、`load-balancer-pipeline.test.ts` 3 例（LB05-01/08/09）；全量 98 文件 / 869 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §8.4 落地说明——记录的 `load` 不含本次预留；亲和命中可用冷却/睡眠节点而新 task 不用；`release()` 幂等；`loadSamples` 暂时是空表（LB-08 接真实采样）；503 的 `no_healthy_node` 记录由 LB-07 补上。
- 提交标题：`feat(load-balancing): [LB-05] select nodes and reserve them in the request pipeline`
- 提交 SHA：`6a406fc`
- 备注：无。

### LB-06

- 状态：完成
- 实际变更：产品代码未动（本任务验证现有时序与 pricing 契约）。测试新增：`test-node/proxy/load-balancer-pipeline.test.ts` 增加 `record timing and pricing around load balancing` 4 例（LB06-01/02/04/05）、新文件 `test-node/logging/load-balancer-log-records.test.ts`（LB06-03）、`test-node/pricing/request-pricing.test.ts` 增加 LB06-06。`test-node/proxy/load-balancer-pipeline.test.ts` 的 fixture 上游现在回答 `usage`，且 `pipelineTarget` 可以携带 `modelPrices`。
- 测试命令：`npx vitest run test-node/logging/load-balancer-log-records.test.ts test-node/proxy/load-balancer-pipeline.test.ts test-node/pricing/request-pricing.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 6 例；全量 99 文件 / 875 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §6.4 落地说明——本任务只验证；组内价格一致由 LB-01 的保存校验保证（LB01-05）。
- 提交标题：`test(load-balancing): [LB-06] pin down record timing and pricing consistency`
- 提交 SHA：`808c7c9`
- 备注：无。

### LB-07

- 状态：完成
- 实际变更：`src/proxy/load-balancer.ts` 的 `plan` 接受 `exclude`，并把它同时用于亲和命中。`src/proxy/proxy-request-pipeline.ts` 新增 `#tryFailover`（一次安全切换）、`applyFailoverRoute`（重写 record 的 target 块与 `model_route`）、`isConnectionPhaseError`、`#recordRejectedRequest`（503 的 `no_healthy_node` 记录）、连接成功后的 `noteSuccess`，`LoadBalancerExhaustedError` 改为携带 group 与 log host；上游目标变量改成 `activeTarget`/`activeReservation`，`finally` 释放当前预留。
- 测试命令：`npx vitest run test-node/proxy/load-balancer-pipeline.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 6 例（LB07-01 内含 LB07-05）；全量 99 文件 / 881 例通过；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §10.1 落地说明——客户端中止不记失败；pricing 快照保留原 target 名字；无可用节点的记录写进组内第一个配置节点的日志库，组内没有配置节点时只剩 503。
- 提交标题：`feat(load-balancing): [LB-07] add one safe failover and 503 refusals`
- 提交 SHA：`ba53010`
- 备注：无。

### LB-08

- 状态：完成
- 实际变更：新增 `src/proxy/load-metrics.ts`（vLLM / SGLang / llama.cpp 别名、多 label 求和、NaN/Inf/负数丢弃、vLLM 睡眠状态）；重写 `src/proxy/load-monitor.ts`（5 秒采样 + 4 秒超时 + 同一 canonical key 单飞 + 失败/恢复各一条日志 + `nodeStatuses()`）；`src/proxy/load-balancer.ts` 节点上存 `sample`、`target_url`、`target_api_key`，新增 `groupFor` / `samples` / `sampleFor` / `setSample` / `nodeIds`，`plan` 不传 samples 时用节点上的快照；`src/proxy/proxy-runtime-registry.ts` 把 `loadSamples` 从空表改成 `() => balancer.samples()`；`src/proxy/index.ts` 补导出。
- 测试命令：`npx vitest run test-node/proxy/load-metrics.test.ts test-node/proxy/load-monitor.test.ts test-node/proxy/target-metrics.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`；真机验证用临时 `.mjs` 脚本走 `fetchTargetMetrics` + `parseLoadMetrics` + `LoadMonitor`，跑完删除
- 测试结果：新增 8 例；复用部分由原有 `target-metrics.test.ts` 继续覆盖且保持绿色；全量 101 文件 / 889 例通过；真机 9393/9394 根路径回退采样成功（12–28 毫秒，解出 vLLM 数字）
- UI 基线：未涉及
- 设计偏差：见设计文档 §8.1 落地说明——一个定时器同时驱动采样和亲和清理；什么都没解析出来时清空样本而不是存一个 0 样本；监视器默认自己的 logger 写 stderr（registry 暂无 logger 注入点）。
- 提交标题：`feat(load-balancing): [LB-08] sample upstream engines and keep load snapshots`
- 提交 SHA：`6d8d798`
- 备注：无。

### LB-09

- 状态：完成
- 实际变更：新增 `src/proxy/load-balancer-admin.ts`（只读内存的状态视图 + `GET /models` 节点校验，base path 后跟根路径回退）；`src/admin/admin-server.ts` 加两个路由、请求/响应 schema 和 `LoadBalancerAdminService` 接口；`src/proxy/proxy-manager.ts` 暴露 `registry` getter；`src/app/runtime.ts` 装配服务；`src/proxy/index.ts` 补导出。
- 测试命令：`npx vitest run test-node/admin/load-balancer.test.ts test-node/proxy/load-balancer-pipeline.test.ts test-node/app/runtime.test.ts`，随后 `npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：新增 LB09-01、LB09-02（流水线）、LB09-03（两条）、LB09-04、LB09-05（三条）、LB09-06（管理路由缺失 + assembled app）；全量 102 文件 / 898 例通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §11.2 落地说明——字段名用 camelCase；`inRotation` 只看启用且不在冷却；每个节点多了 `bindings`；`logged_by` 写在 `load_balance` 里。
- 提交标题：`feat(load-balancing): [LB-09] add route records and the load balancer admin API`
- 提交 SHA：待填写
- 备注：无。

每完成一个任务，在这里追加一条记录：

```text
### LB-XX

- 状态：完成 / 待验收 / 阻塞
- 实际变更：
- 测试命令：
- 测试结果：
- UI 基线：未涉及 / 已重录，文件与哈希为……
- 设计偏差：无 / ……
- 提交标题：
- 提交 SHA：
- 备注：
```

## 6. 最终交付清单

- [ ] LB-01～LB-13 全部完成并有提交定位；
- [ ] 同一 task 正常情况下保持单节点亲和；
- [ ] 新 task 按固定字典序选择，metrics 缺失时能退化；
- [ ] 组内模型映射屏蔽，模型名一致；
- [ ] 价格规则一致，失败切换不造成无依据的 `unpriced`；
- [ ] 多 target `request_received` 时序和 `?ids=` pending 行为有测试；
- [ ] 每个前缀桶和每组绑定都有容量上限；
- [ ] matcher 与路由只对运行时可达证据承诺超集关系；
- [ ] canonical node key 不受本地 host 别名影响；
- [ ] 无健康节点返回 503，不回落普通路由；
- [ ] reload、abort、failover、stop 后没有资源泄漏；
- [ ] API、UI、中文/英文基线和文档同步；
- [ ] `npm run check` 或等价全量检查通过；
- [ ] portable executable 构建完成并经过 artifact 检查。
