# LLM Proxy 现行架构

适用版本：0.4.10。基线提交 `14ae4de`，核对于 2026-10-31。

本文只描述现行实现：Node.js 24 + TypeScript + Electron。Python 时代的设计保留在
[模块设计文档](./module-design.md) 的历史小节里，迁移过程保留在
[Node.js 重构计划](./nodejs-refactoring-plan.md) 里。改代码前先读本文，再按需读第 8 节的材料。

## 1. 运行模型

- 一个 Node 进程，一个事件循环。没有工作线程池，也没有每请求线程。
- 代理转发在上游响应到达时立刻写给客户端，数据面不经过管理端框架的缓冲。
- SQLite 由 `better-sqlite3` 同步执行，每个日志目录一个连接，WAL 模式。
- 同一个日志目录的写入经 `SerialWriteQueue` 排队，见 `src/logging/write-queue.ts`。
- 配置保存、监听器启停和数据库迁移都在 `await` 序列里完成，同一份配置不会被并发改写。
- 日志写入失败只记录诊断，不改变客户端已经收到的上游响应（ADR-005、ADR-012）。

## 2. 启动路径

| 入口         | 代码位置                            | 顺序                                                                           |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| 打包后的托盘 | `electron/index.ts`                 | 单实例检查 → 解析托盘参数 → `createNodeApplication()` → `start()` → 建托盘     |
| 源码直接运行 | `src/main.ts` → `src/cli/runner.ts` | 解析命令行 → `createNodeApplication()` → `start()` → 打印地址 → 可选打开浏览器 |

`createNodeApplication()` 在 `src/app/runtime.ts` 里装配全部服务：读取应用配置，建
`ConfigRepository`，建 `ProxyManager`，建 `LogQueryService`，建管理端。生命周期状态在
`src/app/application.ts`，取值只有 `created`、`starting`、`running`、`stopping`、`stopped`。
`src/app/shutdown.ts` 的 `ShutdownCoordinator` 目前只被 `src/app/index.ts` 导出，运行时尚未向它注册任务。

管理端默认 `127.0.0.1:18080`，应用配置文件 `llm-proxy.json`，代理配置默认 `logs/proxies.json`，
默认日志目录 `logs`。这些默认值在 `src/config/application-config.ts` 和 `src/config/defaults.ts`。

## 3. 配置归属

- `ProxyManager` 是唯一持有生效配置的对象，`manager.config` 返回冻结的已校验配置（AI-01）。
- `ConfigRepository` 只负责读写 `proxies.json`，不保存运行态。
- 配置分节更新经内部队列：`replacePairs()` 和 `updateSummaryModel()` 在执行时用当时的配置
  组合补丁，因此并发保存不会把对方的修改退回（AI-01）。
- 校验、监听端口冲突检查、监听器切换和回滚都在提交前完成；保存失败会恢复旧配置和旧监听器
  （ADR-004、ADR-011）。在途请求继续使用原来的运行时对象。
- 相对日志目录以应用配置文件所在目录为基准解析，管理端回退到该目录下的默认路径（ADR-011）。
- 历史列表和统计在每次查询时重新解析日志目录，不缓存创建时的快照（AI-02）。
- 单次请求的计价在请求开始时用当时目标配置里的 `model_prices` 冻结（`freezeRequestPricing`），
  之后不随配置变化；历史任务重算复用记录里已存的计价与 token，不重新读计价表（ADR-012）。

## 4. 关闭顺序

`application.stop()` 依次执行：关闭管理端，`manager.stopAll()`（先等配置应用队列排空，再停止
监听器），`registry.stopAll()` 关闭数据库句柄。装配阶段启动失败时只关闭已经创建的部分，
半成品监听器会被回收。

托盘退出走 `electron/exit.ts` 的 `shutdownAndQuit()`；冒烟测试通过
`LLM_PROXY_SMOKE_EXIT_FILE` 触发同一条路径（`electron/smoke-exit.ts`）。

## 5. 模块地图

| 目录               | 职责                                                       | 主要文件                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app`          | 装配、生命周期、关闭协调                                   | `runtime.ts`、`application.ts`、`shutdown.ts`                                                                                                                                                                                                                                                                |
| `src/cli`          | 命令行解析与源码启动                                       | `index.ts`、`runner.ts`、`signals.ts`、`browser.ts`                                                                                                                                                                                                                                                          |
| `src/config`       | zod 校验、配置文件读写、默认值                             | `config-schema.ts`、`config-validation.ts`、`config-normalizer.ts`、`config-repository.ts`、`application-config.ts`、`defaults.ts`                                                                                                                                                                           |
| `src/proxy`        | 监听器、转发、请求流水线、负载均衡                         | `proxy-listener.ts`、`proxy-manager.ts`、`proxy-runtime-registry.ts`、`proxy-request-pipeline.ts`、`upstream-forwarder.ts`、`routing.ts`、`target.ts`、`api-request.ts`、`streams.ts`、`payload.ts`、`headers.ts`、`response-decoder.ts`、`load-balancer.ts`、`load-monitor.ts`、`protocol/task-identity.ts` |
| `src/logging`      | 请求事件落库、任务归并、正文存储                           | `traffic-log-service.ts`、`task-matcher.ts`、`write-queue.ts`                                                                                                                                                                                                                                                |
| `src/persistence`  | SQLite schema、迁移、按变更原因拆分的存储模块与唯一入口    | `database.ts`、`repository.ts`（唯一入口与业务写事务）、`task-store.ts`、`record-store.ts`、`search-store.ts`、`pricing-store.ts`、`generated-text-store.ts`、`column-codec.ts`、`access-contracts.ts`、`schema-v1.ts` 到 `schema-v13.ts`、`body-storage.ts`                                                 |
| `src/maintenance`  | 历史查询、统计、压缩、清理、导出、备份、摘要与任务简介生成 | `log-query-service.ts`、`usage-statistics-service.ts`、`log-cleanup.ts`、`log-export.ts`、`summary-model-client.ts`、`summary-generation-service.ts`、`summary-input.ts`、`summary-answer.ts`、`summary-prompts.ts`                                                                                          |
| `src/pricing`      | 计价解析与用量换算                                         | `model-catalog.ts`、`model-price-matcher.ts`、`request-pricing.ts`、`usage-accumulator.ts`、`usage-normalizer.ts`、`money.ts`                                                                                                                                                                                |
| `src/admin`        | Fastify 管理 API、静态页面装配                             | `admin-server.ts`、`admin-contracts.ts`、`admin-schemas.ts`、`static-assets.ts`、`routes/`（8 个功能文件）                                                                                                                                                                                                   |
| `src/admin/static` | ES module 入口与模块、`app.css`、`index.html`              | `entry.js`、`modules/`（`core.js`、`history.js`、`json-pane.js`、`task-detail.js`、`statistics.js`、`metrics.js`、`wiring.js` 等）                                                                                                                                                                           |
| `src/shared`       | 运行诊断、JSON/JSONL、时间与错误工具                       | `runtime-diagnostics.ts`、`json.ts`、`time.ts`、`errors.ts`、`logger.ts`、`paths.ts`、`ids.ts`                                                                                                                                                                                                               |
| `electron/`        | 托盘、单实例、登录项、冒烟退出                             | `index.ts`、`single-instance.ts`、`auto-start.ts`、`smoke-exit.ts`                                                                                                                                                                                                                                           |
| `src/ui/static/`   | 只有 `.gitkeep`，不是 UI 源                                | UI 源在 `src/admin/static/`                                                                                                                                                                                                                                                                                  |

管理端路由按功能注册在 `src/admin/routes/` 下，只有对应服务存在时才注册。
`test-node/admin/api-contract.test.ts` 钉住路由表和顶层响应键，包括空配置的情况。
`src/proxy/protocol/` 是 proxy 目录内的叶模块区：`analysis.ts`（协议分析）、
`task-identity.ts`（任务身份）、`payload.ts` 与 `streams.ts`（负载和 SSE 解析）。这一区对外只
依赖 `src/shared`，transport 和存储都直接引用具体文件，不经 `src/proxy/index.ts` barrel。

## 6. 依赖方向

方向由 `scripts/module-edges.ts` 用 TypeScript AST 检查，入口是 `npm run check:modules`：
它扫 `src/**` 和 `electron/**`，把写成 `.js` 的内部说明符解析回 `.ts` 源和目录 barrel，
排除纯类型 import 与 `export type`，报出运行时 import/re-export 环和越界导入的具体依赖链。

- transport 运行时（`proxy-listener.ts`、`proxy-manager.ts`、`proxy-runtime-registry.ts`、
  `proxy-request-pipeline.ts`）只由控制面 `src/app`、`src/admin`、`src/cli` 和装配根持有。
  `src/proxy/index.ts` barrel 连带这些文件，所以存储、读取和支撑领域只直接导入 proxy 的
  叶模块，不导入 barrel。
- 请求与响应的语义——端点分类、指纹、任务身份、负载与 SSE 解析——住在 `src/proxy/protocol/`。
  transport 和存储同向指向它。在此之前存储经 `src/proxy/index.ts` 反向拿到运行时，形成
  `proxy/index.ts`、`proxy-manager.ts`、`proxy-runtime-registry.ts`、`logging/index.ts`、
  `task-matcher.ts`、`traffic-log-service.ts` 六文件运行时环；AI-10 已把它消除，检查器在
  当前源码上报 0 环、0 越界。
- repository 不反向依赖 service，`shared` 不依赖任何业务领域，任何 `src` 模块不导入
  `electron/`，transport 不依赖 admin/app/cli。
- 新增跨领域运行时导入之前先跑一次检查器；测试夹具仍可直接导入领域内部模块，检查器不扫
  `test-node/`。

## 7. 验证入口

| 目的                                            | 命令                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 静态检查与全量测试                              | `npm run check`                                                                                 |
| 全量类型检查                                    | `npm run typecheck`                                                                             |
| 只编译产品与打包工具                            | `npm run build`                                                                                 |
| UI 组装与静态资源构建                           | `npm run bundle:ui`                                                                             |
| UI lint 与类型检查                              | `npm run lint`、`npm run typecheck`                                                             |
| 便携版打包                                      | `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never` |
| UI 基线重生成                                   | `npm run regen:ui-baselines`                                                                    |
| 文档格式检查                                    | `npx prettier --ignore-path .gitignore --check docs`                                            |
| Node 测试前的原生模块 ABI                       | `npm rebuild better-sqlite3`                                                                    |
| Node 侧 SQLite ABI 用真实查询证明               | `npm run build && npm run abi:node`                                                             |
| Electron 侧 SQLite ABI 用真实查询证明           | `npm run abi:electron`（先 `npm run rebuild:electron`，产物与本地 Electron 都要 Electron ABI）  |
| 两种运行时都要证明                              | `npm run abi:check`                                                                             |
| unpacked 载荷交付冒烟（`release/win-unpacked`） | `npm run smoke:payload`                                                                         |
| portable 包装器交付冒烟（真正发布的 exe）       | `npm run smoke:artifact`                                                                        |
| 按顺序跑完两个交付冒烟                          | `npm run smoke:delivery`（先载荷，后包装器）                                                    |
| 运行时模块环与越界导入                          | `npm run check:modules`                                                                         |

`npm rebuild better-sqlite3` 只在最终 Electron 重建之前跑一次；在 Electron 重建之后、打包之前
再跑一次会让便携版带上 Node ABI 的模块并在启动时失败。Windows 上跑测试和基线命令请从大写
盘符进入（`cd /D/...`）。

`npm run build` 用 `tsconfig.build.json` 只把 `src`、`electron` 和 `scripts` 编译进 `dist-node`，随后复制静态资源并生成 UI bundle：
测试实现不进产品产物，也不参与打包。`npm run typecheck` 用 `tsconfig.json` 检查产品、测试和
工具，再用 `tsconfig.ui.json` 对完整浏览器 ESM 图执行 `checkJs`、`strictNullChecks` 与 `exactOptionalPropertyTypes` 检查，所以测试里的类型错误照样能让 `npm run check`
失败，但不会改变产品编译。`electron-builder.yml` 的 `files` 按这三棵编译树逐项列出，输出目录里
残留的其他文件进不了包。

ABI 证明只认真实查询：`require("better-sqlite3")` 不碰原生绑定，两种 ABI 下都会打印成功，所以
`abi:node`、`abi:electron` 和 `smoke:database` 都打开 `:memory:` 库跑 `select 1`。ABI 不匹配时报出
两个 `NODE_MODULE_VERSION` 数字和该跑的重建命令，不是堆栈。

交付冒烟有两个入口，顺序固定：先 `npm run smoke:payload` 跑 `release/win-unpacked/LLM Proxy.exe`，
再 `npm run smoke:artifact` 跑 portable 包装器。包装器会往 Temp 解包并在退出时删掉那个目录，同
一构建的另一次运行可能占住它，所以包装器失败时先用载荷冒烟判定产物本身是否还好；脚本把这种冲
突报成“解包目录冲突、不是载荷回归”，并且只杀自己启动的进程。每个运行都用独立的临时配置、独立
`LLM_PROXY_DATA_DIR`、绝对日志根和退出信号文件，除 `/api/health` 外还要求一次真实代理往返 200、
`GET /api/logs?limit=5` 返回 200 且 `total >= 1`（500 说明包内 SQLite 绑定加载不了，是 ABI 问题）、
以及该次运行的日志根里出现 `traffic.db`；关闭后临时目录会被删除。脚本自己会从子进程环境里删掉
`ELECTRON_RUN_AS_NODE`；要固定端口就设 `LLM_PROXY_SMOKE_ADMIN_PORT`、`LLM_PROXY_SMOKE_PROXY_PORT`、
`LLM_PROXY_SMOKE_UPSTREAM_PORT`，未设置时脚本自选空闲端口。

## 8. 材料身份

| 材料                                                                                                   | 身份                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 本文、[待办清单](./ai-development-optimization-todo.md)                                                | 现行                                                                                                                               |
| [模块设计文档](./module-design.md)                                                                     | 第 2、3、6 节是 Python 基线历史记录；第 4、5 节描述现行前端与数据模型；第 7～9 节是已实现的 Node 目标；第 10 节的问题已由 ADR 决定 |
| [软件功能说明书](./software-functional-specification.md)                                               | Python 基线起步，持续追加现行功能；引用时以现行代码为准                                                                            |
| [重构计划](./nodejs-refactoring-plan.md)、[重构 TODO](./nodejs-refactoring-todo.md)                    | 已完成的历史计划，记录当时为什么这样切                                                                                             |
| [性能实验](./proxy-benchmark.md)、[Python 分块请求限制](./refactoring/python-chunked-request-limit.md) | 历史记录与测量，不代表现行结论                                                                                                     |
| [发布说明](./release-notes-v0.3.0.md) 及各 rc 说明                                                     | 版本历史记录                                                                                                                       |
| [ADR-001～ADR-013](./adr/)                                                                             | 决策依据，仍然有效                                                                                                                 |
| `.agents/skills/`                                                                                      | 现行操作手册，按需读取                                                                                                             |

## 9. 仍未收口的事项

配置与统计（AI-01、AI-02）、数据库版本来源（AI-03）、类型与 API 合同（AI-05～AI-09）、运行时边界、日志查询与持久化职责（AI-10～AI-13）、SSE 与场景测试（AI-14）、编译与交付入口、代理配置与负载均衡、历史与指标模块化（AI-15～AI-19）、UI 类型与 DOM 合同（AI-20）、渲染输入与缓存失效（AI-21）已经收口。其余见
[待办清单](./ai-development-optimization-todo.md)：组件样式归属（AI-22）、skills 收口（AI-23）以及综合验收（AI-24）。旧配置键保留（AI-25）已经完成，综合验收仍需复核其最终交付证据。
