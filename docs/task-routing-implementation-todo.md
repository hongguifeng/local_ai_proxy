# Task 路由功能实现 TODO

基线：`1c983a10751aaf102a55e223a92e09c1b74e6391`。设计权威：[Task 路由观测、手动迁移与自动再均衡设计](./task-routing-design.md)。当前状态：8 / 12 项验收通过；TRI-08 的两轮返工与 TRI-06 的三个提交（原实现、复审返工、行上限修正）都已通过父代理独立复审并按顺序整合进主 checkout；TRI-09 已实现、待父代理独立复审，本清单不自接为 9 / 12：迁移控件、`POST`/`DELETE` 接线与真实浏览器请求闭环都已落地并在本 lane 的一个提交里，但尚未被任何人接为验收通过，自动策略同样未验收。控件以后又过了两轮：`6652d21` 把一个答复留在发出它的那一页，`c13260a` 把 dispose 与换代时还在途的写当场摘下并留下冻结的重放，两轮的验收都还挂在父代理那里。

本文是供本地 AI 按依赖顺序执行的开发清单。每项任务都必须完成实现、测试、文档同步和本项验收后才能标记为完成。研究稿、模型比较文档和历史负载均衡文档只提供背景，不得覆盖设计权威中的状态、并发和安全合同。

## 1. 决策摘要

- 先建立 binding 身份、活动账本和指标完整性，再提供只读列表。
- 先完成手动迁移，再实现自动建议；自动执行必须经过真实引擎对照实验。
- 所有迁移路径共用 `moveBinding()`，不能让 UI、failover 和自动策略各自直接改写 `targetId`。
- 迁移是运行态动作，默认不跨重启持久化。
- task 是用户可见的历史关联对象，binding 才是代理可以实际迁移的对象。
- 缺失、过期、未知和零值必须分开处理；未知指标不能被转换为空闲。

## 2. 执行约定

每次只选择一个依赖已经完成的未完成任务。开发前先读取根目录 `AGENTS.md`、[现行架构](./current-architecture.md)、本文对应任务引用的 skill 和设计文档章节。

状态只能使用“未开始”“进行中”“阻塞”“已完成”。部分实现保留为“进行中”，并在完成记录中写出剩余工作。任务 ID 应出现在新增测试描述、关键日志或提交说明中，例如 `[TRI-03]`。

每项完成时必须更新三处：

1. 第 4 节进度表的勾选和状态；
2. 该任务的完成记录，包括修改文件、测试、已知限制和实际结果；
3. 如实现改变设计合同，先修改 [task-routing-design.md](./task-routing-design.md)，再继续代码，不要在代码和 TODO 中保留两套语义。

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
| V-D  | 文档格式、链接和任务依赖  | `npx prettier --ignore-path .gitignore --check docs/task-routing-implementation-todo.md docs/task-routing-design.md`                                                                                              |
| V-T  | 相关 Node 测试            | `npm test -- <实际测试文件>`，从大写盘符路径运行                                                                                                                                                                  |
| V-C  | 类型、lint 和模块边界     | `npm run typecheck`、`npm run lint`、`npm run check:modules`                                                                                                                                                      |
| V-A  | 管理 API 合同             | 阅读并遵循 [admin-api-probing](../.agents/skills/admin-api-probing/SKILL.md)                                                                                                                                      |
| V-R  | proxy 生命周期和 reload   | 阅读并遵循 [proxy-runtime](../.agents/skills/proxy-runtime/SKILL.md)                                                                                                                                              |
| V-U  | UI 模块、DOM 和浏览器测试 | [static-checks-and-split](../.agents/skills/static-checks-and-split/SKILL.md)、[ui-markup-contracts](../.agents/skills/ui-markup-contracts/SKILL.md)、[ui-test-quirks](../.agents/skills/ui-test-quirks/SKILL.md) |
| V-B  | UI 截图和基线             | [ui-baseline-regen](../.agents/skills/ui-baseline-regen/SKILL.md)，运行 `npm run regen:ui-baselines`                                                                                                              |
| V-E  | 真实上游收益实验          | [real-upstream-acceptance](../.agents/skills/real-upstream-acceptance/SKILL.md)                                                                                                                                   |
| V-P  | 交付产物                  | `npm run package:electron:portable`、`npm run smoke:delivery`、`npm run abi:node`                                                                                                                                 |

`docs/` 被默认 Prettier 忽略，文档只能使用显式 `--ignore-path .gitignore`。过滤测试必须确认实际匹配了测试；项目 `passWithNoTests` 关闭，空匹配不是通过。

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
| [ ]  | TRI-09 | P1     | 实现手动迁移 UI 和真实请求验证       | TRI-06、TRI-08         | 已实现，待父代理复审 |
| [ ]  | TRI-10 | P2     | 实现 advise 模式和建议状态           | TRI-03、TRI-07、TRI-09 | 未开始 |
| [ ]  | TRI-11 | P2     | 真实引擎校准并决定是否开启 auto      | TRI-10                 | 未开始 |
| [ ]  | TRI-12 | P2     | 自动执行、最终回归和交付收口         | TRI-11                 | 未开始 |

## 4. 任务明细

### TRI-01：固定身份、版本和迁移合同

入口：[设计文档](./task-routing-design.md) 第 4、5 节；[load-affinity.ts](../src/proxy/load-affinity.ts)、[load-balancer.ts](../src/proxy/load-balancer.ts)、[proxy-runtime-registry.ts](../src/proxy/proxy-runtime-registry.ts)。

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

入口：[load-affinity.ts](../src/proxy/load-affinity.ts)、[load-balancer.ts](../src/proxy/load-balancer.ts)、[proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts)。

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

入口：[load-monitor.ts](../src/proxy/load-monitor.ts)、[load-metrics.ts](../src/proxy/load-metrics.ts)、[load-balancer.ts](../src/proxy/load-balancer.ts)。

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

入口：[task-matcher.ts](../src/logging/task-matcher.ts)、[traffic-log-service.ts](../src/logging/traffic-log-service.ts)、[task-store.ts](../src/persistence/task-store.ts)、[repository.ts](../src/persistence/repository.ts)。

- [ ] 先核对 `context_links`、`response_links`、`tasks`、`records` 的现有索引、写入口和查询返回，确认 exact key 到 task 的方向。
- [ ] 增加只读查询，将 binding exact key 映射为 `high`、`candidate` 或 `none`，不把候选关联升级为唯一身份。
- [ ] 返回多个 task 时保留完整覆盖范围、歧义和置信度；一个 binding 关联多个 task 时不得挑一个代表项。
- [ ] 以有界分页和查询上限读取历史，避免在 2 秒 UI 轮询中执行无界 `COUNT(DISTINCT)` 或逐条读取正文。
- [ ] 让查询使用正确的日志根和 URL/canonical target 口径；不要把 `tasks.target` 的 URL 直接当成 canonical physical key。
- [ ] 历史-only task 只能作为只读信息；没有当前 binding 时不返回可迁移操作。
- [ ] 明确没有日志、异步日志尚未落库、旧 task 被清理和历史查询失败时的 coverage 字段。

验收：查询不会创建 binding、续期 TTL、增加 requestCount 或进入代理热路径；合成夹具能验证精确关联、多个候选和无关联三种结果。

验证：V-T，运行 logging、persistence、task-store 和历史查询相关测试；保留查询夹具的对象数、索引和执行计划说明。禁止读用户实例数据库做性能验证。

### TRI-05：建立只读管理 API 和服务装配

入口：[load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts)、[admin contracts](../src/admin/admin-contracts.ts)、[admin schemas](../src/admin/admin-schemas.ts)、[load-balancer route](../src/admin/routes/load-balancer.ts)、[admin-services.ts](../src/app/admin-services.ts)。

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

入口：[load-balancing.js](../src/admin/static/modules/load-balancing.js)、相关 UI 模块、[admin-ui-load-balancing.test.ts](../test-node/ui/admin-ui-load-balancing.test.ts)。

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

入口：[load-balancer.ts](../src/proxy/load-balancer.ts)、[load-affinity.ts](../src/proxy/load-affinity.ts)、[proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts)。

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

入口：[load-balancer route](../src/admin/routes/load-balancer.ts)、[admin schemas](../src/admin/admin-schemas.ts)、[load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts)。

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

入口：[load-balancing.js](../src/admin/static/modules/load-balancing.js)、UI API helper、[admin-ui-load-balancing.test.ts](../test-node/ui/admin-ui-load-balancing.test.ts)。

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

入口：[config schema](../src/config/config-schema.ts)、[load-monitor.ts](../src/proxy/load-monitor.ts)、新增纯判定模块、[load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts)。

- [ ] 在 group 配置中增加 `rebalance_mode: "off" | "advise" | "auto"`，默认 `off`，同步 schema、normalizer、读写和配置测试。
- [ ] 将失衡判定、候选排序和 suggestion 生命周期放入不直接访问网络或数据库的纯模块。
- [ ] 只在完整、新鲜、去重后的指标和安全候选同时满足时生成建议；缺失指标、旧样本和重复采样不产生稳定判定。
- [ ] 候选必须满足零在途、同模型、不同 physical key、无 server-side state 风险、非人工保护和预算未超限。
- [ ] 增加 `suggested`、`unused`、`rejected`、`expired` 原因和建议详情，但不要在 advise 模式改变 binding。
- [ ] 复用现有 monitor timer 和 unref/stop 生命周期；不要让建议只在 UI 页面打开时运行。
- [ ] 增加状态 API 投影，明确 `auto` 尚未校准时返回 `disabledReason: "not_calibrated"`，运行行为等同 advise。

验收：`off` 不计算自动动作，`advise` 只提供候选，未校准的 `auto` 不改绑；同一旧样本不能重复累计稳定次数；建议不泄露请求内容。

验证：V-T、V-R；运行 load-monitor、load-balancer、config、admin API 测试。为候选算法保留可复跑合成探针，先断言夹具确实创建多个独立 binding，再测耗时。

### TRI-11：真实引擎校准并决定是否开启 auto

入口：[real-upstream-acceptance](../.agents/skills/real-upstream-acceptance/SKILL.md)、设计文档第 7.6 和第 11 节、隔离实验脚本目录。

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

入口：计划新增的 `src/proxy/load-rebalance.ts`、[load-monitor.ts](../src/proxy/load-monitor.ts)、[load-balancer.ts](../src/proxy/load-balancer.ts)、[proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts)、设计文档第 7、9、11 节。

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

验证：V-F、V-U、V-B、V-P、V-E。最终报告必须分别列出逻辑安全测试、真实收益实验和交付产物结果。

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

## 7. 完成记录

### TRI-01

- 状态：已完成
- 修改文件：新增 [load-migration-contract.ts](../src/proxy/load-migration-contract.ts)，修改
  [load-affinity.ts](../src/proxy/load-affinity.ts)、
  [load-balancer.ts](../src/proxy/load-balancer.ts)、
  [proxy-runtime-registry.ts](../src/proxy/proxy-runtime-registry.ts) 与
  [proxy/index.ts](../src/proxy/index.ts)。测试：新增 `test-node/proxy/load-migration-contract.test.ts`，
  扩展 load-affinity、load-balancer、load-balancer-pipeline、load-balancer-integration、
  proxy-runtime-registry 与 admin load-balancer 测试。
- 验证：`npm run typecheck`、`npm run lint`、`npm run check:modules`（0 环 0 越界）、
  `npm run format:check` 全部通过。`npx vitest run test-node/proxy/` 34 文件 468 项通过；
  `npx vitest run test-node/logging/ test-node/admin/` 24 文件 166 项通过；`npm test` 139 文件通过、
  1 文件跳过。按本项范围未运行打包、Electron ABI 重建与 UI 基线。
- 结果与限制：`runtimeEpoch` 随 `LoadBalancer` 实例生成——实例的生命周期就是 pair 运行时的生命周期，
  启动时建立、listener 不变的 reload 复用、停止时丢弃——并由 `ProxyRuntimeRegistry.runtimeEpoch(pairId)`
  作为当前运行时身份暴露。`bindingId` 只在一张 affinity table 内唯一；`incarnation` 在同一运行时内唯一，
  由运行时统一发放；`routingRevision` 只在目标真的改变时加一（`bind(..., { allowRebind: true })`、
  `rebind()`，以及经由 `plan({ exclude })` 的连接期 failover）；`groupRevision` 只在组的 routing signature
  （成员及其 model_id、成员的 URL/请求转换/日志根/enabled、组自身的 pattern/strategy/采样/failover 开关）
  变化时加一，同一运行时内不重复发放，组消失后再回来也拿不到旧号码。`bindingForRef()` 解析引用时会拒绝
  旧运行时、已消失的组、已被淘汰的 binding 以及新表里恰好复用同一个数字的另一个 binding；被淘汰的 binding
  不再接受 `rebind()` 或 `attachResponseIds()` 的迟到写回。`MigrationState` 与 `MIGRATION_TRANSITIONS`
  只提供状态合同，本项未实现迁移服务、管理 API、UI 或自动策略，也未改变现有路由选择行为。
- 后续边界：一是管理 API 的 409 冲突与幂等合同要等 TRI-05、TRI-08 落地，本项只用
  `bindingForRef()` 与注册表身份证明“旧引用不能作用于新运行时”，并测试现有状态响应不含 binding 号码；
  二是 reservation 的活动加减与释放幂等属于 TRI-02，本项只保证引用能解析回创建它的那个 binding 对象；
  三是 `BindingRef` 比设计文档第 4.1 节的片段多一个 `incarnation` 字段，用于挡住复用的数字号码，
  设计文档需要在下一阶段同步——本项没有修改那份未跟踪的设计文档，也没有把它纳入提交。

### TRI-02

- 状态：已完成
- 修改文件：新增 [binding-activity.ts](../src/proxy/binding-activity.ts)，修改
  [load-affinity.ts](../src/proxy/load-affinity.ts)（新增 `bindingEntries()` 无副作用投影）、
  [load-balancer.ts](../src/proxy/load-balancer.ts)（活动账本、`bindingSnapshot()`、
  `sweepBindingActivity()`、usage/字节/人工保护写入口）、
  [load-monitor.ts](../src/proxy/load-monitor.ts)（TTL 扫描后顺带清理账本）、
  [proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts)（选路时记字节、定价完成后回填 usage、
  balancer 选中本 pipeline 不认识的目标时归还已建立的 reservation）、
  [request-pricing.ts](../src/pricing/request-pricing.ts) 与 [pricing/index.ts](../src/pricing/index.ts)
  （导出既有的 `resolveUsage`，账本与计价共用同一份 usage 判定）、[proxy/index.ts](../src/proxy/index.ts)。
  测试：新增 `test-node/proxy/binding-activity.test.ts`（19 项），在
  `test-node/proxy/load-balancer-pipeline.test.ts` 追加 "TRI-02 binding activity around the live
  pipeline" describe（10 项）。
- 验证：`npm run typecheck`、`npm run lint`、`npm run check:modules`（0 环 0 越界）、
  `npx prettier --check` 改动文件全部通过。`npx vitest run test-node/proxy/` 35 文件 497 项通过
  （前基线 34 文件 468 项，净增 1 文件 29 项，与新增用例数一致）；
  `npx vitest run test-node/pricing/ test-node/proxy/proxy-runtime-registry.test.ts` 等相关套件通过；
  `npm test` 140 文件通过、1 文件跳过（1285 项通过、2 项跳过）。按本项范围未运行打包、
  Electron ABI 重建与 UI 基线。
- 活动账本生命周期：`LoadBalancer` 内 `BindingActivityLedger` 按 binding 的 `incarnation` 记账，
  绝不按复用的数字 `bindingId`，也不写 traffic 数据库；字段为 `inFlight`、`lastRequestStartedAt`、
  `lastResponseEndedAt`、有界 `recentRequestStarts`（上限 16）、`lastRequestBytes`、`lastUsage`
  （`costSource` 取 `normalized_usage`/`request_bytes`/`none`，附 endpoint、token 与时间）与
  `manualProtection` 内部承载；不存正文、exact key 或用户消息原文。加一只发生在 `plan()` 真正建立
  reservation 的 `#reservation()` 处，减一在 reservation 的 `release()` 内、目标计数归还之后，且
  `release()` 保持一次性：完整响应处理（含 finished 日志写入）在 pipeline 的 `finally` 之前先行完成。
  usage 回填复用计价的 `resolveUsage`：SSE 捕获优先、缓冲 payload 兜底，缺失 usage 时 token 字段保持
  缺失、成本信号退回 `request_bytes`（选路时已记录的字节）或 `none`，绝不伪造 token。清理顺序：
  正常释放后账本留在活 binding 上；binding 被 TTL/LRU/组删除淘汰时，在途账本保留到迟到 release
  落地（release 发现 binding 已不在表中且计数归零就自行删除条目）；空闲死账本由
  `sweepBindingActivity()`（挂在 `LoadMonitor.sweepNow()`，TTL 扫描之后）回收；`clear()`（pair 停止）
  丢弃全部账本，之后的迟到 release 找不到条目、写成 no-op。
- 迟到回调边界：重复 release、binding 消失后的迟到 release 都不会让 `inFlight` 变负——`end()` 只在
  计数大于零时减一，条目已消失时直接返回；迟到写回（字节、usage、manual protection）先经
  `bindingForRef()` 解析，拒绝旧运行时、消失的组、被淘汰的 binding 与复用号码的新 binding，因此
  既不复活旧对象也不误写复用同一数字的新 binding；账本按 incarnation 键控，新 binding 的计数与
  时间戳不受旧 reservation 迟到释放的影响。测试覆盖“binding 已淘汰但请求仍在途”、复用号码、
  长 SSE、上游 5xx 与拒连、客户端取消、日志写入失败（ADR-005 语义：客户端响应与账本都不受影响）、
  reload 期间旧 pipeline 的请求继续按自己的 binding 计数、usage 缺失与 SSE/缓冲两种回填来源。
- 结果与限制：本项只做内存投影与账本，未动管理 API、UI、数据库 schema、自动策略或迁移服务；
  `manualProtection` 只有内部承载与投影展示，设值/清除入口要等 TRI-07/TRI-08 的手动迁移服务接入。
  一处顺带的正确性修复：balancer 选中的目标若不在本 pipeline 的 targets 里，先前建立的 reservation
  现在会被立即归还（旧代码会把它连同目标级与 binding 级计数一起悬挂）。`LoadBalancerSnapshot` 与
  现有状态响应保持不含 binding 号码。后续边界：列表与迁移若要按 task 关联 binding，需要 TRI-04 的
  历史关联查询；账本条目在 binding 存活期间随写随建，`bindingSnapshot()` 目前不过滤 TTL 已过但
  尚未 sweep 的条目，读取它不改变任何状态。
- 评审后的修正（父代理评审初次提交 5ed894d 后在本任务内补做，不改路由语义，也不提前实现 TRI-03 以后）：
  一是连接期 failover 成功、`activeReservation` 切到新 reservation 时补记同一份 request body byte length。旧
  binding 会随它的 reservation 一起离开 affinity 表（例如 reload 把失败节点移出 group），failover 于是重新
  `bind()` 出一个新的 incarnation，它的账本原本不知道这次请求的字节数；应答节点没有 usage 时就会报 `none`，
  而应退回 `request_bytes`。二是 `#tryFailover()` 在 `balancer.plan()` 拿到 next 后，若本 pipeline 的 targets
  里找不到 `next.decision.targetId`，先 `next.release()` 再返回 `undefined`，不再悬挂目标级 reservation 与
  binding 账本（初次提交已经修过初次选路遇到 unknown target 的同一问题，那份修复没有动）。三是
  `toActivity()` 连 `lastUsage` 与 `manualProtection` 也逐字段复制：`readonly` 只约束 TypeScript，调用者在
  运行期写下的改动不能再写回内部账本。
- 为这三项新增的测试：`test-node/proxy/load-balancer-pipeline.test.ts` 的 "TRI-02 binding activity around
  the live pipeline" 追加 2 项真实 socket 用例——reload 把失败节点移出 group 后 failover 落到新的
  incarnation、应答的 bare 节点不提供 usage，断言账本退回 `request_bytes` 且字节数等于请求体；failover 计划
  选中的目标本 pipeline 不认识，断言该目标 inFlight、账本计数与 `sweepBindingActivity()` 全部归零且记录里
  路由不变。`test-node/proxy/binding-activity.test.ts` 追加 1 项：先读投影，按去掉 `readonly` 的可写视角改写
  `recentRequestStarts`、`lastUsage` 与 `manualProtection`，再读并断言内部账本、时间戳与三次读取拿到的都不是
  同一个对象。把两个源文件还原到初次提交后重跑，这三项新用例各自在预期断言上失败（字节数 `undefined`、ghost
  目标 inFlight 为 1、账本被调用者改成 `none`/0），修好后全部通过。
- 修正后验证：`npm run typecheck`、`npm run lint`、`npm run check:modules`（0 环 0 越界）、`npx prettier
  --check` 四个改动文件全部通过；`npx vitest run test-node/proxy/` 35 文件 500 项通过（初次提交 497 项，净增
  3 项与新增用例数一致）；`npm test` 140 文件通过、1 文件跳过（1288 项通过、2 项跳过），`npm run check`
  全链（format、lint、typecheck、check:modules、test、build）也跑通。修正落在初次提交之上的提交 ffd0d79，
  只含这四个源码与测试文件，研究文档与本 TODO 继续留在未跟踪状态。仍未覆盖的边界：failover 落到新 incarnation 且应答
  节点提供完整 usage 的组合（现有用例只覆盖同 incarnation 的完整 usage 与新 incarnation 的缺失 usage），以及
  账本投影进入管理 API 与节点列表 UI 的读取面，那要等 TRI-05 与 TRI-06；本项范围依旧未跑便携版打包、
  Electron ABI 重建与 UI 基线。

### TRI-03

- 状态：已完成
- 修改文件：新增 [load-evidence.ts](../src/proxy/load-evidence.ts)（纯判定输入：分类一个引擎答案、按物理引擎折叠别名）。修改
  [load-balancer.ts](../src/proxy/load-balancer.ts)（`LoadSample` 契约：`running`/`waiting` 改为 `number | undefined`，新增 `sampleSequence`；`#loadOf` 只累加引擎答过的数字）、
  [load-monitor.ts](../src/proxy/load-monitor.ts)（`toLoadSample` 不再把缺失补成 0；按 `canonicalKey` 发放采样序号；`nodeStatuses()` 经 `assessLoadSample` 判新鲜度）、
  [load-metrics.ts](../src/proxy/load-metrics.ts)（写明“整次读取不可解析”与“答了但漏字段”是两种事实）、
  [load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts) 与 [admin-schemas.ts](../src/admin/admin-schemas.ts)（状态里的 `running`/`waiting` 变成 `number | null`）、
  [load-balancing.js](../src/admin/static/modules/load-balancing.js) 与 [core.js](../src/admin/static/modules/core.js)（缺字段显示 `-` 并加状态词“指标不全”/“Metrics incomplete”）、
  [proxy/index.ts](../src/proxy/index.ts)。测试：新增 `test-node/proxy/load-evidence.test.ts`（11 项）；在
  `test-node/proxy/load-monitor.test.ts` 追加 `[TRI-03]` describe（6 项），在 load-metrics（1 项）、
  load-balancer-selection（2 项）、`test-node/admin/load-balancer.test.ts`（1 项）与
  `test-node/ui/admin-ui-load-balancing.test.ts`（1 项）追加用例；`load-balancer-integration.test.ts` 与
  `load-balancer-pipeline.test.ts` 的 `engineSample` 夹具补上新 `sampleSequence` 字段。
- 验证：`npm run typecheck`、`npm run lint`、`npm run check:modules`（136 模块 308 运行时边，0 环 0 越界）、
  `npm run format:check` 全部通过；`npm run check` 全链（format、lint、typecheck、check:modules、test、build）跑通。
  `npm test` 141 文件通过、1 文件跳过（1310 项通过、2 项跳过；上一基线 140 文件 / 1288 项，净增 1 文件 22 项，
  与新增用例数一致，用 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\("` 逐文件复核）。UI 视觉回归 11 项通过，
  其中负载均衡中英文基线两项渲染不变（新分支只在指标为 null 时触发，而基线夹具的节点答了全部数字）；初次提交当时
  只跑了视觉断言，没有重生成基线，也没有改动 `docs/refactoring/ui-visual-baseline.md`——这一步在父代理评审后按下面
  「评审后的修正」返工补做。按本项范围未运行便携版打包、Electron ABI 重建与真实上游实验。
- 指标完整性语义：同一个数字现在有四种互不混同的事实——引擎明确报 0（`running: 0`）、引擎答了别处但漏了这个字段
  （`LoadSample.running === undefined`，状态 API 上是 `null`）、样本超出 15 秒新鲜窗口（`SampleFreshness: "stale"`）、
  从未采到或整次读取不可解析（`"never_sampled"`，状态 API 上 `metrics: null`）。缺失字段全链路保持缺失：监视器不补零，
  `toLoadSample` 原样存 `undefined`，状态 API 用显式 `null` 上送（响应 schema 是闭合的，测试断言线上出现 `"running":null`），
  UI 显示 `-` 并标出“指标不全”，不会打印 0、`undefined` 或 `null` 字样。选路侧 `#loadOf` 取
  `max(本地 inFlight, 引擎答过的数字之和)`：漏答的数字不贡献任何值，所以引擎给出的数只是下界而不是“空闲”声明；两个字段
  都没答时不存在远端证据，负载就等于本地 reservation，与旧行为数值完全一致。既有断言没有放宽：LB05 选路用例一字未改就
  通过，LB08 只补上新增的 `sampleSequence` 字段，选路夹具的 `sample()` 改成如实保留调用方留下的缺失字段。
  只有 KV 的新鲜样本永远不会被判为空闲：`assessLoadSample` 给出 `completeness: "no_load_numbers"` 与
  `usableForLoadJudgement: false`，这就是保留的最小探针。
- 物理引擎去重与采样序号：采样侧原本就按 `canonicalKey` 只发一次 HTTP（LB08-05 钉住），本项把它变成可审计的事实——
  每个 `canonicalKey` 每被接受一次读就领一个递增序号，同一物理引擎的所有 target 别名共享同一个样本对象与同一个序号，
  所以别名既不会重复请求，也不会把 running/waiting 相加出双倍容量；失败的读不领序号，`stop()` 不清空序号表，
  重启监视器也不会回放旧序号。`engineLoadViews(nodes, now)` 把节点按 `canonicalKey` 折叠成每引擎一条视图（带 `targetIds`
  与每 target 自己的 `cooldownRemainingMs`/`inRotation`）；某个别名被禁用时取仍持有样本的那个别名，引擎的数字与 target
  的本地状态不会混在一起。target 级 `inFlight` 仍由 `LoadBalancer` 单独维护，本项没有把它并进引擎视图。
- 自动判定输入与后续用法：`assessLoadSample(sample, now, freshWindowMs?)` 返回 `LoadSampleAssessment`，把采样序号、
  时间戳、完整性、awake、指标来源和“能不能作为判定证据”一次交出来；`engineLoadViews` 给出按物理引擎去重后的这些评估。
  TRI-10 的 advisor 应当只读这两者加 `LoadBalancer.inFlight`/`cooldownRemaining` 来判失衡，并且只在
  `usableForLoadJudgement` 为真、`sampleSequence` 有新增时累计稳定次数：同一序号被重复读到不产生新证据。本项不执行任何
  自动迁移，也没有把 `awake`、`completeness` 或 `sampleSequence` 加进状态 API 响应（那是 TRI-05 的投影工作）。
- 结果与限制：现有 5 秒采样间隔、15 秒新鲜窗口和 4 秒采样超时保持原值，只作为“现行多久问一次、多久算当前”的事实描述；
  本项没有据它们推导任何自动阈值，也没有新增阈值。当前 Prometheus 文本不带采样序号，所以序号由监视器在被接受的读上
  发放，这是本清单允许的最小可验证方案；设计文档第 7.2 节的“同一采样序号”要按这个口径理解，真机校准（TRI-11）如果发现
  引擎自带更可靠的版本标记，先改设计文档再改代码。一处已知滞后：`docs/load-balancing-design.md` 第 8 节的 `LoadSample`
  速写仍写着 `running: number`，该文件是已跟踪文档、不在本项授权提交范围内，需要在下一阶段与代码同步。
- 后续边界：一是 `engineLoadViews` 与 `usableForLoadJudgement` 目前只有测试消费，尚无运行时读取方，接入要等 TRI-10；
  二是状态 API 还没有 awake、完整性与采样序号字段，UI 的“指标不全”是从 `metrics.running === null || metrics.waiting === null`
  推出的显示事实而不是服务端判定，TRI-05 若要把它们做成响应字段需另立 schema 与合同测试；三是同时过期与不全时徽章仍只
  显示“指标过期”（过期解释一切），自动侧一律拒绝；四是漏答字段让负载成为下界，引擎少答不会高估节点但可能低估，这个权衡
  在真实校准前不得改成阈值。
- 评审后的修正（父代理评审初次提交 07e1909 后在本任务内补做，不改路由语义，也不提前实现 TRI-04 以后）：一是按
  `ui-baseline-regen` 与 AGENTS.md 跑完整基线重生成，而不是只靠视觉断言；二是把 `#loadOf` 与 `reportedLoad` 的注释
  钉成“下界求和属于既有请求选择器排序，不是自动判定输入”，并为这条边界新增一项测试。
- UI 基线返工：先 `npm run bundle:ui`，再从大写盘符路径 `D:\code\local_ai_proxy` 运行
  `npm run regen:ui-baselines`（输出写 `logs/regen-ui-baselines.log`，不用 `head` 截断）。十张 `doc/ui_*.png`
  全部重新捕获并落盘——日志里有十行 `[regen] wrote doc/...`，十张文件的 mtime 都更新到本次运行；脚本随后按实测
  SHA-256 重写 `docs/refactoring/ui-visual-baseline.md` 的十个完整 64 位哈希行，最后打印
  `baselines and docs/refactoring/ui-visual-baseline.md hashes are in sync`，退出码 0（`-t "matches"` 过滤下
  10 项通过，第 11 条 760 px 断点用例被过滤掉、记为 skipped）。实测结果：十张重录图与 HEAD 已提交字节逐张完全一致，
  `sha256sum doc/ui_*.png` 与登记表十行哈希逐字相同，`git status` 对 `doc/` 与该基线文档零改动；用 pngjs 读出的
  尺寸 1278 x 1215、1278 x 1208、1278 x 1150、1278 x 1194、1384 x 1212、1384 x 1224、1278 x 1553、
  1278 x 1553、1180 x 1779、1180 x 1779 也与登记表逐行一致。因此本次返工没有产生任何基线图片、README 引用或
  基线文档的 diff，原因有两层：新分支只在 `metrics.running === null || metrics.waiting === null` 时触发，而视觉夹具
  （`loadBalancerStatusFixture()` 未开 `lbStatusPartialMetrics`）的节点答了全部数字；基线里「节点状态」`<details>`
  又保持折叠（`isLbGroupOpen()` 读 localStorage，`loadLbBaseline()` 从不点开），这些行根本不进入画面。十张图逐张
  完整检视：五张中文图与登记表描述一致，五张英文图（Proxy、Load balancing、History、Usage statistics、Task detail）
  界面文案没有任何中文；`ui_proxy_en.png` 第二个代理名称输入框里的“新代理”是 fixture 数据
  （`test-node/ui/admin-ui-fixture.ts` 里的 `name: "新代理"`），与既有登记口径一致，不属于界面文案。
- partial 的路由语义与自动判定边界：`#loadOf` 与 `reportedLoad` 的注释现在写明，漏答字段不参与求和所形成的下界属于
  LB-05 请求选择器的既有排序语义，不是自动判定可消费的输入；自动侧（TRI-10）只读
  `assessLoadSample().usableForLoadJudgement`，即 fresh + complete + awake 三个条件同时成立，partial、
  `no_load_numbers`、stale 与 `awake === false` 一律拒绝，缺失的 `running`/`waiting` 在那里永远不会被当成空闲。
  选路行为一字未改，代码里也没有任何注释声称 partial 可用于自动判定。为这条边界新增一项用例
  `[TRI-03] the selector ranks known numbers as a lower bound the judgement gate refuses`：同一份只有 `waiting: 5`
  （`running` 缺失）的样本，在选路侧作为 5 的下界参与排序、让从未采样的 `node-b` 以 0 胜出，在判定侧
  `assessLoadSample` 报 `partial` 且 `usableForLoadJudgement: false`；同一项里再钉住 KV-only（`no_load_numbers`、
  拒绝）、无样本（`never_sampled`、拒绝）与引擎明确报 0（`complete`、`running: 0`/`waiting: 0`、可用）三种事实。
  原先两项 `[TRI-03]` 选路用例与 `test-node/proxy/load-evidence.test.ts` 的 partial、明确零、awake 用例一字未改，
  继续作为证明。
- 返工后验证：`npm run check` 全链通过（format:check、lint、typecheck、`check:modules` 136 模块 308 运行时边、
  0 环 0 越界、test、build），结束时 `prebuild` 的 `npm rebuild better-sqlite3` 已把原生模块恢复到 Node ABI。
  `npx vitest run test-node/ui/admin-ui-visual.test.ts test-node/ui/admin-ui-load-balancing.test.ts` 2 文件
  26 项全过（视觉回归在非重录模式下 11 项全过）。五个 TRI-03 套件再单独跑一遍：
  `test-node/proxy/load-evidence.test.ts`、`test-node/proxy/load-monitor.test.ts`、
  `test-node/proxy/load-metrics.test.ts`、`test-node/proxy/load-balancer-selection.test.ts` 与
  `test-node/admin/load-balancer.test.ts`——`npx vitest run` 跑这五个文件共 43 项全过（11 + 10 + 5 + 11 + 6）。`npm test` 141 文件通过、1 文件跳过（1311 项通过、2 项跳过；初次提交
  1310 项，净增 1 项与本条新增用例一致），按 AGENTS.md 的声明式口径复核
  `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" HEAD -- test-node` 为 1141，工作树为 1142，
  测试文件数同为 141，唯一增量落在 `load-balancer-selection.test.ts`
  （10 → 11），没有用例被删掉。本项范围依旧不含自动改绑、`rebalance_mode`、迁移 API 与数据库 schema，TRI-04
  之后也没有开始；按本项范围仍未运行便携版打包与真实上游实验。修正落在初次提交之上的提交 b337506（完整哈希
  b33750615ac2274d67968e77ab675431e951bc53），用显式 `git add` 只收 `src/proxy/load-balancer.ts` 与
  `test-node/proxy/load-balancer-selection.test.ts` 两个文件；十张基线图、README 引用与基线文档因为没有 diff 而无事
  可收，研究文档与本 TODO 继续留在未跟踪状态，也没有进提交。

### TRI-04

- 状态：已完成
- 修改文件：新增 [binding-history-association.ts](../src/maintenance/binding-history-association.ts)，修改
  [task-store.ts](../src/persistence/task-store.ts)、[record-store.ts](../src/persistence/record-store.ts)、
  [repository.ts](../src/persistence/repository.ts)、[persistence/index.ts](../src/persistence/index.ts)、
  [maintenance/index.ts](../src/maintenance/index.ts)、
  [task-identity.ts](../src/proxy/protocol/task-identity.ts) 与
  [task-matcher.ts](../src/logging/task-matcher.ts)。测试：新增
  `test-node/maintenance/binding-history-association.test.ts`（25 项 `[TRI-04]`）与
  `test-node/persistence/task-history-read.test.ts`（8 项 `[TRI-04]`）。
- 验证：`npm run check` 全链通过（format:check、lint、typecheck、`check:modules` 137 模块
  314 运行时边与 107 类型边、0 环 0 越界、test、build），收尾时 `prebuild` 的
  `npm rebuild better-sqlite3` 已把原生模块恢复到 Node ABI，`npm run abi:node` 用真实查询确认
  `NODE_MODULE_VERSION 137`。新增两份测试单独跑：2 文件 33 项全过。相关套件再整片跑：
  `test-node/logging test-node/persistence test-node/maintenance` 25 文件 271 项全过（其中
  `task-matcher.test.ts` 的 15 项一字未改仍全过，证明共享边界指纹辅助的抽取没有改动匹配行为），
  `test-node/proxy test-node/admin test-node/app test-node/config` 66 文件 771 项全过。`npm test`
  143 文件通过、1 文件跳过（1344 项通过、2 项跳过，共 1346 项）。按 AGENTS.md 的声明式口径复核
  `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" HEAD -- test-node` 为 1142，工作树为 1175，
  测试文件数 142 → 144；用 `--exclude` 把两份新文件排除后再跑一遍，得到 141 通过、1 跳过与
  1311 通过、2 跳过，与 TRI-03 记录里的 HEAD 口径一致，33 项增量与新增声明数一致，没有用例被删掉。
  提交后独立复核复跑了同一批命令，结论不变：`format:check`、lint、typecheck、`check:modules`（仍是
  137 模块 314 运行时边与 107 类型边、0 环 0 越界）、`npm test` 与 `npm run build` 全绿，两份新测试
  单独跑 2 文件 33 项全过，`test-node/logging test-node/persistence test-node/maintenance` 仍是
  25 文件 271 项全过；声明式口径此时 HEAD 即 `ab74668` 为 1175、`HEAD~1`（TRI-03 收尾 `b337506`）为
  1142，差值 33 正等于两份新文件的 25 + 8 项声明，测试文件数仍是 142 → 144。选路器运行时闭包复测
  为 24 个模块且不含任何 `src/persistence/**` 与 `src/maintenance/**`，新模块闭包 44 个模块且
  `reaches no transport root`；`src/admin/**`、`src/app/**`、`src/ui` 与前端模块里没有任何
  `BindingHistory` 引用，TRI-05 之后的装配与 UI 确实没有提前落地。
  本项范围不含便携版打包、Electron ABI 重建、UI 基线与真实上游实验；所有夹具都建在临时目录，
  没有读写用户实例的 traffic database。
- 结果与限制：数据库一字未动——仍是 schema v13 与 `tasks`、`records`、`context_links`、
  `response_links` 四张现有表，没有新表、没有新 schema 版本、没有迁移，写入口也保持原样（历史行仍只由
  `TrafficLogService`、`TaskMatcher` 与 `LoadBalancer` 经 `TrafficRepository` 写入）。本项把“先核对索引、
  写入口与返回方向”落成代码：两张链接表都以 key 为 `PRIMARY KEY`（`context_key` / `response_id`），
  查询因此走主键自动索引做 `IN (...)` 批量读，一条语句解决一批 key；
  绑定侧的 `response:<id>` 前缀只在本查询内部剥成日志实际存储的裸 id，日志写入路径与存储格式未改。
  关联被明确定义为只读且非权威：一个 exact key 可以对应零个、一个或多个历史 task，`high` 只在 exact key
  确实指向某个 task 且该 task 现存的静态边界（去掉 `first_user` 的边界指纹）仍与绑定记录的边界一致时才给出；
  有链接但边界已不一致降级为 `candidate`，只有边界相同也是 `candidate`，`link_boundary_mismatch` 与
  `boundary_candidates` 两种理由把降级和仅边界两种事实分开说。候选永远不等于唯一身份：只要存在
  `candidate`，`ambiguous` 必为 `true`，多个 `high` 同样 `ambiguous`，`confidence` 仍为 `high` 并保留全部
  命中，绝不挑一个代表项。返回的 task 先按等级分组（`high` 在前，有链接但边界已变的降级项其次，仅边界
  相同项最后），组内一律按 `COALESCE(last_seen_at, last_response_at, started_at)` 倒序——SQL 已经这么排，
  JS 侧用同一口径再排一次保证三组拼接后仍可解释；每项带自己被 exact key 命中的次数，另有 key 计数、
  链接行数、task 行数与扫描行数四组覆盖计数。
  `key_without_task` 专门报告“链接行还在、它指的 task 行已经没了”这一类清理或导入后的不一致，
  不会被算成“没有关联”。
- 有界与只读：一次查询只开一条连接、用完立即关闭，读取不写任何数据（测试直接比对前后各表行数）。
  上限为每次查询 64 个 exact key（硬顶 256）、64 个链接 task（硬顶 256）、100 行候选扫描（硬顶 500）、
  返回 50 个 task（硬顶 200），超出即截断并报 `key_limit_exceeded`、`candidate_scan_truncated`、
  `task_list_truncated` 与 `historyTruncated`；候选扫描多取一行来判定是否还有后续，因此没有无界
  `COUNT(DISTINCT)`、没有逐条正文读取、没有 N+1。读连接自带较短的 `busy_timeout`（默认 500 ms、上限
  5000 ms，由新增的 `TrafficRepositoryOptions.lockWaitMs` 设定，不影响写连接）。关联投影只有 11 列，
  `last_user_messages_json`、请求与响应正文列和 `search_text` 都不在其中，四条语句的执行计划里没有任何
  `body_chunks` 访问，返回值也不含任何 exact key 原文；解码只经 `storedJsonObject` 读
  `boundary_fingerprints_json` 一列。历史-only task 不返回任何可迁移操作字段，查询不创建 binding、不续期
  TTL、不增加 requestCount，也不进代理热路径——`src/proxy/` 里只有共享辅助函数被抽出，
  `npm run check:modules -- --closure src/proxy/load-balancer.ts` 报选路器的运行时闭包为 24 个模块、
  其中没有任何 `src/persistence/**` 或 `src/maintenance/**` 模块，而新模块自身的闭包为 44 个模块且
  `reaches no transport root`。
- 覆盖与失败口径：`coverage.state` 取 `available`、`no_log_configured`、`no_traffic_database` 或
  `failed`。读取失败时 `failure` 带 `phase`（`open` 或 `read`）、SQLite `code`、`errorName` 与消息，
  并且此时只报 `history_query_failed`，由链接推导的 `key_without_link`、`key_without_task` 与
  `link_boundary_mismatch` 一律不再产生，防止把数据库错误读成“这个绑定没有历史”；异步日志还没落库时
  用库内最新记录时间与绑定的 `lastRequestStartedAt` 比较，报 `log_write_may_be_pending`，不改写等级。
  日志根只接受调用方（`resolveRuntimeLogRoot` 与组配置校验）解析出的结果，本查询不自己拼路径；
  `tasks.target` 只是日志存下的上游 URL，仅在 `parseTargetUrl` 能解析时经 `tryCanonicalNodeKey` 与当前
  canonical key 比出 `same` 或 `different`，否则为 `unknown`，从不把它当 canonical physical key，
  task 自身没有 URL 时回退到最新一条 record 的 `target_url`。`storedBoundaryFingerprints` 从
  task-matcher 抽到 `task-identity.ts` 供读写两侧共用，matcher 的行为与测试一字未改。
- 夹具与执行计划：索引与计划口径由 `test-node/persistence/task-history-read.test.ts` 的一项用例钉住：
  120 个 task、120 条 `context_links` 与 120 条带正文的 record 上，四条语句的 `EXPLAIN QUERY PLAN` 必须
  分别报 `SEARCH context_links USING INDEX`、`SEARCH response_links USING INDEX`、
  `SEARCH tasks USING INDEX` 与 `SEARCH tasks USING INDEX idx_tasks_kind`，并且四份计划里都不出现
  `SCAN`、`body_chunks`、`record_search` 或 `last_user_messages`；候选计划还必须报
  `SEARCH records USING INDEX idx_records_task_sequence`，即那个相关子查询只为取最新 record 的上游
  URL 走 `(task_id, sequence)` 索引。每份镜像 SQL 先与 store 自己的返回逐项比对，语句一旦漂移用例
  立刻变红。另用一份临时脚本（放在被忽略的 `logs/` 下，不入库）在更大的规模上量过一次：1000 个
  task、1000 条 `context_links`、2000 条 record（产生 `body_chunks` 2001 行），单次 key 查询、task 查询
  与最新时间都在 1 ms 内，完整一次绑定历史查询 7 ms、读 104 行、返回 50 项并报截断；排序因为键是
  表达式而走 `USE TEMP B-TREE FOR ORDER BY`，不依赖 `idx_tasks_sort`。
- 后续边界：本项只提供 maintenance 侧的服务与类型，没有管理端路由、响应 schema 或 UI——按 §2.1
  “新增路由必须注册真实 service、请求/响应 schema 和 API contract 测试”与 TRI-05 的分工，TRI-04
  验收里“管理端至少有一条与绑定表联调的查询路径”要等 TRI-05 注册路由后才能闭合，本项先用
  `LoadAffinityTable` 产出的真实 exact key 与隔离夹具闭合查询侧合同。第二，迁移操作字段属于
  TRI-07/TRI-08，本查询刻意不返回，历史-only task 因此无法被迁移。第三，候选扫描只按日志根对应的
  数据库文件隔离，不按 group id 过滤，共用同一日志根的多个 group 会互相看到候选 task；这是日志物理
  结构决定的现状，TRI-05 若要按 group 收窄需要在查询参数上另行扩展。第四，本项的并发证据只有
  连接级 `busy_timeout` 与只读不写的对比，WAL 模式下排它写者并不阻塞读者，因此没有构造真实的
  读写争用场景。
- 提交：`ab74668`（完整哈希 ab74668fb5e380fd621c5428f9489fd83e4c6296），用显式 `git add` 只七处产品
  源码与两份新测试；研究稿、设计稿与本 TODO 继续留在未跟踪状态，也没有进提交。

### TRI-05

- 状态：已完成
- 修改文件：修改 [admin-contracts.ts](../src/admin/admin-contracts.ts)、
  [admin-schemas.ts](../src/admin/admin-schemas.ts)、[admin index](../src/admin/index.ts)、
  [load-balancer.ts 路由](../src/admin/routes/load-balancer.ts)、
  [admin-services.ts](../src/app/admin-services.ts)、[proxy index](../src/proxy/index.ts)、
  [load-affinity.ts](../src/proxy/load-affinity.ts)、
  [load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts)、
  [load-balancer.ts](../src/proxy/load-balancer.ts) 与 [proxy-manager.ts](../src/proxy/proxy-manager.ts)，
  共 10 处产品源码。测试：新增 `test-node/admin/load-balancer-tasks.test.ts`（14 项 `LB-T01`…`LB-T14`），
  修改 `test-node/admin/api-contract.test.ts`（+2 项 `[TRI-05]`）、
  `test-node/admin/load-balancer.test.ts`、`test-node/admin/response-schema-openness.test.ts`、
  `test-node/admin/admin-service-fixtures.ts`、`test-node/app/service-assembly.test.ts`（+1 项
  `[TRI-05]`）与 `test-node/ui/admin-ui-server.ts`；合计 17 个文件。
- 验证：`npm run typecheck` 通过（`tsconfig.json` 与 `tsconfig.ui.json` 均 `exit 0`，
  `@ts-expect-error` 反例仍是指望的错误），`npm run lint` 通过（`--max-warnings=0`），
  `npx prettier --check .` 全绿，`npm run check:modules` 报 137 模块、318 条运行时边、
  111 条类型边、0 环 0 越界，`npm run build` 通过，`npm run check:skills` 7 项全过。
  `git diff --check` 与提交后的 `git status` 均只有预期内容，工作树除两份未跟踪的任务路由文档外为空。
  定向五文件（`load-balancer-tasks`、`load-balancer`、`api-contract`、`response-schema-openness`、
  `service-assembly`）为 5 文件 47 项全过；`npm test` 全量为 145 文件（143 通过、1 跳过）与
  1362 通过、2 跳过，但两次并发运行各自在**不同**的 UI 文件上撞上
  `afterAll(closeStubAdminServer)` 的 30 秒拆除超时（先 `admin-ui-visual.test.ts`，后
  `admin-ui-history.test.ts`），两个文件单跑分别 11/11 与 39/39 全过，串行全量
  `npx vitest run --no-file-parallelism` 为 144 通过、1 跳过、1362 通过、2 跳过且 `exit 0`，
  与 `docs/ai-development-optimization-todo.md` 里 AI-22、AI-24 与 CSS 项三次记录的同一并发
  拆除超时一致，不是本项引入的断言失败。按 AGENTS.md 的声明式口径复核
  `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" HEAD~1 -- test-node` 为 1176、提交后为 1193，
  测试文件数 144 → 145，17 项增量正等于 12 项 `LB-T` 加 `api-contract` 的 2 项加
  `service-assembly` 的 1 项加 `LB-T13`/`LB-T14`，没有用例被删掉。
  `npm run abi:node` 用真实查询确认 `NODE_MODULE_VERSION 137`；本项范围不含便携版打包、
  Electron ABI 重建、UI 基线与真实上游实验，所有数据库夹具都建在临时目录，没有读写用户实例的
  traffic database，也没有停或改用户正在跑的 portable 实例。
- 结果与限制：路由 `GET /api/load-balancer/tasks` 只在 `options.loadBalancerService !== undefined`
  时随同 `GET /api/load-balancer/status` 一起注册，因此生产装配下它不可能以
  `not_found` 出现；两个 404 原因分开命名为 `pair_not_found` 与 `group_not_found`，各带自己的句子，
  参数校验失败一律是 Fastify 的 `FST_ERR_VALIDATION`（缺 pair 或 group、空 id、`limit` 越界、
  小数 `limit`、负 `offset`、schema 未声明的键、空 `targetId` 共十种都被钉住）；历史读取失败不变成
  500，而是 200 里 `coverage.state: "failed"` 加 `failure` 的 `phase`、SQLite `code`、`errorName`
  与截到 512 字符的消息，并且此时不再产生由链接推导的 `key_without_link` 等理由，不把数据库错误
  读成“这个绑定没有历史”。闭集 schema 覆盖查询与响应本身加其下八层嵌套对象（行、context、
  `movable`、associations、coverage、task、node、metrics），页面 `limit` 上限 200、
  `items` 与 `tasks` 上限 200、`nodes` 上限 256、`reasons` 上限 13，未声明键（含 TTL、过期时间、
  用户消息计数这类诱饵）在每一层都被序列化器丢掉。
  读取侧：列表取自 `bindingSnapshot()`，即 `bindingEntries()` 的无副作用拷贝，前后两次拷贝
  `toStrictEqual` 证明没有续期 TTL、没有加 `requestCount`、没有改 target、没有淘汰；引擎只在
  采样时被问过，列表本身从不问；没有 balancer 时 `runtimeEpoch` 与 `groupRevision` 为 `null`、
  页面合法为空，节点仍按配置说明自己并把“从未采样”报成 `never_sampled` 而不是空闲；日志根未配置
  报 `no_log_configured`、库不存在报 `no_traffic_database` 并断言不创建 `traffic.db` 与 `-wal`；
  部分指标保持 `partial`、只有 KV 保持 `no_load_numbers`，被引擎跳过的数字保持 `null`；
  共享 binding（一个 binding 的三个 exact key 分别链接到三个 task）仍是一行、一个移动入口、
  `confidence: "high"` 且 `ambiguous: true`，三个 task 全列，边界已漂移的链接降级为 `candidate`
  并报 `link_boundary_mismatch`，仅有 pending 行的 task 带 `pendingRequestOnly: true` 与
  `lastResponseAt: null`，日志最新记录早于本绑定的请求开始时报 `log_write_may_be_pending`；
  读取侧的三个上限（扫描行数、返回 task 数、exact key 数）连同被略过的 key 数一起在 `coverage`
  里报出而不是藏在实现里，超出即报 `key_limit_exceeded`、`candidate_scan_truncated`、
  `task_list_truncated` 与 `historyTruncated`（LB-T09），候选截断时不挑一个代表项；
  `historyTargetNode` 三态 `same`/`unknown`/`different` 都在响应里出现；组外的 `targetId` 与关掉的
  group 都答合法空白页而不是 404，且节点计数保持整组口径，不被过滤子集缩小；空配置装配下
  状态路由答 `{now, pairs: []}`，列表路由答命名的 `pair_not_found`。响应不含 exact key 原文、
  边界指纹、用户消息哈希、正文、用户消息、上游密钥或 session/prompt_cache 原文（LB-T11 逐项查）。
  装配侧：`AdminServerOptions` 现在要求 `getBindings`，`assembleAdminServices` 用
  `new BindingHistoryService()` 与 `manager.logRootForTarget()` 把它建出来，
  `REQUIRED_ADMIN_SERVICES` 当时登记 `getStatus` 与 `getBindings`（TRI-08 整合之后是四条：
  `getStatus`、`getBindings`、`moveBinding`、`cancelMoveBinding`，见下面 TRI-08 的整合记录），
  `assertAdminServicesComplete` 对
  经 cast 构造、方法缺失的半装配按名字报 `loadBalancerService.getBindings`，而只带 `getStatus`
  的服务在编译期就被 `@ts-expect-error` 反例拒掉；空 manager 上真实装配答
  `{error: "pair_not_found"}`，证明生产装的是能答这个路由的服务而不是一个占位方法。
  `src/proxy/load-balancer-admin.ts` 的运行时闭包为 26 个模块，不含任何 `src/persistence/**` 或
  `src/maintenance/**`，`reaches no transport root`：数据库只经装配注入的 reader 可达。
- 与 §6.1 草图的差异（已收敛）：实现把响应摊平——`targetFilter` 而不是回显 `targetId`，
  `associations.coverage` 逐项而不是一份顶层 `coverage`，新增一份 `nodes` 节点状态，
  没有 `lastServedTargetId` 而是每个 task 的 `historyTargetNode`，`context.source` 用账本自己的
  `normalized_usage` 而不是草图的 `usage`。按 §2 第 3 条“实现改变设计合同要先改设计文档”，
  父代理评审后已把设计文档第 6.1 节的示例与字段表改成实现实际交付的形状，并写明这些偏离的理由；
  本项的完成记录只写实现事实，设计权威现在与响应 schema 一致。
- 后续边界：TRI-06 的节点列表 UI 还没有读这个路由——`test-node/ui/admin-ui-server.ts` 里那句
  `getBindings` 只是为了让桩管理端服务集完整、类型能编译，页面上没有任何 binding 行，UI 基线
  与截图因此也未重录（本项无 UI 改动）；TRI-06 整合之后这条边界已过——节点行下的列表真的读
  这一路由，桩服务按夹具答它并记下每次读取的参数，两张负载均衡基线也因为画面里多了展开区而重录，
  见下面 TRI-06 的记录。TRI-07 的 `moveBinding()` 已在主 checkout 落地，但本路由
  刻意不读它，所以 `migration: "unavailable"` 与每个 `movable.ok: false`（理由 `migration_unavailable`，
  在途时再加 `in_flight`）仍是本项能给的全部可迁移性答案：目标是否可选、cooldown、asleep、物理引擎
  与模型兼容一律没有判断，要等 TRI-08 把这条列表接到迁移服务上；TRI-08 的
  `POST /api/load-balancer/task-moves`、幂等键、409 冲突与取消路由当时一条也没有注册，路由表 34 项里
  只有这一条新增；TRI-08 整合之后两条都已注册、路由表 36 项，见下面 TRI-08 的记录。本项也不动 `manualProtection`。第二，本项不改数据库：提交里没有任何 `src/persistence/**` 文件，schema 仍是 v13，
  没有新表、没有新 schema 版本、没有迁移，也没有 traffic 写路径；本查询只读 `tasks`、`records`、
  `context_links` 与 `response_links` 四张现有表。第三，advise/auto 与 `rebalance_mode` 未实现，`usableForLoadJudgement` 只是
  随响应带出的事实，不是判定。第四，一页最多 200 个 binding 会为每个 binding 各开一次只读连接
  （TRI-04 的“一次查询一条连接”口径），共用同一日志根的组内这是 N 次开关而非一次复用，若要改成
  整页复用一条连接需要扩 `BindingHistoryService` 的接口，属新的服务决定。第五，候选扫描仍只按
  日志根物理隔离、不按 group 过滤，共用日志根的多个 group 会互相看到候选 task。
- 提交：`90d2455`（完整哈希 90d2455dfe43ffbd93c5a0074dc06dbbf65e2df7），用显式 `git add --` 只
  十处产品源码与七份测试（含新增的 `test-node/admin/load-balancer-tasks.test.ts`）；没有
  `git add -A` 或 `git add .`，设计稿、本 TODO 与研究材料继续留在未跟踪状态，未进提交，
  临时日志与探针脚本已全部删除。
- 整合：cherry-pick 到主 checkout 后是 `8b825c8`（完整哈希
  8b825c8b75c34b226b76a4ee36afb3c8ffa77594），文件集与源提交逐项相同、无冲突。整合后的全量
  `npm run check` 为 `exit 0`：Prettier 全绿、lint 零告警、两份 typecheck 通过、
  `check:modules` 报 138 模块 / 323 运行时边 / 111 类型边 / 0 环 / 0 越界，Vitest 145 文件
  （144 通过、1 跳过）与 1412 通过、2 跳过，`build` 通过；`npm run check:skills` 7 项全过，
  `git diff 5774a20 HEAD` 不含 `AGENTS.md`、`docs/**`、UI、配置或 persistence 路径。

### TRI-06

- 状态：已完成，父代理独立复审已通过，三个提交按顺序整合进主 checkout。lane
  `D:/code/local_ai_proxy-wt-tri06`（基线 `8b825c8`）不含主树的 TRI-07/TRI-08 修正，所以整合是
  三次 cherry-pick，不 reset、不把整棵 lane 树盖回主树：原实现 `c8a57d7`（完整哈希
  c8a57d77da37f6a4dea6258c20bcf7611f5e80c6，10 个文件、2151 增 12 删）在主树是 `cc727df`（完整哈希
  cc727df10c7dcdda1baa931d91be377895981b7c），复审返工 `458baac`（完整哈希
  458baac1e1ead5fe7547940edc831f3504c9b44f，7 个文件、492 增 21 删）在主树是 `d844249`（完整哈希
  d84424996ddb1b2be3d116a23760d7f549ff8da6），行上限修正 `ce7a924`（完整哈希
  ce7a9240d88c4dd5a07cd47b69aae308d39f8d8a，2 个文件、145 增 12 删）在主树是 `7ac7e50`（完整哈希
  7ac7e50d72fd9ffa303e8aa067a0be2ab4f57eb0）。三次都是显式 `git add --` 逐路径，没有
  `git add -A` 或 `git add .`，`.pi/` 下的探针脚本与日志不进提交。
- 整合冲突只有一处：`test-node/ui/admin-ui-server.ts` 的 `loadBalancerService` 块。lane 用真实
  只读桩（`lbBindingFixturePage` 答这一路由、`lbBindingReads` 记下每次读取的参数）换掉原来那句
  `getBindings: () => ({ response: emptyBindingListResponse() })`，而主树紧接着有 TRI-08 的
  `moveBinding` 与 `cancelMoveBinding` 两个命名拒绝桩（`pair_not_found`、`operation_not_found`，
  shape 是真实服务的答复）。按“三者都留”解决：读取桩换成 lane 的实现，TRI-08 的两个方法与原有
  shape 一字不动，主树其余改动全部保留；后两次 cherry-pick 无冲突，`git diff 2b583da HEAD` 只含
  TRI-06 的 13 个跟踪文件，`git diff HEAD ce7a924` 只含主树自己的 TRI-07/TRI-08 与文档差异。
- 修改文件：三个提交在主树合起来 13 个跟踪文件。产品侧 4 个：`src/admin/static/app.css`
  （`SECTION: load balancing` 由 53 条增至 86 条）、`modules/core.js`（中英文各新增 56 个键，两边
  键集逐项相同）、`modules/load-balancing.js`（节点行里的绑定面板：开合、读取、随状态轮询刷新、
  分页、代次身份、去重、取消、迟到答案丢弃、关闭态持久化与面板回收）、
  `src/admin/ui-contracts.d.ts`（`ApiRoutes` 多一条 `/api/load-balancer/tasks?${string}`）。测试侧 4
  个：`admin-ui-fixture.ts`（按真实响应语义搭的绑定列表夹具与两个旋钮）、
  `admin-ui-load-balancing.test.ts`（声明数 15 → 33，新增 18 项 `[TRI-06]`）、
  `admin-ui-page.ts`（`loadLbBaseline`：真的展开节点状态段与第一个节点的列表，先等到一次真实状态
  读取再量高截图，按代表行缩短列表）、`admin-ui-server.ts`（桩服务按夹具答这一路由并记下参数）。
  基线侧 5 个：`doc/ui_lb_cn.png`、`doc/ui_lb_en.png`、`doc/ui_task_detail_cn.png`、
  `doc/ui_task_detail_en.png` 与 `docs/refactoring/ui-visual-baseline.md`。
- 验证（主树整合后实际跑，不引用 lane 的报告）：`npm run check` 从大写盘符 `exit 0`——
  `format:check` 全绿、`lint` 零告警（`--max-warnings=0`）、`tsconfig.json` 与 `tsconfig.ui.json`
  两份 typecheck 均 `exit 0`、`check:modules` 报 138 模块 / 323 运行时边 / 114 类型边 / 0 环 /
  0 越界、Vitest 147 文件（146 通过、1 跳过）与 1477 通过、2 跳过、`build` 通过；整合前的同一
  条链是 147 文件 / 1459 通过 / 2 跳过，1459 + 18 = 1477 正对上新增的 18 项。`npm run
  check:skills` 7 项全过，本项整合后跑过两次（改 skill 之前与之后）。`git diff --check` 为空。
  按 AGENTS.md 的声明式口径复核
  `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" <rev> -- test-node`：整合前 `2b583da` 为
  1290 项声明，整合后为 1308 项，增量 18 正等于原实现的 12 项、返工的 5 项与上限修正的 1 项；
  测试文件总数用 `git ls-tree -r <rev> --name-only` 后精确匹配 `*.test.ts` 得到 147 → 147，
  `admin-ui-load-balancing.test.ts` 的声明数 15 → 33（本项正式 33 项），没有用例被删掉。Vitest
  实跑总数 1479 高于声明数 1308，差额是 `it.each` 一类按夹具展开的动态用例，不是计数口径问题。
- 基线：`npm run regen:ui-baselines` 重拍全部十张并同步哈希行；十张图的实际 sha256 与文档行逐项
  相同，实际尺寸与文档“图片尺寸”列逐项相同。负载均衡两张现在是 1278 x 2487
  （`c1f3b25828a753aeff615d66d1eb195b91467bba4beece366c5a7d5661c4b3d0`）与 1278 x 2648
  （`ee658f2976429980e0e361f52773091a23dc1d0ec982e703f1bc187feba983b2`），与父代理复审时核对过的
  两张一致；其余八张与整合前已提交图字节相同、哈希相同，所以本轮没有环境漂移。十张图全尺寸逐张
  读过（两张新 LB 图里展开的节点行六项事实、五行代表 binding、汇总句 `5 / 5`、没有“继续读取”按钮、
  折叠的邻居与超长模型名的省略号都在画面里）；英文界面另用 DOM 扫描五个页面状态（代理列表、展开
  一个节点的绑定列表、历史记录明细、使用统计、任务明细面板）：渲染出来的中日韩文本零命中，两处非
  渲染命中是 fixture 里第二张代理卡的名称值“新代理”（`input` 的值，不是界面文案）与统计页预设组的
  `aria-label="统计时间范围"`（`81e1da8` 带来的遗留，不进画面也非本项引入）；两张 LB 英文图连属性
  命中都没有，`admin-ui-load-balancing.test.ts` 里“切回英文后面板不含中日韩字符”那条断言也在钉它。
  与整合前 `2b583da` 的已提交图逐像素比对：LB 两张在重叠区分别差 2087（0.1420%）与 1974
  （0.1294%）个像素，另外 1337 与 1454 行是新增内容、含 53590 与 58868 个非空白像素——展开区带来的
  真实变化，不是编码器噪声；其余八张 0 个像素差。任务明细两张各差 60 个像素，位置是 x 32–39、
  y 211–218 的一枚绿色圆点，即 `4323f3f`（历史列表“请求仍在进行”标记）落定时没跟着重拍的基线遗留，
  本轮全量重拍把它补正，不是本项引入的画面变化；两张尺寸仍是 1180 x 1779，README 按路径引用这些
  图，无需改字。父代理复审留下的 4 张临时展开图（`.pi/tri06-review/screenshots/lb-bindings-open-*`，
  1278 与 380 两种宽度、中英两种语言）留在原处未删，`.pi/` 被 gitignore，不进提交。
- 交付证据（本项整合后在主树跑）：`npm run package:electron:portable` `exit 0`；
  `release/LLM-Proxy-0.4.10-x64-portable.exe` 111917861 字节、sha256
  `d010a71d03c8f676071b95071515760d3793e74ef6b0d1775483296f741f3151`；
  `release/win-unpacked/LLM Proxy.exe` 213991424 字节、sha256
  `4b7bc0b75507c1ab16ed7f5dfe8b182ce1ca1821f372622f42b20ad36a0aad54`；
  `release/win-unpacked/resources/app.asar` 3173 项、18055103 字节。读包内的
  `dist-node\src\admin\static-bundle\admin-app.js` 与 `modules\load-balancing.js` 能看到
  `bindingVersionKey`、`lbBindingReadRowCap`、`panel.version`、`data-lb-bindings-toggle`、
  `lb-binding-panel`、`迁移此绑定` / `Move this binding` 与 `migration service is not wired yet`；
  读包内的 `dist-node\src\admin\routes\load-balancer.js` 仍能看到 `/api/load-balancer/task-moves`、
  `/api/load-balancer/task-moves/:operationId` 与 `moveBinding` / `cancelMoveBinding`，即 TRI-08 的
  迁移逻辑没有被这次整合挤掉；归档里 `static-bundle` 只有 `admin-app.js` 一项，上一版残留的
  `modules-bridge.js` 已被构建路径清掉。`npm run smoke:delivery` 两步都过：解包载荷 547 ms 健康、
  一次真实代理往返 200、`GET /api/logs?limit=5` 200 且 `total` 为 1、该次运行的日志根里出现
  `traffic.db`（4096 字节）、退出码 0；portable 包装器 2588 ms 健康，同样三项、同样退出码 0，两次
  都用独立临时配置与独立 `LLM_PROXY_DATA_DIR`，事后临时目录被删除。之后 `npm run rebuild:node` 与
  `npm run abi:node` 用一次真实查询把 Node ABI 恢复到 `NODE_MODULE_VERSION 137`；`rebuild:electron`
  与 `electron-builder` 之间没有跑过任何 Node 重建。只终止本任务启动的进程，用户的便携实例、其配置
  与 traffic database 未被读写。
- 结果与限制：列表只在用户按下节点行上的“路由绑定”按钮后才被读一次，关闭的面板与折起节点状态段里的
  面板从不被问；已开的面板跟着本文件已有的状态轮询刷新，不新增计时器或监听。读取串行且丢弃迟到答案：
  一个面板同时只有一条在途读取，序号不同或启动它的那次 init 已不是当前这一次即整条答案作废，迟到的
  那一行数字不会覆盖更新的那一份（测试用一次被扣住 800 ms 的第一答与一次立刻答的第二答钉住）。面板按
  `(pair, group, node)` 三元组寻址，绑定号单独不是地址；答案里 `pairId`、`groupId` 或 `targetFilter`
  与面板不符即整页丢弃，不把别的节点的绑定挂到这个节点名下。404 的两个原因按服务端 code 存成翻译键、
  渲染时才取句子，所以切换语言后那句原因跟着换语言，而不是停在读失败当时说的语言；服务端自己的消息与
  code 原样保留，不假装是能翻译的文案。闭集值一律查词表（活动三态、成本来源、置信、task 级别、
  `historyTargetNode` 三态、coverage 四态、13 条关联理由、两条移动理由），词表没有的值原样报线名而不是
  吐出一个翻译键。一个 binding 的三个 exact key 连到三个 task 时仍是一行、一个移动入口、一处
  `Linked tasks: 3`，地址行只写绑定本身，不挑一个 task 当代表；`historyTargetNode` 的同一节点/别的节点/
  历史落点未知三态与只有进行中请求的标记同屏可见。历史读取失败说 `history query failed` 并带
  `phase · errorName · code · message`，与“还没有 traffic.db”“没有配日志根”三句话各自独立，绝不把读坏
  当成“这个绑定没有历史”；扫描被截断与日志可能还没写进去作为单独标签写在置信度旁边。节点自己的
  `Bindings:` 与 `In flight:` 始终来自状态响应，面板里的行不改写它们；空列表说“这个节点目前没有
  binding”并留下节点行原来的数字，不凭空造一行。移动按钮只按 `movable.ok` 渲染启用与否，当前服务端
  一律答 `migration_unavailable`，所以画面里它一直是禁用的，旁边写着服务端给的理由，按钮上没有提交路径，
  也没有目标选择器——那是 TRI-09 的工作，本项不提前做。长名字（模型名、端点、task id、年龄、成本）一律
  省略号截断并用 `title` 留全值，卡片宽度不因开列表而变，窄屏下容器不横向溢出：断言钉住开列表前后卡片
  同宽、`document.scrollWidth` 不超过视口、列出的容器都不裁切，只有末端标签自己截。中英文两侧断言同样
  的九条事实行、覆盖状态词、移动理由与三态落点。
  未做与遗留：一，本项不碰 TRI-08/09/10，不新建全局页面、全局状态、路由或服务端 schema，服务端
  `migration` 与 `movable` 原样消费，`GET /api/load-balancer/tasks` 的 `migration: "unavailable"` 与
  每个 `movable.ok: false` 一字未改；二，列表没有按 task 或按模型筛选的入口，只有按节点过滤；三，面板
  内容存在内存里（`Map`），只有开合状态进 `localStorage`，刷新页面后已开的面板会回到“正在读取”并在
  下一次状态读取后填上，行本身不跨刷新保留；四，状态轮询每两秒一次，面板在读取中被状态 tick 重绘的机会
  存在，Playwright 的动作会自动重试解绑元素，本项测试连跑两轮全过，但真机上更长的读取仍可能撞上。

#### TRI-06 返工（父代理独立复审的两项缺陷）

- 状态：已完成（在原提交 `c8a57d7` 上增量修正成 `458baac`，不 reset、不重做；主树为 `d844249`）。
- 缺陷一，分页混代。`readBindingPage` 的 append 只校了 `pairId`/`groupId`/`targetFilter`，没管响应
  信封里的 `runtimeEpoch` 与 `groupRevision`，所以把 offset 20 的尾页直接 `concat` 到已显示的 20 行上，
  一个面板里同时挂着 20 行旧运行时与 5 行新运行时，列表失去一致身份。现在面板持有自己那一代的版本
  （`version` 是接受的那一页的 `JSON.stringify([runtimeEpoch, groupRevision])`，`""` 表示还没收过任何
  一页，两个字段本身可以合法地为 `null`，所以不能用 `null` 当“未知”），append 一旦发现版本换了就整代
  丢掉并从 offset 0 重读新的一代：旧代的尾页不是新代的首屏，而重读只有一个来回，不是无限 loading。
  offset 0 的正常刷新仍是完整替换。追加进度改用服务端的 `nextOffset`，不再用 `items.length`：同一
  binding 的 `bindingId + incarnation` 已经在面板里出现过时那一行被丢弃，所以行数会比服务端的进度短，
  用行数问下一页就会反复问同一页。
- 缺陷二，取消被当成查询失败。面板创建的 `AbortController` 从来没被主动 `abort`，生命周期 `abort` 的是
  `requestWithCancellation` 合成的那个 signal，所以 `catch` 里的 `pending.signal.aborted` 为假，走到
  `applyBindingError`：父代理在浏览器里把列表打开后读取一直不答、再 `proxyConfig.dispose()`，面板就显出
  "Aborted by lifecycle"。现在面板存这条读取真正的 owner（`readOwner`）与启动它的 surface
  （`readLifecycle`）：关闭列表、`updatePolling` 判定不可见、`dispose` 和节点离开卡片时的
  `pruneBindingPanels` 都会 `abort` 它并把标志位当场清掉；回调作废的条件从“序号不同”扩为“序号不同，或
  启动它的那次 init 已经不是当前这一次”。取消不写 `errorKey`/`errorMessage`，面板留着已经显示的行，
  下一轮状态读取照常把它读回来。
- 新增回归 5 项（该文件声明数 27 → 32，原 27 项一项未删）：换代后只答新一代的 20 行并从 offset 0 重读、
  同一 runtime 下只有 `groupRevision` 换时同样不混代、表在翻页途中下移一位时同一 binding 只列一次且
  下一次问的是服务端的 `nextOffset` 而不是行数、翻满 200 行后说“已到单次读取上限”且所有读的 `limit`
  都不超 200、关列表与 dispose 各取消一条在途读取都不显错误且之后还能正常读。
- 父代理留下的两份只读探针（`.pi/tri06-review/` 下，未改未删）在返工后都失败，正是坏行为没了的证明：
  混代那条点“继续读取”后只答到 20 行而不是 20+5，取消那条在 dispose 后 `[data-lb-binding-error]` 根本没有
  元素。
- 基线范围变更（本返工内做的，理由写在基线文档的负载均衡小节里）：`loadLbBaseline` 之前停在节点状态
  details 折叠，十张图里没有任何一张覆盖这个列表。现在它展开左边那张组的节点状态段与第一个节点的路由
  绑定列表，先等到一次真实状态读取再量高、截图，并把列表用只给基线用的旋钮 `setLbBindingVisualRows` 缩到
  5 行代表行（多 task 共享一个 binding、候选且历史被截断、超长模型名、历史查询失败、没有日志根）：留下的
  行仍是 UI 用例读到的同一批 item，`totalBindings`、`hasMore`、`nextOffset` 与节点计数都按同一批行算，所以
  画面是真实服务能答出的较小一页；第二个节点与第二张组卡片保持折叠，折叠与展开、组配置与布局仍全覆盖。

#### TRI-06 上限修正（一次读取的行数上限与分页时钟）

- 状态：已完成（在 `458baac` 上增量修正成 `ce7a924`；主树为 `7ac7e50`，改 2 个跟踪文件：产品 1
  `load-balancing.js`、测试 1 `admin-ui-load-balancing.test.ts`）。
- 补正内容：一个面板任何时刻都不超过一次读取声明的 200 行。append 先问剩下的空间
  （`Math.min(lbBindingPageRows, lbBindingReadRowCap - panel.items.length)`），已经满 200 行时根本不再
  发起那一页；`storeBindingPage` 两条分支各 `slice(0, lbBindingReadRowCap)`，所以服务端答得比要得多也会被
  裁到上限而不是显示过去。分页进度仍是服务端给的 `nextOffset`：重复出现的 `bindingId + incarnation` 被丢弃
  只让列表比进度短，不会把进度倒回去。产品计时器、CSS、夹具、基线与服务端都没动。
- 新回归用例的时序（该项 1 项，该文件声明数 32 → 33）：`page.clock.install()` 之后先等页面载入时那条状态
  读取落屏，再用 `page.clock.pauseAt(page.evaluate(() => Date.now()))` 把时钟停在页面自己报的时间上；9 次
  点击各追加 19 行（20→39→…→191），第 10 次以 `{offset:200, limit:9}` 问剩下的 9 行并填满 200，此后是“已到
  上限”那句而不是“继续读取”按钮；最后 `runFor(2000)` 只放一次受控轮询，那次刷新读 `{offset:0, limit:200}`，
  列表仍是 200 行、互不重复、同一句上限声明。`finally` 里 `page.clock.resume()`：`closeTestPage` 用页面内的
  `setTimeout(resolve, 0)` 排空任务队列，冻住的时钟永远不会跑那条计时器，不恢复就会让 `afterEach` 超时 30 秒
  盖住真实结果。
- 此前这一项为什么不稳，已被写进 `ui-test-quirks`：`install()` 本身不冻时间，真实等待一旦超过 2 秒状态轮询
  就答一次，`refreshOpenBindingPanels` 以 offset 0 整窗重读，把去重后的 191 行换成服务端首窗，下一次 append
  于是按那扇窗自己的 191 去问，而不是按翻页留下的 200。这是轮询的合法刷新，不是产品 cursor 退回，所以修的是
  测试的时间控制，不是产品的计时器。
- 结果与限制：满 200 行以后面板显示的是服务端的首窗，轮询刷新会把屏幕上这一批换成当前首窗，所以“刷新保留
  用户翻到的那批行”在满上限时退化为“保留上限这么多数量的行”——条数、互不重复与上限声明三条仍逐项钉住，
  具体是哪一批行由服务端决定。

### TRI-07

- 状态：已完成
- 修改文件：新增 [load-migration.ts](../src/proxy/load-migration.ts)（意图记录、状态迁移、有界存储与
  幂等摘要），修改 [load-balancer.ts](../src/proxy/load-balancer.ts)（`moveBinding()`、
  `cancelMoveBinding()`、提交与应用两道门、请求边界的应用、`invalidateMigrationsFor()`、
  `sweepPendingMigrations()`）、[load-migration-contract.ts](../src/proxy/load-migration-contract.ts)
  （写入口地图）、[load-affinity.ts](../src/proxy/load-affinity.ts)（`bind()` 的改绑交回 `rebind()`）、
  [load-monitor.ts](../src/proxy/load-monitor.ts)（清扫跟随迁移记录）、
  [proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts)（failover 的失效顺序）与
  [proxy/index.ts](../src/proxy/index.ts)。测试：新增 `test-node/proxy/load-migration.test.ts`
  （47 项 `[TRI-07]`），在 `test-node/proxy/load-balancer-pipeline.test.ts` 新增 3 项 `[TRI-07]`
  实时流水线用例（该文件声明数 29 → 32）。
- 验证（评审后重跑）：从大写盘符单独跑两份 TRI-07 测试：`load-migration.test.ts` 1 文件 47 项全过，
  `load-balancer-pipeline.test.ts` 1 文件 32 项全过（含长 SSE 挂住、连接期 failover 与迟到 release
  三条实时用例）。整片 proxy：`npx vitest run test-node/proxy` 37 文件 571 项全过。`npm test`
  144 文件通过、1 文件跳过（1395 项通过、2 项跳过，共 1397 项）。`npm run typecheck`、`npm run lint`、
  `npm run check:modules`（138 模块、319 运行时边、107 类型边、0 环 0 越界）、`npm run build` 与
  `npm run format:check` 全部通过，`git diff --check` 无空白错误。按 AGENTS 的声明式口径复核：
  HEAD `5774a20` 为 1176 项声明与 144 个测试文件，工作树跟踪文件 1179 项（+3 全在
  `load-balancer-pipeline.test.ts`），未跟踪的新测试文件另有 44 项声明（评审后的修正把它推到 47 项），
  测试文件数 144 → 145，
  没有用例被删掉。本项范围不含便携版打包、Electron ABI 重建、UI 基线与真实上游实验；实时夹具
  都用 `listen(0)` 自选空闲端口、只写内存记录收集器，没有读写用户实例的配置或 traffic database。
- 唯一入口与 targetId 写入口审计：`moveBinding()` 是唯一能改绑的安全入口，`cancelMoveBinding()`
  只叫停尚未应用的意图。`git grep 'targetId =' src/proxy` 只剩一处赋值，在 `LoadAffinityTable.rebind()`
  内，而 `rebind()` 是唯一同时写目标与 `routingRevision` 的地方，所以一写就带上版本步。会移动目标
  的入口全部经它：`bind()` 的 `allowRebind` 路径（`plan()` 选路）、failover 经 `plan({ exclude })`
  回到 `bind()`、以及 `moveBinding()` 内部的 `#attemptMove`。TRI-05 之后的管理 API 与 TRI-10 的
  自动策略只能调这两个方法，不能自己赋值。
- 合同：提交与应用两个时点各查一遍 runtimeEpoch、group revision、routing revision、incarnation、
  源 target、目标是否为本组成员、是否是本 pair 的 target 且 enabled、cooldown、被新鲜指标明确报告
  为 asleep、与源是否同一 canonical physical key、以及 v1 要求的成员 `model_id` 相同。指标过期不
  阻止手动提交（只有“现在明确 asleep”才拒），应用前再确认一次。`inFlight === 0` 立即应用，否则进
  `pending_boundary`；应用顺序固定为重读 binding 与版本、复核目标与协议条件、经 `rebind()` 同步写
  目标并递增 revision，服务自己不建任何 reservation——下一次请求的 `plan()` 是唯一建 reservation
  的地方，在途请求的目标与 reservation 一字不改，`applied` 也不花掉一个名额。状态语义与第 5.2 节
  一致：`applied` 只说内存路由已改，`observed` 只在后续某条请求真的为该目标建了 reservation 时才给，
  二者都不说上游业务成功；`already_there` 不写也不记，`replayed` 永不重写。
- 状态生命周期：`requested` 只能去 `rejected`、`pending_boundary` 或 `applied`；`pending_boundary`
  可去 `applied`、`cancelled` 或 `expired`；`applied` 可去 `observed` 或 `expired_after_apply`；
  `rejected`、`observed`、`cancelled`、`expired`、`expired_after_apply` 是终态，没有出边，也不会
  被迟到事件复活（过期意图被到界的 release 重新拿起、或把已 applied 的记录改写成 cancelled 都
  测过不会发生）。覆盖到的失效路径：reload 改 group revision、reload 删掉目标或整组、目标转
  disabled、等待期间目标进入 cooldown、failover、pair 停止（`clear()` 连记录一起丢，下一个运行时
  的旧幂等键找不到任何记录）、TTL 清扫淘汰 binding、表主动 prune、以及被别的写路径改过 route。
  迟到 release 只能交回它创建时记录的 target：不能把已淘汰的 binding 放回表里，也不能借新表
  复用的数字号码写一次迁移。
- 竞态修正：本项在 reservation 的 `release()` 里挂上“边界应用待迁移”之后，failover 原顺序（先
  `release()` 再失效）会让交回先把用户 pending 的迁移写进路由，然后才被 failover 覆盖。现在
  先 `invalidateMigrationsFor(ref, "failover")` 再 `loadBalance.reservation.release()`：可用性动作
  优先于 pending 人工或自动动作，pending 一律 `expired`、已应用的记为 `expired_after_apply`，随后的
  交回发现无事可写。实时用例分别证明三件事：pending 迁移不会在 failover 中先落地（记录只有
  `expired` 一态且 `appliedRoutingRevision` 为空，路由经表唯一写走 `round_robin` 换目标并 +1 revision）；
  旧请求完整结束（客户端拿到一份完整应答，`request_finished` 只有一条）；迟到 release 不复活
  binding（表里仍 0 条、binding 目标不变、意图 `expired`）。并发旧 revision 只有一个成功：同一
  tick 两次提交，第二次报 `stale_routing_revision`，表内只有一个 binding、一个目标、一步版本。
- 幂等摘要：`migrationRequestDigest` 现在覆盖 runtimeEpoch、group、**groupRevision**、bindingId、
  incarnation、expectedRoutingRevision、源 target、目标与发起人。同 runtime、同幂等键、同其它字段
  但 group revision 不同现在报 `idempotency_conflict`，不会 replay。测试逐字段各改一处（group
  revision、routing revision、源 target、目标、发起人、binding 号码、incarnation）全部冲突且既不
  写也不新增记录；只改 `reason` 仍然 replay，因为 reason 是被截到 200 字的审计标签，不是操作参数。
- 服务端状态门（保守口径）：`response:` exact key 不带来源——请求的 `previous_response_id` 与响应体里
  引擎产生的 id 被写成同一个 `response:<id>` 放进 `binding.exactKeys`，运行时区分不了，因此任何接受
  都不许建立在“这条 key 应该是无害那一种”的猜测上。门先问 key、再问 endpoint kind、最后问 body 里的
  user 内容：只要 `binding.exactKeys` 里有一个 `response:` key，不论哪个 kind 都报
  `response_state_dependency`，响应体学到的 id 与被请求点名的 id 同样拒绝；self-contained 的 `chat`、
  `messages`、`completions` 只有在不带 `response:` key 且 binding 自己的证据证明 user 内容是随创建它
  的请求体一起来的时候才移动（没有 user 消息报 `state_unknown`），`responses` 没有响应链时报
  `state_unknown`，`other` 同样报 `state_unknown`，`conversation`/`thread`/session 字段一律不作为可迁移
  的证明。设计第 5.1 节“检测到该依赖且没有明确的共享 response 状态声明时拒绝迁移”由此在两种来源上都
  成立；要松动只能靠 TRI-11 的真实上游共享证明，不许靠假设。
- 评审后的修正（父代理评审 5042efc 后在本 worktree 补做，不改 TRI-05/06/08/10，不加 schema，不动
  数据库，不碰用户实例）：上一版对 `chat`/`messages`/`completions` 只查 `evidence.userHashes.length > 0`，
  于是带 `previous_response_id` 又同时带 `messages`/`prompt` 的请求会被放行——exact key 说的是这条任务
  通过一个 response 对象寻址，body 只证明上下文随请求来了，不证明那个对象也能跟着搬。现在
  `#stateRejection()` 的顺序固定为 key → kind → user 内容，提交与应用两个时点跑同一道门。新增回归：
  三份 self-contained body 各带 user 内容与 `previous_response_id` 全部报 `response_state_dependency`，
  响应体学到的 `chatcmpl-1` 与被请求点名的 id 报同一码且留在原节点，`responses`（学到 id、下一轮点名）
  与 `other` 以及没有 user 内容又没有 response key 的 body 照旧拒绝，没有 response key 又有 user 内容的
  三种 kind 才 applied、有在途请求时 pending 并在到界后 applied；边界之前才被响应体学到 id 的在途
  意图会在那里记为 `expired` 而不是写进路由。每条拒绝都断言目标、`routingRevision`、记录的
  `appliedRoutingRevision` 与 `observedAt` 一步未写。声明式复核：`5042efc` 为 1223 项声明、145 个测试
  文件，工作树 1226 项，增量 3 项全在 `load-migration.test.ts`（44 → 47），没有用例被删掉；本条修正
  单独成一个 commit，只含 `src/proxy/load-balancer.ts` 与该测试文件。
- 审计与有界：记录与审计行只有 id、版本、目标、时间戳和幂等摘要；正文、exact key、用户消息与
  token 一字不入（用例直接拿 secret 试）。存储按 pair 运行时作用域，上限 4096 条、保留 15 分钟
  （从记录停止变动起算），满了先淘汰已终态的最旧记录，全是活意图时拒绝新工作而不是丢弃在途意图；
  存储装不下新记录时，已经查出的拒绝理由照原样返回，只有本来会被通过的迁移才报
  `migration_backlog_full`。`load-monitor` 的周期清扫负责失效漂移意图与回收不再值得保留的记录。
- 后续边界（TRI-08 与 TRI-10）：本项只做服务本体，没有动管理 API、UI、自动策略、数据库 schema 或
  真实实验。TRI-08 要把本项的拒绝码映射成设计第 6.2 节的 HTTP 合同：`stale_group_revision`、
  `stale_routing_revision` 与 `source_target_mismatch` 归 409 `binding_stale`，`target_*`、
  `same_physical_key` 与 `model_mismatch` 归 409 `target_not_eligible`，`response_state_dependency`
  与 `state_unknown` 归 422 `state_not_migratable`；`migration_backlog_full` 已经设成 503（运行时
  装不下新意图，稍后重试，不是参数错误），`operation_expired` 归 409，取消已 `applied` 的操作归
  409 `operation_already_applied`，设计第 6.2 节已把这三条定下。`already_there` 与 `replayed` 的
  200/202 边界、`observed` 进入路由
  记录的字段、以及“取消已 applied 只能反向迁移”的界面说法都在 TRI-08/TRI-09 落地。TRI-10 的自动
  策略只能调同一个 `moveBinding()`（`requestedBy: "auto"` 的入口与审计已就位，自动意图不设人工
  保护），不得自己改 `targetId`。
- 提交：初版 `5042efc`（完整哈希 5042efc229eedbf51fe7c9390da09a88bfa571e0）含 9 个文件，评审后的
  状态门修正单独成 `222ea40`（完整哈希 222ea403ad75067653b385f1e5aeb561f885247a），只含
  `src/proxy/load-balancer.ts` 与 `test-node/proxy/load-migration.test.ts`。两份都用显式
  `git add --` 挑选路径，没有 `git add -A` 或 `git add .`，两份任务文档与研究材料未进提交。
- 整合：cherry-pick 到主 checkout 后分别是 `1c996d3`（完整哈希
  1c996d3ac5a5b015eeb53dcd50fb65728f046525）与 `542bf6e`（完整哈希
  542bf6ecac5ad67f51e0cead3f52bfc2401d762e）；两者文件集与源提交逐项相同、
  自动合并无冲突，TRI-07 独占的六份文件与源提交逐字节相同。

### TRI-08

- 状态：已完成，父代理独立复审已通过。两轮返工（第一轮五条缺陷、第二轮三条回执边界加一条
  答复隔离）已经三个源提交按顺序整合进主 checkout；整合之前父代理亲自重跑 8 条独立
  正确断言与正式定向 5 文件 145 项，全部通过。前轮错误验收已由父代理撤回，撤回记录与
  第一轮的实现、验证记录保留在下面，只作历史，不再代表当前验收结论。
- 撤回记录：父代理曾在本清单把本项记成“已完成”，独立复审把那次验收撤回，改写成“已实现并合入；
  独立复审未通过，返工中”，并写下前轮验收与验证记录保留在下面但不再代表当前验收结论；两条
  返工通过复审并整合之后，本项才重新记成已完成。撤回与返工之间的主树计数、定向实跑与整合记录
  逐项保留，并标所属版本。
- 复审发现：拒绝结果同键重试变为 200；`already_there` 未保留幂等键，改目标可再次执行；重试结果混入后一次迁移的 revision 与实时计数；已失效意图重试变为 200；目标连接失败并 failover 回原节点时操作却已终结为 `observed`。现有 4 文件 / 73 项通过，新增 5 条独立诊断复现确认上述行为；需要补入真正的回归测试后再次验收。另有前轮派发与设计 §6.2 的冲突：`model_mismatch` 应按设计返回 422 `state_not_migratable`。
- 复审发现（第二轮，父代理独立复审查出的三条回执边界加一条答复隔离）：满容量下的
  `already_there` 答 200 而键没被记住，腾出空间后同键改目的地会再答 `applied`；独立回执的
  保留窗口被算成两倍；管理层的 group 预检越过第一份回执；存与取都交回调用方手里那个
  答复对象，运行时写会改写以后的重放。四条都由下面第二轮返工关掉。
- 第一轮返工（五条全部关掉；源提交 `7c8cd7a`，完整哈希
  7c8cd7af4806b5d2b3e09e4f1eb204daf1045053，整合后是主树 `439c43d`，完整哈希
  439c43dcad33123d8fc7917baeb2af97ff32ad6e）：
  1. 拒绝不再变 200。存储把第一次答复本身按幂等键记下来（`MigrationSubmissionAnswer`，
     `kind: "refused"` 带拒绝码与句子），`describeMove` 只看这份答复，所以同键同参重试拿回
     同一 `code` 与同一 `detail`，路由也就映射出同一个状态码；首次拒绝与重放拒绝走同一条
     答复链。真实路由回归：`keeps a refused submission's refusal when the same key and parameters
     are retried`（真 Fastify、真 `LoadBalancer`）。
  2. `already_there` 绑定键与摘要。没有写记录就没有可携带答复的记录，所以回执单独成立
     （`StoredReceipt`，`operation` 为空，答复里 `operationId: null`），与记录同容量、同保留
     窗口、同 runtime 作用域；换目的地复用同一键一律 409，路由不动。单元与真实路由两条回归：
     `a no-op answer is bound to its key…` 与 `binds a no-op answer to its key…`。
  3. `POST` 是提交回执，不是状态查询。答复一律从答复本身取值：`liveBindingOf` 整个删掉，
     不再读实时 binding 的计数与版本，也不再把缺失读成 0；`park()` 把 `inFlightAtSubmit` 记在
     记录上，取消用它自己的字段。之后的 `applied`、`observed`、`cancelled`、`expired` 都不改写
     回执，后一次迁移的 revision 也不会盖到前一条上。主管此前“重试返回当前状态、
     `effect` 为 `none`”的结论作废，按设计 §5.3/§6.2 改为回执口径，两份任务文档已随本整合
     一并改为回执口径，不把“回放当前状态、`effect: none`”留作最终行为。新增真实路由回归：
     `answers a parked submission with its own 202 after a lifecycle event called it off`、
     `repeats the count a submit proved instead of a count read off a binding that is gone`、
     `answers the first receipt with its own revision…`、`answers a parked submit's retry with its
     own 202 after the boundary applied the intent`（涵盖后来 `applied` 与 `observed`）与
     `… after the intent was called off`（后来 `cancelled`），以及既有 replay 用例改为逐字段
     等于第一次答复。
  4. `observed` 需要真实落点证据。reservation 不再带 `migrationRoute` 字段，改成一个
     `confirmRouted()`：计划与预约都不改变状态，只有请求路径拿到上游响应行后才证实；4xx 与
     5xx 同样算落点，连接没起来的尝试根本走不到那一行。failover 先把 `applied` 变成
     `expired_after_apply`，终态记录不能被后来的请求复活；`move_*` 键由这次证实写入，因此
     failover 的最终记录一个 `move_*` 键都没有。TRI-07 的 proxy 源码同改（同一缺陷是从
     TRI-07 带进来的），长 SSE 与“迟到 release 不复活”的既有用例原样保留。新增真实上游
     回归四条：连接失败回原节点、目标答 503 仍算落点、pipeline 没有那个 target、派发前被
     流量记录拒绝；单元侧新增“计划不证实”与“failover 后不能复活”两条。
  5. `model_mismatch` 改回设计 §6.2 的 422 `state_not_migratable`（设计权威为准，前轮派发给
     的 409 是派发侧与设计的冲突）；目标资格用例现在把六条资格冲突与这条安全拒绝分开。
- 第一轮返工改动的文件：产品源码 8 个（`load-migration.ts`、`load-balancer.ts`、
  `load-balancer-admin.ts`、`proxy-request-pipeline.ts`、`load-migration-contract.ts`、
  `src/admin/routes/load-balancer.ts`、`src/admin/admin-schemas.ts`、`src/proxy/index.ts`），测试
  3 个（`load-migration.test.ts`、`task-moves.test.ts`、`load-balancer-pipeline.test.ts`），共 11
  个文件，源提交 `7c8cd7a`（1387 增、221 删）。另有一个独立文档提交 `eb2a3ab`（整合后是主树
  `cdff341`，完整哈希 cdff341aaab7058900b04c6a7f2a9324f10c3ab0）只改 `admin-api-probing` 的
  计数与方法清单。
- 第一轮返工验证（源工作树；下面的 1451 是那一版的计数）：`npm run check` 全链 `exit 0`（format:check、lint `--max-warnings=0`、两个 tsconfig typecheck、`check:modules` 138 模块 323 条运行时边 114 条类型边 0 环 0 越界、test、build），`npm run check:skills` 7 项全过，`git diff --check` 无空白错误，`npm run abi:node` 用真实查询证明装的是 Node ABI（`NODE_MODULE_VERSION 137`）。定向实跑：`load-migration` 52 项、`task-moves` 27 项、`load-balancer-pipeline` 36 项（共 115 项）全过；admin 与 assembly 六个文件（`api-contract`、`response-schema-openness`、`service-assembly`、`load-balancer-tasks`、`load-balancer`、`admin-contract-types`）6 文件 60 项全过；全量 Vitest 147 文件（146 通过、1 跳过）、1451 通过、2 跳过（属源提交 `7c8cd7a` 与 `eb2a3ab` 时的源工作树版本）。按 AGENTS 的声明式口径复核 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" 6c769bd -- test-node` 为 1265 项 / 146 个文件，源工作树 1282 项 / 146 个文件，增量 17 项正好等于三个文件各自的 +5、+8、+4，没有用例被删掉；被改写的旧用例是修正断言，不是删除。
- 第二轮返工（三条回执边界与一条答复隔离，全部关掉；源提交 `48d1f85`，完整哈希
  48d1f85e4738348a61e63392d90a40c3f52adeed，整合后是主树 `2210fb8`，完整哈希
  2210fb83ac80f179d1f7ed32598b85a59d34ac4a）：上一轮五条修正已由独立旧复现 5/5 与正式定向
  115/115 确认有效，但回执还有三处已独立复现的边界缺陷。复现是源工作树
  `.pi/independent-recheck/review.test.ts` 末尾 `receipt edge probes` 那三条（断言写的是坏
  行为，该文件未被改动），下面逐项关掉。
  1. 存储满时的 `already_there` 不再是没有回执保护的成功。记录索引与回执索引同受
     `MAX_MIGRATION_RECORDS` 约束，但是两个索引；`#storeReceipt` 过去在找不到可淘汰的回执时
     静默 `return`，于是满容量的 no-op 答 200 而键没被记住，腾出空间后同键改目的地会再答
     200 `applied`，幂等就破了。现在 `moveBinding()` 在给出成功答复之前先问
     `MigrationOperationStore.canRecordAnswer()`：存不下就以 503 `migration_backlog_full`
     拒绝，且不写任何东西；腾空间仍然只淘汰已完成的答案，绝不提前丢仍活着的操作的回执。
     真实路由用例 `refuses a no-op the runtime cannot remember with 503 instead of a receipt
     it cannot keep` 与两条单元用例（满时拒绝且无写、满时先淘汰已完成的答案）钉住这条，
     记录上限全程保持。容量正常时同键改目的地仍是 409 `idempotency_conflict`。
  2. 管理层的 group 预检不再越过第一份回执。`moveBinding()` 先定位 pair、runtime 与
     `runtimeEpoch`（停机与换 epoch 各自仍是 404），然后问
     `LoadBalancer.lookUpIdempotencyKey()`——摘要仍只由 balancer 自己算，admin 层不另立回执
     权威也不复制摘要逻辑——只有本运行时答过 `nothing` 的指令才走 group 预检。于是 group
     已从配置删除、epoch 未变且回执仍在时，原 pending POST 重试仍拿回第一次的 202；同键只
     改成不存在的 groupId 是 409 而不是绕过摘要直接 404；新键第一次问未知 group 仍是
     “Load balancer group not found.” 那条 404。
  3. 独立回执的保留窗口不再被算两次。`recordNoOpAnswer` 过去写 `expiresAt = answeredAt +
     retentionMs`，`dropExpiredRecords` 又拿它与 `now - retentionMs` 比，实际保留的是
     `2 * retentionMs`。现在两个索引用同一个 cutoff，各自只用自己的起算点：记录从 `endedAt`
     起保留一个窗口，独立回执从 `answeredAt` 起保留一个窗口，附在记录上的回执随记录同生
     同死，仍活着的操作的回执永不被时间清掉。单元侧三条用例分别钉住到期前、到期那一刻、
     到期之后，以及 live 回执不会被错删与两个索引同时释放。
  4. 回执对象的隔离：`recordAnswer` 过去存的是调用方手里的 answer 原对象，`findReplay` 又把
     同一个对象交出去，而 `readonly` 只挡 TS 写法不挡运行时写。现在存与取都过
     `toAnswerCopy()`，与 `migrationOperations()` 深复制快照的既有约定同一口径；一条单元用例
     证明改写答复对象或改写拒绝句子都不影响以后的重放。
- 第二轮返工改动的文件：产品源码 3 个（`load-migration.ts`、`load-balancer.ts`、
  `load-balancer-admin.ts`），测试 2 个（`load-migration.test.ts` +6 项、
  `task-moves.test.ts` +2 项），共 5 个文件。上一轮已经通过的修正一字未改，特别是确认上游
  响应行才算 `observed`、失败目的节点 `expired_after_apply`、`model_mismatch` 422。
- 第二轮返工验证（源工作树；下面的 1459 既是那一版的计数，也是本整合后主树的计数）：定向先跑 `load-migration` 58 项、`task-moves` 29 项、`load-balancer-pipeline` 36 项、`api-contract` 12 项、`service-assembly` 10 项（5 文件 145 项）全过；再跑 proxy、admin、app 三个区域 63 文件 785 项全过；`npm run check` 全链 `exit 0`（format:check、lint `--max-warnings=0`、两个 tsconfig typecheck、`check:modules` 138 模块 323 条运行时边 114 条类型边 0 环 0 越界、test、build），`npm run check:skills` 7 项全过，`git diff --check` 无空白错误。按 AGENTS 的声明式口径复核 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" eb2a3ab -- test-node` 为 1282 项 / 146 个文件，源工作树 1290 项 / 146 个文件，增量 8 项正好等于两个文件各自的 +6 与 +2，没有用例被删掉。全量 Vitest 147 文件（146 通过、1 跳过）、1459 通过、2 跳过。
- 第二轮那条待主管定夺的口径已经定夺，不需要新的授权或新的状态：三条诊断在源工作树原样重跑（诊断文件未被改动，mtime 仍是上一轮的时间），修复后各自翻到正确方向——`EDGE capacity` 的 no-op 现在是 503 `migration_backlog_full`，`EDGE retention` 在 1101（即 `answeredAt` 加一个保留窗口）就已经是 `nothing`，`EDGE removed group` 的重试回到 202 且与第一次逐字段相同。那条 `EDGE capacity` 诊断的第二句仍然答 200：503 这个拒绝本身存不下、也就没被记住，空间腾出后同键改目的地会按新状态重新评估。父代理定夺维持这个口径，设计第 5.3 节已写明幂等保证的作用域是当前 runtime 内、回执仍在容量与保留窗口里的那些键：503 背压没有接受这次提交也就什么都没写，因此它不被记住，空间恢复后按新状态重新评估沿用既有合同。这与“存储装不下的拒绝后来按新状态重新评估”一致，也没有把任何一次成功改成没有保护的成功。
- 两轮返工的范围：只动上面这些产品源码与测试。UI、CSS、视觉基线、`GET /api/load-balancer/tasks` 的 `migration` 与 `movable` 字段、config schema、DB schema 与持久化表一字未动；没有做便携版打包、Electron ABI 重建或真实上游实验；没有读写用户正在跑的 portable 实例、它的配置或 traffic database。
- 父代理整合前的独立复验：8 条独立正确断言全过（源工作树 `.pi/independent-recheck/accepted.test.ts` 7 条加 `landing.test.ts` 1 条落点探针，2 文件 8 项全过），正式定向 5 文件 145 项全过（`load-migration` 58、`task-moves` 29、`load-balancer-pipeline` 36、`api-contract` 12、`service-assembly` 10）。
- 两轮返工的整合：三个源提交按顺序显式 `git cherry-pick -x` 合入主 checkout，保留原 author 与 subject。源 `7c8cd7a` → 主 `439c43d`，源 `eb2a3ab` → 主 `cdff341`，源 `48d1f85` → 主 `2210fb8`。前后两个产品提交自动合并、零冲突；只有 `eb2a3ab` 的两份技能文档冲突——主树已在 `9ca1c38` 把计数写成 29 / 34 并补上半装配与响应闭集两段说明，源工作树的原基点还写着 28 / 33。解法是保留主树那两段独有说明，把计数收敛到 31 / 36（`test-node/admin/api-contract.test.ts` 钉住 36 条注册，五条没有响应 schema 的仍是两条流加三个静态），四个 HTTP 动词照源文合入（TRI-08 的取消是第一条 `DELETE`），并把服务方法清单补成 `getStatus`、`getBindings`、`moveBinding` 与 `cancelMoveBinding`——`src/admin/admin-contracts.ts` 的 `LoadBalancerAdminService` 与 `assertAdminServicesComplete` 的方法表现在都是这四条，文字不能再停在两条上。整合后逐项比对：11 个产品源码与测试文件的 blob 哈希与源工作树 `48d1f85` 完全相同；主树与源工作树的 tracked 差异只剩这两份技能文档里主树独有的两段说明。`git diff 50b621b..HEAD` 不含 UI、CSS、视觉基线、config schema、DB schema 或持久化表路径，`git diff --check` 无空白错误。
- 本整合的主树门禁（从大写盘符在主树跑）：全量 `npm test` 147 文件（146 通过、1 跳过）、1459 通过、2 跳过，与源工作树报告的 147 文件 / 1459 通过 / 2 跳过一致——主树没有 TRI-06 的 UI 测试，所以文件数相同而不是更多。按声明式口径复核 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" HEAD -- test-node` 为 1290 项 / 146 个跟踪测试文件，整合前 `50b621b` 为 1265 项 / 146 个文件，增量 25 项正等于第一轮返工的 +17 与第二轮的 +8，没有用例被删掉。
- 修改文件：新增 [load-balancer-admin.ts](../src/proxy/load-balancer-admin.ts) 的
  `moveBinding()` / `cancelMoveBinding()` 与其查询、答复类型，
  [load-migration.ts](../src/proxy/load-migration.ts) 的 `MigrationRouteMeta` 与
  `migrationRouteMeta()`，[load-balancer.ts](../src/proxy/load-balancer.ts) 让 reservation 带上
  本次证明的那条迁移，[proxy-request-pipeline.ts](../src/proxy/proxy-request-pipeline.ts) 把迁移
  路由写进 `request.model_route.load_balance`（failover 的记录块仍只由 failover 决定重建，不带
  `move_*` 键），并修改 [admin-contracts.ts](../src/admin/admin-contracts.ts)、
  [admin-schemas.ts](../src/admin/admin-schemas.ts)、[admin index](../src/admin/index.ts)、
  [load-balancer.ts 路由](../src/admin/routes/load-balancer.ts)、
  [admin-services.ts](../src/app/admin-services.ts) 与 [proxy index](../src/proxy/index.ts)，共 11
  处产品源码。测试：新增 `test-node/admin/task-moves.test.ts`（19 项 `[TRI-08]`），修改
  `test-node/admin/api-contract.test.ts`（+2 项 `[TRI-08]`）、
  `test-node/app/service-assembly.test.ts`（+1 项 `[TRI-08]`）、
  `test-node/admin/response-schema-openness.test.ts`（在既有用例内加闭集断言）、
  `test-node/proxy/load-balancer-pipeline.test.ts`（在既有 TRI-07 实时用例内加路由记录断言并扩
  `LOAD_BALANCE_RECORD_KEYS`）、`test-node/admin/admin-service-fixtures.ts`、
  `test-node/admin/load-balancer-tasks.test.ts` 与 `test-node/ui/admin-ui-server.ts`（两处纯增量
  stub，返回真实服务的具名拒绝）；合计 19 个文件。
- 验证（第一轮，源提交 `6c769bd` 合入为主树 `5069a99` 之后的主树）：`npm run typecheck`（`tsconfig.json` 与 `tsconfig.ui.json` 均 `exit 0`，两处
  `@ts-expect-error` 反例仍是指望的错误）、`npm run lint`（`--max-warnings=0`）、
  `npx prettier --check .` 全绿、`npm run check:modules` 报 138 模块、323 条运行时边、114 条类型边、
  0 环 0 越界、`npm run check` 全链 `exit 0`、`git diff --check` 无空白错误。定向实跑：
  `test-node/admin/task-moves.test.ts` 1 文件 19 项全过；admin 与 assembly 五文件
  （`task-moves`、`api-contract`、`response-schema-openness`、`service-assembly`、
  `load-balancer-tasks`）5 文件 63 项全过；proxy 与 logging 七文件
  （`load-migration`、`load-balancer-integration`、`load-balancer-pipeline`、
  `load-balancer-log-records`、`binding-activity`、`runtime`、`operation-sequence`）7 文件 123 项
  全过；`npm test` 全量 147 文件（146 通过、1 跳过）、1434 通过、2 跳过（该计数属第一轮合入
  `5069a99` 后的主树版本）。
  按 AGENTS 的声明式口径复核 `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" 8b825c8 -- test-node`
  为 1243 与 146 个测试文件，本工作树跟踪文件 1245 项（+2 全在 `api-contract`），加
  `service-assembly` 的 +1 与未跟踪新文件的 19 项声明，测试文件数 146 → 147，增量 22 项正等于
  2 + 1 + 19，没有用例被删掉。
  本项范围不含便携版打包、Electron ABI 重建、UI 基线与真实上游实验；所有夹具都在临时目录或用
  `listen(0)` 自选端口，只写内存记录收集器，没有读写用户实例的配置或 traffic database，也没有停
  或改用户正在跑的 portable 实例。
- 状态与错误映射（当前行为）：路由用答复自己带的 `state` 定状态码——`pending_boundary` 显式回 202，`applied`
  与 `already_there` 回 200，重放交回第一次的提交回执、逐字段等于第一次且永不改写；第一轮写成过
  “重放回第一次那条记录现在的状态”，父代理独立复审把它判为缺陷，已由上面返工第 3 条替换，那一句
  只作历史。服务拒绝码到 HTTP 的映射固定为设计第 6.2 节：三类版本/源不一致归 409 `binding_stale`，
  `target_not_in_group`、`target_unknown`、`target_disabled`、`target_cooldown`、`target_asleep` 与
  `same_physical_key` 六条各带自己的句子但共用 409 `target_not_eligible`，`model_mismatch` 与两道状态门
  共用 422 `state_not_migratable`（第一轮把 `model_mismatch` 映射成 409 `target_not_eligible`，那是
  派发与设计第 6.2 节的冲突，已由上面返工第 5 条按设计改回 422），`migration_backlog_full` 归 503，`idempotency_conflict` 归 409；pair、
  group、runtime 未启动与 runtime epoch 不一致四类前置检查统一映射成 404 `binding_not_found` 且
  句子各不相同（真实路由测试逐个比对句子互不相同），取消侧 `operation_not_found` 归 404、
  `operation_already_applied`/`operation_expired`/`operation_not_cancellable` 归 409，被 reload、
  failover、删组、目标 cooldown 到界与 pair 停止叫停的意图都用它自己的句子回答，绝不把已经没了的
  记录谎报成 `cancelled`。参数校验仍由 Fastify 以 `FST_ERR_VALIDATION` 回答 400，本项不冒充业务
  错误码。
- 响应闭集：`taskMoveResponseDto` 恰好十个键（含设计第 6.2 节字段加 `runtimeEpoch` 与
  `groupRevision`），错误答复仍是 `{code, message}` 两键；用例用 secret 直接试正文、会话 ID、
  prompt cache key 与上游 key，都不出现，序列化器会丢掉服务偷偷多给的键（openness 用例把 smuggle
  的键试出来被丢掉）。请求体在本项经主管批准的偏离里把 `groupRevision` 与 `incarnation` 定成必填
  （列表已经提供这两个字段，客户端必须原样带回才能证明它看的是那条路由），设计文档的相应行由主管
  另行更新，本项不改设计权威。
- 迁移路由元数据：`observed` 由那条请求真的连上目标、拿到上游响应行之后由 `confirmRouted()`
  写入路由记录（计划与预约都不写状态，4xx 与 5xx 同样算落点），字段为
  `move_operation_id`、`moved_by`、`moved_from`、`moved_to`、`move_routing_revision` 与可选
  `move_reason`；没有匹配的意图时一个键都不写。`load-balancer-pipeline` 的 TRI-07 实时用例现在直接
  检查那条流量记录带齐这六个键且不含用户正文，failover 的记录被证明不带任何 `move_*` 键。自动策略
  的 `suggestion_id` 属于 TRI-10，本项只留手动字段。
- 结果与限制：两个页面同持旧 revision 只有一个写成功、另一个 409；同键同参重试只写一次；同键改
  任意一个参数（包括只改 `groupRevision`）一律 409；重启后旧 epoch 的请求 404、旧 operation id 的
  取消 404、同键在新运行时按新状态重新评估而不是套用旧记录；存储满时 503 且已查出的拒绝理由不被
  覆盖；`reason` 不进幂等摘要（换个说法仍是同一次移动），长度上限取审计标签的
  `MAX_MIGRATION_REASON_CHARS`，超出由 schema 拒。本项没有动 `GET /api/load-balancer/tasks` 的形状
  与 `migration`/`movable` 字段，没有动 UI、CSS、视觉基线、config schema、DB schema 版本与持久化
  表；`test-node/ui/admin-ui-server.ts` 只加两个 stub 方法，UI 断言一字未改。第二轮返工后本项还
  钉住：回执索引与记录索引同容量但是两个独立索引，存不下就以 503 拒绝且不写任何东西；一个保留
  时钟两个起算点，记录从 `endedAt`、独立回执从 `answeredAt`，仍活着的操作的回执不被时间清掉；
  group 预检排在回执查询之后且只对从未答过的键生效；答复的存与取都过副本。
- 提交：`6c769bd`（完整哈希 6c769bda4b4ec028d82d603c69f731b1f45ff835），19 个文件、
  2237 增 13 删。用显式 `git add` 逐个挑选产品源码与测试路径，没有 `git add -A` 或 `git add .`；
  在本工作树里两份任务文档仍是未跟踪的副本，没进提交（主 checkout 已在 `9ca1c38` 把它们纳入
  版本控制）。
- 整合（第一轮）：cherry-pick 到主 checkout 后是 `5069a99`（完整哈希
  5069a990870c5af84596fae805d368cccb69bf68），无冲突、文件集与源提交逐项相同。主 checkout 随后的
  全量 `npm run check` 为 `exit 0`：Vitest 147 文件（146 通过、1 跳过）与 1434 通过、2 跳过，
  `check:modules` 0 环 0 越界，Prettier 全绿。设计权威也在 `2b947fe` 补上了 `groupRevision` 与
  `incarnation` 两个必填字段、响应新增的 `runtimeEpoch` 与 `groupRevision`，以及 `reason` 的上限
  与拒绝口径，本节与设计不再互相矛盾。
- 文档收口：设计权威随本整合补上两轮返工与设计初稿的分歧——第 5.2 节的 `observed` 需要真实落点
  （计划与预约不算证实，4xx 与 5xx 同样算，连不上的目的节点由 failover 先叫停成
  `expired_after_apply` 且不能被后来的请求复活）、第 5.3 节的首次不可变提交回执与容量、保留时钟、
  副本口径以及幂等保证的作用域（当前 runtime 内、回执仍在容量与保留窗口里的那些键）、第 6.2 节的
  提交回执段落与 group 预检排在回执查询之后的顺序。收口单独成提交，不与产品源码或测试混在同一
  提交里；本清单前轮写成“重放回第一次那条记录现在的状态”的口径已作废，设计第 5.3 节原先只写
  “重试返回第一次结果”，现在写明交回第一次的提交回执：最终行为是回执，不是当前状态查询，
  `effect` 也不再被重写成 `none`。第 6.2 节那句“把一次 422 变成报成 `rejected` 状态的 200”的语病
  也已改掉。

### TRI-09

- 状态：已实现，待父代理独立复审（本清单仍记 8 / 12，不自接为 9 / 12）。本 lane 交四个提交：
  `d24af5b`（d24af5be3f881c33b546ed67e12daadf1d3d7417）交产品与测试，`04b4d2d`交基线截图与它的哈希行，
  `337853d`交设计、本清单与两份 README，`d61309f`只交上面那个端口修正；四个都只在
  `D:/code/local_ai_proxy-wt-tri09`，没有 push、没有 version/tag、没有进主 checkout，也没有跑便携版
  打包——本 lane 禁 Electron ABI 切换，尾交付留给整合阶段。
- 修改文件：`src/proxy/load-balancer.ts`（新增 `moveGatesFor()`，复用 `#stateRejection()` 与
  `#eligibilityRejection()`，不另建第二权威，读它不写任何东西）、`src/proxy/load-balancer-admin.ts`
  （`migration` 按有没有可寻址的运行时回答，`movable.destinations` 带服务端拒绝码与
  `metricsUnknown`，`migrationOperations` 是去掉 `requestDigest` 与 `idempotencyKey` 的净化投影且不随
  `targetId` 过滤消失）、`src/admin/admin-schemas.ts`（zod 闭集）、`src/admin/ui-contracts.d.ts`、
  `src/proxy/index.ts`（导出）、`src/admin/static/modules/load-balancing.js`（目标选择器、未知确认、
  一份冻结 payload 配一个 key、409 保留选择且不自动重发、操作块、空页仍出操作）、
  `src/admin/static/modules/core.js`（中英词典）、`test-node/admin/load-balancer-tasks.test.ts`、
  `test-node/admin/api-contract.test.ts`、`test-node/admin/response-schema-openness.test.ts`、
  `test-node/admin/admin-service-fixtures.ts`、`test-node/ui/admin-ui-fixture.ts`、
  `test-node/ui/admin-ui-server.ts`、`test-node/ui/admin-ui-load-balancing.test.ts`，以及新增的
  `test-node/ui/real-app-load-move.test.ts`，共 15 个跟踪路径。没有新增样式，所以 css-cascade-audit
  本轮不适用。
- 验证：`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run check:modules`（138 个模块，
  323 条运行时边，0 环 0 越界）与 `npm run check:skills` 各自 `exit 0`；`test-node/ui/real-app-load-move.test.ts`
  3 项全过，`test-node/ui/admin-ui-load-balancing.test.ts`（44 项）、`test-node/admin/load-balancer-tasks.test.ts`
  （22 项）、`test-node/admin/api-contract.test.ts` 与 `test-node/admin/response-schema-openness.test.ts` 一起
  跑为 5 文件 89 项全过；`npm run regen:ui-baselines` 重录 10 张并重写哈希行，两张负载均衡基线因接上
  选择器与操作块长高（中文 1278×2720，英文 1278×2857），已按实际尺寸改行并全尺寸看过，英文画面无中文残留。
  `git diff --check` 干净。
- 声明对账：基线 `eee78a0` 是 146 个含声明的测试文件与 1308 条声明，`git grep -cE` 同一口径下本提交是
  147 个文件与 1330 条声明，增量 22 条就是 UI 的 +11（原 33 → 44）、API 的 +8（原 14 → 22）与真实 app
  用例的 +3；Vitest 收集 148 文件（147 跑、1 跳过）共 1501 项，与 1479 + 22 逐项对得上。UI 那一档里
  TRI-06 原本那条“每个迁移按钮都禁用并写着服务端给的理由”不是被删掉凑绿，而是改写成
  `[TRI-09] shows the server's refusal where it will not offer a destination`，保住的还是同一个有效意图：
  按钮的可用与否由服务端回答。
- 真实浏览器闭环：`test-node/ui/real-app-load-move.test.ts` 开的是产品自己的 admin 服务、产品自己的
  proxy 监听和产品自己的页面，只有两个上游是本地可控 HTTP。上游在第一帧后停住，等这个文件自己放行，
  不再靠抢四秒窗口；客户端真的读到第一帧、列表说这条 binding `inFlight` 为 1，此时通过现有状态轮询驱动
  的界面登记意图，看到 `pending_boundary`、可取消，且源节点没换、下一帧没多、上游计数没动；放行到
  `[DONE]` 后客户端手里全部 frame 按原序齐全，路由才在这个边界上变成 `applied` 并把 binding 移到目标；
  下一份同身份请求（同一个 `conversation_id`，第一条用户消息重复在前）实到目的地，只有目的地接到它，
  而 `observed` 是在目的地的响应头到达之后才成立的；界面靠现有的 2 秒轮询读到 `observed`，源节点页在行
  消失之后仍然显示这条记录；持久记录用产品自己的字段名对齐：`move_operation_id`、`moved_by` 为 `manual`、
  `moved_from`、`moved_to` 与 `move_routing_revision`，而被移动的那一条是唯一带这些字段的一条，先前那条
  SSE 记录里没有迁移元数据。这一条链是真实 HTTP 请求经过产品到本地控制服务，不是真实 LM 引擎，TRI-11
  的真实引擎收益不在本项。三个用例各自开自己的对话并重置自己碰到的夹具，不串成一条依赖链。
- 结果与限制：
  - 一次并发碰撞确实发生过，根因不是操作系统分端口：`src/config/config-normalizer.ts` 里 pair 的
    `listen_port` 走 `positiveNumber(raw["listen_port"], 1234)`，任何不是正数的值在落盘配置里都被换成产品
    默认的 1234。本 lane 新增的真实 app 用例当时往 `proxies.json` 写 `listen_port: 0`，经归一化就变成固定
    1234；`test-node/app/runtime.test.ts` 的 `disabledPairFixture` 同样写 0、也被归一到 1234，于是两个常驻
    fixture 钉在同一个端口上，`[AI-09] answers every write route on its own assembled application` 在启用
    `managed-pair` 时拿到 `409 listen_conflict`。当时把它读成“两个测试进程抢 ephemeral 端口”是错的推断，
    已在下面的修正里推翻。
    修只在本 lane 自己的 fixture 里（`d61309f`）：`test-node/ui/real-app-load-move.test.ts` 现在按仓库既有的
    `availablePort()` 配方（bind :0、读出真实端口、再关掉）先取一个正端口写进 `proxies.json`，启动后同时
    核对 `/api/pairs` 里配置的 `listen_port` 与 `actual_listen_port` 都等于要的那个正端口，任一半漂了就带着
    三方数字报错停下；上游与 admin 仍直接 `listen(0)`，产品的归一化语义与 `runtime.test.ts` 那句断言都没
    动，也没有加全局串行、端口段或重试。修后两文件并发 10 项全过，`npm run test` 单独重跑为 148 文件（147
    通过、1 跳过）与 1499 通过、2 跳过，与声明增量对得上；`npm run check` 整条 `exit 0`（含 `build`）。
  - `npm run build` 随 `npm run check` 跑过；便携版打包、`smoke:delivery` 与 `abi:node` 仍未跑，本 lane
    禁 ABI 切换，留给整合阶段。
  - 截图给人亲看的一份留在 `.pi/tri09-review/screenshots/`（仓库忽略该目录）：
    `lb-{zh,en}-1278-bindings-expanded.png`、`lb-{zh,en}-1278-group-edit.png`、
    `lb-{zh,en}-380-bindings-expanded.png`、`lb-{zh,en}-380-group-edit.png`，共 8 张。
  - 真实 app 用例现在只覆盖一次成功移动的全闭环、一个被拒绝的成员和一个 response id 造成的保守
    拒绝；pending 的真取消、跨 runtime 的迟到回答与 `expired_after_apply` 在真实装配里还没走一遍，
    它们目前有 API 与 UI 桩用例覆盖。
- 返工轮（`6652d21` 之后再加 `c13260a` 一个产品提交、`04b4d2d` 之外的基线一张与本清单一张）：
  - 上一轮那句“obsolete 的回答不会为新页说话”当时并不成立，也没满足先前约定的 lifecycle 隔离：
    dispose 后同一个 runtime 里重新 init，一条旧 *失败* 的 `POST` 回调照样把“结果未知”写进新页面的行。
    父代理的探针（`.pi/parent-review/late-failure.test.ts` + `late-failure.config.ts`，`-t PARENT`）在
    `6652d21` 上 1 pass，就是这个漏洞的复现记录。当时那条路只是把旧回执藏起来，草稿还挂在旧 attempt
    上，下一次读就把被污染的状态显示出来。本轮不解释“这个风险可以接受”，直接改掉。
  - 产品改动：`dispose()`、换代的新页（`storeBindingPage` 的非追加分支）与整代行丢掉重读
    （`discardBindingGeneration`）三个时刻都当场 `detachPendingMoveWrites`——摘下在途 attempt、清掉
    `submitting`、清掉 `panel.cancelling`，并把这份没有答复的 intent 就地转成 unknown，payload 与 key
    一分不动，行自己的重试还能原字节重放。“标 unknown”是 detach 当时写下的本地状态，不是迟到的
    callback；迟到回调因为 `draft.attempt !== attempt` 完全不写。`resolveStrandedAttempt` 因此被删掉而不是
    加一道 guard：submit 与 retry 现在先问“这一页还是我出发那一页吗”，不是就直接 return。
  - 文案：`lbMoveUncertainNotice` 不再写“也可以用同一请求重试，也可以放弃”（这一页没有给未知提交取消
    入口，读者会以为能取消）；`lbMoveCancelUnreachable` 改名 `lbMoveCancelUnknownOutcome`，英文不再说
    “did not reach the server”，中英都只说取消的结果未知、当前状态无法确认。
  - 测试：`test-node/ui/admin-ui-load-balancing.test.ts` 新增 4 条、改写 1 条，总数 53 → 57，没有删任何
    有效用例。四条是：同 runtime 重建后迟到的 `POST` 失败、同 runtime 重建后迟到的成功答复、迟到的
    `DELETE` 失败解不开新一代正在持有的取消 claim、组版本在同一 runtime 下换了代以后迟到的失败。每条
    先把状态轮询停掉（只把 `document.hidden` 置真，不 dispose），再拍快照：此时唯一还能动这一行的就是
    手里那个答复；放行后断言快照逐字段相等、`bindingReadParameters()` 从放行那一刻起一条也没记到、
    `lbBindingReads`/`lbStatusReads` 与 `sent` 计数都不动，然后用户自己点重试把完全相同的 key/payload 重
    放一遍（并与落到桩上的那一份 `lbMoveCall().body` 逐字段对相等）。改写的那条现在断言的是 dispose 当
    场写下的状态与“迟到的 `applied` 回执从不上新页”，不再是“那一行什么都没写”。
  - 声明计数：`eee78a0` 1308 条 / 146 个文件，`6652d21` 1339 条 / 147 个文件，本提交 1343 条 / 147 个
    文件（+4 就是上面四条新增，文件数没动）。按口径加和：1479 + 22 + 9 + 4 = 1514（预期 1512 pass、
    2 skip）。本轮实跑的只有这一个 UI 文件（57 pass）与 `npm run typecheck`、`npm run lint`、
    `npx prettier --check`（改动文件）；整条 `npm run check` 与全量 Vitest 计数留给整合阶段跑，不在这里
    冒充已经跑过。父代理的探针现在在那条“release 之前还没有提示”的断言上 fail——提示是 dispose 写的，
    release 之后什么都不变，这正是本轮要的可证明行为。
  - 基线：`npm run regen:ui-baselines` 跑通并重录 10 张，自动同步哈希行；除 `doc/ui_logs_cn.png` 以外
    九张本轮拍出来的字节与 HEAD 完全相同（两张负载均衡也没动：基线画面里没有提交过的行，新加的
    detach/retry 态默认不触发，所以哈希不变是合理的，但实跑重录的证据在上面）。`ui_logs_cn.png` 只
    差 1 个像素，已在设计文档旁边的基线登记里归因：把 `6652d21` 的源码单独取回重新打包再拍，出来的
    还是同一张，所以不是本轮引起的，本轮按可复现结果登记而不是退回旧图。英文截图扫描（`.pi/tri09-final/english-scan.txt`）：
    画面里只剩 emoji 与语言选择器自己的“中文/English”选项字面，另有两句中文在没被截到的隐藏视图里
    （统计指标 option “费用”与一个 `aria-label="统计时间范围"`）——那是本轮范围外的旧缺口，不在本轮动。
  - 截图：`.pi/tri09-review/screenshots/` 现在共 20 张。旧的 8 张（bindings-expanded / group-edit）不动；
    本轮新交 12 张，都是同一个 stub admin 页、真实控件与真实投影，没有伪造上游也没有伪造 GET：
    `lb-{zh,en}-1278-move-confirm.png`（第二节点引擎不答数，目标带“目标指标未知 / destination metrics
    unknown”，已选中、确认框未勾、提交保持禁用，`setLbStatusPartialMetrics` 后重读列表）、
    `lb-{zh,en}-380-move-confirm.png`（同一状态下窄屏）、
    `lb-zh-1278-move-unknown.png`、`lb-en-1278-move-unknown.png`、`lb-zh-380-move-unknown.png`（route
    `abort("failed")` 后的未知句 + 行自己的重试 + 目标选择器 disabled）、`lb-{zh,en}-1278-move-conflict.png` 与
    `lb-en-380-move-conflict.png`（桩以产品
    自己的映射回答 409 `binding_stale`，提示 + 服务端原句 detail）、`lb-{zh,en}-1278-move-operations.png`
    （`setLbBindingMigrationOperations` 四条记录 `applied` / `observed` / `cancelled` / `expired_after_apply`
    同时在场）。覆盖是两语言 × 宽 1278 / 窄 380，不是每个状态四份重复。
  - 仍在的真实限制：本页只认行上的重试，行不在本页时只在行下说一句，本轮不做 off-page 重放；一次
    成功的回执会被用户的新意图覆盖，不建无限历史，操作的当前事实以列表 GET 为准；取消 claim 由发起它
    的 attempt 释放，代际换了不锁死按钮，但也不同步告诉用户“取消成功了还是失败了”（操作块自己说）；
    真实装配里 pending 真取消、跨 runtime 迟到回答与 `expired_after_apply` 仍未走一遍；便携版打包、
    `smoke:delivery` 与 `abi:node` 仍留给整合阶段。本清单仍记 **8 / 12**，TRI-09 返工与本轮的基线/文档
    都**待父代理独立复审**，不由本 lane 自接为验收通过。

### TRI-10

- 状态：未开始
- 修改文件：
- 验证：
- 结果与限制：

### TRI-11

- 状态：未开始
- 修改文件：
- 验证：
- 结果与限制：

### TRI-12

- 状态：未开始
- 修改文件：
- 验证：
- 结果与限制：

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

- [ ] 第 4 节所有任务已完成，或每个阻塞项都有明确的证据和后续任务。
- [ ] `task-routing-design.md` 与代码、API、UI 和测试没有互相矛盾的状态或错误码。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:modules` 和 `npm run check` 通过。
- [ ] `npm run regen:ui-baselines` 已运行，截图已完整检查，基线哈希已更新。
- [ ] 三组真实引擎对照结果已归档；自动模式收益和风险结论独立记录。
- [ ] `npm run package:electron:portable`、`npm run smoke:delivery` 和 `npm run abi:node` 通过。
- [ ] `git status --short` 和 `git diff --stat` 只包含本次授权的实现、测试、文档和基线文件。
- [ ] 未修改用户实例、用户配置、用户 traffic database 或 `AGENTS.md`，除非另有明确授权。
