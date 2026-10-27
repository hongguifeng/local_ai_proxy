# Task 路由功能实现 TODO

> 状态：计划中
> 权威性：执行状态记录，不是产品合同。
> 更新条件：任务状态、依赖或验收证据变化时更新。

当前状态：TRI-01～TRI-09 已验收并整合进主 checkout；TRI-10 已完成并整合进主 checkout（实现、测试、文档已收口）；TRI-11 阻塞——本机唯一可用的真实引擎属于用户正在运行的实例，按边界不得读取其负载，也不存在第二个隔离的
同模型引擎，因此三组对照实验无法在隔离环境中跑成；TRI-12 未开始，`auto` 今天不执行任何改绑，这一点由测试钉住。历史
整合过程和每项证据保留在本文后续完成记录中。

本文是供本地 AI 按依赖顺序执行的开发清单。每项任务都必须完成实现、测试、文档同步和本项验收后才能标记为完成。研究稿、模型比较文档和历史负载均衡文档只提供背景，不得覆盖设计权威中的状态、并发和安全合同。

## 1. 决策摘要

- 先建立 binding 身份、活动账本和指标完整性，再提供只读列表。
- 先完成手动迁移，再实现自动建议；自动执行必须经过真实引擎对照实验。
- 所有迁移路径共用 `moveBinding()`，不能让 UI、failover 和自动策略各自直接改写 `targetId`。
- 迁移是运行态动作，默认不跨重启持久化。
- task 是用户可见的历史关联对象，binding 才是代理可以实际迁移的对象。
- 缺失、过期、未知和零值必须分开处理；未知指标不能被转换为空闲。

## 2. 执行约定

每次只选择一个依赖已经完成的未完成任务。开发前先读取根目录 `AGENTS.md`、[现行架构](../../current/architecture.md)、[TODO 文档与执行流程](../../../.agents/skills/todo-workflow/SKILL.md)、本文对应任务引用的 skill 和设计文档章节。

状态只能使用“未开始”“进行中”“阻塞”“已完成”。部分实现保留为“进行中”，并在完成记录中写出剩余工作。任务 ID 应出现在新增测试描述、关键日志或提交说明中，例如 `[TRI-03]`。

每项完成时必须更新三处：

1. 第 4 节进度表的勾选和状态；
2. 该任务的完成记录，包括修改文件、测试、已知限制和实际结果；
3. 如实现改变设计合同，先修改 [task-routing-design.md](../../design/active/task-routing.md)，再继续代码，不要在代码和 TODO 中保留两套语义。

本清单不授权提交、推送、发布或操作用户正在运行的 portable 实例。验证必须使用隔离 fixture、临时配置、临时数据库、独立数据目录和空闲端口。

### 2.1 必须遵守的边界

| 范围       | 要求                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| 现行代码   | 以当前源码和测试为事实来源，历史 Python 文档只作背景。                                        |
| 运行实例   | 只读；不停止、不修改配置、不读写用户 traffic database，只杀自己启动的进程。                   |
| 请求数据面 | 保持响应字节、SSE、backpressure、取消、压缩透传和在途请求生命周期。                           |
| 迁移语义   | 只影响后续请求；不得中断当前请求、搬运 KV 或伪造上游状态迁移。                                |
| 身份       | 管理端使用 runtime epoch、group、binding ID 和 routing revision；不能只使用 binding 数字 ID。 |
| 数据库     | v1 不新增 traffic 表和 schema 版本；历史查询不得进入 proxy 热路径。                           |
| API        | 新增路由必须注册真实 service、请求/响应 schema 和 API contract 测试。                         |
| UI         | 只根据服务端状态决定按钮；显示 binding 影响范围、在途状态和迁移待生效状态。                   |
| 自动模式   | 默认关闭；未校准时 `auto` 运行状态必须降级为 advise，并返回 `not_calibrated`。                |
| 原生模块   | Node 测试和 Electron ABI 重建串行执行；Electron 重建后到打包前禁止 Node rebuild。             |
| 交付       | 最终执行 portable 打包、delivery smoke 和 Node ABI 恢复。                                     |

### 2.2 标准验证入口

| 编号 | 目的                      | 命令或技能                                                                                                                                                                                                        |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-D  | 文档格式、链接和任务依赖  | `git diff --check`；文档保持现有表格样式，局部修改后复核 `test-node/docs` 的文档结构与本地链接检查                                                                                                    |
| V-T  | 相关 Node 测试            | `npm test -- <实际测试文件>`，从大写盘符路径运行                                                                                                                                                                  |
| V-C  | 类型、lint 和模块边界     | `npm run typecheck`、`npm run lint`、`npm run check:modules`                                                                                                                                                      |
| V-A  | 管理 API 合同             | 阅读并遵循 [admin-api-probing](../../../.agents/skills/admin-api-probing/SKILL.md)                                                                                                                                      |
| V-R  | proxy 生命周期和 reload   | 阅读并遵循 [proxy-runtime](../../../.agents/skills/proxy-runtime/SKILL.md)                                                                                                                                              |
| V-U  | UI 模块、DOM 和浏览器测试 | [static-checks-and-split](../../../.agents/skills/static-checks-and-split/SKILL.md)、[ui-markup-contracts](../../../.agents/skills/ui-markup-contracts/SKILL.md)、[ui-test-quirks](../../../.agents/skills/ui-test-quirks/SKILL.md) |
| V-B  | UI 截图和基线             | [ui-baseline-regen](../../../.agents/skills/ui-baseline-regen/SKILL.md)，运行 `npm run regen:ui-baselines`                                                                                                              |
| V-E  | 真实上游收益实验          | [real-upstream-acceptance](../../../.agents/skills/real-upstream-acceptance/SKILL.md)                                                                                                                                   |
| V-P  | 交付产物                  | `npm run package:electron:portable`、`npm run smoke:delivery`、`npm run abi:node`                                                                                                                                 |

`docs/` 被默认 Prettier 忽略。新建或整篇重写的文档使用显式 `--ignore-path .gitignore`；已有表格密集文档的局部修改使用 `git diff --check`、文档结构测试和本地链接检查。过滤测试必须确认实际匹配了测试；项目 `passWithNoTests` 关闭，空匹配不是通过。

## 3. 进度与依赖

| 完成 | ID     | 优先级 | 任务                                 | 前置任务               | 状态   |
| ---- | ------ | ------ | ------------------------------------ | ---------------------- | ------ |
| [x]  | TRI-01 | P0     | 固定身份、版本和迁移合同             | 无                     | 已完成 |
| [x]  | TRI-02 | P0     | 实现 binding 投影和活动账本          | TRI-01                 | 已完成 |
| [x]  | TRI-03 | P0     | 修复指标完整性并建立自动判定输入     | TRI-01                 | 已完成 |
| [x]  | TRI-04 | P1     | 实现 task/binding 历史关联查询       | TRI-02                 | 已完成 |
| [x]  | TRI-05 | P1     | 建立只读管理 API 和服务装配          | TRI-02、TRI-03、TRI-04 | 已完成 |
| [x]  | TRI-06 | P1     | 实现节点 binding 列表 UI             | TRI-05                 | 已完成 |
| [x]  | TRI-07 | P1     | 实现统一安全迁移服务                 | TRI-01、TRI-02、TRI-03 | 已完成 |
| [x]  | TRI-08 | P1     | 实现手动迁移 API、幂等和生命周期处理 | TRI-04、TRI-05、TRI-07 | 已完成 |
| [x]  | TRI-09 | P1     | 实现手动迁移 UI 和真实请求验证       | TRI-06、TRI-08         | 已完成 |
| [x]  | TRI-10 | P2     | 实现 advise 模式和建议状态           | TRI-03、TRI-07、TRI-09 | 已完成 |
| [ ]  | TRI-11 | P2     | 真实引擎校准并决定是否开启 auto      | TRI-10                 | 阻塞   |
| [ ]  | TRI-12 | P2     | 自动执行、最终回归和交付收口         | TRI-11                 | 未开始 |

## 4. 任务明细

### TRI-01：固定身份、版本和迁移合同

入口：[设计文档](../../design/active/task-routing.md) 第 4、5 节；[load-affinity.ts](../../../src/proxy/load-affinity.ts)、[load-balancer.ts](../../../src/proxy/load-balancer.ts)、[proxy-runtime-registry.ts](../../../src/proxy/proxy-runtime-registry.ts)。

- [ ] 逐一搜索 `bind()`、`lookup()`、`bind(...allowRebind)`、`rebind()`、failover 和配置 reload 的全部写入口。
- [ ] 定义 `runtimeEpoch` 的生成和生命周期：pair 启动生成，listener 不变 reload 保持，pair stop/start 和进程重启更换。
- [ ] 定义 `groupRevision`、`routingRevision` 和 binding incarnation 的作用域、初值、递增入口和失效规则。
- [ ] 保证管理 API 不把单独的数字 `bindingId` 当作跨重启稳定 ID。
- [ ] 为 `pending_boundary`、`applied`、`observed`、`cancelled`、`expired` 和 `expired_after_apply` 建立共享类型或明确内部合同。
- [ ] 写一张当前写入口与新版本更新入口的映射表，确认 failover 也会使旧 revision 失效。
- [ ] 增加只验证身份和版本语义的单元测试，不在本项提前改变路由选择。

验收：旧 binding 被 TTL/LRU 淘汰后，迟到 reservation 不能更新新表中复用的数字 ID；重启后的旧管理请求不能作用于新 runtime；所有改变目标的路径都能被版本观察到。

验证：V-T，运行 `test-node/proxy/load-affinity.test.ts`、`test-node/proxy/load-balancer.test.ts`、`test-node/proxy/load-balancer-integration.test.ts` 和 reload 相关测试。若发现写入口遗漏，保持本项进行中。

### TRI-02：实现 binding 投影和活动账本

入口：[load-affinity.ts](../../../src/proxy/load-affinity.ts)、[load-balancer.ts](../../../src/proxy/load-balancer.ts)、[proxy-request-pipeline.ts](../../../src/proxy/proxy-request-pipeline.ts)。

- [ ] 增加无副作用的 binding snapshot/entries 投影；列表查询不得调用会 touch `lastSeenAt` 或 `requestCount` 的 `lookup()`。
- [ ] 在 LoadBalancer 内建立 binding incarnation 对应的活动账本，至少覆盖 `inFlight`、开始/结束时间、最近请求环、请求字节数、最近 usage 成本信号和人工保护状态。
- [ ] 将活动加一放在 reservation 真正建立的位置，将活动减一放在完整响应处理和释放路径之后。
- [ ] 让 reservation 捕获自己的 incarnation、target ID 和 release 状态；重复 release、迟到 release 和 binding 删除都不能造成负数或复活对象。
- [ ] 在 usage 完成后回填 input token、cache read token 和来源；缺失 usage 时保留 `none` 或 `request_bytes`，不得伪造 token。
- [ ] 明确应用 reload、stop、group 删除、TTL/LRU 淘汰和 failover 时活动账本的清理顺序。
- [ ] 不把 traffic pending 行当作实时锁；如果使用它做历史展示，必须标注历史来源。

验收：长 SSE、上游错误、客户端取消、连接期 failover、日志写入失败和重复释放都能保持活动计数正确；读取 snapshot 不改变 TTL、次数或目标。

验证：V-T，运行 proxy pipeline、load-balancer、load-affinity、SSE 和 logging 相关测试。新增测试必须覆盖“binding 已淘汰但请求仍在途”。

### TRI-03：修复指标完整性并建立自动判定输入

入口：[load-monitor.ts](../../../src/proxy/load-monitor.ts)、[load-metrics.ts](../../../src/proxy/load-metrics.ts)、[load-balancer.ts](../../../src/proxy/load-balancer.ts)。

- [ ] 修改 load sample 类型，区分 `running`/`waiting` 缺失、过期、明确为零和明确为非零。
- [ ] 检查 `toLoadSample()` 和所有消费者，禁止把缺失字段转换成自动策略可用的零。
- [ ] 按 `canonicalKey` 去重物理引擎采样；保留 target 级 reservation 计数，不把同一物理引擎的指标重复相加。
- [ ] 为采样序号、时间戳、完整性、awake、cooldown 和指标来源建立纯判断输入。
- [ ] 验证现有 5 秒采样、15 秒新鲜窗口和 4 秒超时的实际语义；它们只能作为现状事实，不能直接成为自动阈值。
- [ ] 为重复样本、字段缺失、部分样本、相同 physical key、多 target alias 和 stale sample 增加测试。
- [ ] 不在本项实现自动改绑，只提供可靠的判定输入。

验收：只有 KV 指标的新鲜样本不会被判为空闲；同一采样序号不会重复增加稳定次数；同物理节点的 alias 不会制造虚假容量。

验证：V-T，运行 `test-node/proxy/load-monitor.test.ts`、`test-node/proxy/load-metrics.test.ts`、`test-node/proxy/load-balancer-selection.test.ts`。保留一个最小探针证明缺失字段的输出。

### TRI-04：实现 task/binding 历史关联查询

入口：[task-matcher.ts](../../../src/logging/task-matcher.ts)、[traffic-log-service.ts](../../../src/logging/traffic-log-service.ts)、[task-store.ts](../../../src/persistence/task-store.ts)、[repository.ts](../../../src/persistence/repository.ts)。

- [ ] 先核对 `context_links`、`response_links`、`tasks`、`records` 的现有索引、写入口和查询返回，确认 exact key 到 task 的方向。
- [x] 增加只读查询，将 binding exact key 映射为 `high`、`candidate` 或 `none`，候选必须匹配完整边界（含 `first_user`）、物理 target 和活动窗口，不把候选关联升级为唯一身份；混合 `high`/`candidate` 集合的 aggregate confidence 为 `candidate`。
- [ ] 返回多个 task 时保留完整覆盖范围、歧义和置信度；一个 binding 关联多个 task 时不得挑一个代表项。
- [ ] 以有界分页和查询上限读取历史，避免在 2 秒 UI 轮询中执行无界 `COUNT(DISTINCT)` 或逐条读取正文。
- [ ] 让查询使用正确的日志根和 URL/canonical target 口径；不要把 `tasks.target` 的 URL 直接当成 canonical physical key。
- [ ] 历史-only task 只能作为只读信息；没有当前 binding 时不返回可迁移操作。
- [ ] 明确没有日志、异步日志尚未落库、旧 task 被清理和历史查询失败时的 coverage 字段。

验收：查询不会创建 binding、续期 TTL、增加 requestCount 或进入代理热路径；合成夹具能验证精确关联、多个候选和无关联三种结果。

验证：V-T，运行 logging、persistence、task-store 和历史查询相关测试；保留查询夹具的对象数、索引和执行计划说明。禁止读用户实例数据库做性能验证。

### TRI-05：建立只读管理 API 和服务装配

入口：[load-balancer-admin.ts](../../../src/proxy/load-balancer-admin.ts)、[admin contracts](../../../src/admin/admin-contracts.ts)、[admin schemas](../../../src/admin/admin-schemas.ts)、[load-balancer route](../../../src/admin/routes/load-balancer.ts)、[admin-services.ts](../../../src/app/admin-services.ts)。

- [x] 扩展现有负载均衡状态服务，返回节点状态、binding snapshot、活动字段、历史关联和 `movable` 原因。
- [x] 增加 `GET /api/load-balancer/tasks`，支持 pair、group、target、limit、offset，设定服务端上限。
- [x] 响应禁止 exact key、session ID、请求正文、用户消息哈希、认证信息和 API key。
- [x] 为请求和响应建立闭集 schema；明确 `unknown`、`none`、空数组、截断 coverage 和历史失败的表示。
- [x] 将新服务接入完整应用装配和 `REQUIRED_ADMIN_SERVICES`；空配置下路由行为必须是稳定的合法结果。
- [x] 更新 `test-node/admin/api-contract.test.ts`，钉住路由、顶层响应键、schema 和服务缺失行为。
- [x] 为 404、400、500 分别确认是 binding 不存在、参数校验失败还是服务错误，不让 UI 用 undefined 猜测。

验收：真实应用装配能够注册接口；查询不会改变 binding；响应只包含设计文档允许的投影；历史查询失败能诊断且不破坏代理响应。

验证：阅读并执行 V-A；运行 `test-node/admin/load-balancer.test.ts`、`test-node/admin/api-contract.test.ts`、相关 schema 测试和 `npm run check:modules`。

### TRI-06：实现节点 binding 列表 UI

入口：[load-balancing.js](../../../src/admin/static/modules/load-balancing.js)、相关 UI 模块、[admin-ui-load-balancing.test.ts](../../../test-node/ui/admin-ui-load-balancing.test.ts)。

- [x] 在现有负载均衡状态卡片的节点行下增加可展开 binding 列表，不创建全局 task 页面。
- [x] 分开显示 binding 数、inFlight、最近请求、最后服务 target、关联 task 数、置信度和状态 unknown。
- [x] 对共享 binding 显示受影响 task 数和覆盖范围；没有精确关联时显示 unknown 或 candidate。
- [x] UI 不自行判断可迁移性，只使用服务端 `movable.ok` 和原因。
- [x] 处理空态、加载态、历史截断、查询失败、窄屏、长模型名、中英文和刷新期间未保存状态。
- [x] 保持已有轮询和生命周期，避免重复 listener、重复 timer 和旧响应覆盖新状态。
- [x] 遵循 UI markup、render internals 和 static module 的现有合同，不引入第二套全局状态。

验收：页面不会把 binding 数称为 task 数；没有在途请求、unknown 指标和多 task 关联时文案准确；刷新和展开状态符合现有 UI 行为。

验证：阅读 V-U 相关 skills；运行 UI lint、typecheck、`test-node/ui/admin-ui-load-balancing.test.ts` 和相关 DOM contract 测试。修改 UI 后运行 V-B，检查全尺寸截图、英文截图中的中文残留和基线哈希。

### TRI-07：实现统一安全迁移服务

入口：[load-balancer.ts](../../../src/proxy/load-balancer.ts)、[load-affinity.ts](../../../src/proxy/load-affinity.ts)、[proxy-request-pipeline.ts](../../../src/proxy/proxy-request-pipeline.ts)。

- [x] 实现唯一的 `moveBinding()` 入口；手动、自动和需要统一版本语义的 failover 不得直接赋值 `targetId`。
- [x] 在提交和实际应用两个时点检查 runtime epoch、group revision、routing revision、源 target、目标成员、enabled、cooldown、明确 asleep 和 canonical physical key。
- [x] v1 要求源目标与目标成员的 `model_id` 相同；目标模型不同必须返回明确原因。
- [x] 实现 `previous_response_id` 和未知 server-side state 的保守拒绝门；不能用 conversation 字段本身假定状态可迁移。
- [x] 实现 `inFlight === 0` 时立即应用、有在途请求时进入 pending boundary 的状态机。
- [x] 将 pending 操作保存为有界、运行态的 operation；它必须包含创建时的 revision、runtime epoch、目标和幂等摘要。
- [x] 绑定应用顺序固定为重新读取/验证、递增 revision、统一经 `rebind()` 改变目标；服务自己不建 reservation，只有下一次请求的 `plan()` 建，保证同一事件循环内不被另一个 plan 插入。
- [x] 设计并测试取消、目标失效、reload、failover、group 删除、pair 停止、TTL/LRU 清理和迟到 release。
- [x] 审计操作原因，但不写入请求正文、exact key 或用户消息。

验收：手动和自动调用相同服务；在途请求不被改变；目标失效和 revision 冲突不产生部分改绑；迟到回调不能复活 binding。

验证：V-R；运行 `test-node/proxy/load-balancer.test.ts`、`load-balancer-pipeline.test.ts`、`load-balancer-integration.test.ts`、`load-affinity.test.ts`，新增长 SSE 和 failover 竞态测试。

### TRI-08：实现手动迁移 API、幂等和生命周期处理

入口：[load-balancer route](../../../src/admin/routes/load-balancer.ts)、[admin schemas](../../../src/admin/admin-schemas.ts)、[load-balancer-admin.ts](../../../src/proxy/load-balancer-admin.ts)。

- [x] 增加 `POST /api/load-balancer/task-moves`，请求包含 pair、group、runtimeEpoch、bindingId、expected revision、expected source、destination 和 idempotency key。
- [x] `applied` 返回 200，存在在途请求返回 202 `pending_boundary`，同目标重复提交返回 `already_there`。
- [x] 增加 `DELETE /api/load-balancer/task-moves/:operationId`，只允许取消尚未应用的 operation。
- [x] 实现并固定 `binding_not_found`、`binding_stale`、`idempotency_conflict`、`target_not_eligible`、`operation_expired` 和 `state_not_migratable` 错误。
- [x] 同 runtime epoch、同参数、同幂等键重试返回原结果；同键不同参数返回 409；重启后旧幂等键不能作用于新运行态。
- [x] 接入 `test-node/admin/api-contract.test.ts` 和真实应用装配，不允许只在 mock service 上通过。
- [x] 在路由记录中写入 source、destination、movedBy、operation/suggestion ID 和 revision，使 `observed` 可以由后续请求确认。

边界：本项不动 `GET /api/load-balancer/tasks` 的 `migration` 与 `movable` 字段——把列表接到迁移
服务上是 TRI-09 的工作，否则 TRI-06 先交付的按钮会变成能点、点了无效的按钮。

验收：两个页面同时提交旧 revision 时只有一个成功；请求客户端重试不会重复改绑；应用成功和业务成功分开显示；接口不会返回正文或敏感身份键。

验证：V-A、V-T；运行 admin、proxy integration、error 和 logging 相关测试。对每种 HTTP 错误至少有一个真实路由测试。

### TRI-09：实现手动迁移 UI 和真实请求验证

入口：[load-balancing.js](../../../src/admin/static/modules/load-balancing.js)、UI API helper、[admin-ui-load-balancing.test.ts](../../../test-node/ui/admin-ui-load-balancing.test.ts)。

- [x] 把节点列表的 `migration` 与 `movable` 接到 TRI-07 的迁移服务上，按钮只在服务端说可以时才可用。
- [x] 增加目标选择器和“只影响下一次请求”的明确文案。
- [x] `inFlight > 0` 时允许登记 pending，但不显示“已迁移”；应用、观察、过期、取消和冲突状态要分别显示。
- [x] 冲突时保留用户选择，刷新当前 binding 行，并提示状态已变化；不要静默重试覆盖新 revision。
- [x] 多 task binding 显示影响范围，目标 unknown 显示警告，明确不可用时禁用提交。
- [x] 通过浏览器测试验证完整流程：展开节点、查看 binding、提交迁移、看到 pending/applied、发起下一请求、看到 observed。
- [x] 增加一个长 SSE 集成用例，证明迁移期间旧响应完整结束且下一请求才去目标节点。
- [x] 按 UI skill 更新视觉基线和英文截图检查；本轮没有新增样式，CSS cascade 审计因此不适用。

验收：用户能够从节点列表完成一次安全的 binding 迁移；页面不会把 API accepted 显示为业务已迁移；重启和 reload 后状态文案符合运行态合同。

验证：V-U、V-B、V-R；运行相关 UI、proxy integration、视觉和 API 测试。记录截图和测试结果，不以单纯 API 200 代替浏览器验证。

### TRI-10：实现 advise 模式和建议状态

入口：[config schema](../../../src/config/config-schema.ts)、[load-monitor.ts](../../../src/proxy/load-monitor.ts)、新增纯判定模块、[load-balancer-admin.ts](../../../src/proxy/load-balancer-admin.ts)。

- [x] 在 group 配置中增加 `rebalance_mode: "off" | "advise" | "auto"`，默认 `off`，同步 schema、normalizer、读写和配置测试。
- [x] 将失衡判定、候选排序和 suggestion 生命周期放入不直接访问网络或数据库的纯模块。
- [x] 只在完整、新鲜、去重后的指标和安全候选同时满足时生成建议；缺失指标、旧样本和重复采样不产生稳定判定。
- [x] 候选必须满足零在途、同模型、不同 physical key、无 server-side state 风险、非人工保护和预算未超限。
- [x] 增加 `suggested`、`unused`、`rejected`、`expired` 原因和建议详情，但不要在 advise 模式改变 binding。
- [x] 复用现有 monitor timer 和 unref/stop 生命周期；不要让建议只在 UI 页面打开时运行。
- [x] 增加状态 API 投影，明确 `auto` 尚未校准时返回 `disabledReason: "not_calibrated"`，运行行为等同 advise。

验收：`off` 不计算自动动作，`advise` 只提供候选，未校准的 `auto` 不改绑；同一旧样本不能重复累计稳定次数；建议不泄露请求内容。

验证：V-T、V-R；运行 load-monitor、load-balancer、config、admin API 测试。为候选算法保留可复跑合成探针，先断言夹具确实创建多个独立 binding，再测耗时。

### TRI-11：真实引擎校准并决定是否开启 auto

入口：[real-upstream-acceptance](../../../.agents/skills/real-upstream-acceptance/SKILL.md)、设计文档第 7.6 和第 11 节、隔离实验脚本目录。

- [ ] 使用独立应用配置、独立 `LLM_PROXY_DATA_DIR`、绝对日志根、空闲管理端口和隔离 upstream；不得触碰用户实例。
- [ ] 固定相同模型、上下文档位、轮次数、并发、节点配置、缓存初始条件和客户端脚本。
- [ ] 至少比较三组：不迁移基线、手动安全边界迁移、自动建议/执行策略。
- [ ] 记录整体任务完成时间、任务级尾延迟、TTFT、生成吞吐、错误率、input/cache token、源 waiting、目标 waiting、迁移后实际轮数和 unused 比例。
- [ ] 预先写出可推翻 auto 的门槛；不能以一次 TTFT、KV 比例、节点均匀度或合成查询耗时作为开启依据。
- [ ] 记录模型/协议是否保存 response 或其它 server-side state；未证明共享时继续拒绝这类迁移。
- [ ] 把实验版本、输入、样本数、前置断言、原始结果和有效范围写入实验记录。
- [ ] 如果收益不足或错误/额外成本超限，明确结论为保持 `advise`，不要为了完成任务调整阈值。

验收：实验能证明或否定自动迁移对整体完成时间和尾延迟的收益；能够给出稳定窗口、源忙阈值、目标静默时长、候选成本上限、冷却和预算的来源。没有证据时本项保持阻塞，不能勾选完成。

验证：V-E。实验脚本不得启动、停止或读写用户 portable 实例；完成后保留隔离实例日志和清理结果。

### TRI-12：自动执行、最终回归和交付收口

入口：计划新增的 `src/proxy/load-rebalance.ts`、[load-monitor.ts](../../../src/proxy/load-monitor.ts)、[load-balancer.ts](../../../src/proxy/load-balancer.ts)、[proxy-request-pipeline.ts](../../../src/proxy/proxy-request-pipeline.ts)、设计文档第 7、9、11 节。

- [ ] 只有 TRI-11 明确通过后，才允许 `auto` 在运行态执行；把已校准参数和来源写入配置/设计记录。
- [ ] 自动动作只在下一次请求的 `plan()` 边界应用，不在后台直接移动长期空闲 binding。
- [ ] 应用前重新检查 suggestion、runtime epoch、group/routing revision、inFlight、目标、协议、model 和指标。
- [ ] 实现 binding 冷却、group 迁移预算、episode 上限、目标承诺上限、A→B 防回摆和失败熔断。
- [ ] 自动动作通过 `moveBinding()`，写入 `movedBy: "auto"`、source、destination、suggestion ID、成本信号和 revision。
- [ ] auto 被关闭时停止新动作，不自动回迁已应用 binding；目标变化、failover、reload、TTL/LRU 和重启按设计失效。
- [ ] 完成 TR-01～TR-08 的需求追踪，逐项检查测试、API、UI 和文档是否一致。
- [ ] 运行完整 `npm run check`，修复本次引入的问题并区分既有失败。
- [ ] 运行 UI 基线、全尺寸截图和英文截图检查。
- [ ] 最后执行 `npm run package:electron:portable`、`npm run smoke:delivery`、`npm run abi:node`；检查 packaged app 不是 stale output，且只杀自己启动的进程。
- [ ] 更新本文完成记录、最终设计文档的实施状态和遗留问题；不把“代码合并”写成“收益已证明”。

验收：自动策略具备可解释的建议/应用/观察/未使用/拒绝状态；真实对照实验支持开启，否则仍保持 advise；全量质量门禁、便携版打包、交付冒烟和 Node ABI 恢复均通过。

验证：V-T、V-C、V-U、V-B、V-P、V-E。最终报告必须分别列出逻辑安全测试、真实收益实验和交付产物结果。

## 5. 需求追踪矩阵

| 需求                                    | 主要任务                       | 最终证明                                   |
| --------------------------------------- | ------------------------------ | ------------------------------------------ |
| TR-01 按节点列出 binding 与 task 覆盖   | TRI-02、TRI-04、TRI-05、TRI-06 | API contract、历史关联测试、UI 截图        |
| TR-02 分开 binding、inFlight 和历史服务 | TRI-02、TRI-05、TRI-06         | 响应字段测试和 UI 行为测试                 |
| TR-03 明确 binding 影响范围             | TRI-04、TRI-06、TRI-08、TRI-09 | 多 task binding 夹具、API 和浏览器测试     |
| TR-04 在途不被迁移打断                  | TRI-02、TRI-07、TRI-08、TRI-09 | 长 SSE 集成测试、failover/reload 测试      |
| TR-05 版本冲突和幂等                    | TRI-01、TRI-07、TRI-08         | 并发旧 revision、网络重试、重启测试        |
| TR-06 自动安全门                        | TRI-03、TRI-07、TRI-10、TRI-12 | 缺失指标、旧样本、物理去重、预算和熔断测试 |
| TR-07 可追踪且不泄露                    | TRI-04、TRI-05、TRI-08、TRI-12 | schema 拒绝敏感字段、路由元信息和日志测试  |
| TR-08 真实收益评价                      | TRI-10、TRI-11、TRI-12         | 三组真实引擎对照和最终实验记录             |

## 6. 明确不做的工作

- 不在 TRI-01～TRI-10 阶段实现后台自动改绑。
- 不通过新增 traffic schema 保存 binding、迁移操作或客户端会话身份。
- 不把 task ID 强行作为 binding ID 的唯一替代，不删除共享 binding 的影响范围。
- 不以 pending 日志行、KV 使用率、requestCount 或节点均匀度单独判定 task 活跃或迁移收益。
- 不在目标模型不兼容、server-side state 未证明共享或目标 physical key 相同的情况下提供强制迁移按钮。
- 不把 stale/partial metrics 补成零来让自动测试通过。
- 不为了让 UI 通过而在前端复制服务端迁移判定。
- 不修改用户正在运行的 portable 实例，不读取其配置或 traffic database。
- 不在没有 TRI-11 实验结果时把 `rebalance_mode` 默认改为 `auto`。

## 7. 已完成任务记录

TRI-01～TRI-09 的详细实现、复审、整合和交付证据已经移到[历史完成记录](../../reports/task-routing-tri-01-09-history.md)。本计划只保留当前任务的完成记录和未完成任务，避免历史整合过程遮蔽当前依赖。

### TRI-10

- 状态：已完成（主分支已整合提交 `5e458ef`、`2924801`；文档记录来自原隔离实现提交 `80483a0` 和测试修正提交 `51fae58`）。
- 修改文件：该提交共 30 个文件。产品侧 8 个：新增 [load-rebalance.ts](../../../src/proxy/load-rebalance.ts)（纯判定：
  失衡、候选排序、建议状态机，不碰网络也不碰数据库），修改 [config-schema.ts](../../../src/config/config-schema.ts)
  （`loadBalancerRebalanceModeSchema` 与 `rebalance_mode`，默认 `off`）、
  [config-normalizer.ts](../../../src/config/config-normalizer.ts)（缺失读 `off`、命名值去空格、未知文本原样交给 schema
  报出 group 路径，与既有 `normalizeLoadBalancerStrategy` 同形）、[config/index.ts](../../../src/config/index.ts)、
  [proxy/index.ts](../../../src/proxy/index.ts)、
  [load-balancer-admin.ts](../../../src/proxy/load-balancer-admin.ts)（状态里的 group 多一个 `rebalance` 块）、
  [load-monitor.ts](../../../src/proxy/load-monitor.ts)（advisor 挂在采样 tick 上、入口丢弃、停止清理、日志）与
  [admin-schemas.ts](../../../src/admin/admin-schemas.ts)（`loadBalancerRebalanceDto` 与它内部的闭合建议 DTO）。
  测试侧 22 个：新增 `test-node/proxy/load-rebalance.test.ts`（24 项 `[TRI-10]`）；
  `test-node/proxy/load-monitor.test.ts` 追加 6 项 `[TRI-10]`；`test-node/admin/load-balancer.test.ts` 追加 4 项
  `[TRI-10]`；`test-node/admin/pairs.test.ts` 追加 2 项 `[TRI-10]`；`test-node/config/` 三份各 1 项。其余 12 份测试
  文件各一至二行：给负载均衡 group 夹具显式写出 `rebalance_mode: "off"`，不让夹具靠隐式默认。UI 侧只动两处测试
  桩——`test-node/ui/admin-ui-fixture.ts` 的状态夹具补上服务现在会答的 `rebalance` 块，
  `test-node/ui/admin-ui-server.ts` 存盘前像真实路由一样先 `normalizeLoadBalancerGroups`。收口审查后的测试修正另成
  一个提交，只动 `test-node/proxy/load-monitor.test.ts` 一个文件（见下面的提交段）。
- 验证：`npm run check` 从大写盘符 `exit 0`：Prettier 全绿、lint `--max-warnings=0` 零告警、`tsconfig.json` 与
  `tsconfig.ui.json` 两份 typecheck 均 `exit 0`、`check:modules` 报 139 模块 / 327 运行时边 / 120 类型边 /
  0 环 / 0 越界、Vitest 150 文件（149 通过、1 跳过）与 1571 项（1569 通过、2 跳过）、`build` 通过。按 AGENTS.md
  的声明式口径复核 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" HEAD~1 -- test-node` 为 1362、提交后为 1400，
  测试文件数 149 → 150；38 项增量正等于新文件 24 + load-monitor 5 + admin load-balancer 4 + pairs 2 +
  config 三份各 1，没有用例被删掉。定向复跑：`npx vitest run test-node/proxy/load-rebalance.test.ts
test-node/admin/load-balancer.test.ts` 连续八次并发运行全过（24 + 10 项）；
  `npx vitest run test-node/config/ test-node/admin/` 27 文件 289 项全过；
  `npx vitest run test-node/ui/admin-ui-visual.test.ts test-node/ui/admin-ui-load-balancing.test.ts` 2 文件
  70 项全过。全量链第一次跑在日志键断言上红了一项，定位到上面第三条修正后重跑：
  `npx vitest run test-node/proxy/load-monitor.test.ts` 独跑十次全过（15 项），`npm run check` 再次 `exit 0`。
  五项变异各自被抓回：把 `off` 组也送进 advisor → `computes nothing while off` 失败；去掉
  `runtimeEpoch` 失效检查 → 命名失效原因的项失败；把稳定阈值 `stable < min` 写成 `<=` → 14 项失败；去掉人工保护门
  → `spares a binding a human protected` 失败；给建议日志多打一个字段 → `logs a suggestion with ids, targets and
  numbers only` 失败。变异全部还原后复跑，`git status` 只剩本次授权的文件。
- 已成立的语义：模式属于 group，默认 `off`，`off`/`advise`/`auto` 是唯一三个合法文本，写错拼法是 400 并点名
  `pairs.0.load_balancers.0.rebalance_mode`，不会静默降级成 `off`；`rebalance_mode` 经
  `ConfigRepository` 存盘再读回不丢也不改名（旧配置里没写这项的组读回 `off` 并在下一次存盘时显式写出）。advisor
  由监视器的采样 tick 驱动，自己不建 timer，`stop()` 连自己的状态一起清掉，因此建议不依赖任何 UI 页面开着。`off`、
  禁用的组和 `metrics_enabled: false` 的组在 advisor 入口处直接 `dropGroup`，状态整体消失，不是留下一串终态记录。
  判定只吃 `usableForLoadJudgement`（fresh + complete + awake）与按 canonical key 折叠后的引擎视图：陈旧样本、部分
  样本、只有 KV 的样本和自称睡着的引擎都不产生判定；同一个 `sampleSequence` 被重复读到不增加稳定次数；只有两个
  以上不同物理引擎才谈得上迁移；目标本地还有 reservation 时不许被当成空闲。候选侧读的是 `moveGatesFor()`——
  `moveBinding()` 在提交和写入时会重跑的同一套判断，本模块不重新推导门；自己只加三件事：`inFlight === 0`、
  `candidateActivityWindowMs` 内真的起过请求、成本信号有真实来源（`costSource: "none"` 一律拒）。`costEstimated: true`
  标记那个数字是请求体字节数而不是 token。建议状态 `suggested` → `unused`/`rejected`/`expired` 单向，终态不被后来的
  漂移改写，终态项到期即从存储消失；`unused` 的两个子原因分开“没有下一次请求”和“有请求但不许动”。冷却、组预算、
  同 episode 只一个活跃建议、目标承诺上限和 A→B 后禁自动 B→A 都已实现并可在状态里读出，但它们今天只决定“要不要
  产生建议”。状态 API 是闭合 DTO：`{calibrated, disabledReason, mode, suggestions}`，建议项 14 个声明键，未声明键
  在两层都被序列化器丢掉；`auto` 在未校准时上送 `disabledReason: "not_calibrated"`，没有监视器的 pair 也答配置的
  模式加同一个拒绝而不是编造建议。`AUTO_REBALANCE_CALIBRATED` 是常量 `false`，注释写明只有 TRI-11 的真实引擎三组
  对照记录能改它，代码评审、单元测试和合成夹具都不能。
- 不泄露：建议与日志只带 id、目标、revision、时间和数字。监视器日志行的键集被钉成七项（`bindingId`、
  `destinationTargetId`、`groupId`、`incarnation`、`sourceTargetId`、`stableSamples`、`suggestionId`，终态行多一个
  `stateReason`）；路由响应里没有 session id、正文、exact key、用户消息哈希和上游密钥（测试把私有 prompt 和 session
  塞进身份，再断言响应体里不出现它们）。响应 `suggestions` 的 128 上限与 advisor 生产配置的上限逐项对齐，由
  `test-node/admin/load-balancer.test.ts` 从路由注册的 JSON schema 里读出 `maxItems` 钉住，防止建议列表变成 500。
- 与本轮代码直接相关的三项修正（都在收口审查里找到）：一是 `source_metrics_lost` 曾被同时用在“源不再回答”和
  “目标不再回答”两种事实上，后者现在叫 `destination_metrics_lost` 并在闭合枚举里占一格——源失联说明失衡可能已经
  消失，目标失联只说明没人知道它还静默，混用会把后者读成前者。二是管理路由的轮询等的是 `state === "suggested"`
  而不是“列表非空的第一项”：响应是新的在前，一条比建议更晚登记的拒绝项合法地能排在最前，按下标取会让断言依赖
  谁先落地。三是日志键集合的断言把两种行当成一种行：新建议的行只有七个键，而报告一条建议结束的行合法地多一个
  `stateReason`，全量跑里只要时序造出这样一行就会红（本工作树第一次 `npm run check` 就是这样）。现在两种形状各自
  被逐项断言，并且终态行不再靠时序碰运气：目标引擎可以切换文本，把它换成忙以后建议因 `target_busy` 结束，那一行
  的八个键和原因被直接钉住。代码侧两处修正在 `80483a0`，测试侧两处修正另成提交 `51fae58`；没有删除或放宽任何断言。
- UI：本轮没有改 `src/admin/static/**`，页面不读 `rebalance` 块，因此没有重录基线，也没有基线 diff：十张 `doc/ui_*.png`
  与 `docs/current/contracts/ui-visual-baseline.md` 在 `git status` 里零改动，十张文件的实测 SHA-256 与登记表十行哈希
  逐项相同。UI 浏览器测试全过（视觉 11 项 + 负载均衡行为 59 项）。浏览器保存路径不丢这个字段：
  `loadBalancing.collectGroups` 从上一份 group 复制 `{...group}` 再覆盖有控件的字段，所以配置里写过的
  `rebalance_mode` 能穿过一次 UI 保存；UI 新建的 group 不带这个字段，按默认存成 `off`。
- 结果与限制：一是**没有自动执行**：`auto` 与 `advise` 走完全相同的判定路径，advisor 没有 balancer 引用，运行期唯一
  调 `LoadBalancer.moveBinding()` 的地方是管理路由（手动迁移）。未校准的 `auto` 组产出与 `advise` 一样的建议，同时
  binding 仍在源目标上、`routingRevision` 保持 0、`migrationOperations()` 为空——这三条断言在监视器测试和真实路由
  测试里各钉一次。二是参数仍未校准：`ADVISE_OBSERVATION_POLICY` 里的稳定样本数、源忙阈值、活动窗口、冷却、预算、
  承诺上限和防回摆窗口都是观察默认值，状态在每条建议旁报 `calibrated: false`，TRI-11 未交出实测值前它们不得被
  当作执行阈值。三是排序把 token 数与字节估算放在同一个数值序里，只靠 `costEstimated` 标注区分；这两者能不能直接
  比大小是 TRI-11 要回答的问题，本轮没有改排序规则。四是建议只活在内存里，随 pair 停止丢弃，不落盘、不进 traffic
  数据库，跨重启不保留。五是组从配置里消失时，monitor tick 会清理它的 advisor 状态；重新使用同一 group id 也不会复现旧建议。六是 UI 还没有展示建议：今天只有状态 API 和结构化日志能看到它们。
- 交付：见下面“TRI-10 交付产物”一节（便携包、交付冒烟与 Node ABI 恢复）。
- 提交：`80483a0`（代码与建议状态机）与 `51fae58`（测试形状修正），都用显式 `git add --` 逐路径只收授权文件；
  没有 `git add -A`，也没有把 `AGENTS.md`、`test-node/docs/`、`test-results/`、`logs/` 或用户实例的任何文件收进来。

#### TRI-10 交付产物（便携包、交付冒烟与 Node ABI）

- `npm run package:electron:portable` `exit 0`，顺序是 `build`（`prebuild` 跑 `rebuild:node`）→ `rebuild:electron` →
  `electron-builder -w portable`；`rebuild:electron` 与打包之间没跑过任何 Node ABI 重建，所以包里是 Electron ABI。
- 产物 `release/LLM-Proxy-0.4.10-x64-portable.exe`，111974522 字节，SHA-256
  `a88e3ddf376336016fc894e30d6a97699da17540bbd516980faca872bcb69bcd`。与 TRI-09 登记的 111968556 字节那张不同，
  因为本轮多了 advisor 与配置层，这是预期差异，不是基线回归。
- 不是 stale 产物：`release/win-unpacked/resources/app.asar` 里本轮新增的名字都在——`not_calibrated` 4 次、
  `load-rebalance` 8 次、`rebalance_mode` 10 次、`ADVISE_OBSERVATION_POLICY` 9 次、`destination_metrics_lost` 4 次。
- `npm run smoke:delivery` 两项全过，各自用自己的临时配置、`LLM_PROXY_DATA_DIR`、绝对日志根与自选空闲端口，跑在
  用户那台便携实例旁边而不碰它：解包载荷 health 793 ms、一次真实代理往返 200、`GET /api/logs?limit=5` 200 且
  `total` 为 1、该次运行的日志根里出现 `traffic.db`（4096 字节）、子进程退出码 0；portable 包装器 health 2881 ms，
  同样四项全过，退出码 0。包里 SQLite 能用是由包装器冒烟证明（日志路由答 200、日志根里出现 `traffic.db`），
  不以 `require` 成功为据。
- 打包完成后 `npm run build`（它的 `prebuild` 才跑 `rebuild:node`）把 ABI 换回 Node，`npm run abi:node` 用真实查询
  证明 `NODE_MODULE_VERSION 137`、查询结果 `{"a":1}`。整个过程中只结束自己启动的进程，没停用户实例，没写用户的
  配置与 traffic database。

### TRI-11

- 状态：阻塞（缺可隔离的真实引擎环境；不伪造结论，`auto` 保持 `not_calibrated` 降级）。
- 修改文件：本项没有改代码。工作树里与本项相关的只有 `AUTO_REBALANCE_CALIBRATED = false` 这一处常量与它旁边的
  说明——它只能被本项的真实对照记录改动。
- 本项做了什么：按 [real-upstream-acceptance](../../../.agents/skills/real-upstream-acceptance/SKILL.md) 的隔离要求
  先确认环境是否可用，只读，不启动、不停止、不读写用户实例的配置与 traffic database。结论是这台机器上跑不成三组
  对照：
  1. 唯一在听的真实引擎是 `127.0.0.1:9393` 与 `127.0.0.1:9394`（PID 40996 与 38052，用户自己启动的 vLLM，服务
     `D:\models\Qwen3.8-Flash-Next-AutoRound-3bpw-MTP`），用户的便携版代理此刻也在运行（PID 44988，管理端口 12346）。
     按 AGENTS.md 的边界这两者都不能碰：给它们加负载会改变用户正在跑的实例的表现。
  2. `nvidia-smi`：GPU 1 与 GPU 2（NVIDIA CMP 170HX 64G）显存已用 63247/65536 与 63219/65536 MiB（约 97%），GPU 2
     利用率 84%——那就是用户那两个引擎占着的卡。剩下 GPU 0 是 RTX 3090，总显存 24576 MiB、已用 1374 MiB，而模型目录
     `du -sh` 量出 143 GB。同模型、同 `--gpu-memory-utilization 0.96`、带 OffloadingConnector 与 PLE SSD 卸载配置的
     第三台引擎在这张卡上起不来，三组对照需要的**两台**隔离同模型引擎更起不来。
  3. 三组对照要量的量是整体完成时间、任务级尾延迟、源与目标 waiting、迁移后实际轮数和 unused 比例（设计第 7.6 与
     第 11 节）。换成假 upstream 或换成一张小模型会把前提（共享 KV 卸载、前缀缓存、同模型同上下文档位）全部换掉，
     量出来的数不能回答 TRI-11 问的问题，因此不拿它当替代品，也不把它写成校准结果。
- 因此本轮不做的事：不写任何阈值来源，不把合成夹具或单元测试写成收益证明，不把 `AUTO_REBALANCE_CALIBRATED` 改成
  `true`，不调整 `ADVISE_OBSERVATION_POLICY` 的数字，不因为“清单没完成”而给 `auto` 编一个可用的校准结论。
- 后来要跑成本项需要什么：两台不属于用户的同模型真实引擎（同一份模型、同一份缓存/KV 配置）、独立
  `LLM_PROXY_DATA_DIR`、绝对 `log_root`、空闲管理端口、固定客户端脚本与上下文档位、事先写下的可推翻阈值，以及
  `docs/reports/` 里一份带版本、输入、样本数与原始结果的实验记录。这些条件哪一条没满足，本项就继续阻塞。
- 验证：`nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv`、
  `netstat -ano | grep LISTEN`、`Get-CimInstance Win32_Process` 查 PID 命令行（只读）与
  `du -sh /d/models/Qwen3.8-Flash-Next-AutoRound-3bpw-MTP`。本项范围没有跑实验脚本，也没有动用户实例。

### TRI-12

- 状态：未开始（前置 TRI-11 阻塞；不为完成清单改变门槛）。
- 修改文件：本项没有改代码。`applied` 与 `observed` 两个状态既不产生也不上送，因此响应 schema 里没有声明它们；
  计划里 `proxy-request-pipeline.ts` 在 `plan()` 边界应用 pending suggestion 这条入口至今没有实现。
- 本项今天能验的部分：自动执行不存在。运行期调用 `LoadBalancer.moveBinding()` 的只有 `src/proxy/load-balancer-admin.ts`
  的 `moveBinding()`，它由 `POST /api/load-balancer/task-moves`（手动）触发；`src/proxy/load-rebalance.ts` 不引用
  balancer，也不调 `moveBinding()`、`rebind()` 或任何写目标的路径。配置成 `auto` 的组在监视器测试与真实路由测试里
  都产出与 `advise` 相同的建议，同时 binding 还在源目标、`routingRevision` 为 0、`migrationOperations()` 为空。
- 本项没做的事：在 `plan()` 边界应用建议、动作级冷却与预算与连续无效熔断、`movedBy: "auto"` 的路由元信息、
  TR-01～TR-08 的需求追踪收口、自动态的 UI 与基线、以及依赖 TRI-11 结果的最终回归。
- 验证：`grep -rn "moveBinding(" src/ --include='*.ts'`（运行期写入点只有管理侧）、
  `grep -n "moveBinding|rebind|targetId =" src/proxy/load-rebalance.ts src/proxy/load-monitor.ts`（只有注释与字段读取）、
  `npx vitest run test-node/proxy/load-monitor.test.ts` 与 `test-node/admin/load-balancer.test.ts` 里的 `auto` 降级项。
- 结果与限制：本项的验收条件“真实对照实验支持开启，否则仍保持 advise”今天落在“保持 advise”这一侧，因为 TRI-11
  没有证据。交付产物按 TRI-10 的范围跑了一轮（见下一节），它验的是 advise 的可交付性，不验自动收益；
  第 9 节的最终收口仍未全部完成。

## 8. 实施中的开放问题

| 问题                                              | 阻塞任务       | 处理规则                                                       |
| ------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| 当前协议是否保存 `previous_response_id` 对应状态  | TRI-07、TRI-11 | 未通过隔离真实上游验证前拒绝迁移，不允许用猜测解锁。           |
| 一个 binding 的 exact key 能否稳定映射到一个 task | TRI-04、TRI-05 | 保留多候选和歧义；不能为了单 task UI 删除关联范围。            |
| 自动阈值与上下文成本上限                          | TRI-10、TRI-11 | 只保留命名参数；真实校准前不得写入 auto 默认值。               |
| 历史查询在真实大库中的耗时                        | TRI-04、TRI-05 | 只用合成夹具测查询形状；真实库验证必须使用隔离副本或新建数据。 |
| 是否需要跨重启固定节点                            | TRI-12 之后    | 另立持久化设计，不在本清单中临时扩展。                         |

任何开放问题如果改变迁移对象、状态机、错误合同或自动开启条件，先更新设计文档和本清单的依赖，再继续实现。

## 9. 最终收口检查

- [x] 第 4 节所有任务已完成，或每个阻塞项都有明确的证据和后续任务。（TRI-11 阻塞，证据与后来所需条件在本项
      完成记录里；TRI-12 以 TRI-11 为前置，保持未开始）
- [x] [task-routing 设计](../../design/active/task-routing.md) 与代码、API、UI 和测试没有互相矛盾的状态或错误码。
      （TRI-10 的范围：该任务完成记录写上了已落地口径，`applied`/`observed` 不产生也不上送）
- [x] `npm run typecheck`、`npm run lint`、`npm run check:modules` 和 `npm run check` 通过。
- [ ] `npm run regen:ui-baselines` 已运行，截图已完整检查，基线哈希已更新。（TRI-12 范围；TRI-10 没改
      `src/admin/static/**`，十张基线图与登记表逐项相同、零 diff，UI 浏览器测试 70 项全过）
- [ ] 三组真实引擎对照结果已归档；自动模式收益和风险结论独立记录。（TRI-11 阻塞）
- [x] `npm run package:electron:portable`、`npm run smoke:delivery` 和 `npm run abi:node` 通过。
- [x] `git status --short` 和 `git diff --stat` 只包含本次授权的实现、测试、文档和基线文件。
- [x] 未修改用户实例、用户配置或用户 traffic database；AGENTS.md 和文档维护规则的本次更新属于授权的流程改进。
