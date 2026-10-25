# 面向 AI 持续开发的优化 TODO

基线：`14ae4de`，应用版本 0.4.10。初始状态：0 / 24 项完成。

本文是本轮优化的执行清单和验收依据。它把代码审查中的发现拆成独立任务，供本地 AI 按依赖顺序实施。历史设计和旧 TODO 只作为背景材料；执行时应复核当前源码。

## 1. 决策摘要

- 先修复配置覆盖和统计目录快照两个已复现的问题。
- 让项目自有数据的类型贯穿持久化、服务、API 和前端。
- 用明确的模块边界限制跨功能状态访问。
- 让缓存判断与渲染使用同一份输入。
- 将重复操作固化为脚本，将历史说明与现行文档分开。
- 保持代理协议、计价口径、已有数据和用户界面行为稳定。

## 2. 执行约定

每次选择一个依赖已完成的未完成任务。默认按进度表顺序推进；不跨过 P0 去做大规模重构。

每项先核对现状，再完成实现、相关验证和文档同步。状态只能是“未开始”“进行中”“阻塞”“已完成”。部分实现保留为“进行中”，写清剩余工作。

测试描述或测试分组应引用对应任务 ID，例如 `[AI-01]`。每项完成后填写第 9 节的记录，再勾选进度表。测试数量会随开发变化，不把本文中的历史计数写成永久断言。

如果入口文件已经迁移，应更新本文中的链接和验证入口。新增文件必须在完成记录里标明用途。小任务作为独立审查单元；大任务可拆成多个步骤，但必须完成全部验收条件才能勾选。

本清单不要求自动提交、推送、发布或替换用户的便携实例。提交与发布按用户后续指令执行。

### 2.1 必须遵守的边界

| 范围       | 执行要求                                                         |
| ---------- | ---------------------------------------------------------------- |
| 项目约定   | 先读根目录 AGENTS.md，再按实际任务加载相关 skill。               |
| 用户实例   | 保持只读；使用临时配置、临时数据库、独立数据目录和空闲端口验证。 |
| 内部接口   | 可同步修改当前调用方；临时适配层必须有明确移除任务。             |
| 代理数据面 | 保持响应字节、重复头、SSE、backpressure、取消和压缩透传合同。    |
| 配置保存   | 保持事务回滚、监听器复用和在途请求继续使用原配置的行为。         |
| 历史数据   | 保持旧库可读、正文去重、搜索、任务归并和金额精度。               |
| UI         | 按项目约定验证截图，检查中英文、窄屏、空态和加载态。             |
| 原生模块   | 同一工作区的 Node 测试与 Electron ABI 重建串行执行。             |
| 完成门禁   | 每项仍遵循 AGENTS.md 的便携版构建要求。                          |

### 2.2 验证配置

以下命令均已存在。Windows Git Bash 下从大写盘符路径执行 Vitest 和 UI 基线命令。

| 编号 | 用途       | 执行要求                                                            |
| ---- | ---------- | ------------------------------------------------------------------- |
| V-D  | 文档       | 用显式 ignore-path 检查 docs 文档，核对链接、命令和任务依赖。       |
| V-B  | 后端与工具 | 执行相关测试、`npm run typecheck` 和 `npm run lint`。               |
| V-U  | UI         | 执行相关浏览器测试、类型检查和 lint；按项目约定更新并完整查看截图。 |
| V-F  | 综合回归   | 执行 `npm run check`，失败时区分既有问题与本次回归。                |
| V-P  | 交付构建   | 最后执行 build、Electron 重建和 portable 打包。                     |

项目的默认 Prettier 配置忽略 docs 目录。文档任务应显式指定 ignore-path，避免检查命令成功却未检查文件：

```bash
npx prettier --ignore-path .gitignore --check docs/ai-development-optimization-todo.md
```

相关测试示例：

```bash
cd /D/code/local_ai_proxy
npm test -- test-node/app/runtime.test.ts test-node/proxy/proxy-manager-apply.test.ts
npm run typecheck
npm run lint
```

UI 基线更新命令：

```bash
npm run regen:ui-baselines
```

检查完整的生成图片，再同步 README 使用的图片和基线哈希。UI 文案变更还要执行 `npx prettier --check .`，检查英文截图中的中文残留。

每项最后执行的构建命令：

```bash
npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never
```

V-P 完成后依赖处于 Electron ABI。此后若开始下一项 Node 测试，应先通过 `npm test -- <实际测试文件>` 恢复 Node ABI，并在该项结束时重新完成 V-P。不要在 Electron 重建和打包之间执行 Node 重建。

冒烟测试使用临时目录，并实际访问数据库接口。只检查健康接口或成功 import SQLite 包，不能证明原生数据库绑定可用。完整流程见 [packaging-smoke](../.agents/skills/packaging-smoke/SKILL.md)。

## 3. 已核实的起点

这些是审查基线下的事实，用于帮助复现；执行任务时应重新确认。

| 发现                       | 证据或复现结果                                                                         | 对应任务  |
| -------------------------- | -------------------------------------------------------------------------------------- | --------- |
| 总结设置保存会覆盖代理修改 | 临时实例中先改代理名称，再保存总结模型，两次均返回 200，名称和落盘配置恢复旧值。       | AI-01     |
| 统计持有旧日志目录         | 修改日志目录后访问统计，创建和访问的仍是启动时目录中的数据库。                         | AI-02     |
| 当前版本常量漂移           | persistence barrel 导出的 schema 版本为 8，新建数据库实际迁移到 13。                   | AI-03     |
| UI 类型检查有空值盲区      | 原配置通过；仅开启 strictNullChecks 后得到 614 条诊断。                                | AI-20     |
| 前端共享作用域与状态       | 九个脚本合计 7,296 行，50 个被访问的 state 字段中有 22 个跨文件使用。                  | AI-17～21 |
| 样式跨区域竞争             | CSS 为 4,526 行、82 处 important；已有层叠普查和对拍工具。                             | AI-22     |
| 后端存在运行时依赖环       | proxy barrel、registry、logging barrel、matcher、log service 和 manager 构成六文件环。 | AI-10     |
| SSE 测试出现时序脆弱性     | 一次全量运行解码窗口约 3.7 ms，低于 20 ms 断言；单跑及再次全量运行通过。               | AI-14     |
| 全量回归基线               | 第二次运行 957 通过、2 跳过；格式、lint、类型检查通过。                                | AI-24     |

614 条诊断不等于 614 个已证实的运行缺陷。单次时序失败也不足以确定根因，不能据此降低断言或添加重试掩盖问题。

## 4. 进度与依赖

P0 是已复现的功能缺陷；P1 是契约、文档和后端基础；P2 是工具、前端和工作流重构。P2 表示安排顺序，不表示风险或收益低。

| 完成 | ID    | 优先级 | 任务                        | 前置任务                                                                                                                                                        | 状态   |
| ---- | ----- | ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| [x]  | AI-01 | P0     | 统一配置状态和局部更新      | 无                                                                                                                                                              | 已完成 |
| [x]  | AI-02 | P0     | 统计动态读取日志目录        | AI-01                                                                                                                                                           | 已完成 |
| [x]  | AI-03 | P1     | 统一当前数据库版本来源      | 无                                                                                                                                                              | 已完成 |
| [x]  | AI-04 | P1     | 建立现行架构文档入口        | AI-01、AI-02、AI-03                                                                                                                                             | 已完成 |
| [x]  | AI-05 | P1     | 错误分类与内部诊断          | 无                                                                                                                                                              | 已完成 |
| [x]  | AI-06 | P1     | 日志事件和写入模型类型化    | 无                                                                                                                                                              | 已完成 |
| [x]  | AI-07 | P1     | 查询结果和服务契约类型化    | AI-06                                                                                                                                                           | 已完成 |
| [x]  | AI-08 | P1     | API schema 与客户端契约统一 | AI-07、AI-04、AI-15、AI-18、AI-19、AI-20、AI-21                                                                                                                 | 已完成 |
| [x]  | AI-09 | P1     | 完整应用的服务装配约束      | AI-01、AI-02、AI-07、AI-08                                                                                                                                      | 已完成 |
| [x]  | AI-10 | P1     | 消除运行时依赖环            | AI-06                                                                                                                                                           | 已完成 |
| [ ]  | AI-11 | P1     | 分离模型调用与日志查询      | AI-01、AI-05、AI-07、AI-10                                                                                                                                      | 未开始 |
| [x]  | AI-12 | P1     | 按职责拆分持久化访问        | AI-06、AI-07、AI-10                                                                                                                                             | 已完成 |
| [ ]  | AI-13 | P1     | 稳定历史迁移依赖            | AI-03、AI-10、AI-12                                                                                                                                             | 未开始 |
| [ ]  | AI-14 | P1     | 补齐场景测试并稳定时序验证  | AI-01、AI-02、AI-05、AI-08、AI-09                                                                                                                               | 未开始 |
| [x]  | AI-15 | P2     | 分离产品、测试与工具编译    | 无                                                                                                                                                              | 已完成 |
| [x]  | AI-16 | P2     | 固化 ABI 和交付冒烟流程     | AI-15                                                                                                                                                           | 已完成 |
| [ ]  | AI-17 | P2     | 建立前端模块构建入口        | AI-08、AI-15                                                                                                                                                    | 未开始 |
| [ ]  | AI-18 | P2     | 模块化代理配置与负载均衡    | AI-17                                                                                                                                                           | 未开始 |
| [ ]  | AI-19 | P2     | 模块化历史、详情和指标      | AI-11、AI-17、AI-18                                                                                                                                             | 未开始 |
| [ ]  | AI-20 | P2     | 收紧 UI 类型与 DOM 合同     | AI-18、AI-19                                                                                                                                                    | 未开始 |
| [ ]  | AI-21 | P2     | 统一渲染输入和缓存失效      | AI-19、AI-20                                                                                                                                                    | 未开始 |
| [ ]  | AI-22 | P2     | 建立组件样式归属            | AI-18、AI-19、AI-21                                                                                                                                             | 未开始 |
| [ ]  | AI-23 | P2     | 整理 skills 并固化操作入口  | AI-04、AI-14、AI-16、AI-20、AI-21、AI-22                                                                                                                        | 未开始 |
| [ ]  | AI-24 | P2     | 综合验收与文档收口          | AI-01、AI-02、AI-03、AI-04、AI-05、AI-06、AI-07、AI-08、AI-09、AI-10、AI-11、AI-12、AI-13、AI-14、AI-15、AI-16、AI-17、AI-18、AI-19、AI-20、AI-21、AI-22、AI-23 | 未开始 |
| [ ]  | AI-25 | P2     | 保留旧配置里未建模的键      | AI-18                                                                                                                                                           | 未开始 |

## 5. 任务明细

### AI-01：统一配置状态和局部更新

入口：[应用装配](../src/app/runtime.ts)、[ProxyManager](../src/proxy/proxy-manager.ts)、[配置仓储](../src/config/config-repository.ts)。

- [x] 先在真实应用装配测试中复现“修改代理后保存总结设置”的覆盖问题。
- [x] 让 manager 或独立配置服务成为唯一当前配置来源，移除启动配置闭包的后续读写职责。
- [x] 提供明确的局部更新操作，在配置应用队列内基于最新状态合成变更。
- [x] 保存失败时，当前内存、磁盘配置及总结模型读取结果都保留原值。
- [x] 让摘要和简介调用读取已成功提交的当前总结模型配置。

验收：代理、总结设置交错更新互不覆盖；串行和受控并发操作均保留不相交的修改。提交失败不得提前暴露新配置。已有配置回滚和在途请求语义保持。

验证：V-B、V-P；扩展 `test-node/app/runtime.test.ts`、`test-node/proxy/proxy-manager-apply.test.ts`。

### AI-02：统计动态读取日志目录

入口：[usageStatisticsService](../src/maintenance/log-query-service.ts)、[应用装配](../src/app/runtime.ts)、[统计路由](../src/admin/routes/statistics.ts)。

- [x] 每次统计查询从当前配置解析日志根，避免在服务创建时冻结目录列表。
- [x] 统一列表、统计、选项和导出使用的日志根语义，包括去重和相对路径基准。
- [x] 完整应用始终提供统计服务；没有日志根时返回合法空结果。
- [x] 覆盖启动为空后添加代理、更换目录、移除最后一个目录和多目录更新。
- [x] 临时夹具给新旧目录写入不同数据，断言结果随成功配置提交变化。

验收：变更立即生效；不再读取或重新创建移出的目录。空配置下统计接口正常注册，返回与现有 DTO 一致的空结果。

验证：V-B、V-P；扩展 `test-node/maintenance/log-query-service.test.ts`、`test-node/app/runtime.test.ts` 和 `test-node/admin/api-contract.test.ts`。

### AI-03：统一当前数据库版本来源

入口：[数据库迁移入口](../src/persistence/database.ts)、[持久化导出](../src/persistence/index.ts)、各 schema-v 文件。

- [x] 为有序迁移列表和当前版本建立唯一来源，公共导出与迁移入口共同使用它。
- [x] 检查迁移版本的唯一性与顺序，避免导出仍指向历史版本。
- [x] 全量搜索历史 SCHEMA_VERSION 别名，清理有歧义的内部导出。
- [x] 同时测试公共版本、新库版本及备份恢复后的版本。

验收：三处版本一致。测试另外钉住预期的最新迁移和关键结构，防止“全都从错误常量推导”造成假通过。本项无需新增数据库迁移。

验证：V-B、V-P；扩展 `test-node/persistence/database.test.ts`，运行持久化迁移相关测试。

### AI-04：建立现行架构文档入口

入口：[模块设计](./module-design.md)、[功能说明](./software-functional-specification.md)、[模块约定](./refactoring/typescript-module-conventions.md)。

- [x] 建立简明的现行架构入口，标明适用版本、启动路径、配置归属和验证入口。
- [x] 描述 Node 事件循环、同步数据库访问、运行时资源和关闭顺序。
- [x] 将 Python 基线、已完成迁移和旧性能实验归入明确的历史材料。
- [x] 核对旧限制、待决问题及目录约定，链接已作出决策的 ADR。
- [x] 更新 README 和 AGENTS.md 中需要调整的导航，避免复制整份架构说明。

验收：通过现行入口能确定真实运行模型和修改位置；历史材料不再以无版本限定的“当前实现”误导检索。保留历史决策依据与链接。

验证：V-D、V-P；运行相关 `test-node/docs` 测试。只为文档结构添加必要校验，不给每句文字编写测试。

### AI-05：错误分类与内部诊断

入口：[日志路由](../src/admin/routes/logs.ts)、[管理错误处理](../src/admin/admin-server.ts)、[日志写入](../src/logging/traffic-log-service.ts)、[查询服务](../src/maintenance/log-query-service.ts)。

- [x] 为未找到、生成冲突、上游失败和存储失败建立明确的错误类型或 code。
- [x] 使用稳定错误分类映射 HTTP 状态，移除对英文消息片段的判断。
- [x] 内部日志保留阶段、关联 ID、数据库标识及可用 cause/code。
- [x] 对外错误保持可理解，并避免暴露密钥和请求正文。
- [x] 多目录查找只忽略预期的“不在此目录”，真正的写入失败应可诊断。

验收：改动错误文案不会改变 HTTP 状态。注入可控存储错误能定位具体阶段；日志失败仍不破坏已经正常进行的代理响应。

验证：V-B、V-P；扩展 `test-node/admin/errors.test.ts`、`test-node/admin/logs.test.ts`、`test-node/logging/traffic-log-service.test.ts` 和查询服务测试。

### AI-06：日志事件和写入模型类型化

入口：[代理 pipeline](../src/proxy/proxy-request-pipeline.ts)、[日志服务](../src/logging/traffic-log-service.ts)、[任务匹配](../src/logging/task-matcher.ts)、[repository](../src/persistence/repository.ts)。

- [x] 区分代理事件、任务写入、记录写入和数据库行，避免共用一个任意字典。
- [x] 用可区分的事件模型表达 received、pending 和 finished 的必要字段。
- [x] 明确原始 body、改写后 body、解码响应、计价快照和时间单位。
- [x] 外部任意 JSON 保留 unknown，并在边界解析；内部自有字段使用具体类型。
- [x] 更新 fixture 和调用方，避免用宽泛断言消除新增编译错误。

验收：必需字段缺失、类型错误和生命周期事件拼错能被编译检查发现。正文和元数据存储结果、任务归并及失败记录保持一致。

验证：V-B、V-P；运行 logging、任务身份、pipeline、listener 和 repository 相关测试。

### AI-07：查询结果和服务契约类型化

入口：[LogQueryService](../src/maintenance/log-query-service.ts)、[管理服务接口](../src/admin/admin-contracts.ts)、[统计服务](../src/maintenance/usage-statistics-service.ts)。

- [x] 为任务计价、三类趋势、请求计价、摘要和简介提供具体返回类型。
- [x] 将数据库行到服务模型、服务模型到响应的转换放到明确边界。
- [x] 统一服务接口和真实实现，清理 unknown 返回值及重复定义。
- [x] 为有业务意义的空值、缺失值、pending 和未计价状态建立明确合同。
- [x] 用有类型的 fixture 构造器减少重复载荷；移除整份服务的双重强转。

验收：服务字段重命名或遗漏能影响真实消费者的编译检查。外部模型的原始 JSON 仍可保持开放结构。

验证：V-B、V-P；运行 maintenance、statistics、admin 和 UI fixture 的相关检查。

### AI-08：API schema 与客户端契约统一

入口：[响应 schema](../src/admin/admin-schemas.ts)、[路由](../src/admin/routes)、[前端 API 助手](../src/admin/static/01-core.js)、[API 契约测试](../test-node/admin/api-contract.test.ts)。

- [x] 为项目自有 DTO 选择统一 schema 来源，并推导 TypeScript 类型和可用的 Fastify schema。
- [x] 补齐日志、计价、趋势、统计、总结设置及摘要的字段结构。
- [x] 任意用户请求/响应 JSON 使用显式开放字段，避免误删原始内容。
- [x] 建立客户端的类型化访问边界，覆盖消费者字段的检查。
- [x] 使用非空数据测试嵌套字段、数组元素、空值及大金额字符串。

验收：字段漂移在编译或契约测试阶段失败。HTTP 往返保留客户端实际使用的字段；错误载荷不被误当成功结果。不能仅以存在 response schema 计为完成。

验证：V-B、V-U、V-P；运行 API 契约和相关 UI 测试。本项允许先用 JSDoc 引用契约，模块导入在 AI-17～19 完成。

### AI-09：完整应用的服务装配约束

入口：[应用装配](../src/app/runtime.ts)、[AdminServerOptions](../src/admin/admin-contracts.ts)、[管理服务](../src/admin/admin-server.ts)。

- [x] 为正式应用建立必需的完整服务集合，遗漏方法应在编译或启动时失败。
- [x] 将用于测试的部分服务装配做成显式入口或选项。
- [x] 让日志查询、总结、统计等服务的生命周期和持有者清晰可见。
- [x] 保留真实应用装配测试，覆盖必需 GET 及关键写操作。

验收：新增正式功能后忘记接线，不会悄悄表现为路由 404。业务对象不存在与路由未注册有稳定的不同错误结果。

验证：V-B、V-P；运行 `test-node/app/runtime.test.ts`、`test-node/admin/api-contract.test.ts` 及相关路由测试。

### AI-10：消除运行时依赖环

入口：[proxy 导出](../src/proxy/index.ts)、[运行时注册表](../src/proxy/proxy-runtime-registry.ts)、[日志服务](../src/logging/traffic-log-service.ts)、[任务身份](../src/proxy/task-identity.ts)。

- [x] 将协议分析、任务身份和纯记录处理放入职责明确的叶模块。
- [x] 避免低层 helper 通过包含 manager/registry 的大 barrel 引入运行时。
- [x] 依据实际职责更新依赖方向，保持 transport、存储和控制面的边界。
- [x] 用 AST 或成熟工具检查运行时 import/re-export 环，排除纯类型导入。
- [x] 增加边界校验，并用必然违规的样例验证校验器有效。

验收：本次发现的六文件环消失，纯 helper 可独立加载。检查器能发现新环和越界导入，报出具体依赖链。

验证：V-B、V-P；运行任务匹配、代理运行时和模块边界检查。同步修正文档中的目录与导出约定。

### AI-11：分离模型调用与日志查询

入口：[LogQueryService](../src/maintenance/log-query-service.ts)、[总结模型测试装配](../src/app/runtime.ts)、[目标测试](../src/proxy/target-check.ts)。

- [ ] 提取总结模型客户端，统一三种协议的 URL、headers、超时和响应读取。
- [ ] 提取摘要/简介生成服务，明确缓存、并发保护和存储职责。
- [ ] 连接测试与正式调用共享协议构造能力，保留各自不同的业务参数。
- [ ] 输入整理、提示词和响应解析分别提供可独立验证的边界。
- [ ] 保持已有提示词版本与缓存语义；确需改变时单独记录原因。

验收：查询服务不再承担上游 HTTP 请求构造。三种协议、非法响应、超时、并发生成和最新配置读取均有测试，测试不调用真实付费上游。

验证：V-B、V-P；扩展 `test-node/maintenance/log-query-service.test.ts` 和总结相关测试；新增测试文件在完成记录中登记。

### AI-12：按职责拆分持久化访问

入口：[TrafficRepository](../src/persistence/repository.ts)、[正文存储](../src/persistence/body-storage.ts)、[计价计算](../src/pricing/money.ts)。

- [x] 按任务、记录、搜索和计价聚合等变化原因拆分内部职责。
- [x] 保持同一个业务写入事务覆盖 task、record、links 和搜索同步。
- [x] 所有写操作使用明确输入类型，查询返回明确投影。
- [x] 收敛裸 database 暴露，清理业务层直接 SQL 的不必要入口。
- [x] 保留分页、批量查询、正文延迟读取和金额精度。

验收：模块边界能说明一项修改影响哪些数据；事务失败无部分写入。大库搜索和列表查询不因拆分退化为逐条读正文。

验证：V-B、V-P；运行 persistence、logging、maintenance 和 statistics 测试；用既有基准比较相关查询。

### AI-13：稳定历史迁移依赖

入口：[迁移入口](../src/persistence/database.ts)、[schema v5](../src/persistence/schema-v5.ts)、[迁移校验](../scripts/validate_migration.ts)。

- [ ] 审查每次迁移引用的当前业务函数，列出可能随新功能变化的依赖。
- [ ] 将需要历史稳定语义的转换固化为迁移专用实现或稳定版本的纯函数。
- [ ] 保留必要的历史转换代码，不能为统一目录而改写既有数据含义。
- [ ] 验证旧 fixture 到最新版本、重复打开、失败回滚和关系一致性。

验收：修改当前协议解析能力不会隐式改变旧库升级结果。迁移测试覆盖关键转换值和数据关系，版本常量仍与实际结构一致。

验证：V-B、V-P；运行 `test-node/persistence/database.test.ts`、`test-node/persistence/migration-validation.test.ts`、`test-node/persistence/real-data-rehearsal.test.ts` 及迁移基准。

### AI-14：补齐场景测试并稳定时序验证

入口：[应用测试](../test-node/app/runtime.test.ts)、[SSE 测试](../test-node/proxy/proxy-listener.test.ts)、[源码守卫](../test-node/admin/static-source.test.ts)、[UI 测试基础](../test-node/ui/admin-ui-server.ts)。

- [ ] 审查并补齐跨设置更新、空配置到有配置、失败回滚等操作序列。
- [ ] 复现和定位压缩 SSE 时序失败，使用可观测事件协调发送阶段。
- [ ] 将协议内容、流式先后关系和测量计算分层验证，保留必要真实流集成测试。
- [ ] 将只检查业务源码文本的用例改为行为或结构测试，保留必要静态不变量。
- [ ] 浏览器测试统一收集未处理 pageerror，确保测试结束时有明确失败反馈。

验收：相关用例单跑和全量并发运行均通过；报告重复次数和环境。仍要发现压缩未解码、整段响应被缓冲、测量公式错误等回归。不得仅加等待、重试或放宽阈值求绿。

验证：V-B、V-U、V-F、V-P；按发现复跑相关用例，避免把重复全量测试当成唯一证明。

### AI-15：分离产品、测试与工具编译

入口：[主 tsconfig](../tsconfig.json)、[UI tsconfig](../tsconfig.ui.json)、[npm scripts](../package.json)、[静态复制](../scripts/copy_static_assets.ts)。

- [x] 为产品、测试和开发工具建立清晰的 TypeScript 编译入口。
- [x] 产品 build 不编译测试实现，完整 typecheck 仍覆盖所有源码。
- [x] 保证打包所需工具按需编译，更新脚本使用的实际产物路径。
- [x] 同步 CLI archive、Electron files 和 CI 的路径及执行顺序。
- [x] 从干净输出目录验证，避免旧文件掩盖缺失产物。

验收：测试类型错误能使质量门禁失败，但不会成为产品代码编译的隐式输入。产物不包含测试；CLI、静态资源和打包工具均可运行。

验证：V-B、V-P；运行 `test-node/admin/built-static-assets.test.ts`、Electron 构建配置和相关 CLI 测试。

### AI-16：固化 ABI 和交付冒烟流程

入口：[npm scripts](../package.json)、[数据库 smoke](../scripts/database_smoke.ts)、[产物 smoke](../scripts/artifact_smoke.ts)、[发布工作流](../.github/workflows/release.yml)。

- [x] 为 Node 与 Electron 验证提供明确入口，用真实查询证明 SQLite ABI。
- [x] 将清理 ELECTRON_RUN_AS_NODE 等启动条件写进脚本。
- [x] 使用唯一临时配置、独立 userData、空闲端口和可追踪的子进程。
- [x] 除 health 外，检查日志接口和实际建库；关闭后清理临时资源。
- [x] 区分 portable 包装器与 unpacked 载荷冒烟，按顺序执行，避免共享目录冲突。

验收：错误 ABI 有可理解的诊断；打包后可访问数据库并正常退出。portable 解包路径碰撞不得被误报为 payload 回归；脚本只关闭自己启动的进程。

验证：V-B、V-P；运行 Electron/CLI 相关测试及隔离冒烟。完整发布验证仍覆盖实际 portable artifact。

### AI-17：建立前端模块构建入口

入口：[静态资源加载](../src/admin/static-assets.ts)、[拼接工具](../scripts/concat_ui_parts.ts)、[静态复制](../scripts/copy_static_assets.ts)、[UI 检查](../tsconfig.ui.json)。

- [ ] 建立明确的 ES module 源码入口，选择原生模块或构建打包方案并记录理由。
- [ ] 迁移一组纯工具或统计计算模块，先证明 import/export、测试和构建链路可用。
- [ ] 保持现有静态 URL 与功能可用，验证编译后和打包后的资源。
- [ ] 调整 lint、类型检查、静态源码守卫，避免依赖隐藏的全局作用域。
- [ ] 必须过渡的桥接仅导出列明的能力，并在 AI-19 完成前移除。

验收：新模块不依赖任意跨文件全局名字，检查器实际检查运行的代码。该项不要求引入 UI 框架，也不能一次性改写全部页面。

验证：V-U、V-P；运行 static-assets、built-static-assets、static-source 及相关 UI 测试。

### AI-18：模块化代理配置与负载均衡

入口：[代理配置](../src/admin/static/02-proxy-config.js)、[负载均衡](../src/admin/static/03-load-balancing.js)、[事件装配](../src/admin/static/09-wiring.js)。

- [ ] 为代理配置和负载均衡分别明确状态所有者、初始化和销毁操作。
- [ ] 用显式操作连接 API、表单和轮询，限制跨模块直接写状态。
- [ ] 把事件监听、语言更新和轮询生命周期收敛到功能模块。
- [ ] 测试未保存输入在语言切换、轮询和状态刷新时保持。

验收：排序、模型映射、价格、成员选择、指标刷新及配置保存均保持。重复初始化不增加监听器或定时器，切换页面后正确停止不需要的轮询。

验证：V-U、V-P；运行 `test-node/ui/admin-ui-proxy.test.ts`、`test-node/ui/admin-ui-load-balancing.test.ts` 及视觉测试。

### AI-19：模块化历史、详情和指标

入口：[历史列表](../src/admin/static/04-history-logs.js)、[任务详情](../src/admin/static/05-task-detail.js)、[JSON 面板](../src/admin/static/06-json-pane.js)、[指标](../src/admin/static/08-metrics.js)。

- [ ] 依次迁移历史加载与选择、JSON 面板、任务详情、指标和剩余统计交互。
- [ ] 为每个模块定义输入、操作和资源释放合同，保留请求取消和过期结果保护。
- [ ] 移除 AI-17 的过渡桥接和 numbered classic-script 加载约定。
- [ ] 测试探针通过专用适配层提供，生产功能不依赖 window 上的业务函数。
- [ ] 同步静态资源构建、语言注册和浏览器测试辅助，不保留两套状态。

验收：所有前端业务依赖通过 import/export 或明确参数表达。打开、切换、关闭、刷新和分页均无资源泄漏；大正文和快速滚动行为保持。

验证：V-U、V-P；分步运行 history、statistics、proxy、load-balancing 和 visual 测试，最终执行完整 UI 套件。

### AI-20：收紧 UI 类型与 DOM 合同

入口：迁移后的前端模块、[UI 类型检查配置](../tsconfig.ui.json)、[当前 DOM 助手](../src/admin/static/01-core.js)。

- [ ] 按模块启用 strictNullChecks，再逐步收紧其他严格检查。
- [ ] 区分必需节点与可选节点；必需节点缺失时给出含选择器的错误。
- [ ] 通过具体元素类型访问 input、dialog、details 等成员。
- [ ] 将 state、API 结果和异步状态定义为明确类型。
- [ ] 移除不再适用的宽泛 UiElement 和无保护类型断言。

验收：完整前端严格检查通过。不存在节点和错误控件类型能在编译或初始化时明确失败。不得用批量忽略、宽泛 any 或可选链掩盖必需节点缺失。

验证：V-U、V-P；运行相关交互、空态、错误态及中英文基线；记录实际检查范围。

### AI-21：统一渲染输入和缓存失效

入口：[历史签名](../src/admin/static/04-history-logs.js)、[任务面板签名](../src/admin/static/05-task-detail.js)、[JSON 渲染](../src/admin/static/06-json-pane.js) 的迁移后模块。

- [ ] 为历史区块和任务面板定义明确的渲染输入模型。
- [ ] 缓存判断和模板渲染使用同一个输入，减少独立手写依赖清单。
- [ ] 记录 JSON 测量、宽度变化、展开恢复和视口预填充的失效条件。
- [ ] 增加字段变化、语言变化和过期响应的渲染回归测试。
- [ ] 同时验证数据未变化时不发生无意义重建。

验收：状态变化后立即显示；原节点保留、展开、选择和滚动位置符合现有行为。大正文不因取消缓存而重新冻结页面。

验证：V-U、V-P；用相同夹具和浏览器比较修改前后的处理耗时、DOM 重建和滚动表现。记录数据规模及测量方法，不新增无依据的性能阈值。

### AI-22：建立组件样式归属

入口：[app.css](../src/admin/static/app.css)、[层叠对拍测试](../test-node/ui/admin-ui-css-cascade.test.ts)、迁移后的组件模板。

- [ ] 先选择一个明确组件边界，记录其实际生效规则和跨区域竞争。
- [ ] 用组件命名或局部作用域逐项收敛样式，保持共享 token 清晰。
- [ ] 检查 hover、focus、disabled、hidden、窄屏和中英文长文本。
- [ ] 逐组件迁移，每步使用既有 computed-style 对拍和视觉检查。
- [ ] 无意外视觉变化后再清理不可达覆盖规则。

验收：迁移组件的样式归属清楚，其他页面不受影响。只减少 important 数量或移动 SECTION 注释不算完成；不机械添加多层 layer。

验证：V-U、V-P；先读 [css-cascade-audit](../.agents/skills/css-cascade-audit/SKILL.md)，运行层叠对拍、相关交互和视觉测试。

### AI-23：整理 skills 并固化操作入口

入口：[AGENTS.md](../AGENTS.md)、[项目 skills](../.agents/skills)、[skills 校验](../test-node/docs/skills.test.ts)。

- [ ] 将每个 skill 整理为适用条件、不变量、标准命令、结果判断和深入材料链接。
- [ ] 将长篇事故过程、历史测量与失败实验移到可链接的参考记录。
- [ ] 删除已被前述代码和工具消解的重复提醒，保留仍有效的使用边界。
- [ ] 对固定操作优先提供可重复执行的工具入口，再同步文档。
- [ ] 维持 skills 的有效加载和引用校验，减少多处手工维护相同清单。

验收：本地 AI 能按短步骤完成验证，并知道如何判断成功。文档引用、skill 元数据和测试入口一致；语义过时的内容也经过复核。

验证：V-D、V-P；运行 `test-node/docs/skills.test.ts` 和受影响工具的测试。修改 AGENTS.md 时执行其专门的 diff 与格式检查要求。

### AI-24：综合验收与文档收口

入口：本文、现行架构入口、[README](../README.md)、[英文 README](../README.en.md)、相关 ADR 与 skills。

- [ ] 逐项核对完成记录和实际代码，不能仅凭勾选认定完成。
- [ ] 执行完整质量检查、所有相关 UI 验证和干净产物构建。
- [ ] 用隔离实例复验配置更新、统计切换、数据库读写和正常退出。
- [ ] 复核依赖环、类型检查范围、API 字段和打包内容。
- [ ] 更新现行文档，列出遗留问题、设计偏差和后续独立工作。

验收：第 8 节全部满足，或明确记录未满足项并保持本任务未完成。交付报告区分自动测试、人工截图检查和尚未验证的内容。

验证：V-D、V-F、V-U、V-P，以及 AI-16 固化后的隔离交付冒烟。

### AI-25：保留旧配置里未建模的键

入口：[配置归一化](../src/config/config-normalizer.ts)、[配置校验](../src/config/config-validation.ts)、[代理配置写回](../src/admin/routes/pairs.ts)。

- [ ] `normalizeProxyPair` 与 `validateProxyConfigFile` 不再静默丢掉本模型未建模的键，而是保留它们并能经 `PUT /api/pairs` 往返读回。
- [ ] 区分“旧应用写下的键”与“控制台自己的运行时键”（`running`、`actual_listen_port`、`expanded`），后者不得被写进保存文件。
- [ ] 确实要丢的键给出可理解的诊断，而不是静默删除。
- [ ] 用一条真实往返测试钉住最终去向：写入 27 个键的旧扁平 pair，其未建模键在 `/api/pairs` 与保存文件里必须被明确断言，而不是靠“没报错”默认。

验收：未建模键不再静默丢失；UI 运行时键不进入保存文件；旧扁平 pair 的已建模值（如 `log_root`）仍按现行规则落到 `targets[0]` 的绝对路径。

验证：V-B、V-P；运行 config 与 admin 相关测试。

背景：AI-08 实测 `GET /api/pairs` 对一个写入 27 个键的 pair 只答 11 个键（`id,name,enabled,listen_host,listen_port,access_log,targets,default_target_id,load_balancers,running,actual_listen_port`），`log_root` 只在 `targets[0]` 里以绝对路径出现；`validateProxyConfigFile` 静默剔掉未知的 pair/target 键。开放响应本来就能原样答出未声明键（fast-json-stringify 探针实测），所以丢键发生在 `src/config` 而不在传输层——这条需求属于本任务，不属于 AI-08。

## 6. 第一轮不包含的工作

- 不新增路由、负载均衡、计价或摘要产品功能。
- 不引入新的 UI 框架作为完成模块化的前提。
- 不整体重做界面，也不机械重排全部 CSS。
- 不替换 SQLite 驱动，也不为代码整理变更存储格式。
- 不改变任务归并、模型路由、价格冻结和统计业务口径。
- 不一次性消除所有任意 JSON，也不为内部旧接口添加长期兼容层。
- 不以缩短文件、减少测试数量或删除提醒作为独立完成指标。
- 不自动提交、推送、发布或操作用户的在用实例。

## 7. 实施前需核实的选择

以下选择由执行 AI 在对应任务开始时结合源码决定，并写入完成记录。常规实现决策不需要反复向用户确认；涉及本节排除的范围时应另立需求。

| 问题                        | 推荐方向                                               | 替代与适用条件                                                       | 决定任务      |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- | ------------- |
| 当前配置由谁持有？          | 优先由现有 manager 持有，通过排队的局部更新访问。      | 若生命周期独立且收益明确，可提取配置服务；仍只能有一个提交状态。     | AI-01         |
| DTO schema 用什么实现？     | 优先评估现有 Zod，推导类型和可表达的 JSON schema。     | 如现有 refinement 不可转换，可选其他单一来源方案；说明新增维护成本。 | AI-08         |
| 服务缺失如何处理？          | 完整应用要求所有服务齐备，部分装配显式化。             | 测试可保留轻量入口，不能默默放宽正式应用的要求。                     | AI-09         |
| 前端采用哪种模块交付？      | 源码使用 ESM，优先评估小型构建打包方案以保持静态 URL。 | 原生浏览器 ESM 也可；需验证开发、测试和包内资源路径。                | AI-17         |
| 是否将前端改成 TypeScript？ | 可先用严格 JSDoc 配合 ESM，按模块衡量收益。            | 改成 TS 时同步构建和 source map；不保留重复实现。                    | AI-20         |
| 是否隔离原生依赖目录？      | 先固化串行重建与真实 ABI 探测。                        | 多 Agent 确需同时执行两种运行时时，再评估独立安装或工作区。          | AI-16         |
| 如何设性能门槛？            | 使用已有合同和同环境前后测量。                         | 新阈值需记录数据规模、噪声和选择理由。                               | AI-14、21、22 |

## 8. 最终验收清单

- 本轮勾选口径：勾 §8 只勾“本轮亲自复现过判据”的那一条；AI-01～AI-05 的验收由更早的会话做出，本轮没有逐条独立复现它们的判据，所以先留空，到 AI-24 综合验收时再统一核对（进度表行与任务小节的复选框已按当时验收勾过）。

- [ ] AI-01：代理和总结设置交错更新互不覆盖，失败不暴露未提交状态。
- [ ] AI-02：统计随日志目录变更生效，空配置下接口返回合法空结果。
- [ ] AI-03：公共 schema 版本、新库和备份恢复版本一致。
- [ ] AI-04：存在唯一现行架构入口，历史基线有明确身份。
- [ ] AI-05：业务错误按稳定分类映射，内部失败有足够诊断信息。
- [x] AI-06～08：自有日志和 API 数据有具体契约，嵌套字段受验证。
- [x] AI-09：完整应用遗漏服务接线时有确定失败反馈。
- [x] AI-10：运行时依赖环消除，并有有效的自动检查。
- [ ] AI-11～13：查询、模型生成和存储职责明确，历史迁移结果稳定。
- [ ] AI-14：操作序列和流式边界有回归测试，时序问题有定位记录。
- [x] AI-15～16：产品构建、测试检查、ABI 与交付验证入口明确可重复。
- [ ] AI-17～20：前端通过模块边界协作，过渡桥接清除，严格检查生效。
- [ ] AI-21：渲染与缓存输入一致，刷新和大正文体验保持。
- [ ] AI-22：组件样式归属明确，层叠与像素验证无意外变化。
- [ ] AI-23：skills 内容简明且有效，固定操作由工具承担。
- [ ] AI-24：完整检查、截图核验、portable 构建与隔离冒烟有实际记录。
- [ ] AI-25：旧配置里未建模的键不再被静默丢弃，控制台自己的运行时键不会被写进保存文件。

## 9. 单项完成记录模板

复制本模板，每项只保留一份最新记录。测试日志可引用本地文件；提交不存在时填写“未提交”。

```text
任务 ID：AI-XX
状态：进行中 / 阻塞 / 已完成
实际变更：
修改文件与新增入口：
前置任务与现状复核：
关键设计选择及理由：
实际验证命令、结果与日志：
新增/更新的测试及任务 ID：
UI 截图、性能或迁移结果（适用时）：
便携版构建与冒烟结果：
与本清单的偏差、剩余事项：
提交 SHA：未提交 / 实际 SHA
```

### AI-01 完成记录

- 状态：已完成
- 实际变更：`ProxyManager` 成为当前配置的唯一持有者，提交后的配置对象被 `Object.freeze`；新增 `config` getter、`updateSummaryModel()` 和只在配置应用队列内基于最新状态合成变更的 `#enqueueConfigurationPatch()`；`replacePairs()` 改为走该队列；删除已无调用方的 `replaceConfig()`。`runtime.ts` 不再持有启动配置副本，总结模型读写和摘要/简介均改为读 `currentManager.config`。
- 修改文件：`src/proxy/proxy-manager.ts`、`src/app/runtime.ts`、`test-node/app/runtime.test.ts`、`test-node/proxy/proxy-manager-apply.test.ts`、`docs/task-brief-design.md`。
- 前置任务与现状复核：无前置；先用 `[AI-01]` 装配测试复现，修复前 GET `/api/pairs` 在保存总结模型后返回 `Original`。
- 关键设计选择及理由：采用清单推荐的“由现有 manager 持有 + 排队的局部更新”，不新增配置服务；补丁在队列执行时读取 `#config`，因此并发交错的两次不相交写互不回退；无效补丁在入队前同步抛出，不提交也不暴露新配置。
- 实际验证命令与结果：`npm test -- test-node/app/runtime.test.ts -t "AI-01"` 先失败后通过；`npm test -- test-node/app/runtime.test.ts test-node/proxy/proxy-manager-apply.test.ts test-node/proxy/proxy-manager.test.ts test-node/admin/pairs.test.ts` → 33 通过；`npm run check` → 111 文件通过、1 跳过，963 通过、2 跳过，格式/lint/类型检查/构建均通过；`npx prettier --ignore-path .gitignore --check docs/task-brief-design.md docs/ai-development-optimization-todo.md` 通过。
- 新增测试：`test-node/app/runtime.test.ts` 1 项；`test-node/proxy/proxy-manager-apply.test.ts` 5 项（不动监听器的总结更新、队列合成不回退 pair 编辑、保存失败保留原值、无效模型不提交、提交后的配置不可写）。
- UI 截图/性能：不适用，未改 UI。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过；用 `release/win-unpacked/LLM Proxy.exe` + 临时配置/临时数据目录/空闲端口实验：PUT pairs 改名、PUT 总结模型后 GET `/api/pairs` 为 `edited-name`，GET 总结模型为 `summarizer`，落盘两处均为新值，退出码 0。
- 与清单的偏差：无。
- 提交 SHA：1a7300f

### AI-02 完成记录

- 状态：已完成
- 实际变更：`LogQueryService.usageStatisticsService()` 不再在创建时冻结目录列表，行读取在每次查询时解析根目录；返回值从 `UsageStatisticsService | undefined` 改为总是提供。新增 `#configuredRoots()`，把文件里 16 处内联的“去重 + 丢弃空字符串”写法收敛为一个入口，导出和清理也从原始列表改为该入口。`runtime.ts` 只创建一个 `LogQueryService`，同时提供日志视图和统计服务，不再用条件展开决定统计路由是否存在。
- 修改文件：`src/maintenance/log-query-service.ts`、`src/app/runtime.ts`、`test-node/maintenance/log-query-service.test.ts`、`test-node/app/runtime.test.ts`、`test-node/admin/api-contract.test.ts`。
- 前置任务与现状复核：AI-01 已完成；先确认 `usageStatisticsService()` 在创建时就 `const roots = [...new Set(...)]`，因此新目录不可见、旧目录仍被读取。
- 关键设计选择及理由：根目录解析点下移到查询边界，而不是缓存后再手动失效，避开失效链不一致；`#configuredRoots()` 保留原有语义（丢弃空字符串、去重），对 manager 已去重的生产配置是无操作，只在测试和脚本传入含空值/重复的列表时起作用。
- 实际验证命令与结果：`npm test -- test-node/app/runtime.test.ts test-node/maintenance/log-query-service.test.ts test-node/admin/api-contract.test.ts` → 35 通过；`npm run check` 首轮因 lint 捕获 `Object.keys(await response.json())` 的 unsafe any 两处，修正后复跑：格式/lint/类型检查/构建通过，测试 966 通过、2 跳过，但 `test-node/proxy/proxy-listener.test.ts` 压缩 SSE 用例在全量并发下 `decode_window_ms` 为 5.15 ms，低于 20 ms 断言；单独重跑 `npm test -- test-node/proxy/proxy-listener.test.ts` → 32 通过。与 §3 记录的时序脆弱现象一致，不是本项引入的回归，留给 AI-14。
- 新增测试：maintenance 2 项（每次查询重新解析根目录、去重与移除后不重建旧库文件；无根目录时 overview/trend/rows 返回空结构）；runtime 1 项（空配置下四个统计接口 200 空结果，提交新日志根后列表与统计同时移动，清空后不再读取或重建已移除目录）；api-contract 1 项（空配置仍注册统计路由且顶层键与空库一致）。
- UI 截图/性能：未改 UI；统计页在空配置下从 404 变为空结果，现有 UI 测试使用 stub 服务，不受影响。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过；用 unpacked exe + 临时配置/临时数据目录/空闲端口实验：无日志根时 overview/options/logs 均为 200 空结果；提交新日志根后新目录出现 `traffic.db`（4096 字节）、历史列表出现该任务、统计计入 `unpriced.no_matching_price = 1`；清空 `pairs` 后统计与列表回到空结果，退出码 0。
- 与清单的偏差：无。未计价请求计入 `unpriced` 而不计入 `requests`，这是现有口径，本项未改变。
- 提交 SHA：885b3aa

### AI-03 完成记录

- 状态：已完成
- 实际变更：`database.ts` 导出 `DATABASE_MIGRATIONS`（冻结的 1–13 有序列表）和由它推导的 `CURRENT_SCHEMA_VERSION`，`connectLogDatabase` 改为使用这份列表；持久化 barrel 改为导出这两项，删掉 11 行逐迁移再导出（含指向 v8 的 `SCHEMA_VERSION`）；schema-v4 到 v8 里五个无人使用的 `SCHEMA_VERSION` 别名删除。全仓搜索确认除定义处外没有其它引用。
- 修改文件：`src/persistence/database.ts`、`src/persistence/index.ts`、`src/persistence/schema-v4.ts`、`schema-v5.ts`、`schema-v6.ts`、`schema-v7.ts`、`schema-v8.ts`、`test-node/persistence/database.test.ts`。
- 前置任务与现状复核：无前置；修复前 barrel 导出的版本为 8，而 `connectLogDatabase` 已能迁移到 13。
- 关键设计选择及理由：版本从迁移列表推导，使两者不可能分开漂移；测试同时把 `CURRENT_SCHEMA_VERSION` 钉为 13 并钉住版本序列，避免全部断言都从同一个错常量推导。
- 实际验证命令与结果：`npm test -- test-node/persistence` → 7 文件 55 通过；`npm run check` → 格式/lint/类型检查/构建通过，测试 969 通过、2 跳过（本次全量运行 SSE 用例未出现 §3 的时序失败）。
- 新增测试：2 项（版本序列严格为 1..13 且不重复；公共导出版本与新库、备份恢复库报告的版本一致）。
- UI 截图/性能：不适用。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过；用 unpacked exe + 临时配置/临时数据目录/空闲端口实验，日志接口 200，退出码 0；用 Python 标准库 sqlite3 读该次运行新建的 `traffic.db`：`schema_version` 为 13，表数量 15。
- 与清单的偏差：无。未新增数据库迁移。
- 提交 SHA：52f0075

### AI-04 完成记录

- 状态：已完成
- 实际变更：新增 `docs/current-architecture.md`，以八个主题组织：运行模型、启动路径、配置归属、关闭顺序、模块地图、依赖方向、验证入口、材料身份；只写怎么运行、谁持有配置、去哪验证，不复制历史文档细节。`docs/module-design.md` 第 1 节改成小节状态表并把现行入口链接放在最前；第 2、3、6 节标题加“Python 基线（历史记录）”限定，并把“当前系统是…”改成 v0.3.0 之前的描述；第 7 节标为切换前的设计；第 6.3 中与现行行为矛盾的结论改成“Python 基线…，Node 版本…”并链到 ADR-004、ADR-011；第 10 节的 8 条待决问题换成结论与 ADR 对应表，并补上切换后新增的 ADR-011～013；“数据库 schema version 为 1”补上现行来源 `CURRENT_SCHEMA_VERSION`。`docs/software-functional-specification.md` 第 1 节加一段身份说明，明确未加版本限定的“当前实现”指 Python 基线。README.md 与 README.en.md 各加一句指向现行入口；AGENTS.md 顶部加一条同样的导航。
- 修改文件：`docs/current-architecture.md`（新增）、`docs/module-design.md`、`docs/software-functional-specification.md`、`README.md`、`README.en.md`、`AGENTS.md`、`test-node/docs/architecture-entry.test.ts`（新增）。
- 前置任务与现状复核：AI-01、AI-02、AI-03 已完成。修复前 `docs/module-design.md` 第 2、6 节把 Python 多线程模型称为“当前”，第 6.3 仍写“配置替换过程中没有整体事务和运行时回滚”（与 ADR-004、ADR-011 相反），第 10 节把 8 个已有 ADR 的问题列为待决；README 与 AGENTS.md 没有指向任何现行架构入口。
- 关键设计选择及理由：不重写历史文档，只加身份标签和回链，保留迁移过程与决策依据；新文档只回答“现在怎么跑、配置归谁、去哪验证”。模块地图里的文件名逐个用目录列表核对，依赖环按实测的 6 个节点书写，计价语义按代码里的 `freezeRequestPricing` 而不是旧设计目标改写。
- 实际验证命令与结果：V-D `npx prettier --ignore-path .gitignore --check docs/current-architecture.md` → 通过；`npm test -- test-node/docs` → 10 文件 24 通过（含 `no-stale-python-commands`、`node-only-repository`、`readme` 6 项）；`npm run check` → 格式/lint/类型检查/构建通过，测试 972 通过、2 跳过，测试文件 112；本次全量运行未出现 §3 的 SSE 时序失败。
- 新增测试：3 项（现行入口覆盖八个主题；入口的相对链接都指向存在的文件；`module-design.md` 回链到现行入口且相对链接都存在）。结构校验只查主题与链接，不给每句文字写测试。
- UI 截图/性能：不适用，未改 UI。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过；unpacked exe + 临时配置/临时数据目录/空闲端口：health 就绪，`/api/usage-statistics/overview?from&to` 返回 200 且顶层键为 `dataVersion,totals,byTarget,byModel,unpriced`，`/api/usage-statistics/trend` 200，`/api/logs?limit=5` 200 且 `total` 为 0，写退出文件后退出码 0。首轮冒烟把路径写成 `/api/statistics/overview` 收到 404，真实路径是 `/api/usage-statistics/overview`，不是回归。
- 与清单的偏差：`docs/module-design.md` 与 `docs/software-functional-specification.md` 未做全文件 Prettier 重排。`.prettierignore` 把 `docs/`、`README.md`、`README.en.md` 排除在 `npm run format:check` 之外，对这两份既有文档整文件重排会产生 192 行和 144 行纯空白差异，掩盖本次真正的内容改动。因此 V-D 只对新增文档用显式 ignore-path 检查，历史文档保持原有表格风格；是否统一历史文档风格留给 AI-24 决定。
- 提交 SHA：0c2ed10

### AI-05 完成记录

- 状态：已完成
- 实际变更：`src/shared/errors.ts` 的 `ApplicationErrorCode` 增加 `storage_error` 并新增 `storageError()`（保留 `cause`，`expose` 为 false，状态 500），`upstreamError()` 现在可带 `details`。`log-query-service.ts` 把四类失败写成带 code 的 `ApplicationError`：重复生成用 `conflict`，任务不存在用 `notFound`，模型返回非 2xx、空内容、非法 JSON、过大响应和连不上上游用 `upstream_error`（消息是固定句子，上游原文只留在 `cause`），存不下用 `storageError`；构造函数新增可选 logger，读失败和写失败各记一条带 `phase`、关联 ID、`log_root`、`error_type`、`cause_type` 的 warn；`saveSummary()` 先确认该目录真的有这条记录再写，写失败不再静默返回。`routes/logs.ts` 不再用 `message.includes` 选择状态，改为按 `error.code` 映射，并新增可选 logger：只有未分类错误才记 warn。`runtime.ts` 的“未配置总结模型”改为 `expose` 的 `ApplicationError`。`traffic-log-service.ts` 的写入失败 warn 从只有 `error_type` 改为带阶段、事件、record ID、task ID 和日志目录。
- 修改文件：`src/shared/errors.ts`、`src/shared/index.ts`、`src/maintenance/log-query-service.ts`、`src/admin/routes/logs.ts`、`src/admin/admin-server.ts`、`src/app/runtime.ts`、`src/logging/traffic-log-service.ts`、`test-node/admin/errors.test.ts`、`test-node/admin/logs.test.ts`、`test-node/logging/traffic-log-service.test.ts`、`test-node/maintenance/log-query-service.test.ts`。
- 前置任务与现状复核：无前置。修复前 `routes/logs.ts` 用 `message.includes("already in progress")` 和 `message.includes("Log group not found.")` 选择 409/404/502；服务里四处抛普通 `Error`；写入失败只记 `error_type`；`saveSummary` 和 `#saveTaskBrief` 吞掉所有目录的异常，前者还会让调用方以为摘要已保存。
- 关键设计选择及理由：分类靠 `code` 而不是消息文本，改文案不会改状态；面向用户的消息由本项目写定，不含上游正文或密钥，上游原文只留在 `cause`；预期的“该目录没有这条记录或任务”靠存在性检查跳过且不记日志，真正的异常才记。日志只存错误类型名，不存错误原文，避免把私有路径写进日志。
- 实际验证命令与结果：`npm test -- test-node/logging test-node/maintenance test-node/admin test-node/app` → 24 文件 165 通过；`npm run check` → 格式/lint/类型检查/构建通过，测试 991 通过、2 跳过，测试文件 112；本次全量运行未出现 §3 的 SSE 时序失败。首轮 `npm run check` 报过 3 个 lint 错误（`= undefined` 默认参数、不必要的 `String()` 转换）和 3 个类型错误（asymmetric matcher 带来的 `any`），均已改写而不是关闭规则。
- 新增测试：maintenance 8 项（缺任务→`not_found`；上游非 2xx→状态可读且不泄露密钥；连不上上游→`cause` 保留；同任务重复生成→`conflict`；摘要存不下→报存储失败并记阶段；简报存不下→记 `task_brief_save` 与目录；不持有记录的目录不产生日志；读失败记阶段与目录）。admin 11 项（errors 3 项：分类映射、改文案不改状态、不暴露未 `expose` 的消息与存储细节；logs 8 项：409/404/502/500 映射、不泄露密钥与私有路径、未预期错误记一条 warn、已分类错误不再重复记录）。logging 重写 1 项：写入失败日志带阶段、事件、record ID、task ID 与目录，且不含请求正文里的密钥。
- UI 截图/性能：不适用，未改 UI。简报与摘要的错误提示由 UI 直接展示 `error.message`，现行文案仍是可理解的短句。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过；unpacked exe + 临时配置/临时数据目录/空闲端口：先向已关闭的上游发一次真实代理请求得到 502 并生成任务，再配置指向已关闭端口的总结模型。未配置模型时 POST 简报返回 502 `task_brief_failed` 与“Summary model is not configured.”（与 `runtime.test.ts` 钉住的结论一致）；模型连不上时返回 502 `task_brief_failed` 与“The summary model could not be reached.”，响应不含 `sk-live-secret`；代理请求仍返回 502；写退出文件后退出码 0。存储与写入失败的阶段诊断由单元注入验证，打包实例无法安全注入。
- 与清单的偏差：两处对外行为改变，均为有意。一、摘要或简报存不下时现在返回 500 `storage_failed`，不再静默成功；二、未预期的内部错误不再把原始异常文本回给浏览器，改为固定短句并在服务端记一条 warn。管理员代码 `storage_failed` 是新增值。日志写入失败仍只记日志、不影响代理响应（`traffic-log-service` 的隔离用例未改）。
- 提交 SHA：8c6adb9

### AI-06 完成记录

- 状态：已完成
- 实际变更：新增 `src/proxy/traffic-event.ts`：`TRAFFIC_EVENT_NAMES` 与 `TrafficEventName` 把生命周期名称钉成三字面量联合，`TrafficEventCore` + 三个变体（received 与 pending 的 `response` 只能是 `undefined`，finished 必须有）描述一条请求的三个状态，`receivedEvent()`、`pendingResponseEvent()`、`finishedEvent()` 成为唯一的构造入口；`TrafficRequestDraft` 描述 pipeline 手里尚未成形的记录，`target`、`request`、`model_route` 可写以便 failover 就地改写。新增 `src/logging/traffic-record-write.ts`：`TrafficRecordWrite` 和 `TrafficTaskWrite` 按名称列出 repository 真正读取的列，`id`、`task_id`、`event`、`sequence` 等必填。`proxy-request-pipeline.ts` 删掉 `eventRecord()` 辅助和 `isRecord` 探测，改用三个 builder 与带类型的 draft/route；`TrafficLogWriter` 的参数从 `Readonly<RepositoryRecord>` 改为 `Readonly<TrafficRecordEvent>`。`redaction.ts` 的 `redactRecord()`（对字符串字典做深拷贝）删除，改为 `redactEvent()` 按 `event` 分支处理，`redactHeaders()` 只接受 `Readonly<Record<string, readonly string[]>>`，`redactBody()` 只在 `"base64" in body` 时才清 base64。`traffic-log-service.ts` 删除 `mapping()`、`stringValue()`、`listValue()`、`bodyValue()` 四个从字典里取值的辅助，直接读带类型字段并产出 `TrafficRecordWrite`；任务 ID 不再从 `task["id"]` 试探。`task-matcher.ts` 删除 `recordRequestPath()`、`requestHeaders()`，`TaskAssignment.task` 为 `Readonly<TrafficTaskWrite>`，三个任务构造函数显式带 `id`。两个 barrel 导出新类型。
- 修改文件：`src/proxy/traffic-event.ts`（新增）、`src/logging/traffic-record-write.ts`（新增）、`src/proxy/redaction.ts`、`src/proxy/index.ts`、`src/proxy/proxy-request-pipeline.ts`、`src/logging/traffic-log-service.ts`、`src/logging/task-matcher.ts`、`src/logging/index.ts`、`test-node/proxy/traffic-event-types.test.ts`（新增）、`test-node/proxy/redaction.test.ts`、`test-node/proxy/proxy-listener.test.ts`、`test-node/logging/task-matcher.test.ts`、`test-node/logging/task-identity-boundary.test.ts`、`test-node/logging/traffic-log-service.test.ts`。
- 前置任务与现状复核：无前置。修复前 `TrafficLogWriter` 的签名是 `write(record: Readonly<RepositoryRecord>)`，而 `RepositoryRecord` 就是 `Record<string, unknown>`；pipeline 用一个 `eventRecord()` 辅助把字段塞进字典，failover 之后靠 `isRecord(record["request"])` 再改写；matcher 用 `record["request"]`、`record["body"]` 逐层试探，任务 ID 缺失时到运行期才抛错；redaction 对整个字典做 `structuredClone` 并按 `["request","response"]` 两个键名遍历。
- 关键设计选择及理由：三个状态共用一个 `TrafficEventCore`，只有 `event` 和 `response` 的有无不同，因此拼错状态或漏填必要字段在编译期就失败；builder 是唯一构造路径，pipeline 不能再自造记录形状。为同时满足 eslint 的 `consistent-type-definitions` 和 `consistent-indexed-object-style`，形状写成 `interface` 再与 `Record<string, unknown>` 交叉，历史与导入回退用的 `prompt_cache_key`、`client_metadata` 仍可读，而新代码不再需要 `isRecord` 探测。`exactOptionalPropertyTypes` 下所有可选属性写成 `?: T | undefined`，否则 spread 旧行的任务写入无法通过。header 一律是 `readonly string[]`，与 HTTP 实际到达的形状一致，也避免大小写两种形状在库里混用。上游与外部模型仍是 `unknown`（`TrafficRecordWrite.request_body`、`response_body`、`model_route` 都是 `unknown`），本项目自有字段才是具体类型。
- 实际验证命令与结果：首轮类型化后 `npx tsc -p tsconfig.json --noEmit` 报 48 处错误，全部在测试 fixture（`exactOptionalPropertyTypes`、header 标量写成字符串、`base64` 必填缺失、`redactRecord` 已删），逐个改 fixture 与断言而不是放宽类型；修完后 `npx tsc -p tsconfig.json --noEmit` 与 `npx tsc -p tsconfig.ui.json --noEmit` 退出码均为 0。`npm run lint` 首轮 47 处、第二轮 35 处（index signature/type 别名两条规则冲突、`["id"]` 点号写法、不必要的 `=== true` 与 `??`），改为 interface + `Record` 交叉、点号访问和直接布尔判断后为 0。`npm test -- test-node/logging test-node/proxy test-node/persistence` → 41 文件 515 通过；`npm run check` → 格式/lint/类型检查/构建通过，测试文件 113 通过、1 跳过，测试 999 通过、2 跳过，本次全量运行未出现 §3 的 SSE 时序失败。打包后 `npm rebuild better-sqlite3` 再用真实查询证明 Node ABI 已恢复（`require` 本身证明不了），重跑 `npm test -- test-node/logging test-node/proxy test-node/persistence test-node/docs` → 51 文件 539 通过。恢复 Node ABI 后再跑两轮全量 `npm run check`：第一轮 `test-node/proxy/proxy-listener.test.ts` 的一个用例以 `listen ENOBUFS: no buffer space available 127.0.0.1` 失败——不是断言失败，是并发下系统套接字资源耗尽，单独重跑该文件 32 项通过；第二轮 113 文件通过、1 跳过，999 通过、2 跳过。该现象与 §3 的 SSE 时序失败不是同一件事，属于并发资源耗尽，留给 AI-14、AI-20 一并处理。
- 新增测试：`test-node/proxy/traffic-event-types.test.ts` 7 项（生命周期名称恰为三个；拼错状态、缺 client、`duration_ms` 写成文本三种情况用 `@ts-expect-error` 钉住——指令失效即构建失败；无状态行的 `status: null` 仍可读；`body` 与 `upstream_body` 分别是客户端原文和转发版本；计价快照与 `cost_nano_cny` 随记录携带）。`test-node/proxy/redaction.test.ts` 重写为 4 项，其中 2 项 `[AI-06]`：脱敏只改深拷贝副本，原记录仍保留凭据与字节，且副本与原记录不共享任何对象；正文不是 JSON 时保持原样。另更新 4 个日志测试文件的 fixture：header 改为数组、`body_pending` 与 `base64` 补齐、`model_route` 用真实键名 `requested_model`/`upstream_model`。
- UI 截图、性能：不适用，未改 UI。日志写入路径未增加拷贝或序列化，单条记录的写入仍是一次 upsert。
- 便携版构建与冒烟：`npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 通过（`building target=portable file=release\LLM-Proxy-0.4.10-x64-portable.exe`）。用 unpacked exe + 临时应用配置（只含 `admin.port`）+ 临时 pairs 文件（成员用绝对 `log_root`）+ 全新 `LLM_PROXY_DATA_DIR` + 三个空闲端口，另在本机起一个固定回退上游：一次真实 POST 得到 200 与 `resp-ai06-smoke`；`/api/logs` 的 `total` 为 1；`/api/log-groups/:id/logs` 返回该记录；`/api/logs/:id` 的 `request_meta` 含 `task_id`、`sequence: 1`、`duration_ms: 15.9`、`model_route: {"requested_model":"gpt-5","target_id":"fixture","target_name":"Fixture"}`，header 全为数组且 `Authorization` 为 `["[redacted]"]`，`response_meta` 含 `status: 200`、输入输出 token 与 `decode_window_ms`，`pricing` 为 `unpriced`/`no_matching_price`；统计 overview 顶层键仍为 `dataVersion,totals,byTarget,byModel,unpriced` 且 `unpriced.no_matching_price = 1`。写退出文件后退出码 0。用 Python 标准库 sqlite3 读该次运行的 `traffic.db`：`event` 为 `request_finished`，`task_id` 非空，`request_headers_json` 值是数组，`model_route_json` 为带类型键名，`schema_version` 为 13；`tasks` 表里该任务的 `match_strategy_version` 为 6、`anchor` 为 `req-f5c21ce13af7`。
- 与本清单的偏差：一、过程中先加了一个 `redactUnknownHeaders()` 供未脱敏的字典行使用，全仓搜索确认无调用方后删除，避免留下无人使用的出口。二、`TrafficRecordEvent`、`TrafficRecordWrite` 仍保留 `Record<string, unknown>` 的一半，历史与导入回退的键因此仍走字典，本轮只收口本项目自有字段，不等于清单里“消除全部任意 JSON”。三、统计 overview 的 `totals` 只计已计价请求，未计价只进 `unpriced`，这是 AI-02 已记录的现有口径，本项未改。
- 提交 SHA：f47b7dd

### AI-07 完成记录

- 状态：已完成
- 实际变更：`src/maintenance/log-query-service.ts` 新增并导出 `LogPricingStatus`、`LogRecordPricing`、`HistorySummaryFields`/`HistorySummary`，并加两个边界：`parseSummaryPayload()`（总结模型原始文本 → 可入库摘要，只校验“必须是对象且 `segments` 是数组”，其余键一律原样保留，围栏 JSON 照收）和 `taskBriefFromRow()`（`task_briefs` 行 → 简介模型，读写共用同一转换）。`summarizeRecord()` 从 `Promise<unknown>` 改为 `Promise<HistorySummary | undefined>`，`getSummary()` 从 `unknown` 改为 `HistorySummary | undefined`，`LogRecordDetail.pricing` 从可选 `unknown` 改为必填 `LogRecordPricing | null`，并补上早已存在却从未进类型的 `decode_window_ms`。`usage-statistics-service.ts` 把 `totals`/`byTarget`/`byModel`/`points`/`unpriced` 从字典收成五个具名模型，并用 `StatisticsAccumulator` 取代六处 `ReturnType<typeof empty>`。`admin-contracts.ts` 的 `LogAdminService` 逐项改为具体返回类型，三份目标探测的请求/响应定义改为从 `src/proxy/index.js` 重新导出并删掉本文件的第二份定义。`routes/logs.ts` 新增 `absentAsNull()` 作为“服务模型 → 响应”的唯一转换点，`listRecordsByIds` 去掉 `?? { records: [] }` 补偿，POST 摘要对任何日志目录都不持有的记录改为显式 `404 record_not_found` 分支；`routes/statistics.ts` 引用服务导出的 `StatisticsMetric`/`UsageStatisticsBreakdown`，CSV 由 `p["bucket"]` 字典试探改为点号读取。
- 修改文件与新增入口：`src/maintenance/log-query-service.ts`、`src/maintenance/usage-statistics-service.ts`、`src/maintenance/index.ts`、`src/admin/admin-contracts.ts`、`src/admin/routes/logs.ts`、`src/admin/routes/statistics.ts`、`test-node/admin/logs.test.ts`、`test-node/admin/api-contract.test.ts`、`test-node/maintenance/log-query-service.test.ts`、`test-node/statistics/usage-statistics-service.test.ts`、`test-node/statistics/statistics-benchmark.test.ts`、`test-node/ui/admin-ui-fixture.ts`、`test-node/ui/admin-ui-server.ts`；新增 `test-node/admin/log-service-fixtures.ts`（10 个带类型的 fixture 构造器，取代 9 份手写空页字面量）与 `test-node/admin/admin-contract-types.test.ts`（编译期契约钉）。`src/app/runtime.ts` 未改：类型化后的契约与真实装配完全吻合。
- 前置任务与现状复核：AI-05、AI-06 已完成，本项在其成果之上进行，未触碰 `src/proxy/**`、`src/logging/**`、`src/persistence/**`。动手前逐条复核：`summarizeRecord`/`getSummary` 写着 `unknown`，`LogRecordDetail.pricing?: unknown`，`admin-contracts.ts` 与 `src/proxy` 各存一份目标探测类型，统计 `totals` 是 `Record<string, string | number>`，`api-contract.test.ts` 靠整份服务的 `as unknown as AdminServerOptions` 双重强转才能把桩交给 `createAdminServer`，`admin-ui-server.ts` 把“没有简介”答成 `null`。
- 关键设计选择及理由：摘要与计价保持“开放的一半”——`HistorySummary` 是声明字段与 `Record<string, unknown>` 的交叉，模型自己多写的键（实测的 `model_note`）必须原样读回，所以 `parseSummaryPayload()` 只拒绝“不是对象”和“`segments` 不是数组”。项目自有模型写成 `interface`，需要容纳外部键时才交叉，以避开 `consistent-type-definitions` 与 `consistent-indexed-object-style` 互相矛盾的两条规则，一律由 `npm run lint` 判定。缺失态在服务端是 `undefined`、在浏览器是 `null`，转换只写在 `absentAsNull()` 一处，于是“没存过”（200 + `null`）与“不存在”（带 code 的 404）对浏览器永远不同形，也不再由 `result ?? reply.code(404)` 一个表达式混两种语义。契约用 `@ts-expect-error` 钉在编译期：指令失效即构建失败，把签名放宽回 `unknown` 会先炸门禁。批量读恒返回记录页，空态由模型自己表达而不是用补偿掩盖契约缺失。
- 实际验证命令、结果与日志：委派方在其 worktree 内跑过 `npm run typecheck`、`npm run lint`、`npx prettier --check .` 与分组测试。编排方独立复核（不看委派方结论，只重跑）：`npm run typecheck` 0 错误、`npm run lint` 0、`npx prettier --check .` 0；`npm test -- test-node/maintenance test-node/statistics test-node/admin` → 20 文件 146 通过；`npm test -- test-node/app test-node/docs test-node/config` → 19 文件 134 通过；`npm test -- test-node/ui` → 5 通过 1 跳过、93 通过 2 跳过。合并到 main 后全量 `npm run check` → 格式/lint/类型检查/`check:modules`/测试/构建全部退出码 0，测试文件 116 通过 1 跳过（117），测试 1027 通过 2 跳过（1029）；与 AI-06 基线 114 文件 999 测试逐项对账：+2 文件 +16 用例（AI-07）与 +2 文件 +12 用例（AI-10）刚好对上，`analysis.test.ts` 的用例是从 `records.test.ts` 平移而非新增，总数不变，可证明没有用例被悄悄删掉。委派方首轮全量 `npm test -- test-node/ui` 出现的 8 个 `Target page, context or browser has been closed` 失败，编排方单独重跑该文件 11 通过、合并后再跑整目录仍全绿，确认是并发资源抖动而非回归，未放宽任何断言。
- 新增与更新的测试及任务 ID：`test-node/admin/admin-contract-types.test.ts` 10 项（1 项正向编译、8 项 `@ts-expect-error` 拒绝：缺 `listGroups`、摘要写成原始文本、简介正文改名 `brief_text`、`listRecordsByIds` 返回 `undefined`、任务计价写成数字、序列写成单个对象、缺 `pricing` 块，外加模型自造键的括号读与三种缺失态均答 `undefined`）；`test-node/maintenance/log-query-service.test.ts` 30 → 33（原样入库读回、围栏 JSON 入库、两种非法回答各以 `upstream_error` 失败且什么都不入库）；`test-node/admin/logs.test.ts` 17 → 20（存过的摘要逐字段原样答出与没存过答 `null`、存过与没存过的简介、服务不持有该记录时 POST 答 404 `record_not_found`）。均标 `[AI-07]`。
- UI 截图、性能或迁移结果：本项不改任何 UI 源码，也不改用户可见数据。但编排方在合并后跑 `npm run regen:ui-baselines` 时 6 张基线的字节与哈希全部变动，文档哈希表随之改写，因此不能按“没改 UI”一笔带过。按 ui-baseline-regen 的对拍方法判定：`pixelmatch`（阈值 0.1）测得 `ui_stats_cn/en` 与 `ui_task_detail_cn/en` 差异 0 像素；`ui_logs_cn/en` 相对已提交基线差 231/249 像素（0.014 %，远低于 0.12 断言阈值，正是该 skill 警告的“断言过但基线图仍是旧样子”）。再用同一条捕获命令分别在改动前后源码上各捕获一次：中文页差异 0 像素，且两次运行字节完全相同；提交时 PNG 与提交时文档哈希表六对六完全一致。结论是本地环境与捕获环境漂移（编码器元数据 + 已提交基线采自另一环境），不是本次任务的视觉变化，故把 6 张 PNG 与哈希表 `git checkout` 还原，不往历史里塞虚假的“UI 变了”差分。无迁移：`CURRENT_SCHEMA_VERSION` 仍为 13，新建库仍报 13、15 张表。
- 便携版构建与冒烟结果：合并后 `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` 三步退出码 0，产物 `release\LLM-Proxy-0.4.10-x64-portable.exe`（111,671,780 字节）。隔离冒烟（临时配置 `admin.host`+`admin.port`、绝对 `log_root`、全新 `LLM_PROXY_DATA_DIR`、管理 39411/代理 39412/夹具 39413、删掉 `ELECTRON_RUN_AS_NODE`）21 项检查全通过：真实代理请求 200；`/api/logs` `total=1`；记录详情顶层键 `id,pending,request,response,pricing,decode_window_ms,request_meta,response_meta`，`request_meta.headers` 的 `authorization` 为 `["[redacted]"]` 且整个响应不含夹具密钥；带类型计价块 `unpriced/no_matching_price/cost_nano_cny:null`；摘要与简介未生成时均为 200 + `null`；生成后逐字节原样读回且模型自造的 `model_note` 存活；不存在的记录 GET 答 200 + `null`、POST 答 404 `record_not_found`；不存在的分组答 404 `log_group_not_found`；统计 overview/trend/CSV 顶层键与口径未变；写退出文件后退出码 0。
- 与本清单的偏差、剩余事项：一、三处有意收紧——行里的 `pricing` 不是对象时详情答 `null`；库里 `summary_json` 不是对象时视为“没有摘要”；POST 摘要的 404 分支改为 `return await reply`（已先用 Fastify inject 证明状态码与正文不变）。二、`LogRecordPricing`、请求/响应正文与两个 meta 仍是 `unknown`/`Record<string, unknown>`，外部与历史 JSON 故意不在此收口，本项不等于“消除全部任意 JSON”。三、`HistorySummaryFields` 的声明字段是 `?: unknown`，模型可省略其中任何一个。四、任务计价与三类序列直接指向持久层模型，换成项目自有 DTO 是 AI-08 的范围。五、编排方层面的偏差（有意）：两条 lane 只跑聚焦 V-B 而不跑 `npm run check`——本仓历史记录里两个全量 Vitest 并发已造成 `listen ENOBUFS`，全量由编排方在合并后跑一次；每项 lane 各自完成 V-P 与隔离冒烟作为单项证据，合并后再跑一次作为交付门禁。
- 提交 SHA：57ebd90

### AI-10 完成记录

- 状态：已完成
- 实际变更：协议语义从 `src/proxy/records.ts` 迁出到新叶模块 `src/proxy/protocol/analysis.ts`（端点分类、请求消息计数、指纹、用户消息抽取、响应 id 提取、稳定哈希、Codex 固定上下文识别），`records.ts` 只剩响应 token 记账；`task-identity.ts`、`payload.ts`、`streams.ts` 用 `git mv` 移入 `src/proxy/protocol/`。`src/logging/task-matcher.ts`、`traffic-log-service.ts`、`traffic-record-write.ts` 不再从 `../proxy/index.js` 取运行时，改为直接导入具体叶模块，类型改从 `traffic-event.ts`、`response-log-capture.ts` 取。`src/proxy/index.ts` 的导出名一个没删、一个没改，只是改从 `./protocol/*` 再导出，所以 domain 外部（`src/app/runtime.ts`、`src/admin/**`、`test-node/admin/**`、`scripts/proxy_benchmark.ts`）一字未动。新增 AST 检查器 `scripts/module-edges.ts` + `scripts/check-module-edges.ts` 与 npm 脚本 `check:modules`，并插入 `check` 的 typecheck 与 test 之间。`isPythonTruthy` 只留一份并导出，两条路径共用，避免边界值分叉。
- 修改文件与新增入口：新增 `src/proxy/protocol/analysis.ts`（协议分析，transport 与存储共用）、`src/proxy/protocol/task-identity.ts`、`src/proxy/protocol/payload.ts`、`src/proxy/protocol/streams.ts`（三者为平移）、`scripts/module-edges.ts`（TypeScript AST 建运行时模块图、Tarjan 求 SCC 后枚举环、检查 transport 运行时包含与领域方向表）、`scripts/check-module-edges.ts`（命令行入口，`--closure <模块>` 打印运行时闭包）、`test-node/logging/module-boundaries.test.ts`（检查器自身的 12 项测试）、`test-node/proxy/analysis.test.ts`（从 `records.test.ts` 拆出的协议用例）。修改 `src/proxy/index.ts`、`records.ts`、`load-affinity.ts`、`load-balancer.ts`、`proxy-request-pipeline.ts`、`redaction.ts`、`response-log-capture.ts`、`traffic-event.ts`、`src/logging/task-matcher.ts`、`traffic-log-service.ts`、`traffic-record-write.ts`、四个 proxy 测试文件的导入路径、`package.json`、`docs/current-architecture.md`、`docs/refactoring/typescript-module-conventions.md`。
- 前置任务与现状复核：前置 AI-06 已完成。`src/proxy/traffic-event.ts` 与 `src/logging/traffic-record-write.ts` 的类型和 `test-node/proxy/traffic-event-types.test.ts` 的 7 项测试原样保留（前者只改一行 `BytePayload` 导入路径）。编排方在 HEAD `535740e` 上用 TypeScript AST 独立复算（把 `.js` 说明符映射到 `.ts` 与目录 `index.ts`、排除纯类型边）：`src/` 226 条运行时边，两条运行时环为 `proxy/index.ts → proxy-runtime-registry.ts → logging/index.ts → task-matcher.ts → proxy/index.ts` 与 `… → traffic-log-service.ts → proxy/index.ts`，与清单第 3 节的六文件环一致。复核时撞上清单没写的那个陷阱：内部说明符写成 `.js` 而源文件是 `.ts`，不做映射的解析器在这里报 0 环——那是假阴性，检查器必须两种都处理。
- 关键设计选择及理由：叶模块区放在 `src/proxy/protocol/` 而不是新建顶层领域，因为新建要么改 `src/index.ts`（不属本项所有权）要么让 proxy barrel 跨领域再导出，保持出口形状不变代价最小、也最不容易和后续任务的写者冲突。`records.ts` 保留原路径与原名字，因为 `src/persistence/schema-v5.ts` 仍按 `../proxy/records.js` 取 `responseTokenCounts`。检查器的核心规则是“运行时闭包”而不是目录名：`src/logging` 导入 `src/proxy/protocol/analysis.js` 仍是跨目录导入，但闭包里没有 listener/manager/registry/pipeline，所以合法；导入 `src/proxy/index.ts` 时闭包立刻包含 registry，于是报出 `task-matcher → proxy/index → proxy-runtime-registry` 这条链——这正是清单第二条要防的东西，且新增一个 manager 会自动落进闭包，不需要维护手工名单。transport 根只列 listener、manager、registry、pipeline 四个，控制面与装配根允许持有运行时。领域方向表照抄现行约定文档，把写着的规则变成可执行的而不是另发明一套。只扫 `src/**` 和 `electron/**`，因为约定允许测试直接导入领域内部，把 `test-node/` 纳入会把夹具的正常导入报成违规。
- 实际验证命令、结果与日志：委派方在其 worktree 内报 `npm test -- test-node/logging test-node/proxy` 36 文件 472 通过、`typecheck`/`lint`/`prettier` 退出码 0、检查器 `115 modules: 247 runtime edges, 73 type-only edges, runtime cycles: 0, boundary violations: 0`。编排方独立复核：`npm run check:modules` 同样 0 环 0 越界、`npm run typecheck` 0、`npm run lint` 0、`npx prettier --check .` 0、`npm test -- test-node/logging test-node/proxy` → 36 文件 472 通过。合并后全量 `npm run check` 里 `check:modules` 报 `115 modules: 247 runtime edges, 75 type-only edges / runtime cycles: 0; boundary violations: 0`（类型边由 73 变 75，是 AI-07 新增的契约类型边，与运行时结论无关）。检查器的有效性按清单要求证了两头：在还原到 `535740e` 的源码上退出码 1 并报 6 环 2 越界（清单列的两条环是同一强连通分量里的两条 4 模块环，其余是旋转），在本分支退出码 0；编排方另外用自己的命名样例（`src/logging/parent-review-sample.ts` 导入 `../proxy/index.js` 并从 logging barrel 再导出）跑出退出码 1、2 环 1 越界并打印三条依赖链，随后删除样例并还原 barrel。
- 新增/更新的测试及任务 ID：`test-node/logging/module-boundaries.test.ts` 12 项，分在 5 个 `[AI-10]` describe 组里（`.js` 映射陷阱本身、纯类型边不进图而值再导出进、副作用与动态 import 记边、报出六文件环并断言链文本、修好后的方向 0 环 0 越界、helper 经 barrel 拉运行时报 `transport-runtime-containment`、控制面可持有运行时、三种越界导入各报 `domain-direction`、`findRuntimeChain` 穿中间模块、签入树 0 环 0 越界、存储侧每条指向 proxy 的运行时边其目标闭包都不含 transport 根、任务身份 helper 独立加载）。`test-node/proxy/analysis.test.ts` 为平移用例，文本与断言均未改，因此不带 `[AI-10]` 标签；用例总数与断言均未删减。
- UI 截图、性能或迁移结果：不适用。未改 UI、未改统计口径、未新增迁移（schema 仍 13）。协议路径未动，响应字节、重复头、SSE 顺序、backpressure、取消、压缩透传由既有 `proxy-listener`/`response-decoder` 用例守着，本次只改了这些文件的 import 路径；日志写入失败仍不影响代理响应（隔离用例未改）。纯 helper 独立加载另用一次性 tsx 探针证实：只导入 `protocol/analysis.js` 与 `protocol/task-identity.js` 时进程没有加载任何 proxy 运行时文件，闭包只有 `src/shared/*` 与协议叶模块。
- 便携版构建与冒烟结果：单项 V-P 由委派方完成（三步退出码 0，产物 111,651,678 字节）并用真实代理请求 + `/api/logs` + 记录 meta + 统计顶层键 + `traffic.db` 做隔离冒烟。编排方在合并后的产物上重跑交付门禁并另验 portable 包装器：`release/LLM-Proxy-0.4.10-x64-portable.exe` 在清掉 `ELECTRON_RUN_AS_NODE` 后 5.0 秒健康，代理请求 200，`/api/logs` 200 且 `total=1`，该次运行的日志根里出现 `traffic.db`，写退出文件后退出码 0。`npm run smoke:artifact` 本身失败并报 `did not become healthy`——原因是该脚本把本 shell 的 `ELECTRON_RUN_AS_NODE=1` 原样传给子进程且从不清理，打包 exe 于是退化成纯 Node；按 packaging-smoke 这条已知陷阱判定为脚本缺陷而非产物回归，清理该环境变量属 AI-16 的范围，本次未改 `scripts/artifact_smoke.ts`。
- 与本清单的偏差、剩余事项：一、`src/logging → src/proxy` 这条跨目录边没有消失，只是每条都落在闭包不含 transport 运行时的叶模块上，清单第二条由检查器强制。二、三条现存跨领域运行时边保留且被判合法：`persistence → proxy/records.ts`、`pricing → proxy/target.js`、`pricing → proxy/routing.js`、`maintenance → proxy/target.js`；这些文件不属本项所有权，把工具下放到支撑领域是 AI-12/AI-13 的活。三、`src/proxy/records.ts` 文件名与内容现在不完全对称（名字是 records，内容是响应 token 记账），改名要动别人的文件，留给后续。四、`logging` 对 `proxy` 仍有纯类型依赖，运行时环按定义排除类型边，彻底挪到共享记录模型是后续任务的事。五、`npm run check` 现在多一步 `check:modules`，CI 会跑到它。六、`docs/current-architecture.md` §9 里 AI-05、AI-06～AI-09 在 HEAD 上就被列为未收口而实际已完成，本次只把 AI-10 移出，其余过时条目留给 AI-24。
- 提交 SHA：02b0ecd

### AI-15 完成记录

- 状态：已完成
- 实际变更：`tsconfig.json` 变成“全量类型检查、什么都不产出”的入口（加 `noEmit: true`，删掉 `rootDir`/`outDir`/`declaration`/`declarationMap`/`inlineSources`/`sourceMap`，`include` 仍是 src、electron、test-node、scripts 四个根）；新增 `tsconfig.build.json` 继承它、把 `include` 收窄到 src、electron、scripts，只把产品与打包工具编进 `dist-node`；`package.json` 只改 `build` 一行指向新配置，其余脚本名、文本、顺序一字未动（五个 `pre*` 钩子仍跑 `rebuild:node`，`check` 链路仍是 format:check → lint → typecheck → check:modules → test → build）；`electron-builder.yml` 的 `files` 从“glob + 取反”改为枚举三棵编译树加 `package.json`；`docs/current-architecture.md` 只改 §7 验证入口；新增 `test-node/docs/build-entry-configs.test.ts`（3 个 `[AI-15]` 用例，钉住“测试不是产品编译的隐式输入而全量检查仍看到它们”这条编译器自己看不见的不变量）。
- 修改文件与新增入口：`tsconfig.json`、`tsconfig.build.json`（新）、`package.json`、`electron-builder.yml`、`docs/current-architecture.md`、`test-node/docs/build-entry-configs.test.ts`（新），共 6 个。`src/**`、`src/admin/**`、`src/maintenance/**`、`test-node/admin/**`、`scripts/**`、`.github/**` 与本清单均未被触碰；`copy_static_assets.ts` 与 `create_cli_archive.ts` 不需要改路径（它们的 `dist-node/src` 目标在拆分后依然存在）。
- 前置任务与现状复核：无前置。动手前实测：产品 build 当时**确实**把 484 个测试文件编进 `dist-node/test-node`（`npm run build` exit 0、6.77 s、1,019 个产物），`electron-builder` 只做事后排除，所以 asar 里本来就没有测试实现——真正错的是“编译”，不是“打包”。
- 关键设计选择及理由：两套配置按用途命名，`tsconfig.build.json` 用 `extends` 使严格度只有一份来源，`npm run typecheck` 的命令文本保持不变、ESLint 的 `projectService` 仍能解析每个文件、编辑器仍经根 tsconfig 解析测试；工具继续编进 `dist-node/scripts`，因为九个 npm 脚本、CI、README、`run.bat` 与 skills 全指向那条路径，另起一个工具输出目录要把 `src` 重编一遍并改一大片面而收益为零；`files` 枚举而非 glob+取反，因为取反已经指向一条不存在的路径，枚举同时堵住“旧构建残留的 `dist-node/test-node` 被打进包”这条路；不在 `build` 里 `rm -rf dist-node`（那改的是构建语义，本项要求的只是“从干净输出验证”）；新测试放在 `test-node/docs/`（该家族钉 README、`run.bat`、CI、skills 等仓库入口）以避开另一 lane 正在改的 `test-node/admin/**`。
- 实际验证命令、结果与日志：lane 内基线与改后均由编排方独立复现：`typecheck`/`lint`/`check:modules` 全 exit 0，检查器报 115 模块 / 247 运行时边 / 75 类型边 / 0 环 / 0 越界（与基线数字一致）。编排方自己的探针（不是复用写者的）：在 `test-node/app/ai15-probe-parent.ts` 植入 `export const probe: string = 42;` → `npm run build` exit 0 且 0 条 `error TS`，`npm run typecheck` exit 2 并报 `TS2322 ... ai15-probe-parent.ts(1,14)`；删探针后 typecheck 回到 0。`npx tsc -p tsconfig.json --noEmit --listFiles` 按根计数 src 104 / electron 11 / test-node 122 / scripts 16 = **253**。合并后全量 `npm run check` exit 0 → 测试 117 文件通过 1 跳过（118）、1030 通过 2 跳过（1032），相对上一轮 116 文件 / 1027 用例恰好 +1 文件 +3 用例，对账证明没有用例被删。干净输出目录复验：`rm -rf dist-node && npm run build` exit 0、0 错误、535 个文件、只剩 `src`/`electron`/`scripts`、`dist-node/test-node` 不存在、`dist-node/scripts` 16 个工具 `.js`、`npm run smoke:database` exit 0。交付门禁复跑：`rebuild:electron` exit 0 → `electron-builder -w portable` exit 0 → `release\LLM-Proxy-0.4.10-x64-portable.exe` 111,654,817 字节；`npx asar list` 3,085 条 = `node_modules` 2,663 + `dist-node` 421 + `package.json` 1，其中 src 336 / electron 33 / scripts 48 个文件加 4 个目录条目 = 421，`dist-node\test-node` 与 `.test.js` 均 0 条，唯一的 “test-node” 字样是第三方 `node_modules\pump\test-node.js`；`dist-node\scripts\database_smoke.js` 确在包内。21 项隔离冒烟 0 失败（管理 39471 / 代理 39472 / 夹具 39473）：health `0.4.10 running`、代理往返 200、`authorization=["[redacted]"]` 且响应不含夹具密钥、`pricing_status=unpriced`/`reason=no_matching_price`/`cost_nano_cny=null`、未生成摘要与简介均答 200+`null`、生成后逐字节读回且模型自造的 `model_note` 存活、不存在的记录 GET `200/null` 而 POST 404 `record_not_found`、不存在的分组 404 `log_group_not_found`、统计 overview/trend/CSV 顶层键与表头未变、退出码 0 且端口释放、`schema_version 13` 与 15 张表。portable 包装器另验（清掉 `ELECTRON_RUN_AS_NODE`）：3.0 秒健康、代理 200、`/api/logs 200 total=1`（不是 500，说明包内 SQLite 可用）、`traffic.db` 4,096 字节、退出码 0。CLI 归档独立复验：`npm run package:cli` exit 0 → `release\llm-proxy-cli-0.4.10.zip` 771,102 字节、444 条目、`dist-node/src/main.js` 在、`dist-node/electron` 0 条、测试 0 条、`admin/static` 16 条。
- 新增与更新的测试及任务 ID：`test-node/docs/build-entry-configs.test.ts` 0 → 3 用例，`test-node/docs` 组从 10 文件 24 用例 → 11 文件 27 用例，`[AI-15]` 打在 describe 与每个 `it` 上；没有任何既有用例被删除、跳过、放宽或加等待。
- UI 截图、性能或迁移结果：不适用——未改 UI 文本、布局或渲染内容，UI 测试在全量门禁里全绿，`dist-node/src/admin/static` 里是 9 个分片 + `app.css` + `index.html` 且没有旧的合并版 `app.js`；schema 仍 13，无迁移。基线未重生成。
- 便携版构建与冒烟结果：三步 exit 0、产物 111,654,817 字节、asar 3,085 条无测试实现、21 项冒烟 0 失败、包装器 3.0 秒健康、CLI 归档 444 条目（见上）。
- 与本清单的偏差、剩余事项：一、**CI 文件未改**，因为逐项核对后确实没有可同步的路径或顺序：CI 只调 `npm run build`、`npm run smoke:database`、`npx playwright install chromium`、`npm run check`、`npm run test:coverage`，不写死 dist-node 路径，而合并后 `dist-node/scripts/database_smoke.js`、`dist-node/src/main.js`、`dist-node/electron/index.js` 全部实测存在。二、写者手记里“typecheck 后仍覆盖 252 文件”是一句**过时数字**（它引的是自己新增测试之前的计数），编排方实测 253；非阻断，方向更有利。三、编排方的任务包写了一个并不存在的文件名 `test-node/admin/built-static-assets-app-appended.test.ts`（`git log --all -- <path>` 为空，main 里也没有）——这是**编排方给的锚点错了**，写者按实情跑了 `built-static-assets.test.ts` + `static-source.test.ts` + `static-assets.test.ts`。四、打包工具仍在 `app.asar` 里（48 个文件，维持原状）；要不要把 dev 工具从包里剔除是另一个决定。五、旧输出残留只堵住一半：`dist-node/test-node` 再也打不进包，但还能躺在开发者目录里误导按 `asar list` 推理的人，拉取本提交后删一次 `dist-node` 仍值得提醒（本轮就实际撞上：合并后首次 `ls dist-node/test-node` 仍看到旧目录，删净重构建才消失）。六、`npm run smoke:artifact` 仍受 `ELECTRON_RUN_AS_NODE` 继承之坑影响，清理属 AI-16；本轮包装器是用自备脚本另验的。
- 提交 SHA：8116782（由 `lane/ai-15` 的 `9986c65` squash 合并，零冲突）；另有 `55ff45b` 同步 `AGENTS.md` 与两条 skills 里被本项改假的三句陈述。

### 本轮委派执行环境记录

- 两条写者 lane 各自独占一个 `git worktree`（`D:/code/lane-ai07` 分支 `lane/ai-07`、`D:/code/lane-ai10` 分支 `lane/ai-10`，均从 `535740e` 起），并各持一份 `node_modules` 副本（595 MB，robocopy /MT:16，退出码 1 为成功，文件计数与源一致）。原因：pi-subagents 的托管 worktree 会把主检出的 `node_modules` 软链接进去，而每项任务收尾的 `npm run rebuild:electron` 会把共用的 `better_sqlite3.node` 换成 Electron ABI，另一个 lane 的 Node 测试会当场失败——同一目录里两个写者还同时违反 AGENTS.md 的“Node 测试与 Electron ABI 重建串行执行”。因此这里不用托管隔离，而是自建 worktree + 显式 `cwd`，副本互不影响 ABI。
- 内置 `worker` 的 frontmatter 写 `thinking: high`，而本机 lmstudio 的 `Qwen3.8-Flash-Next` 只接受 `xhigh`/`medium`/`low`，第一次启动两个子任务都在 2 秒内以 HTTP 400 死去、没有产生任何改动。同协议重试的办法是在 `model` 字段上加思考档后缀（`lmstudio/Qwen3.8-Flash-Next:xhigh`），后缀优先于 frontmatter；`resume` 会沿用子任务存下来的 model/thinking 契约，救不了这类失败。
- 两项任务合并进 main 时零冲突：两条 lane 改动的文件集合交集为空（用 `comm` 对 `git status --porcelain` 与 `git diff --name-only -M` 求交），且 AI-07 从 `src/proxy/index.js` 重新导出的 8 个目标探测类型在 AI-10 的 barrel 里全部仍在（AI-10 只改再导出路径，不改名字）。
- 冒烟用的端口段与各 lane 自用的端口段严格分开：lane 用 39411/39412 与 39421/39422，编排方合并后用 39431/39432/39433 与 39441/39442/39443，全部先实测空闲；用户实例占用的 18085 全程未使用、未停止，清理时只杀自己启动的进程。
- 勾验收要同时勾三处，只勾进度表会漏：任务小节里的验收复选框（每项 4～5 条）、进度表那一行、§8 里覆盖到该项的那一条。上一轮 AI-07 与 AI-10 只补了后两处，任务小节的 10 个复选框拖到用户提醒才补，补勾时逐条对着本轮亲自复现的证据判定：AI-07 五项分别对着“冒烟里三类序列与分组计价键、行→模型的 `taskBriefFromRow` 与 `parseSummaryPayload`、`admin-contracts.ts` 具体返回类型且 `api-contract.test.ts` 已无 `as unknown as`、200+`null` 与带 code 的 404 与 `unpriced`/`pending`、`log-service-fixtures.ts` 的 10 个构造器”；AI-10 五项分别对着“`protocol/` 叶模块、检查器的 transport 包含规则、0 越界、AST 图排除纯类型边、还原 HEAD 报 6 环 2 越界与自造样例报 2 环 1 越界”。
- §7 里“是否隔离原生依赖目录？”那一行的替代条件已经实际触发并落地：两条 lane 各自一个 worktree + 一份 `node_modules` 副本，并各自能独立切换 ABI（本轮实测：副本内 `:memory:` 查询报 Node ABI，lane 自己 `rebuild:electron` 后不影响另一 lane）。AI-16 动手时直接拿这个实测结论写方案，不必再从零评估。

### AI-08 未验收记录（委派子任务超时，部分改动仍留在 lane 内）

- 状态：`ai-15` 已完成、已由编排方独立复现并 squash 合并进 main（`8116782`，另有 `55ff45b` 同步三处被改假的陈述）；`ai-08` 的子任务在 30 分钟上限处被终止，未交回可验收的成果，进度表里它的状态是“受阻”，两处复选框都仍 `[ ]`。
- 委派拓扑：workflow `6b338d6e-9d71-4e2c-92fd-105a348acbcd`，脚本 `.pi/subagents/lanes-ai08-ai15.mjs`（临时文件，收尾即删），`action=validate` 报 `{"ok":true,"errors":[]}` 后才启动。两个子任务：`ai-08` 子运行 `9ede718f-2a07-499a-9361-0722dade8c47`，`ai-15` 子运行 `a60f4389-990e-4a95-a33d-ab68acbea0b1`，启动后均报 running 而非上一轮那种两秒内 HTTP 400 死亡，原因是子 `model` 字段带了 `:xhigh` 后缀（内置 `worker` 的 `thinking: high` 被本机 lmstudio 拒绝）。两条 lane 各自独占 worktree：`D:/code/lane-ai08` 分支 `lane/ai-08`、`D:/code/lane-ai15` 分支 `lane/ai-15`，均从 `ea7ba87` 起，启动前 `git status --short` 为空，各自持一份 595 MB `node_modules` 副本，并用 `:memory:` 库实查询报 `{"a":42}` 证明装的是 Node ABI。结局：`ai-15` 交回完整 handoff 并被验收合并；`ai-08` 的子任务在跑满 1,800,000 ms 上限后被终止（`ok:false`，`Error: Subagent timed out after 1800000ms`），什么都没提交。
- 端口分配：`ai-08` 用 39451/39452/39453，`ai-15` 用 39461/39462/39463，启动前逐个实测空闲；与上一轮用过的 39411～39443 不复用，避免把旧运行的残留当成新证据。
- 本项动手前编排方实测的现状（写进任务包，免得写者重新摸索）：`build` = `tsc -p tsconfig.json && node dist-node/scripts/copy_static_assets.js`，而 `tsconfig.json` 的 `include` 里有 `test-node/**/*.ts` 与 `scripts/**/*.ts`，所以今天产品 build **确实**在编译测试实现，`electron-builder.yml` 只是事后用 `!dist-node/test-node/**/*` 排除；`create_cli_archive.ts` 只收 `dist-node/src`；`copy_static_assets.ts` 把 `src/admin/static` 复制到 `dist-node/src/admin/static`；`check` = `format:check && lint && typecheck && check:modules && test && build`；五个 `pre*` 钩子都跑 `npm run rebuild:node`；`src/admin/admin-schemas.ts` 336 行里有 22 个 `export const *_SCHEMA`，各 route 文件里 `schema: {` 附件共 21 处（logs 9、statistics 4、targets 3、pairs 3、model-catalog 1、load-balancer 1），行级 grep 只数到 32 个 `server.<verb>`，而 AGENTS.md 记的是 33 条注册——差的那一条正是跨行泛型（`server.post<{ Body: ... }>(` 占三行）这个已知盲点，已要求写者改用 TypeScript AST 重数；`src/admin/static/01-core.js` 只有第 946 行一处 `fetch`。
- 编排方在任务包里预先写明的陷阱（清单正文没有、但按本仓历史极可能踩到）：一、给 Fastify 挂 `response` schema 会让 `fast-json-stringify` 接管序列化并**丢掉 schema 未声明的属性**，而 AI-07 故意保留的开放摘要键（实测样例 `model_note`）必须逐字节存活，所以要求用真实 inject/HTTP 往返证明未声明键仍在，类型编译通过不算证据。二、AI-15 收窄 build 后，`smoke:database`、`checksums`、`validate:migration`、`package:cli`、各 `benchmark:*` 等仍在执行 `dist-node/scripts/*.js` 的脚本必须照样能解析，`check:modules` 必须留在链路里且继续报 0 环 0 越界。三、两条 lane 的所有权隔离：AI-15 拥有 `package.json`/`tsconfig*`/`scripts/**`/CI/electron-builder，AI-08 禁入这些且只能新建 `docs/refactoring/` 文档，AI-15 只能改 `docs/current-architecture.md` 的验证命令小节，避免在同一个文件上相撞。应验情况：第二条对 AI-15 完全应验（工具产物路径与 `check:modules` 都被逐项复验）；第一条对 AI-08 也应验——写者自己写的开放性测试抓到它把 `decode_window_ms` 和 `log_root` 这类 UI 真正读取的键丢掉了，那正是本项最危险的失败方式。
- 编排方待执行的验收清单（等两条 lane 交回后逐条做，不采信子任务自述）：在各自 worktree 里复跑包内命令并核对数字；求两条 lane 改动文件集合的交集；合并两条分支并记录冲突面；全量 `npm run check` 一次并与 AI-07/AI-10 的 116 文件 1027 测试逐项对账，证明没有用例被删；若基线哈希变动按 ui-baseline-regen 做像素对拍并决定还原还是接受；合并后重跑交付门禁（`build` + `rebuild:electron` + `electron-builder -w portable`）与 21 项隔离冒烟，另验 portable 包装器；确认 `asar` 条目数变化与 CLI 归档路径一致、测试实现不再进产品产物、而 `typecheck` 仍能报出测试文件里的类型错误；最后写完成记录、勾进度表与 §8 复选框。
- 本轮不做的事：不 push、不发布、不替换用户正在跑的 portable 实例；`scripts/artifact_smoke.ts` 的 `ELECTRON_RUN_AS_NODE` 清理属 AI-16，本轮不动。
- `ai-08` 部分改动的编排方实测（完全不看写者自述，因为它没写完也没提交）：`npm run typecheck` exit 0、0 条 `error TS`——那 758 行的 Zod 单源改写能编译；`npm run lint` exit 1，8 条 error **全部**在它新写的 `test-node/admin/response-schema-openness.test.ts` 里（119 行 require-await、197 行非空断言风格、362/398/404/408/417/421 六条 `no-unsafe-argument`），产品代码本身 lint 干净；`npm test -- test-node/admin` 6 失败 98 通过、15 文件通过，失败的 6 条全在它新写的开放性测试里，既有 admin 用例一个没挂。它改的 11 个跟踪文件 +1182/−684，另有两个未跟踪物：新测试文件与测量垃圾目录 `.measure-tmp/`（`after-admin.txt` 到 `after-admin4.txt`）。`src/admin/static/` 下 `git status --short` 为空——客户端契约那一半完全没动；它头注释里承诺的 `docs/refactoring/admin-api-contract.md` 也不存在。它没跑 V-P、没提交，39451～39453 三个端口未使用。它的方向是对的（Zod 单源、把类型与 Fastify schema 从同一声明读出、显式写开放/封闭判定），错的只是把 `decode_window_ms`、`log_root` 这类 UI 真正读的键判成了封闭。
- 失败教训（可复用）：子任务默认 30 分钟上限对“把整份 wire schema 重写成单一来源”这种体量不够——AI-07 与 AI-10 都在上限内交回，AI-08 跑满上限时被终止且客户端那一半还没开工。重试要么显式抬高 `timeoutMs`，要么先切成“schema 单源 + 路由挂载”与“客户端契约 + 文档 + 门禁”两段分别跑，别把两段塞进同一个 30 分钟预算。部分改动是有价值的底子，重试应在它上面改而不是推倒重来。重试策略已由用户选定并实施：在部分底子上重试——WIP `3b59a26` rebase 到 `247b38b`（rebase 后实测 typecheck 仍 0 错误、仍是 6 失败 98 通过），子任务预算抬到 60 分钟，并被要求“测试一绿就先提交”以免再次超时把进度弄丢。编排方在它开工前后对两个卡点做了裁决：一、不允许为了“legacy 扁平 pair 的未建模键原样回读”去改 `src/config`——那既越出本项所有权，又违反“保存格式不变”与“把旧的扁平 pair 归一成嵌套模型是现行有意行为”这两条；清单 §7 明说被排除的范围要另立需求，所以这条归以后的任务。写者被要求把那条测试原样留着失败、只在注释里写明实测原因（注释不是断言，改断言是），它实测 `/api/pairs` 只有 11 个键而写入的是 20+ 个键，且自己的 fast-json-stringify 探针证明“开放的 pair 对象”确实能原样答出未声明键——丢键发生在 `src/config` 不在 schema。二、错误 DTO 按 `{code,message}` 封闭声明，但**不给路由挂 per-status 错误响应 schema**——写者实测 Fastify 的 `setErrorHandler` 回复会走路由的 response schema，封闭声明会静默丢掉 `issues`，而 `issues` 是控制台真读的字段（`01-core.js:957` → `configIssueText` → `09-wiring.js:157`），`test-node/admin/pairs.test.ts` 里有 4 处精确路径断言。
- 第二棒交回（workflow `e4466d24-8899-4325-919d-9f3f05356d1a`，子运行 `fefc0003-5d05-4026-aed8-c6dfb2038235`，lane 提交 `f46c439` + `1a487e1`）：**六条里修好五条**，第六条按裁决留着败；客户端半与 V-P 没跑完（60 分钟预算耗尽）。lane HEAD `1a487e1`，工作树干净。
- 父侧在 lane 里独立复现（不信摘要）：typecheck exit 0 且 0 `error TS`；lint exit 0；`npx prettier --check .` exit 0；`check:modules` exit 0 报 `115 modules: 249 runtime edges, 74 type-only / runtime cycles: 0; boundary violations: 0`（249 = 上一轮的 247 加 AI-08 新增的 2 条边）；`npm test -- test-node/admin` = `105 tests: 104 passed | 1 failed`，唯一失败正是旧 pair 那条；`pairs.test.ts` 13 测全过、含那 4 条 `error.issues` 精确路径断言，`api-contract.test.ts` 7 测全过（33 条路由登记），`logs.test.ts` 20 测全过——这证明“错误 DTO 闭合但不挂载”的裁决保住了 `issues`。
- 审计“改了测试”的质疑：`git diff 3b59a26..1a487e1 -- test-node/` 报删 6 行断言、新增 11 行——逐块看上下文后证实是**同样断言换了写法以过 lint**（加 `as Record<string, unknown>` 避开 `no-unsafe-argument`），期望值一字未变：`FST_ERR_VALIDATION` / `invalid_request` / `log_record_not_found` / `task_brief_in_progress`，状态码 400/404/409/500，`Object.keys(failure)` 仍等于 `["code","message"]`。没断言被删、被 skip、被放宽、被加等待。
- 两个真实陷阱值得记下：`loadBalancerMetricsDto.nullable()` 的 `anyOf` 形式碰上未声明键会走 ajv 校验路径并抛错，`/api/load-balancer/status` 直接 500；探针对比出 `type: ["object","null"]` 列表形式不抛、仍输出 `null`、开放时仍保留未声明键，于是在 `toAdminJsonSchema` 里加了第三个转换。`decode_window_ms` 的位置是另一个：fast-json-stringify 先排 required 属性，声明成 optional 就把它排到最后，声明成 required 会在每条 pending 记录上抛 `'decode_window_ms is required!'`——最后靠把两个 meta 块声明成 optional 把顺序还原成 main 的样子。
- 第三棒已派（workflow `3ba4a8f5-4733-43e8-a170-f4c828be40d3`，脚本 `.pi/subagents/ai08-final.mjs`，先 `validate` 报 `{"ok":true,"errors":[]}`，预算 40 分钟），范围只剩三件：按上述裁决重写那一条测试 → `01-core.js` 的 fetch 接缝（约 15 行：让 `ApiError` typedef 与 `line 955` 的抛出点跟上真实 `{ error: { code, message, issues } }`，给 `line 946` 的 fetch 加 JSDoc 指名 `docs/refactoring/admin-api-contract.md`；**不得**把 `api()` 返回值改成 `Record<string, unknown>`，那会打断 `tsc -p tsconfig.ui.json` 下的所有调用方）→ V-P 与隔离冒烟（端口 39451/39452/39453，父侧实测空闲；启动 spawn 前必须删掉 `ELECTRON_RUN_AS_NODE`；不得跑 `npm run smoke:artifact`，那个脚本止于 `512f80e` 且还在改）。包内明写：不许碰 `scripts/**`、`package.json`、`.github/**`（lane-ai16 正在改这三族），不许碰 `src/config/**`（属 AI-25）；若不同意裁决，在 DEVIATIONS 里拿自己的数字说话，而不是静默改写法。

### AI-16 在办记录（第二槽位）

- 状态：在办，**未验收**；复选框仍 `[ ]`。这一条是用户选了“占用第二槽位”后才开的：AI-15 交回并被验收后它的写者就不存在了，AI-08 的第一个写者超时死掉，所以被批准的那一轮只剩一个写者；“最多 2”是上限不是配额，没活干不会去造活，而未授权就开新任务等于越出用户选定的范围。
- lane 与身份：`D:/code/lane-ai16` 分支 `lane/ai-16`，从 `ad8a600` 起，启动前 `git status --short` 为空；自带一份 595 MB `node_modules` 副本（robocopy 退出码 1 为成功），并用 `:memory:` 实查询报 `{"a":42}` 证明装的是 Node ABI。workflow `435730e3-5fff-4228-82c3-3bf30dff526e`，子运行 `4628797b-d4d4-40bb-8ca4-1d78b8dae647`，预算 45 分钟；脚本 `.pi/subagents/lane-ai16.mjs` 先 `action=validate` 报 `{"ok":true,"errors":[]}` 再启动。端口 39491/39492/39493 逐个实测空闲；用户实例此刻仍有 4 个进程在跑，全程不碰。
- 与 AI-08 的所有权切分：AI-16 拥有 `scripts/**`、`package.json` 的新增条目（不改 `build`/`typecheck`/`check`/`check:modules` 的文本）、`test-node/electron/**`、两个 workflow 文件、`docs/current-architecture.md` 的验证命令小节，以及 `.agents/skills/packaging-smoke/SKILL.md` 里那句“`npm run smoke:artifact` 继承了本 shell 的 `ELECTRON_RUN_AS_NODE=1` 且从不清理”（它描述的正是本次要修的 bug）；禁入 `src/**`、`src/admin/**`、`test-node/admin/**`（AI-08 正在重写那两个面）与 `tsconfig*`（AI-15 已收口）。预计两边文件集合交集为空。
- 写进任务包的实测事实：`scripts/artifact_smoke.ts` 用 `env: { ...process.env, ... }` 启动 portable exe 且**从不删除** `ELECTRON_RUN_AS_NODE`；参数只有 `--port <空闲>` 与**相对**的 `--config-file smoke/proxies.json`、`--log-root smoke/logs`，根本没有 `--application-config`；健康之后它只写退出文件并等 10 秒看端口释放，**从不请求 `/api/logs`、从不错看 `traffic.db`**（即清单第 4 条的空缺）；健康截止 30 秒，而陷阱清掉后本机实测 3.0 秒就健康，陷阱没清掉时 exe 直接退化成纯 Node、永远不会健康；`test-node/electron/artifact-smoke.test.ts` 只钉了 `findPortableArtifact`（选 portable `.exe`、缺产物时报 `Portable artifact not found`）；`.github/workflows/release.yml` 有一步 `npm run smoke:artifact`。本 shell 此刻实测 `ELECTRON_RUN_AS_NODE=1`，就是那个坑的现场。
- 对写者的硬要求：两个方向都要证明（先复现陷阱下的失败，再证明修好后能过），并加一条断言“spawn 子进程的环境里不再有 `ELECTRON_RUN_AS_NODE`”，让以后回归在门禁里死而不是靠人现场发现；交付冒烟必须看 `/api/logs`（200、total ≥ 1、不是 500——500 代的是载荷里 ABI 不对，不是应用 bug）与该运行日志根里真的出现 `traffic.db`；portable 包装器与 unpacked 载荷两条路分开跑、按顺序跑，共享解包目录争用要报可理解的提示而不是报成“载荷回归”；ABI 一律用 `:memory:` 查询证明，`require("better-sqlite3")` 在两种状态下都报成功、不算证据；只杀自己启动的进程。
- 实时看护两次报了同一个子代理“bash 长时间未返回”，父侧第一版判断**是错的**，后来被实测推翻：`npm run abi:electron` 并没有卡住，它在 15:52 正常结束并报 `electron ABI probe finished with exit code 1`（日志从 113 字节长到 204 字节）——npm 的子进程是在退出时才写输出，所以“跑着的时候日志很短”是正常现象，不是卡住的证据；我当时“lane 里没有任何进程”的判断同样无效，因为按 CommandLine 匹配 worktree 路径的过滤器永远匹配不上 `npm run build`（npm 不把 cwd 写进命令行）。可复用经验：**判断子代理是否卡住要看进程是否存在（过滤器按可执行名与参数，别按路径）、产物 mtime 是否推进、日志是否只在退出时落地、以及 turn/tool 计数是否还在涨；单看时长或日志长度会误判**。误判的代价是编排方发出一条“别再等”的 steer，可能让写者放弃一条本来正当的验证——已发第二道 steer 撤回并要求继续 V-P。顺带记下一个真缺陷：`native_abi_probe.js --electron` 在纯 node 下运行、而装的是 Electron ABI 时，证明的只是**纯 Node 打不开那个二进制**（`ERR_DLOPEN_FAILED`），文案却写成“Electron 运行时打不开 SQLite”——报错了运行时名字。要证明 Electron 侧能开库，要么把 `ELECTRON_RUN_AS_NODE` 从 spawn 环境删掉后在 Electron 内跑探针，要么看打包载荷在 Electron 里 `GET /api/logs` 报 200。两个方向必须在报告里分开：纯 Node 打不开 Electron ABI 二进制是预期现象、不是载荷回归；Electron 打不开 SQLite 才是真回归。

### AI-16 完成记录

- 状态：**已完成（带偏差）**，由编排方验收。lane 提交 `512f80e`（清理启动环境、真实 ABI 探测、拆分两条冒烟）、`ff78123`（把冒烟变量交给子进程、按路径跑 Electron 探针）、`9db2f6d`（把解包目录争用归类为启动碰撞），squash 合并进 main 为 `6c21d74`，**零冲突**。以上“在办记录”保留作审计。
- 子代理**没交回 handoff**：workflow `435730e3-5fff-4228-82c3-3bf30dff526e` 在 2,700,000 ms 上限处超时（子运行 `4628797b-d4d4-40bb-8ca4-1d78b8dae647` 被停），所有事实由编排方从 lane 提交与实测重建。
- 编排方在 lane 内独立复现：`npm run typecheck` exit 0 且 0 `error TS`；`npm run lint` exit 0；`npx prettier --check .` exit 0；`npm run check:modules` exit 0 报 `115 modules: 247 runtime edges, 75 type-only / runtime cycles: 0; boundary violations: 0`；`npm run abi:node` exit 0 报 `better-sqlite3 answered a real query in node (NODE_MODULE_VERSION 137, query result {"a":1})`；`test-node/electron` 17 文件 50 测全过；`test-node/docs` 11 文件 27 测全过。断言审计：`git diff ad8a600..HEAD -- test-node/` 删 0 行断言、新增 11 处声明——计数用 `^\s*(it|test)\(`，因为 `emit(` 与 `await(` 含子串 `it(` 会让粗粒度 grep 多算。全量对账：声明测试 `871 → 881`（+10），测试文件 `118 → 119`（+1），无删除。
- 合并后的集成验收（本轮关键证据）：main 上 typecheck / lint / prettier / `check:modules` 全 exit 0；`npm run package:electron` exit 0（portable `107,740,822` 字节，NSIS installer `107,963,236` 字节）；`npm run abi:electron` exit 0 报 `NODE_MODULE_VERSION 143, query result {"a":1}`；`npm run smoke:delivery` 在**本 shell 仍带 `ELECTRON_RUN_AS_NODE=1`** 的前提下 exit 0——unpacked payload：health 557 ms、proxy 200、`GET /api/logs?limit=5` 200 total 1、`traffic.db` 4096 字节；portable wrapper：health 3436 ms、proxy 200、同一组结果。修复前 `npm run smoke:artifact` 在同一 shell 里必然报 `did not become healthy`，所以“陷阱还在但冒烟能过”就是验收本身。
- 错误 ABI 的诊断文案实测可行动：`better_sqlite3.node carries the ABI built for NODE_MODULE_VERSION 137 while electron needs 143, so it cannot be loaded here: run npm run rebuild:electron before packaging or running a packaged executable.`（exit 1），反方向 exit 0。
- 与本清单的偏差、剩余事项：一、子代理自己的 V-P 没跑成——16:09 那次 `electron-builder` 因网络 TLS 抖动失败（`Client network socket disconnected before secure TLS connection was established`，`got` 栈，`BUILDER_EXIT=1`），与它的代码无关；编排方集成 V-P 成功，产物结论成立。二、`abi:check` 在只装了 Node ABI 的工作树里必然失败（`abi:node` 过后 `abi:electron` 报 ABI 不匹配并 exit 1），这是 ABI 状态的耦合不是 bug，用之前先确认装的是哪种。三、UI 基线未动（本次不改渲染）。四、全量 `npm run check` 本轮未跑：另一条 lane 还在跑测试，两条全量并发有 `listen ENOBUFS` 前科，留到 AI-08 落定后一次跑。
- 顺带更正编排方两处误判：`git diff --stat | tail` 截断让我一度以为 skill 没更新（`.agents/skills/packaging-smoke/SKILL.md` 实际就在合并清单里，已写明 `smokeChildEnvironment` 与它的门禁测试）；健康截止已从 30 秒改为 `DEFAULT_HEALTH_DEADLINE_MS = 60_000`（shutdown 30 s、建库 20 s），skill 里那句“30 s 可能太短”同步修掉。

### AI-08 完成记录

- 状态：**已完成（带偏差）**，由编排方验收。lane 提交 `f46c439`（开放载荷保持开放、封闭漂移、错误只由一个生产者应答）、`1a487e1`（合同文档）、`f4b6302`（按裁决重写那条 pair 检查）、`bea8f99`（`api()` 的失败侧类型化），squash 合并进 main 为 `25ccead`，**零冲突**；上面的“未验收记录”与“在办记录”保留作审计。
- 编排方在 lane 内独立复现：typecheck exit 0 且 0 `error TS`；lint exit 0；`npx prettier --check .` exit 0；`check:modules` exit 0 报 `115 modules: 249 runtime edges, 74 type-only / runtime cycles: 0; boundary violations: 0`；`npm test -- test-node/admin` 16 文件 `105/105` 全过；`npm test -- test-node/ui` 93 过 2 跳过（那两个跳过是既有的 `CSS_CANDIDATE` / `CSS_CENSUS` opt-in 守卫，不是新增）。断言审计：`git diff 1a487e1..HEAD -- test-node/` 只删了那 4 条错误前提断言（`pair["log_root"]`、`redact_logs`、`model_mapping_mode`、`length > 20`），换上来的是有序的 11 键全集、模型化值、合成 target 的绝对 `log_root`、九个具名缺失键的 `toBeUndefined()`、以及靠 `running`/`actual_listen_port` 证明的开放性；`it.skip|it.only|it.todo|todo.describe` 的新增计数实测为 0。
- 独立核数：那条 pair 字面量的顶层键是 **27，不是本文早先记录的 25**（当时我直接采信了超时那棒的报告，没自己数）。用大括号深度扫描数过的 27 个键：`id,name,enabled,listen_host,listen_port,upstream_url,model_mapping_mode,default_model,default_upstream_model,preserve_route_model,allow_unnamed_model,unknown_model_policy,unknown_param_mode,unknown_param_paths,stream_keepalive_interval_seconds,target_retry_limit,target_retry_backoff_milliseconds,failover_reuse_connection,target_connect_timeout_milliseconds,target_first_byte_timeout_milliseconds,target_idle_chunk_timeout_milliseconds,target_headers,strip_request_fields,inject_request_fields,log_root,redact_logs,model_mappings`。其中 5 个出现在答里、22 个被丢、6 个是流水线自己合成的——子代理报的 `27/11/5/22/6` 成立，本文两处 25 已同步改成 27。
- 合并后的集成验收：`npm run check` exit 0，`119 passed | 1 skipped (120)` 文件、`1050 passed | 2 skipped (1052)` 测试，`check:modules` 仍报 0 cycles / 0 violations；日志里 44 处 `failed` 全是应用自己的 warn 行（`Admin request failed`、`Task brief generation failed` 等），来自负路径用例，不是测试失败。三棒合计对账 `+3 文件 / +22 测试`（AI-15 `+1/+3`、AI-16 `+1/+10`、AI-08 `+1/+9`），无用例被删。
- 合并产物的真实冒烟（17 项全过，exit 0）：`--dir` 与 `-w portable` 都用 `-c.electronDist=node_modules/electron/dist` 构建成功（此刻本机到 GitHub 的 TLS 反复断开、Electron zip 不在缓存里，而 `node_modules/electron/dist/electron.exe` 正好是 40.9.3）；health `0.4.10`、真实代理请求 200、`GET /api/logs` 200 `total=1`、记录顶层键序 `id,pending,request,response,pricing,decode_window_ms,request_meta,response_meta`、`authorization=["[redacted]"]` 且探针密钥在整条记录里查不到、`cost_nano_cny` 是文本、总结 POST 200 并原样读回未声明的 `model_note`、缺失记录 404 只带 `code,message`、未声明查询键 400 `FST_ERR_VALIDATION`（这正是 `removeAdditional:false` 收紧后的可见行为）、被拒配置带 `issues`、pair 答 11 键且 `targets[0].log_root` 是绝对路径、统计概览键与 CSV 表头未变、退出码 0、端口释放、`traffic.db` 180,224 字节。
- 探针一开始的三次失败全是编排方自己写错的夹具，不是产品回归：target 读的是 `target_url`，我写了 `upstream_url`，于是静默回落到 `DEFAULT_TARGET_URL = http://127.0.0.1:1235` 并在记录的 `response_meta.error` 里留下 `connect ECONNREFUSED`（应用报 502 `Bad Gateway` 是对的）；总结夹具没给 `segments` 数组，应用按合同报 `summary_failed`；头部脱敏由 target 的 `redact_logs` 控制、默认 false，我没开。这三条已写进 `real-upstream-acceptance`。
- 与本清单的偏差、剩余事项：一、`api()` 里 `typeof data.error === "string"` 那条死分支被保留（作者把五个错误生产者都核过，没有一个能答裸字符串；删它等于在未可达的路径上改行为，越出任务范围），这条是披露而不是静默。二、`ApiError.code` 今天没有消费者，是为了让失败侧跟上真实线形而带的。三、`request_meta`/`response_meta` 为了还原键序被声明成 optional，代价是服务若不写某一块会静默少一块而不是大声失败。四、`removeAdditional:false` 把“未声明键静默删掉”改成 400，全量套件证明现有用例都不受影响，但这是对外可见的收紧。五、UI 基线未重跑：改动只有注释与一处属性赋值，11 条视觉回归测试（阈值 0.12）在改动后两次全过——这就是像素层面的证据。
- 遗留风险：`docs/refactoring/admin-api-contract.md` 里的 27/11 钉在这份夹具上，改 `opennessPair` 会让注释和文档同时过时；那条有序键序断言会大声失败而不是静默漂移，这正是设计意图。

### 第三轮在办记录（AI-09 + AI-12）

- 状态：两条都在办，**未验收**；复选框仍 `[ ]`。选这一对是用户定的；为什么不是表格顺序上最靠前的 AI-09 + AI-11：两个任务小节的“入口”里都列着 `src/app/runtime.ts`（AI-09 要改装配，AI-11 的总结模型测试装配也在那里），同时开必定撞上本项目前三轮零冲突的好事；而 AI-12 的入口是 `src/persistence/repository.ts`、`body-storage.ts`、`src/pricing/money.ts`，与两边都不相交。
- lane 与身份：`D:/code/lane-ai09` 分支 `lane/ai-09`、`D:/code/lane-ai12` 分支 `lane/ai-12`，均从 `818e07d` 起；两边启动前 `git status --short` 行数实测 0（净），各自自带一份 595 MB `node_modules` 副本（robocopy 退出码 1 = 成功），并用 `:memory:` 实查询报 `{"a":42}` 证明装的是 Node ABI。workflow `d3ff3fb7-1abb-461e-bb19-5c03f044ee29`，子运行 `a75b7862-04be-4149-9e3f-00915bb8a23f`（AI-09）与 `61e8384b-6d05-42fe-8648-7dfdc584c8d5`（AI-12），预算分别 45 / 50 分钟，编排层上限 55 分钟；脚本 `.pi/subagents/wave3-ai09-ai12.mjs` 先 `action=validate` 报 `{"ok":true,"errors":[]}` 再启动。端口 39501/39502/39503（AI-09）与 39511/39512/39513（AI-12）逐个实测空闲，均未与前两轮重叠。
- 所有权切分（两边任务包里都明写了对方正在改的文件族）：AI-09 拥有 `src/app/**`、`src/admin/admin-contracts.ts`、`src/admin/admin-server.ts`、`src/admin/routes/**`、`test-node/app/**`、`test-node/admin/**`，禁入 `src/persistence/**`、`src/pricing/**`、`src/maintenance/**`、`src/logging/**`、`src/proxy/**`、`src/admin/static/**`、`scripts/**`、`package.json`、`tsconfig*`、`electron-builder.yml`、`.github/**` 与两份文档；AI-12 拥有 `src/persistence/**`、`src/pricing/money.ts` 与必须随之调整的 `src/logging/**`、`src/maintenance/**` 调用点，禁入 `src/app/**`、`src/admin/**`、`src/proxy/**`、`src/config/**` 与同上工具/文档。若真的需要改对方文件，任务包要求停下来在 DEVIATIONS 里写出理由与具体行，而不是静默改。
- 写进 AI-09 包里的实测事实：`src/app/runtime.ts` 共 169 行，`NodeApplicationOptions`（第 27 行）只有六个字段（`applicationConfigFile, configFile, host, logRoot, port, version?`），admin 服务全部在启动路径里 64–112 行就地构造（`LogQueryService`、`pairService` 即当前 manager、`logService` 对象、`usageStatisticsService`、`targetCheck/Metrics/Models`、`loadBalancerService`、`modelCatalogService`、`summaryModelService`）；`AdminServerOptions` 共 34 个 readonly 成员、很多是 `?`（`cleanupKeepLatest?`、`cleanupOlderThan?`、`cleanupSelectedGroups?`、`getGroupLogs?`、`getRecordDetail?`、`getSummary?`、`getGroupPricing?` 等），路由注册靠 `getGroupLogs !== undefined` 这类卫子，所以今天缺一个服务只会表现为 404、编译阶段不报任何错。
- 写进 AI-12 包里的实测事实：`src/persistence/repository.ts` 1,523 行 / 51 个方法，SQL 处处走 `this.#database.prepare(...)`，唯一事务缝在第 135 行 `this.#database.transaction(work)()`；`body-storage.ts` 119 行、`database.ts` 169 行、`schema-v3.ts` 60 行；引用方（fan-in）是 `task-matcher`、`traffic-log-service`、`log-cleanup`、`log-export`、`log-query-service`、`persistence/index`；`CURRENT_SCHEMA_VERSION` 为 13、迁移 `1..13`、新库报 `schema_version 13` 与 15 张表，`test-node/persistence/database.test.ts` 在两处钉着版本号并列出表名。
- 两轮共同教训已写进两边任务包：不跑 `npm run check` 与全量套件（两条全量并发有过 `listen ENOBUFS`），ABI 只能用 `:memory:` 实查询证明，只杀自己启动的进程，用户实例只读，不许削弱断言，不许静默改既有测试的期望值，提交要早要勤；本轮新加的三条冒烟陷阱（`target_url` 对 `upstream_url`、总结需要 `segments` 数组、脱敏由 `redact_logs` 控制）已先写进 `real-upstream-acceptance`，任务包里直接指名。

### AI-09 完成记录

- 状态：**已完成（带偏差）**，由编排方验收。lane 提交 `dc999bb`（生产装配要求完整服务集）、`3012023`（两个方向都证明的装配测试）、`27ad1fa`（把装配规则写在读到它的地方），squash 合并进 main 为 `6c49e07`，**零冲突**，15 个文件 `+1002/-155`。
- 偏差就是它**没交回 handoff**：子运行 `a75b7862-04be-4149-9e3f-00915bb8a23f` 在最后一步以一个奇怪错误终止（`bash failed (exit 1): (no output)`），产物文件里只剩它中途的一句自我叙述（`Now I have the picture. Let me verify a few assignability assumptions before editing.`），没有报告。所以验收完全建在代码与编排方自己复现的门禁上，不建在它的说法上；三个提交加干净工作树（`git status --short` 行数实测 0）说明活干完了。
- 改动实质：`AdminServerOptions` 的服务成员全变必填（`Required<LogAdminService>`、`Required<PairAdminService>` 等），只有 `logger` 保留可选（它不是任何路由用来应答的服务，`createAdminServer` 在不给时会自己补一个结构化的）；新增 `src/app/admin-services.ts`（`assembleAdminServices`、`AssembledAdminServices = Omit<AdminServerOptions, "staticAssets">`、`assertAdminServicesComplete`）；`src/app/runtime.ts` 第 71–73 行在**建控制平面之前**就调用断言，所以端口未绑就会失败；那个模块头部 23–25 行明写生命周期：每次 start 创建一次、由谁持有、关闭时 manager 停止，三者没有第二个持有者——这就是清单第 3 条要的可见性。
- 编排方在 lane 内独立复现：typecheck exit 0 且 0 `error TS`；lint exit 0；`npx prettier --check .` exit 0；`check:modules` exit 0 报 `116 modules: 253 runtime edges, 76 type-only / runtime cycles: 0; boundary violations: 0`（模块 115→116 = 新文件，运行时边 249→253，类型边 74→76）；`test-node/app` 4 文件 `19/19`（原 3 文件 12 测）、`test-node/admin` 16 文件 `106/106`（原 105）、`test-node/ui` 93 过 2 既有跳过、`test-node/docs` 27/27。断言审计：`git diff 818e07d..HEAD -- test-node/` 删断言 0 行、新增 `expect(` 33 处，`it.skip|it.only|it.todo|todo.describe` 新增 0；main 上声明测试数 `891 → 899`（+8）、文件 `120 → 121`（+1），无用例被删。
- 验收关键两条实测都成立：编译期——装配按 `AssembledAdminServices` 类型化，漏一个成员就是 `src/app/runtime.ts` 里的编译错误；运行期——`assertAdminServicesComplete` 在建控制平面之前拒绝靠 cast 或裸对象混进来的洞，所以缺服务永远不可能以 `404 { error: { code: "not_found" } }` 的样子到达浏览器（那正是未注册路由的样子）。`service-assembly.test.ts` 头部明写这点并把“缺一个服务会带走的十条路由”钉住；`runtime.test.ts` 新增 158 行覆盖真实装配下的必需 GET 与关键写操作。
- 它还改了 `AGENTS.md`（两条新事实：`prettier --write` 会重排 `docs/` 下的表格，因为默认配置忽略那个目录；在测试里构造“完整值减一个成员”时 `delete value[key]` 撞 `no-dynamic-delete`、`Object.fromEntries(...) as T` 撞非空断言规则）与 `admin-api-probing` 的花名册描述（改成 “the required service set”）；花名册门禁 `test-node/docs` 27/27 过。
- 遗留：V-P 本轮未在 lane 里跑（没报告，编排方也不假设），所以与 AI-12 合并后对**最终状态**一次性跑集成 V-P；在那之前这一条是 outstanding，不是已满足。

### AI-12 完成记录

- 状态：**已完成（带偏差）**，由编排方验收。lane 提交 `45fb515`（拆分本体，21 文件 `+2815/-1679`）、`a86c5e0`（`AGENTS.md` 一条 WAL 规则），squash 合并进 main 为 `889b414`，`AGENTS.md` 自动合并、**零冲突**。
- 编排方自己数的数：`repository.ts` 1,523 → **332 行**；`prepare(` 在 `src/persistence/**` 内共 **59** 处（record-store 15、task-store 14、search-store 8、pricing-store 5、generated-text-store 4，加原有 body-storage 8、database 3、schema-v5 2），**持久层之外 0 处**（合并前是 3 处，全在 `log-query-service.ts`）；`RepositoryRecord` 引用 `85 → 40`，**不是它报的 35**——它把 access-contracts 2、index 1、log-export 12、usage-statistics 5 漏在了汇总之外。逐文件实测：`task-store` 7、`record-store` 6、`search-store` 4、`task-matcher` 2、`log-export` 12、`usage-statistics-service` 5、`access-contracts` 2、`repository.ts` 1、`index.ts` 1，合计 40。
- 门禁复现：typecheck exit 0（两份 tsconfig）、lint exit 0、prettier exit 0、`check:modules` exit 0（lane 报 `122 模块 / 274 运行时 / 86 类型 / 0 环 0 越界`；合并后 main 报 `123 / 278 / 88 / 0 / 0`，AI-09 的 +1 加 AI-12 的 +7 正好对得上）；persistence 57、logging 43、maintenance 43、statistics 8 全过。admin/proxy/ui/docs 我没在 lane 里单独跑，由合并后的全量套件覆盖（更强的证据）。
- 断言审计：我第一版正则把 `?.["x"]` 归一成了 `?..x`（多一个点），导致 10 行假阴性、结论错了一次；修好后结论翻转为——删除 14 行断言，**14 行全有逐字等价的替身**（只是方括号读数改成点读数，`typeof` 保留），0 行无对应；新增 29 处断言里 15 处是真新断言；`it.skip|only|todo` 新增 0，等待/重试新增 0。
- 事务回滚是真证据：`leaves no partial write when the business write fails halfway` 用真实外键失败（link 指向本笔写入从不插入的 task）在 task、record、搜索行都已写入、`traffic-keep` 已被删之后触发；断言 task/record/两条 link 全不在、`record_search_map` 的 `COUNT(*)` 为 0、以及 **`traffic-keep` 回来了**——最后那条才把它和“什么都没发生”区分开。
- WAL 顺序规则对着代码核过：`writeTraffic` 事务的第一条语句是 `this.#tasks.write(...)`，`rawRow` 读在其后；独立的 `RecordStore.write`（`record-store.ts:252-253`）先读再开事务，带注释说明 `SQLITE_BUSY_SNAPSHOT` 不会被 `busy_timeout` 重试。`AGENTS.md` 只 `+1` 行、`-0` 行。
- 集成验收（合并后 `npm run check` 跑了三次）：第一次 exit 1，唯一失败是 `proxy-listener > decodes a compressed SSE response…`，断言 `decode_window_ms >= 20` 实得 `1.208 ms`；第二、三次 exit 0，`120 passed | 1 skipped (121)` 文件、`1060 passed | 2 skipped (1062)` 测试。为了把“我改坏的”和“本来就有的”分开，我在 lane 里检出合并前的 `6a178a9` 跑同样的全量：exit 0、1060 测试、**0 失败**。该测试的 `trafficLog` 是个返回 `Promise.resolve()` 的桩、完全不碰 SQLite，所以 AI-12 碰不到它的时间路径；单独连跑三次 `32/32` 全过。判读：套件级事件循环饥饿下，夹具那个 40 ms 定时器与 gzip flush 回调的先后顺序漂移，首块与尾块挤进同一个 tick，窗口才掉到 1.2 ms——是既有计时夹具在重载下偶发，不是 AI-12 的回归。测试数对账 `1060 → 1062`（+2 = 它新增的两条 `writeTraffic`），文件数不变。
- 基准我自己跑了一次（main，Node ABI 实查询 `{"a":42}`，`cast(41125000 as text)` 返回 `'41125000'`）：`medianListMs 80.15`、`medianSearchMs 112.45`、`medianDetailMs 16.39`，三项都低于报告里 2026-09-11 的参考值（90.19 / 123.34 / 23.61），也低于它报的 lane 值。跳会话数字不可比（机器状态不同），但至少没有回归迹象，也没越过报告里“超过 20% 要查”的线。
- 集成 V-P（顺带补上 AI-09 那条 outstanding）：`npm run build` exit 0 → `rebuild:electron` exit 0（`✔ Rebuild Complete`）→ 用 `-c.electronDist=node_modules/electron/dist` 出包 exit 0，`release/LLM-Proxy-0.4.10-x64-portable.exe` **111,807,864** 字节；`npm run abi:electron` exit 0（Electron 内实查询 `NODE_MODULE_VERSION 143, {"a":1}`）；39521/39522/39523 上 `npm run smoke:delivery` exit 0——解开包 health **815 ms**、代理 200、`GET /api/logs?limit=5` 200 `total 1`、`traffic.db` 4096 字节；便携壳 health **2886 ms**、同样 200 / `total 1` / `traffic.db`；跑完三端口全空闲，之后 `npm run rebuild:node` exit 0 并用实查询证明 `{"a":42}`。
- 编排方的一处表格错误更正：我在“第三轮在办记录”那次 `sed` 打在 119 与 121 行，而 121 行其实是 AI-11，于是 AI-11 被错标成“在办”、AI-12 留在“未开始”。现在 AI-11 回到“未开始”、AI-12 标“已完成”。教训：表格行号会随前置任务增删而移动，改状态单元格要用 `| AI-NN |` 定位，不要用固定行号。
- 偏差：一、它动了 `scripts/database_smoke.ts`、`test-node/proxy/proxy-runtime-registry.test.ts`、三处我划在所有权外的 `test-node` 文件与 `docs/current-architecture.md` 一行——都是类型投影让方括号读数和 `String()` 变成 lint 错误，不改它自己的门禁就过不去；`src/app/**` 与 `src/admin/**` 确实一行未动。二、`TrafficTaskWrite.kind` 从 `EndpointKind | undefined` 放宽成 `string | undefined`（`scripts/database_concurrent_writer.ts` 会写 `"concurrent-write"`，那是 TEXT 列），代价是写边界不再由类型保证。三、`repository.transaction()` 与 `database` getter 保留（基准脚本与测试用），生产侧已无一处调用与句柄。四、`log-export.ts` 与 `usage-statistics-service.ts` 仍把行类型标成 `Readonly<RepositoryRecord>`（投影可赋值、二者不写 SQL），是一个明写的后续。五、`src/pricing/money.ts` 一行未改（拆分搬的是聚合，不是算术）。六、`AGENTS.md` 在它所有权外，但该文件自己的规则要求记可复用的调试教训。七、一个提交装拆分（测试改动与类型改动不可分，拆开就是个坏提交）。
- 遗留风险（它写的，我核过的）：`_search_text` 是连接级能力，自己开连接的存储必须再注册；`TaskStore.rawRow` 是访问层最后一处未建模行，AI-19 若删 `RepositoryRecord` 就得连它改；standalone `upsertRecord` 的 `task_text` 可能滞后一次编辑（业务路径在自己写之后读，是准的）；admin 的 `LogPricingStatus` 与 codec 的 `PricingState` 今天双向可赋值。
- §8 那第三处没打：`- [ ] AI-11～13` 要等 AI-11 与 AI-13 都完成才打（同 `AI-15～16` 的先例），所以 AI-12 的“三处”只打了两处。这个例外是明写的，不是漏打。
