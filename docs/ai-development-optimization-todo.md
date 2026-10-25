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
| [ ]  | AI-07 | P1     | 查询结果和服务契约类型化    | AI-06                                                                                                                                                           | 未开始 |
| [ ]  | AI-08 | P1     | API schema 与客户端契约统一 | AI-07                                                                                                                                                           | 未开始 |
| [ ]  | AI-09 | P1     | 完整应用的服务装配约束      | AI-01、AI-02、AI-07、AI-08                                                                                                                                      | 未开始 |
| [ ]  | AI-10 | P1     | 消除运行时依赖环            | AI-06                                                                                                                                                           | 未开始 |
| [ ]  | AI-11 | P1     | 分离模型调用与日志查询      | AI-01、AI-05、AI-07、AI-10                                                                                                                                      | 未开始 |
| [ ]  | AI-12 | P1     | 按职责拆分持久化访问        | AI-06、AI-07、AI-10                                                                                                                                             | 未开始 |
| [ ]  | AI-13 | P1     | 稳定历史迁移依赖            | AI-03、AI-10、AI-12                                                                                                                                             | 未开始 |
| [ ]  | AI-14 | P1     | 补齐场景测试并稳定时序验证  | AI-01、AI-02、AI-05、AI-08、AI-09                                                                                                                               | 未开始 |
| [ ]  | AI-15 | P2     | 分离产品、测试与工具编译    | 无                                                                                                                                                              | 未开始 |
| [ ]  | AI-16 | P2     | 固化 ABI 和交付冒烟流程     | AI-15                                                                                                                                                           | 未开始 |
| [ ]  | AI-17 | P2     | 建立前端模块构建入口        | AI-08、AI-15                                                                                                                                                    | 未开始 |
| [ ]  | AI-18 | P2     | 模块化代理配置与负载均衡    | AI-17                                                                                                                                                           | 未开始 |
| [ ]  | AI-19 | P2     | 模块化历史、详情和指标      | AI-11、AI-17、AI-18                                                                                                                                             | 未开始 |
| [ ]  | AI-20 | P2     | 收紧 UI 类型与 DOM 合同     | AI-18、AI-19                                                                                                                                                    | 未开始 |
| [ ]  | AI-21 | P2     | 统一渲染输入和缓存失效      | AI-19、AI-20                                                                                                                                                    | 未开始 |
| [ ]  | AI-22 | P2     | 建立组件样式归属            | AI-18、AI-19、AI-21                                                                                                                                             | 未开始 |
| [ ]  | AI-23 | P2     | 整理 skills 并固化操作入口  | AI-04、AI-14、AI-16、AI-20、AI-21、AI-22                                                                                                                        | 未开始 |
| [ ]  | AI-24 | P2     | 综合验收与文档收口          | AI-01、AI-02、AI-03、AI-04、AI-05、AI-06、AI-07、AI-08、AI-09、AI-10、AI-11、AI-12、AI-13、AI-14、AI-15、AI-16、AI-17、AI-18、AI-19、AI-20、AI-21、AI-22、AI-23 | 未开始 |

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

- [ ] 为任务计价、三类趋势、请求计价、摘要和简介提供具体返回类型。
- [ ] 将数据库行到服务模型、服务模型到响应的转换放到明确边界。
- [ ] 统一服务接口和真实实现，清理 unknown 返回值及重复定义。
- [ ] 为有业务意义的空值、缺失值、pending 和未计价状态建立明确合同。
- [ ] 用有类型的 fixture 构造器减少重复载荷；移除整份服务的双重强转。

验收：服务字段重命名或遗漏能影响真实消费者的编译检查。外部模型的原始 JSON 仍可保持开放结构。

验证：V-B、V-P；运行 maintenance、statistics、admin 和 UI fixture 的相关检查。

### AI-08：API schema 与客户端契约统一

入口：[响应 schema](../src/admin/admin-schemas.ts)、[路由](../src/admin/routes)、[前端 API 助手](../src/admin/static/01-core.js)、[API 契约测试](../test-node/admin/api-contract.test.ts)。

- [ ] 为项目自有 DTO 选择统一 schema 来源，并推导 TypeScript 类型和可用的 Fastify schema。
- [ ] 补齐日志、计价、趋势、统计、总结设置及摘要的字段结构。
- [ ] 任意用户请求/响应 JSON 使用显式开放字段，避免误删原始内容。
- [ ] 建立客户端的类型化访问边界，覆盖消费者字段的检查。
- [ ] 使用非空数据测试嵌套字段、数组元素、空值及大金额字符串。

验收：字段漂移在编译或契约测试阶段失败。HTTP 往返保留客户端实际使用的字段；错误载荷不被误当成功结果。不能仅以存在 response schema 计为完成。

验证：V-B、V-U、V-P；运行 API 契约和相关 UI 测试。本项允许先用 JSDoc 引用契约，模块导入在 AI-17～19 完成。

### AI-09：完整应用的服务装配约束

入口：[应用装配](../src/app/runtime.ts)、[AdminServerOptions](../src/admin/admin-contracts.ts)、[管理服务](../src/admin/admin-server.ts)。

- [ ] 为正式应用建立必需的完整服务集合，遗漏方法应在编译或启动时失败。
- [ ] 将用于测试的部分服务装配做成显式入口或选项。
- [ ] 让日志查询、总结、统计等服务的生命周期和持有者清晰可见。
- [ ] 保留真实应用装配测试，覆盖必需 GET 及关键写操作。

验收：新增正式功能后忘记接线，不会悄悄表现为路由 404。业务对象不存在与路由未注册有稳定的不同错误结果。

验证：V-B、V-P；运行 `test-node/app/runtime.test.ts`、`test-node/admin/api-contract.test.ts` 及相关路由测试。

### AI-10：消除运行时依赖环

入口：[proxy 导出](../src/proxy/index.ts)、[运行时注册表](../src/proxy/proxy-runtime-registry.ts)、[日志服务](../src/logging/traffic-log-service.ts)、[任务身份](../src/proxy/task-identity.ts)。

- [ ] 将协议分析、任务身份和纯记录处理放入职责明确的叶模块。
- [ ] 避免低层 helper 通过包含 manager/registry 的大 barrel 引入运行时。
- [ ] 依据实际职责更新依赖方向，保持 transport、存储和控制面的边界。
- [ ] 用 AST 或成熟工具检查运行时 import/re-export 环，排除纯类型导入。
- [ ] 增加边界校验，并用必然违规的样例验证校验器有效。

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

- [ ] 按任务、记录、搜索和计价聚合等变化原因拆分内部职责。
- [ ] 保持同一个业务写入事务覆盖 task、record、links 和搜索同步。
- [ ] 所有写操作使用明确输入类型，查询返回明确投影。
- [ ] 收敛裸 database 暴露，清理业务层直接 SQL 的不必要入口。
- [ ] 保留分页、批量查询、正文延迟读取和金额精度。

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

- [ ] 为产品、测试和开发工具建立清晰的 TypeScript 编译入口。
- [ ] 产品 build 不编译测试实现，完整 typecheck 仍覆盖所有源码。
- [ ] 保证打包所需工具按需编译，更新脚本使用的实际产物路径。
- [ ] 同步 CLI archive、Electron files 和 CI 的路径及执行顺序。
- [ ] 从干净输出目录验证，避免旧文件掩盖缺失产物。

验收：测试类型错误能使质量门禁失败，但不会成为产品代码编译的隐式输入。产物不包含测试；CLI、静态资源和打包工具均可运行。

验证：V-B、V-P；运行 `test-node/admin/built-static-assets.test.ts`、Electron 构建配置和相关 CLI 测试。

### AI-16：固化 ABI 和交付冒烟流程

入口：[npm scripts](../package.json)、[数据库 smoke](../scripts/database_smoke.ts)、[产物 smoke](../scripts/artifact_smoke.ts)、[发布工作流](../.github/workflows/release.yml)。

- [ ] 为 Node 与 Electron 验证提供明确入口，用真实查询证明 SQLite ABI。
- [ ] 将清理 ELECTRON_RUN_AS_NODE 等启动条件写进脚本。
- [ ] 使用唯一临时配置、独立 userData、空闲端口和可追踪的子进程。
- [ ] 除 health 外，检查日志接口和实际建库；关闭后清理临时资源。
- [ ] 区分 portable 包装器与 unpacked 载荷冒烟，按顺序执行，避免共享目录冲突。

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

- [ ] AI-01：代理和总结设置交错更新互不覆盖，失败不暴露未提交状态。
- [ ] AI-02：统计随日志目录变更生效，空配置下接口返回合法空结果。
- [ ] AI-03：公共 schema 版本、新库和备份恢复版本一致。
- [ ] AI-04：存在唯一现行架构入口，历史基线有明确身份。
- [ ] AI-05：业务错误按稳定分类映射，内部失败有足够诊断信息。
- [ ] AI-06～08：自有日志和 API 数据有具体契约，嵌套字段受验证。
- [ ] AI-09：完整应用遗漏服务接线时有确定失败反馈。
- [ ] AI-10：运行时依赖环消除，并有有效的自动检查。
- [ ] AI-11～13：查询、模型生成和存储职责明确，历史迁移结果稳定。
- [ ] AI-14：操作序列和流式边界有回归测试，时序问题有定位记录。
- [ ] AI-15～16：产品构建、测试检查、ABI 与交付验证入口明确可重复。
- [ ] AI-17～20：前端通过模块边界协作，过渡桥接清除，严格检查生效。
- [ ] AI-21：渲染与缓存输入一致，刷新和大正文体验保持。
- [ ] AI-22：组件样式归属明确，层叠与像素验证无意外变化。
- [ ] AI-23：skills 内容简明且有效，固定操作由工具承担。
- [ ] AI-24：完整检查、截图核验、portable 构建与隔离冒烟有实际记录。

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
- 提交 SHA：未提交

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
- 提交 SHA：未提交

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
- 提交 SHA：未提交

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
- 提交 SHA：未提交

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
- 提交 SHA：未提交

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
- 提交 SHA：未提交
