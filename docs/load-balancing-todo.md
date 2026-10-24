# 多节点负载均衡开发 TODO

创建日期：2026-10-22。当前进度：21 / 21 项完成。

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
| [x] | LB-10 | 管理 UI、i18n 和视觉基线 | LB-01、LB-08、LB-09 | 完成 |
| [x] | LB-11 | 端到端、reload、pending 和价格回归 | LB-02～LB-10 | 完成 |
| [x] | LB-12 | 真实节点验收与性能检查 | LB-11 | 完成 |
| [x] | LB-13 | 文档收尾、全量检查和交付构建 | LB-12 | 完成 |
| [x] | LB-14 | 校验节点模型支持未保存的组草稿 | LB-10、LB-09 | 完成 |
| [x] | LB-15 | 卡片与转发地址同宽，参与节点改成浮动勾选 | LB-10 | 完成 |
| [x] | LB-16 | 删除匹配预览输入与校验节点模型 | LB-10、LB-14 | 完成 |
| [x] | LB-17 | 统一组卡片里四个控件的长相 | LB-15、LB-16 | 完成 |
| [x] | LB-18 | 节点状态改成名字开头、固定列宽、三行排版 | LB-10、LB-17 | 完成 |
| [x] | LB-19 | 组成员各自的模型 id 映射（含删掉成员上方的标签行） | LB-05、LB-10、LB-18 | 完成 |
| [x] | LB-20 | 组卡片头部：删除按钮挪到启用开关左边 | LB-10 | 完成 |
| [x] | LB-21 | 代理页布局：添加按钮上移、删除进头部、名称框定宽 | LB-10 | 完成 |

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

### LB-14：校验节点模型支持未保存的组草稿

背景：用户反馈「肯定是先确认节点没问题才保存配置的」，而 LB-09/LB-10 把校验接口
实现成只按 `pairId` + `groupId` 查已保存配置，所以新建还没保存的组只能得到
`Load balancing group not found.`，用起来的顺序和用户的顺序相反。

实现功能：

- 接口同时接受 `modelPattern` + `nodeTargetIds`，按已保存的 pair 解析成员 id，校验一个还没保存的组；
- 响应新增 `source`（`draft` / `saved`），界面把它写进结果区的第一行；
- 界面把卡片当前的模型匹配和勾选的成员一起发送，不再要求先保存；
- 模型匹配为空或一个节点都没勾时界面自己拦住，不发请求；
- 成员数上限 64（schema `maxItems` + 服务端 `MAX_VERIFY_NODES`）；
- 更新 README、功能说明书和设计文档里关于「先保存才能校验」的说法。

验收标准：未保存的组可以直接校验并得到逐节点结果；已保存的组仍然可以只发 ids 校验；
请求里带不进 URL 或 key，所以草稿无法让服务端访问任意上游；新接口在 assembled-app smoke
里有覆盖；全量测试和六张视觉基线不变。提交定位：`[LB-14]`。

### LB-16：删除匹配预览输入与校验节点模型

用户结论：这两件事没带来什么价值，直接删。本项会反方向撤掉 LB-14 的全部校验相关代码。

前置条件已满足：LB-15 的「选择节点」浮动列表已经提交（`019560d`），
`src/admin/static/app.js` 和 `app.css` 的工作区是干净的。

删除内容：

- 界面：`.lb-preview` 整块（标签、输入、`output`）、`[data-lb-preview]` 的 input 监听、
  `refreshLbCards()` 里的预览计算、`lbPatternMatches`（只有预览在用）；
  `patternToRegex` 和 `lbPatternsMayOverlap` 服务于重叠警告，保留。
- 界面：`校验节点模型` 按钮、`[data-lb-verify]` 结果区、`runLoadBalancerModelCheck`、
  没填 pattern / 没勾节点时的本地守卫，以及只给这两件事用的六个中英文案。
- 样式：`.lb-verify-results`、`.lb-verify-line` 及其三个状态色、`.lb-verify-source`、
  `.lb-verify-results.is-warn`。
- 服务端：`verifyModels`、`fetchModelList`、`LoadBalancerVerifyModelsRequest`、
  `LoadBalancerVerifyModelsResponse`、`LoadBalancerNodeModelCheck`、
  `VERIFY_MODELS_TIMEOUT_MS`、`MAX_VERIFY_MODELS_BYTES`、`MAX_VERIFY_NODES`；
  `POST /api/load-balancer/verify-models` 路由和三处 schema；admin 接口的 `verifyModels`。
  `getStatus` 和状态轮询不动。
- 测试：`test-node/admin/load-balancer.test.ts` 里 LB09-05 的三个 `it` 和 LB14-01～03；
  `test-node/app/runtime.test.ts` 里的 verify 断言（换成确认这条路由已经不存在）；
  `test-node/ui/admin-ui.test.ts` 里的模型校验测试和守卫测试、其它测试中对
  `[data-lb-preview]` 的填写和断言、stub 的 `verifyModels`、`lbVerify*` 状态变量与 fixture。
  状态轮询和节点数字的测试保留。
- 文档：README 的「校验节点模型」行；功能说明书 §5.4 的两个 bullet；
  设计文档 §5.3、§12 里关于预览和校验的落地说明、LB-09 API 说明里的 verify 部分。

验收标准：卡片上不再有这两块；全量 tsc、lint、prettier、vitest 全绿；
`GET /api/load-balancer/status` 仍然正常；中英文代理页基线重录并更新完整 SHA-256，
其余六张零像素差；portable 产物重建后在 asar 里确认已经没有校验相关代码；
`/api/load-balancer/verify-models` 返回 `not_found`，不是 `load_balancer_group_not_found`。
提交定位：`[LB-16]`。

### LB-17：统一组卡片里四个控件的长相

用户反馈：选择策略的下拉框和选择节点的下拉框颜色、大小都不一样。

统一后的长相（组名、pattern、选择策略、选择节点四个控件共用）：

| 项 | 值 |
| --- | --- |
| 背景 | `#ffffff` |
| 边框 | `1px solid #b8c5d3` |
| 圆角 | 6 px |
| 高度 | 32 px |
| 字号 | 13 px |
| 悬停背景 | `#eef3f8` |
| 箭头 | 同一张 SVG，10 px，靠右 10 px，`#55616f` |

验收标准：两个下拉右端各裁 34 px 宽，逐像素相同；`getComputedStyle` 报出的宽高、字号、
背景、边框、圆角完全一致；中英文负载均衡基线重录并更新完整 SHA-256，其余八张零像素差。
提交定位：`[LB-17]`。

### LB-18：节点状态排版与命名

用户反馈三件事：`target-xxxx` 看不出是谁；芯片宽度随内容变，位置一直在动；全都挤在一起。

选定形状（用户在选项里选了「指标分两行、每行三列」）：

| 项 | 内容 |
| --- | --- |
| 第一行 | 节点名字（取 target 的 `name`，没有名字才退回 id），`title` 带完整 id |
| 名字行右侧 | 一枚只写状态词的标签：启用 / 禁用 / 没有采样 / 指标过期 |
| 名字下方 | 一条分隔线 |
| 指标 | 两行，每行三列等宽（`repeat(3, minmax(0, 1fr))`），列宽固定 |
| 列宽不够 | 只截断当前一项，悬停给完整文本 |

验收标准：两个节点的同一指标 `getBoundingClientRect()` 的 x 与宽完全相同；名字行写的是
节点名而不是 id；全量测试绿；负载均衡基线零像素差通过（基线里 details 是折叠的，所以画面不变）。
### LB-19：成员各自的模型 id

用户要的是「一张卡对应一个上游模型名」：`vllm-win -> Qwen3.8-Flash-Next-WIN`、
`vllm-win2 -> Qwen3.8-Flash-Next-WIN2`；留空表示这一行不映射。
两条后续反馈：成员上方那行重复的节点标签删掉，节点名沿用标签的描边配色并与输入框等高。

决策摘要（每条是一个可验证的契约）：

1. 组成员存成 `members: [{ target_id, model_id }]`。
2. `model_id` 为空时上游收到客户端原始的模型名。
3. `model_id` 非空时上游收到它；成员自己的 `model_mappings` 既不参与选择也不改写。
4. 亲和键记客户端请求的模型名，不记改写后的名字。
5. 失败切换按新成员的 `model_id` 重写请求体，并记 `model_route.upstream_model`。
6. 每个勾选成员占一行：左边节点名，右边这一行自己的模型输入框。
7. 在输入框里打字不重建行；取消勾选删掉该行连同它的映射。
8. 保存请求只接受 `members`；旧的 `node_target_ids` 由 normalizer 折算，老组行为不变。

| 项 | 内容 |
| --- | --- |
| 配置形状 | `members`，每项 `{ target_id, model_id }`，`min(1)` |
| 校验路径 | `pairs.0.load_balancers.0.members.N.target_id` |
| 空 `model_id` | 归一成 `undefined`，照原样转发 |
| 日志字段 | `model_route.upstream_model`；切换后一并更新 `upstream_body`、`stripped_fields`、`injected_fields` |
| 行渲染签名 | id + 名字 + 启用状态，不含模型文本 |
| 成员顺序 | 已配置的成员保持在前，新勾选的追加在后 |
| 名字框外观 | 白底、`1px #b8c5d3`、6 px 圆角、32 px 高、13 px 字 |

非目标：不让 target 级映射在组内复活，不做模型名别名池，不引入第二套上游配置。

验收标准：`LB19-01`～`LB19-03` 覆盖形状、迁移与拒绝旧形状；`LB19-06` 证明两个成员各发自己的模型名
且后续轮回原节点；`LB19-07` 证明切换后按应答节点重写且日志里只剩新模型名；`LB19-10` 证明改映射名
不会搬走已绑定的任务；UI 两条用例证明每行一个输入框、取消勾选连映射一起消失；探针量到名字框与
输入框同为 32 px 高、列坐标固定、整卡片只有超长节点名的内层 span 被裁。
提交定位：`[LB-19]`。

### LB-20：把删除按钮挪到启用开关左边

用户一句话要求：组卡片头部的删除按钮和启用开关换个位置。

决策摘要：

1. 头部一行从左到右是组名输入框、删除按钮、启用开关。
2. 开关仍在最右端，仍是唯一控制启停的控件。
3. 删除按钮仍只在 `collectPairs` 之后删掉本组，行为不变。

| 项 | 内容 |
| --- | --- |
| 实现方式 | 只换 `lbGroupCard` 里 `.lb-head` 两个子元素的先后 |
| 为什么够用 | `.lb-head` 是 `minmax(0, 1fr) auto auto` 自动放置，没有写死列位 |
| 不受影响的选择器 | 删除按钮按 `[data-remove-lb]` 匹配，开关按 `[data-lb-toggle]` 匹配，都不按位置取 |

验收标准：探针量到三个格子依次落在 x = 42 / 282 / 338；点开关仍能关掉组，点删除仍能删掉卡片；
窄屏 380 px 时三个格子还在同一行；两张负载均衡基线重录后全量测试绿。
提交定位：`[LB-20]`。

### LB-21：代理卡片的两个按钮换位，名称框改固定宽

用户三条要求：「添加转发地址」不该在卡片底部，应像「添加负载均衡组」那样放在「转发地址」标题行的右边；
「删除」放到代理头部、端口的右边、开关的左边；代理名称输入框不要太长，改成一个固定值。

决策摘要：

1. 「转发地址」标题行左标题右按钮，按钮位置和负载均衡区段的添加按钮一致。
2. 代理头部从左到右是名称、监听地址、端口、删除、开关；开关仍在最右端。
3. 名称框固定 240 px，不随列拉伸；名称过长时在框内横向滚动。
4. 卡片底部不再有任何操作行。

| 项 | 内容 |
| --- | --- |
| 标题行样式 | `.targets-head` 与 `.lb-section-head` 共用同一条 `flex` + `space-between` 规则 |
| 头部列 | `grid-template-columns: 240px minmax(160px, 220px) 100px max-content 1fr` |
| 为什么是 max-content | `auto` 会把删除按钮拉到 316 px；`min-content` 会把「删除」折成两行（36 × 57） |
| 开关为什么还在最右 | 最后一列是 `1fr`，开关 `justify-self: end` |

验收标准：删除按钮和标题行的添加按钮都落在预期的列里；点两者行为不变；`.row-actions` 在代理卡里为 0；
窄屏不塌版；四张受影响的基线重录、全量测试绿。
提交定位：无 LB 前缀（这是代理页通用布局，不属于负载均衡功能），提交标题以 `feat(ui)` 开头。

提交定位：`[LB-18]`。

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
- 提交 SHA：`7a53ebb`
- 备注：无。

### LB-10

- 状态：完成
- 实际变更：`src/admin/static/app.js`（中英语言键、组卡片与节点状态渲染、`collectPairs` 收集 `load_balancers`、添加/删除/校验点击处理、输入与勾选变更后的警告和匹配预览、捕获阶段 `toggle` 把展开状态写进 `localStorage`、2 秒轮询且只改 `[data-lb-fact]` 文本、`api()` 透传 `error.issues` 与 `configIssueText`、删除 target 时从本 pair 组成员中清理）；`src/admin/static/app.css`（`lb-*` 样式块、`.lb-section-head` 标题行、覆盖全局 `label span` 的单行规则）；`test-node/ui/admin-ui.test.ts`（负载均衡状态与模型校验桩、`pairsSaveIssues` 抛 `ConfigValidationError`、9 条新用例）。
- 测试命令：`npx vitest run test-node/ui/admin-ui.test.ts -t "admin UI load balancing groups"`、`REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui.test.ts -t "proxy page baseline"`、`npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：9 条新用例全部通过（保存与重载、三种警告、字段级报错、删除节点清理成员、轮询不丢焦点/草稿/展开态、隐藏与切标签时停止轮询、模型校验三种结果、中英翻译与 380 px 窄布局、键盘删除并忘记存储）；全量 102 文件 / 907 例通过
- UI 基线：已重录 `doc/ui_proxy_cn.png` = `641a8465939bb624c50ce8d1b001cbd0eb2c4c5adcea076bcff5a982290d6076`、`doc/ui_proxy_en.png` = `dcec51e547b5c76b6d54885305c105d73142620d2a36d1bbac164650021b7c17`；两张图完整检视过，英文界面没有中文、标签没有被截断；其余六张基线未重录且在全量测试里保持通过
- 设计偏差：见设计文档 §12.3 落地说明——「添加负载均衡组」按钮与标题同行；节点状态行随勾选成员重建；模型校验读已保存配置，未保存的组得到 404；短标签必须显式压过页面级 `label span { overflow-wrap: anywhere }`
- 提交标题：`feat(load-balancing): [LB-10] add load balancing group cards to the proxy page`
- 提交 SHA：`e13aa69`
- 备注：验证用的 `probe-lb-card.mts` 与三张临时截图已删除，没有遗留浏览器进程或定时器。

### LB-11

- 状态：完成
- 实际变更：只新增和扩展测试，没有改产品代码。新建 `test-node/proxy/load-balancer-integration.test.ts`（9 条，LB11-01～LB11-06、LB11-09～LB11-11：两个 stub 上游 + 真实 `ProxyRequestPipeline` + `ProxyListener`，上游回显收到的模型名，客户端共用一个 keep-alive agent，`refusedPort()` 用绑过又关掉的端口模拟死引擎）；扩展 `test-node/proxy/proxy-runtime-registry.test.ts`（LB11-07：在真实监听端口上发请求，请求仍在飞行时 `reloadPair`，断言同一个 balancer/monitor 对象、绑定存活、inFlight 归零、采样状态保留、下一轮仍回原引擎、`stopPair` 后亲和表清空；新增 `startStickyEngine`、`reloadStickyFixture`、`nodeOf`，`postJson` 增加可选 headers）；扩展 `test-node/logging/load-balancer-log-records.test.ts`（LB11-08：分片慢发 body，选路前 `?ids=` 返回空，选路后 pending 行可读且不含 body 列，落选引擎 `hits` 为 0；新增 `postSlowBody`，`startSlowEcho` 加 hits 计数）。
- 测试命令：`npx vitest run test-node/proxy/load-balancer-integration.test.ts test-node/proxy/proxy-runtime-registry.test.ts test-node/logging/load-balancer-log-records.test.ts`、集成文件连跑三次、`npx vitest run`（全量）、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`
- 测试结果：三个落点共 24 例全部通过（集成 9、runtime registry 13、history 2）；集成文件连跑三次都是 9/9；全量 103 个测试文件 / 918 个用例通过，LB 关闭时的既有路由、日志和价格用例行为没有变化；类型、lint、格式检查通过
- UI 基线：未涉及
- 设计偏差：见设计文档 §13.2 落地说明——冷却是建议不是禁止，全冷却的组仍会挑一个节点，所以 503 只由禁用或睡着产生；响应头发出后被掐断的流会冷却该节点，客户端自己 abort 不会；切换后 pricing snapshot 继续指向原计划节点；首条 user 相同的同构请求就是同一个 task，桶上限必须用不同的首条 user 才测得到；Windows 会耗尽临时端口，客户端必须复用 keep-alive socket；监视器首采样落在 5 秒定时器上，reload 测试改成先显式 `sampleNow()`
- 提交标题：`test(load-balancing): [LB-11] prove the whole route, reload, pending and pricing chain`
- 提交 SHA：`08f2263`
- 备注：本项没有新增产品代码；没有遗留临时文件、定时器或浏览器进程；`.pi/` 仍然未跟踪也没有被提交。

### LB-12

- 状态：完成
- 实际变更：没有改产品代码，只写了临时验证脚本（跑完即删）和设计文档 §13.4 的落地说明。验证跑在独立实例上：`release/win-unpacked/LLM Proxy.exe` + 临时 `proxies.json`（只保留 9393/9394 两个成员，价格规则对齐，`summary_model.target_url` 改指临时监听口）+ 临时 `llm-proxy.json`（管理端 18099）+ 绝对路径的临时日志目录 + 全新 `LLM_PROXY_DATA_DIR` + 代理端 12399；生产 `D:\Portable Program\llm_proxy\logs\proxies.json` 和 `llm-proxy.json` 的 mtime 都在本次验证之前，没有被写过。
- 测试命令：`python tmp-lb12-verify.py traffic|records|cache|model|config|perf|latency`（临时脚本，验证后删除）、`curl /api/load-balancer/status`、`curl /metrics`（9393/9394）、`psutil` 按进程创建时间区分自己与用户实例
- 测试结果：验收清单 10 项全部通过——四个并发新会话两张卡各两个；同一会话四轮全部回原节点且历史写入 `affinity`；组内直通时上游收到原始模型名（引擎 404 文案为证），关组后同一模型被成员映射改写并 200；死端口成员下四次请求全 200、只切换一次、历史写入 `decision: "failover"` 和来源节点；无关配置（`access_log`）保存后绑定 10 不变且会话回原节点；死成员的指标采样失败不阻断转发；切换后价格仍 `priced` 且 `pricing_snapshot.target_id` 停在原计划节点；`localhost:9393` 归一成 `http://127.0.0.1:9393/v1`；API key 没出现在状态响应、应用日志或记录详情里，记录也没有存 `authorization` 头。性能：开组 16 条中位数 210 ms，关组 247 ms（差异来自单卡拥挤，不是选路成本），状态接口中位数 0.75 ms，1.5 MB 请求体 193,207 prompt token / 41.3 s / 首 token 41.2 s
- UI 基线：未涉及
- 设计偏差：见设计文档 §13.4 落地说明——生产 pair 两张卡的价格规则现在不一致（`cache_write_per_million` `0` vs `1.25`），LB-01 校验会拒绝这样的组；组匹配区分大小写，小写别名不进组；进组后成员映射失效，客户端必须发引擎真实模型名；这台 vLLM 不保存 response，`previous_response_id` 一律 404 且 SSE 摘要里没有 response id，所以流式 Responses 无法靠 id 回到原节点（已记入 P2）；混合 Mamba 引擎把 follow-up 的前缀全算成 `local_compute`、`cached_tokens` 报 0，但冷启动首 token 528 ms vs 已缓存 325 ms，亲和的收益只能间接度量
- 提交标题：`docs(load-balancing): [LB-12] record real node acceptance findings`
- 提交 SHA：`21a1cfd`
- 备注：验证结束后只杀掉自己 17:32 启动的三个进程，用户 21:58 启动的实例和两张卡上的引擎都还在；临时目录、临时脚本和 `/tmp/lb12-app.log` 已删除；`release/win-unpacked` 在本次验证前重建过，`better-sqlite3` 现在是 Electron ABI，LB-13 跑 Node 测试前需要 `npm rebuild better-sqlite3`。

### LB-13

- 状态：完成
- 实际变更：`README.md` 新增「负载均衡」一节（组的位置、成员选择、模型直通、两种策略、粘性及其四类例外、无健康节点 503、价格与日志目录约束、节点状态轮询、指标来源与回退、校验模型按钮、展开状态、容量上限、重启后果、示例配置和路由记录字段）；`docs/software-functional-specification.md` 新增 §5.4 用户可见行为、§6.2 第 0 步和 §6.3 的组内路由示例；`docs/module-design.md` §7.3 补齐七个 LB 模块文件名、§7.4 新增模块职责；`docs/adr/013-load-balancing-sticky-routing.md` 状态改为已采纳并已实现，补实施 TODO 链接和两条真机修正；本 TODO 进度、LB-13 行和第 6 节交付清单。
- 测试命令：`npm rebuild better-sqlite3`、`npm run check`（= `format:check` + `lint` + `typecheck` + `test` + `build`）、`npm run package:electron:portable`、`npx asar list release/win-unpacked/resources/app.asar`、一次性 `tmp-lb13-artifact.cjs`（用 `@electron/asar` 把 asar 里的 `app.js` / `app.css` 读回来比对，用完删除）
- 测试结果：`npm run check` exit 0：Prettier 全部文件通过、eslint 零问题、tsc 零错误、103 个测试文件 / 918 个用例全部通过（包含六张视觉基线比对）、build 成功。portable 产物 `release/LLM-Proxy-0.4.10-x64-portable.exe` 111,611,496 字节构建成功；asar 内的 `app.js` 同时含 `lb-card`、`data-lb-fact`、`llmProxyLbGroupOpen`、`data-add-lb-group`、`data-verify-lb-models`、`lb-takeover-note`、`applyLoadBalancerStatus`、`purgeLoadBalancerMember`、`configIssueText`、`loadBalancerStatusIntervalMs` 和中文「添加负载均衡组」与英文 `Add load balancing group`；`app.css` 里 `.lb-*` 选择器 39 个；15 个 LB 模块条目在包里。`fallback_disabled` 只在断言和文档里作为「不会出现」出现，产品代码不会产生它。两个新接口在 assembled-app smoke 里有覆盖（`test-node/app/runtime.test.ts`：status 200 空态、verify 404 `load_balancer_group_not_found`、错误请求体 400）
- UI 基线：本次未重录；LB-10 的哈希保持不变并在全量测试里通过（`ui_proxy_cn` `641a8465…`、`ui_proxy_en` `dcec51e5…`）
- 设计偏差：无新增。v2 未实现能力已在设计文档 §15（重启丢亲和、prompt 长度、异构节点、KV 饱和迁移、更精细的缓存感知、同构请求碰撞）和 §14 的 P1/P2/P3 里记录，ADR-013 补了两条真机约束
- 提交标题：`docs(load-balancing): [LB-13] document the feature for users and modules`
- 提交 SHA：`08e13ff`
- 备注：`npm run check` 把 `better-sqlite3` 留在 Node ABI 137；portable 打包后 native 模块变成 Electron ABI，下次跑 Node 测试前仍需 `npm rebuild better-sqlite3`。临时 `.cjs` 已删除，没有遗留临时文件、浏览器进程或测试实例。

### LB-14

- 状态：完成
- 来源：交付后的用户反馈。用户指出正常用法是先确认节点没问题再保存，而旧实现只能校验已保存的组。
- 实际变更：`src/proxy/load-balancer-admin.ts` 把 `verifyModels(pairId, groupId)` 改成 `verifyModels(request)`，`modelPattern` + `nodeTargetIds` 同时存在时走草稿模式，成员 id 仍按已保存的 pair 解析，新增 `MAX_VERIFY_NODES = 64` 和响应里的 `source`；`src/admin/admin-server.ts` 的接口签名、请求 schema（新增两个可选字段，`nodeTargetIds` 限 1–64）和响应 schema（`source` 必填枚举）跟着改，路由直接把 body 透传；`src/proxy/index.ts` 导出新类型；`src/admin/static/app.js` 发送卡片当前值并在缺 pattern / 没勾节点时本地提示（新增 4 个中英文案），结果区多一行来源说明；`src/admin/static/app.css` 新增 `.lb-verify-results.is-warn` 和 `.lb-verify-source`。文档：设计文档 §5.3 / §12.2 / LB-09 落地说明、README、功能说明书 §5.4。
- 测试命令：`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`、`npx vitest run test-node/admin/load-balancer.test.ts test-node/app/runtime.test.ts`、`npx vitest run test-node/ui/admin-ui.test.ts -t "admin UI load balancing groups"`、`npx vitest run`、`npm run check`
- 测试结果：`LB14-01`（从未保存过的组草稿得到逐节点结果，pair 里 `load_balancers` 为空，两台引擎各被访问一次，不存在的 target 明确报错）、`LB14-02`（草稿 pattern 覆盖已保存 pattern，`source` 分别是 `draft` / `saved`）、`LB14-03`（空成员和 65 个成员都在任何上游请求之前被 400 `FST_ERR_VALIDATION` 拒掉）通过；assembled-app smoke 里 `LB14` 在运行中的 pair 上拿到 `source: "draft"` 且死端口节点 `ok: false`、`status: null`，不存在的 pair 带草稿字段仍返 404 `load_balancer_group_not_found`；UI 新增一条测试：没填 pattern 或没勾节点时不发请求，勾上后只发一次。UI LB 区块 10 passed（之前 9），全量 `npx vitest run` 103 文件 / 922 用例全绿，六张视觉基线未变（结果区默认隐藏），`npm run check` exit 0
- UI 基线：未重录；六张基线在全量测试里原样通过
- 设计偏差：LB-10 落地说明里「没保存的组得到 404 是预期行为，不是 bug」那句写错了——设计文档 §5.3 从没要求组必须先保存，那是 LB-09 自己实现出来的限制，已改写；其余无新增偏差
- 提交标题：`feat(load-balancing): [LB-14] verify a group from the card draft`
- 提交 SHA：`feb36ad`
- 备注：过程中踩了两次：`Array.isArray` 把 `readonly string[]` 收窄成 `any[]`，触发了 `@typescript-eslint/no-unsafe-assignment`，改用 `?? []` 后消失；`npm run package:electron:portable` 把 `better-sqlite3` 留在 Electron ABI 143，不 rebuild 直接跑 Node 测试会在 `openLogDatabase` 处炸 `NODE_MODULE_VERSION`。

### LB-15

- 状态：完成
- 来源：交付后的用户反馈。用户指出负载均衡卡片占满整行、与转发地址卡片视觉不统一，而「参与节点」一排复选框不对齐、「禁用」还被挤成竖排。
- 实际变更：`src/admin/static/app.css`（`.lb-groups` 改成与 `.targets-row` 相同的 `repeat(auto-fit, minmax(300px, 360px))` + `justify-content: start` + `align-items: start`，`.lb-card` 加 `align-self: start`；删掉旧的 `.lb-members` / `.lb-member` / `.lb-member-disabled`，新增 `.lb-members-field`、`.lb-selected`、`.lb-chip`、`.lb-picker`、`.lb-picker-pop`（含 `[hidden]`）、`.lb-member`（三列网格）、`.lb-off`）；`src/admin/static/app.js`（新增 `lbMemberOptionHtml`、`lbSelectedNodesHtml`、`lbSelectionSignature`、`lbDisabledTargetIds`、`toggleLbPicker`、`closeLbPickers`，`lbGroupCard` 把参与节点改成「卡片只列已选 + 浮层列全部」，`refreshLbCards` 按成员+禁用签名重建 `.lb-selected`，`handleLoadBalancerClick` 认 `[data-lb-picker-toggle]`，document `pointerdown` 与 `keydown` 关闭浮层，新增 `lbMembersNone` / `lbChooseNodes` 中英文案）；`test-node/ui/admin-ui.test.ts`（`tickMembers` 先开浮层再勾选，10 条旧用例改造，新增一条浮层用例，新增 `visualLbPairs()` + `loadLbBaseline()` 与两条整页基线用例，fixture 只保留第一个代理、两组各选两个启用的节点，因此没有禁用标记和警告）；新增基线 `doc/ui_lb_cn.png` / `doc/ui_lb_en.png`；`scripts/regen_ui_baselines.mjs`（捕获清单加这两张）；`docs/refactoring/ui-visual-baseline.md`（登记从八张改为十张，新增「负载均衡组卡片状态」一节）；`docs/ui-screenshot-assessment.md`。文档：README 负载均衡表与整页插图、功能说明书 §5.4、设计文档 §12.1 / §12.3 / §13.3。
- 测试命令：`npx vitest run test-node/ui/admin-ui.test.ts -t "admin UI load balancing groups"`、`REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui.test.ts -t "load balancing baseline"`、`npx vitest run test-node/ui/admin-ui.test.ts`、`npm run test`、`npx tsc -p tsconfig.json --noEmit`、`npm run lint`、`npx prettier --check .`；另用一个临时 `probe-lb.mjs`（跑完即删）在真实 Chromium 里量宽度、行高和浮层几何
- 测试结果：LB 区块 11 passed（之前 10，新增「lists every node in a floating picker…」）；视觉回归新增的两条负载均衡基线均通过，`admin-ui.test.ts` 88 passed（之前 86）；全量 103 文件 / 925 例全绿；类型、lint、格式检查通过。探针实测：组卡片宽 360 px 与转发地址卡片相同，打开浮层前后卡片高度都是 412 px，11 行选项行高均为 27 px（无换行无截断），「禁用」标记高 16 px（单行），点浮层外与 Esc 均关闭，一次只开一个浮层，卡片贴近页面底部时浮层朝上开且底边落在视口内
- UI 基线：新增两张整页基线并按用户三次反馈重录——`doc/ui_lb_cn.png`（1278 x 1167）= `76ace97b6e79fc42cb2efa113e211f67016b4ef779deb54ce550268a94927d75`、`doc/ui_lb_en.png`（1278 x 1212）= `0fc1e81ffdae89260b79d6a001458d122164b745b2b377c0cf3c44174f247b48`；`visualLbPairs()` 只留第一个代理卡片（第二个代理把整页撑到近 1800 px，用户要求去掉），两组都选了成员（第二组 Cloud relay 用轮转），并且成员全部启用——这张图要放 README，用户要求不出现「组里有禁用的节点，它不会参与选择」，所以 fixture 不再把第三个转发节点置为禁用；两张图都完整检视过，英文界面没有任何中文，节点标签没有被截断；原有八张基线未重录，在全量测试里原样全绿（代理页 fixture 的 `load_balancers` 仍为空数组，所以代理页基线字节不变）
- 设计偏差：无新增偏差；设计文档 §12.1 的「本 pair target 的勾选列表」按本次交互改写为「已选标签行 + 浮层复选框列表」
- 提交标题：`feat(load-balancing): [LB-15] match target card width and pick members in a floating list`
- 提交 SHA：`019560d`
- 备注：`display: grid` 盖掉 `[hidden]` 的 `display: none`，第一版探针因此报出「点外面没关掉」——补上 `.lb-picker-pop[hidden] { display: none }` 才正确；临时探针与四张临时截图已删除，没有遗留浏览器进程。

### LB-16

- 状态：完成
- 来源：用户结论「匹配预览输入和校验节点模型这两个功能没什么用，直接删掉」，
  并在追问里选了「界面和接口一起删」。
- 实际变更：`src/admin/static/app.js` 删掉 `.lb-preview` 整块、校验按钮与结果区、
  `runLoadBalancerModelCheck`、`lbPatternMatches`、`[data-lb-preview]` 监听、卡片点击里的校验分支
  和 11 个只给这两件事用的中英文案；`src/admin/static/app.css` 删掉 `.lb-preview`、
  `.lb-verify-*` 以及媒体查询里的 `.lb-preview`。
  `src/proxy/load-balancer-admin.ts` 删掉 `verifyModels`、`fetchModelList`、`readLimitedBody`、
  `modelIdsFromPayload`、三个类型、三个常量和 `LoadBalancerAdminOptions`，255 行变 137 行；
  `src/admin/admin-server.ts` 删掉路由、两个 schema、接口里的 `verifyModels` 和两个类型导入；
  `src/proxy/index.ts` 删掉 5 个导出。
  `test-node/admin/load-balancer.test.ts` 删掉整个 verify `describe`（6 条用例）、`jsonModelList`
  和校验类型导入，LB09-06 改成「服务缺席时 404，且模型校验路由已不存在」；
  `test-node/app/runtime.test.ts` 两处校验断言换成「这条路由已经不存在 → 404 `not_found`」；
  `test-node/ui/admin-ui.test.ts` 删掉 2 条用例、预览断言、stub 的 `verifyModels`、`lbVerify*`
  状态变量与 fixture，浮层布局探针从 `.lb-preview` 换成 `.lb-status`，溢出检测选择器去掉
  `.lb-preview`。
- 测试命令：`npx vitest run test-node/admin/load-balancer.test.ts test-node/app/runtime.test.ts`；
  `npx vitest run test-node/ui/admin-ui.test.ts`；
  `REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui.test.ts -t "load balancing baseline"`；
  `npx vitest run`。
- 测试结果：admin + runtime 8 passed；UI 86 passed（88 减去删掉的 2 条）；
  全量 103 文件 / 917 用例（之前 925，删掉 8 条）。
- UI 基线：已重录 `doc/ui_lb_cn.png`（1278×1075，
  `87918dca4a0eb5960f1d6647e6f4ab5af13a51f336a1127e2cbe2b8728f2e036`）和
  `doc/ui_lb_en.png`（1278×1120，
  `71f05d0dfbe373b5dc810eaaab58b6ce6adf56202552894f2211600a57397f36`），两张都比旧基线矮
  92 px；其余八张零像素差通过，代理页和统计页没动。
- 设计偏差：设计文档 §5.3（模型一致性校验）整节删除；§11 的 API 列表、§12.1 的卡片
  内容清单、§13.3 的验收清单各去掉一条；§12 落地说明里 LB-10 那条关于校验按钮的描述
  （含 LB-14 对它的改写）删掉，换成 LB-16 这一条。
- 提交标题：`feat(load-balancing): [LB-16] drop the match preview and the node model check`
- 提交 SHA：`c86295f`（功能与文档）；本条记录单独提交。
- 备注：删 `const draft = drafts[groupIndex] || {}` 时认定只有预览在用，其实 LB-15 的芯片行
  和节点状态行重建都靠它，恢复这一行之后才有 86 passed；第一轮 8 条失败里有 6 条是这个原因。
  第二个坑：用 `grep | head` 枚举待删引用被截断了，`[data-verify-lb-models]` 的一次点击留在
  轮询用例里，点了已经不存在的按钮，30 秒超时。

### LB-17

- 状态：完成
- 来源：用户反馈，两个下拉框颜色、大小不一致；选项中选了「统一成输入框样式」。
- 改之前两个控件的实测差（同一张卡片、同为 338 px 宽）：`select` 19 px 高、12 px 字、
  纯白底、系统画的 `1px #767676` 边框、直角、零内边距；`.lb-picker-toggle` 36 px 高、
  14 px 字、`#f1f5f9` 底、`1px #c8d2df`、6 px 圆角、`7px/10px` 内边距，箭头是自己写的
  `▾`（会被 Windows 的彩色字体接管，渲染出来带橙蓝颜色）。
- 实际变更：`src/admin/static/app.css` 新增一组 `.lb-card` 前缀的规则，把组名输入、
  pattern 输入、`select` 和 `.lb-picker-toggle` 共用一套长相（白底、`1px #b8c5d3`、
  6 px 圆角、`min-height: 32px`、13 px 字、悬停 `#eef3f8`、聚焦换accent 边框），
  `select` 加 `appearance: none` 并用 `--lb-arrow` 这张 SVG 画箭头；`.lb-card` 上定义了
  `--lb-arrow`，两处背景共用它。箭头hover 必须写 `background-color`，不能写 `background`，
  简写会把 `background-image` 洗掉。`src/admin/static/app.js` 把 `.lb-picker-caret` 里的
  `▾` 字符清空，换成一个 10×10 的空 span 画同一张 SVG。
- 测试命令：`node tmp-lb-unify.mjs`（探针量 computed styles 并裁两个下拉右端）、
  `node tmp-lb-arrow-diff.mjs`（pixelmatch 对比两张裁图）、
  `npx vitest run test-node/ui/admin-ui.test.ts`、
  `REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui.test.ts -t "load balancing baseline"`。
- 测试结果：两个下拉右端裁图 `differing pixels: 0 of 1088`；四项控件 computed styles
  全部为 338×32、13 px、`rgb(255,255,255)`、`1px solid rgb(184,197,211)`、6 px；
  UI 86 passed（其中负载均衡区块的窄屏溢出用例没因字号从 14 px 改成 13 px 而坏掉）。
- UI 基线：重录 `doc/ui_lb_cn.png`（1278×1082，
  `a12bab9313966d2e01b3c704a0ddec015348c4de1ce6b0691da80be781ffe9f5`）和
  `doc/ui_lb_en.png`（1278×1127，
  `b4fece8e773e42327d6ab8dc82d48694156d2bd4cada4784ef316ff9b3ae91c5`），两张都比 LB-16
  那版高 7 px；其余八张零像素差通过，代理页和统计页没动。
- 设计偏差：无。设计文档 §12.1 本来只列了卡片内容，没定控件长相；这次补了一条落地说明。
- 提交标题：`feat(load-balancing): [LB-17] give the group card one shared control look`
- 提交 SHA：`90f1215`（代码、测试基线与文档）；本条记录单独提交。
- 备注：`.lb-card` 前缀的规则特异性高于页面全局的 `button`（0,0,1）和 `button:hover`（0,1,1），
  所以能盖住它们；按 AGENTS 的说法 CSS 文件里靠后的块并不权威，这次是靠特异性赢的，
  不是靠位置。`▾` 这种几何字符在 Windows Chromium 上会被彩色字体替换，所以不能当图标用。

### LB-21（代理页布局：按钮换位 + 名称框定宽）

- 状态：完成
- 来源：用户看到 `doc/ui_lb_cn.png` 后提出三条：添加转发地址挪到「转发地址」标题行右边（和添加负载均衡组一样）、
  删除按钮挪到代理头部端口右边开关左边、代理名称框改固定宽度。
- 实际变更：`src/admin/static/app.js` 里 `renderPairs` 把 `.proxy-head` 的最后一个元素换成「删除」按钮再跟开关，
  原先光秃秃的 `<strong>转发地址</strong>` 包成 `.targets-head`（标题 + `[data-add-target]`），底部的
  `.row-actions` 整行删掉；`src/admin/static/app.css` 里 `.proxy-head` 改成五列
  `240px minmax(160px, 220px) 100px max-content 1fr`，`.targets-head` 并入 `.lb-section-head` 那条规则。
  列宽试错两次：`auto auto` 时删除按钮被拉到 316 px 宽，`min-content` 时「删除」折成两行 36 × 57 px；
  `max-content` + 末列 `1fr` 才对。
- 测试命令：`node tmp-pair-move.mjs`（量头部五格、量标题行、打字、点两个按钮、看窄屏）、
  `npx vitest run test-node/ui/admin-ui.test.ts`、`npx vitest run`、`node tmp-baseline-diff.mjs`。
- 测试结果：头部量到标题格 x = 31 宽 240 高 36、监听地址 x = 279 宽 220 高 33、端口 x = 507 宽 100 高 33、
  删除按钮 x = 615 宽 50 高 36、开关 x = 1205 宽 42 高 24，前四格 bottom 全对齐在 168。
  名称框 client 220，打进 `New proxy-renamed` 后 `scrollWidth === clientWidth`，打字与 `collectPairs` 都正常。
  「转发地址」标题行的添加按钮 x = 1141 宽 106、右边缘 1247 与该行右边缘齐平，和负载均衡区那颗按钮同一位置。
  点添加按钮 target 数从 2 变 3，点删除卡片数从 1 变 0，`.proxy-card .row-actions` 数量 `0`。
  窄屏 380 px 五格竖排（各 318 宽、删除按钮也 318 宽），不塌版。UI 93 passed；全量 105 文件 / 945 用例。
- UI 基线：受影响的是 proxy 中英文和 lb 中英文四张。proxy 两张视口固定，尺寸仍是
  `1278×1215` / `1278×1208`，新哈希 `8c56ef181f2fd753471ee115239e919ef03c3019a9793ac69f91347dc497870d` /
  `6aa2418e7b9c67e1add1f412fc92715de6a5c26f6d81f85fd2aba6df72fb3d78`；lb 两张是自适应视口，矮了 30 / 31 px 变成
  `1278×1150` / `1278×1194`，新哈希 `70cbcbbec9794509ca0f172c9b903f7a5362f82d5b3670b548febce8603c0957` /
  `c915168d4ee953e25b3a01a8a8d041e0ca35af6b1ad375e953f71e71490c89c9`。
  与 HEAD 按测试自己的 `threshold: 0.2` 逐像素比是 67716 / 62029 / 71858 / 66098 个像素差（4.0 – 4.9 %），
  差值真实。proxy 两张在重录之前也能过——又是比例容差加高度 ≤ 4 那条挡住的，跟 LB-20 同一个坑；
  lb 两张是被 `expected 30 to be less than or equal to 4` 拦下来的。
  另外 HEAD 上这四张基线是用户自己 `ab066cb` 那次重录的，本次是在其之上再重录。
- 设计偏差：设计文档 §12 只讲组卡片，代理卡片头部顺序与标题行按钮位置原先没有任何一处文档写过；
  已把 `docs/refactoring/ui-visual-baseline.md` 的代理页描述、功能规格 §11.2 补上位置和 240 px 定宽。
- 提交标题：`feat(ui): put add-target in the targets head and pair delete in the proxy head`
- 提交 SHA：`369e69b`；本条记录单独提交。
- 备注：这纯粹是代理页通用布局，不动负载均衡的逻辑。窄屏下删除按钮跟着字段铺满一整行，看着略宽，
  但和 760 px 以下其它按钮的行为一致。

### LB-20

- 状态：完成
- 来源：用户要求「卡片的删除按钮和启用开关换个位置」。
- 实际变更：`src/admin/static/app.js` 的 `lbGroupCard` 里把 `.lb-head` 的删除按钮与
  `label.switch` 调了先后，CSS 一行没改——`.lb-head` 是 `minmax(0, 1fr) auto auto` 自动放置，
  没有写死列位；删除按钮按 `[data-remove-lb]`、开关按 `[data-lb-toggle]` 匹配，没有任何代码
  按位置取这两个控件。
- 测试命令：`node tmp-lb-head.mjs`（探针量三个格子坐标、点开关、点删除、看窄屏）、
  `npx vitest run test-node/ui/admin-ui.test.ts`、`npx vitest run`、`node tmp-lb-head-diff.mjs`。
- 测试结果：探针量到组名框 x = 42、宽 234、高 32；删除按钮 x = 282、宽 50、高 36、底色
  `#f1f5f9`；开关 x = 338、宽 42、高 24；头部高 36，四个元素 `clipped` 全是 `false`。
  点开关 `checked` 变 `false`，点删除后 `.lb-card` 数量变 `0`；窄屏 380 px 三个格子
  仍在同一行（x = 42 / 240 / 296）。UI 88 passed；全量 103 文件 / 926 用例。
- UI 基线：换位置后先跑了一遍非重生成的比对，88 全过——这正是 AGENTS 记的那个陷阱，
  `screenshotDifference` 不重生成时只读不写，而且负载均衡基线用的是 0.12 的比例容差，
  局部换位的差值只有 0.2 %，根本拦不住。重录后中文 `1278×1180`
  （`7edccaf4966fbf3e1fcf321b4a0c0774a6f123beda3fd26411b06198426210bc`）、
  英文 `1278×1225`（`c496c9a3185aa0c385b7b522f40c35f9f9bb94f34a7cdc310a8b1e600136f0d3`），
  两张尺寸没变（两控件高度本来就差不多，文档高度不动）。与 HEAD 逐像素比是 2952 / 2900
  个像素差（约 0.2 %），两张 proxy 基线 0 像素差，其余六张原样通过。
- 设计偏差：设计文档 §12 的字段清单原先写「组名、启用开关、删除按钮」，已按新顺序改成
  「组名、删除按钮、启用开关」；基线文档里那句头部描述也跟着改了。
- 提交标题：`feat(load-balancing): [LB-20] put the group delete button before the enable switch`
- 提交 SHA：`2eb4b21`；本条记录单独提交。
- 备注：这次没有新增产品行为，纯粹是头部两个控件换位。探针里 `[data-lb-toggle]` 那个
  `<input>` 是隐藏元素，直接 `click()` 会等到超时，得点 `label.switch`——和浮动列表里
  的复选框要先点触发器是同一类问题。

### LB-19

- 状态：完成
- 来源：用户要求给负载均衡成员加自己的模型 id（`vllm-win -> Qwen3.8-Flash-Next-WIN`），
  每个勾选的节点一行：左边节点名、右边模型输入框，留空即不映射。选项里定了
  配置形状 `members: [{ target_id, model_id }]`（取代 `node_target_ids`）、保留浮动勾选列表 + 每行一个输入框、
  以及把真正发往上游的模型名记进日志。后续两条反馈：成员上方那行「已添加节点」标签删掉
  （下面的映射列表已经说明同一件事），节点名沿用原来标签的配色并带描边框；再一条反馈：
  名字框要和右边输入框等高。
- 实际变更：`src/config/config-schema.ts` 新增 `loadBalancerMemberSchema`，组的 `members` 用
  `min(1)`，重复 id 的路径改成 `members.N.target_id`，pair 校验路径跟着变成
  `pairs.0.load_balancers.0.members.N.target_id`，并加 `loadBalancerMemberTargetIds()` /
  `loadBalancerMemberModelId()`（空串归一成 `undefined`）；`src/config/config-normalizer.ts` 把旧的
  `node_target_ids` 折成 `members`、`model_id` 留空，按 `target_id` 去重但保留空 id 条目让 schema
  指出到底缺哪一个；`src/config/index.ts` 导出新形状。`src/proxy/proxy-request-pipeline.ts` 用
  `memberModelId ?? requestModel` 决定上游模型，`rewrittenBody` / `transformed` 改成可变，
  `#tryFailover` 连组一起返回，切换后按新成员的 `model_id` 重写请求体并更新
  `upstream_body` / `stripped_fields` / `injected_fields` / `model_route.upstream_model`；
  `load-balancer.ts`、`load-monitor.ts`、`load-balancer-admin.ts` 改读 `loadBalancerMemberTargetIds(group)`。
  管理端保存只接受 `members`，旧的纯 id 数组被拒。`src/admin/static/app.js` 新增
  `lbMemberIds` / `lbMemberModelId` / `lbMemberRowsHtml` / `lbMemberRowsSignature` / `lbCollectMembers`，
  卡片渲染成员行（名字框 + `data-lb-member-model` 输入框）、`purgeLoadBalancerMember` 按 `target_id`
  过滤、警告与 `collectPairs` 走成员列表，新增 `lbMemberModel` / `lbMemberModelPlaceholder` /
  `lbMemberModelHint` 三个中英词条；LB-19.1 删掉 `lbSelectedNodesHtml` 与卡片上的 `.lb-selected`，
  名字改用内层 `.lb-member-row-label` 承载省略号，并把启用状态加进行重建的签名。
  `src/admin/static/app.css` 加 `.lb-member-rows`（`minmax(0,5fr) minmax(0,7fr)`）、`.lb-member-row`、
  `.lb-member-row-name`（白底、`1px #b8c5d3`、6 px 圆角、32 px 高、13 px 字，与右边输入框等高）、
  `.lb-member-row-label`、`.lb-member-hint`，窄屏塌成单列；删掉 `.lb-selected` / `.lb-chip` / `.lb-chip-name`。
- 测试命令：`node tmp-lb19-ui.mjs`、`node tmp-lb-name.mjs`、`node tmp-lb-diff.mjs`、
  `npx vitest run test-node/config/ test-node/admin/load-balancer.test.ts test-node/admin/pairs.test.ts`、
  `npx vitest run test-node/proxy/ test-node/logging/load-balancer-log-records.test.ts`、
  `npx vitest run test-node/ui/admin-ui.test.ts`、`npx vitest run`、`npm run check`。
- 测试结果：新增 `LB19-01`（schema 修剪成员 id、缺省 `model_id`）、`LB19-02`（normalizer 折旧形状、
  去重、老组行为不变）、`LB19-03`（保存拒绝旧 id 数组，路径落在 `members`）、`LB19-06`（各成员发自己的
  模型名，后续轮次仍回同一节点）、`LB19-07`（切换后按应答节点的 `model_id` 重写，日志里出现
  `Model-On-B` 且没有 `Model-On-A`）、`LB19-10`（改映射名不会把已绑定任务挪走）、两条 UI 用例
  （每行一个输入框；取消勾选连行带映射一起消失）。UI 88 passed；全量 103 文件 / 926 用例；
  `npm run check` exit 0。探针量到三行的名字框都在 x = 42、宽 138 px，输入框都在 x = 188、宽 193 px，
  两框都是 32 px 高、13 px 字、圆角 6 px；整卡片只有一个元素被裁，就是那个超长节点名的内层 span
  （正是省略号该起作用的地方）；空态是 0 行 + 「未选择节点」+ 警告保持隐藏；取消勾选 target-a 之后
  只剩 target-b 一行，映射值还在，警告是「这个组只有一个节点，起不到均衡作用 组里有禁用的节点…」。
- UI 基线：加成员行后两张长到 1278×1207 / 1278×1252；LB-19.1 删掉标签行后各矮 27 px，
  现在中文 1278×1180（`4e1004c2d34c5e725999648281fe24855489fe9d476f57e56be45b96dbb9d20e`）、
  英文 1278×1225（`570ac996cf97ba0bd0b328ca774c7ed58407749b189c9859a61104243ea54fe0`）。
  与 HEAD 逐像素比对分别是 14539 / 13561 个像素差、底部多出的行有内容，属于真实画面变化；
  两张 proxy 基线 0 像素差，其余六张原样通过。
- 设计偏差：设计文档 §5.1 的 schema 草稿和 R4 原本写的是「组命中透传请求模型、成员映射屏蔽」；
  LB-19 把上游模型名改成由成员 `model_id` 决定，已同步改 §5.1、§5.2、§4.5、R4、决策 3 和
  ADR-013 决策 3（含「切换会连带换模型名」这条后果），`docs/module-design.md` 也补了成员形状。
- 提交标题：`feat(load-balancing): [LB-19] let each member carry its own upstream model id`
- 提交 SHA：`336e30a`（代码、测试、两张基线与面向用户的文档）；本条记录单独提交。
- 备注：一路踩到的坑——`LB19-06` 先是 `expected 'a' to be 'b'`，因为两轮用了相同的首条用户消息，
  exact key 把两个任务合成一个，换掉首条消息才对；UI 浮层重叠那条断言把探针从 `.lb-status` 换成
  `.lb-member-rows` 才通过；加行之后基线高度差 125 px 超了容差，必须重录；normalizer 那条把缺失的
  组期望写成非空成员，应是 `members: []`。TS7053 出在 `"model_id"` 不能索引那个联合类型，
  给 record 定成单一 `Record<string, unknown>` 就好了；lint 这边 `noPropertyAccessFromIndexSignature`
  要求方括号、`dot-notation` 又嫌方括号，真正报错的是那个联合类型——索引签名属性一律用方括号，
  并且给 `Array.isArray` 收窄出来的 `any[]` 元素标注 `unknown`。`npm run check` 第一遍撞上
  `connect ENOBUFS`（AGENTS 里那条 Windows 临时端口耗尽），单独跑那个文件 32 passed，重跑全量 exit 0。
  探针里 `window.state` 读不到（`state` 是词法全局），`uncheckAll` 在这份 playwright-core 1.62 里不存在，
  浮动列表的复选框要先点一次 `.lb-picker-toggle` 才可见。

### LB-18

- 状态：完成
- 来源：用户反馈：节点状态里打的是 `target-xxxx`，看不出是谁；宽度随内容变，位置一直动；
  都挤在一块。选项中选了「指标分两行、每行三列」+「名字 + 悬停看 id」+「只留状态词」。
- 实际变更：`src/admin/static/app.js` 重写 `lbStatusRowHtml(targetId, target)`（名字行 +
  两行三列指标，每枚芯片带 `title`），新增 `lbNodeRenderSignature(targetIds, targets)` 和
  `lbNodeStatesHtml`，两处调用点（初始渲染与 `refreshLbCards`）都改用它们；
  `data-lb-rendered` 的签名从「只拼 id」改成「id + 名字」，重命名才会重建行；
  `setLbFact` 同步更新 `title`；`enabled` 不再走 `setLbFact`，新 `setLbBadge` 只写状态词并
  切 `is-off` / `is-nosample` / `is-stale` 三个类。
  `src/admin/static/app.css` 把 `.lb-node-state` 从 wrap flex 改成三行 grid，新增
  `.lb-node-head` / `.lb-node-flag`（三个状态色）/ `.lb-node-metrics`，`.lb-node-fact` 加上
  `min-width: 0` + ellipsis，`.lb-node-states` 行间距从 6 px 提到 12 px。
- 测试命令：`node tmp-lb-states.mjs`（带状态 stub 的探针，量名字、标签、六列坐标）、
  `npx vitest run test-node/ui/admin-ui.test.ts`、`npx vitest run`、
  `npx vitest run test-node/admin/static-source.test.ts`。
- 测试结果：探针里两个节点的六列全部落在 x = 42 / 157 / 271、宽 109 px，`clipped` 全为
  `false`；名字行是 `vllm-win` / `vllm-win2`，`title` 是 `target-a` / `target-b`；第二个节点
  标签是「禁用 · 没有采样」，类名 `lb-node-flag is-off is-nosample`。UI 86 passed；
  全量 103 文件 / 917 用例。
- UI 基线：未变。负载均衡基线里节点状态 details 保持折叠，所以这两块的新排版不在画面里，
  八张基线零像素差原样通过。
- 设计偏差：无。设计文档 §12.1 原本只列了字段清单，没定行形状；这次补了落地说明。
- 提交标题：`feat(load-balancing): [LB-18] label node rows by name and fix the metric columns`
- 提交 SHA：`53379fd`（代码与文档）；本条记录单独提交。
- 备注：全量测试第一遍只有 `keeps the browser source canonically formatted` 一条失败——
  `test-node/admin/static-source.test.ts` 会拿 prettier 对比 `src/admin/static/app.js`，
  我写完没先跑 prettier 就被它拦下了。这个守卫比人工看格式快。节点名字进入渲染签名这件事
  是 AGENTS 里「任何改变标记的状态都要进渲染签名」那条的直接应用：原来只拼 id，
  重命名后行里的名字不会跟着变。

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

- [x] LB-01～LB-13 全部完成并有提交定位；
- [x] 同一 task 正常情况下保持单节点亲和（LB11-02、LB12 真机四轮全回原节点）；
- [x] 新 task 按固定字典序选择，metrics 缺失时能退化（LB05、LB08、LB12 死成员仍转发）；
- [x] 成员 `model_mappings` 屏蔽，上游模型名由成员自己的 `model_id` 决定（LB05、LB12 真机 404 文案、LB19-06/07/10）；
- [x] 价格规则一致，失败切换不造成无依据的 `unpriced`（LB06、LB12 快照停在原节点）；
- [x] 多 target `request_received` 时序和 `?ids=` pending 行为有测试（LB06-03、LB11-08）；
- [x] 每个前缀桶和每组绑定都有容量上限（LB03、LB11-10）；
- [x] matcher 与路由只对运行时可达证据承诺超集关系（LB02-08）；
- [x] canonical node key 不受本地 host 别名影响（LB04、LB12 `localhost` 归一）；
- [x] 无健康节点返回 503，不回落普通路由（LB07-06、LB11-06）；
- [x] reload、abort、failover、stop 后没有资源泄漏（LB04-04/05、LB11-07、LB11-11）；
- [x] API、UI、中文/英文基线和文档同步（LB09、LB10 基线哈希、LB13 四处文档、LB15 两张负载均衡整页基线）；
- [x] `npm run check` 或等价全量检查通过（2026-10-24，103 文件 / 917 用例）；
- [x] portable executable 构建完成并经过 artifact 检查（`release/LLM-Proxy-0.4.10-x64-portable.exe`）。
