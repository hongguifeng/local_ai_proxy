# 当前架构

> 状态：当前
> 权威性：当前运行时、配置、模块边界和验证入口的唯一总览。
> 更新条件：启动路径、状态所有权、模块边界、持久化版本或验证入口变化时更新。

适用版本：`0.4.10`。本文只描述仓库当前的 Node.js 24、TypeScript 和 Electron 实现。Python 基线、Node 迁移过程和旧版本发布材料位于 [历史材料](../history/)，只用于追溯。

## 1. 运行模型

应用是一个 Node.js 进程和一个事件循环。代理数据面直接使用 Node HTTP 流，不经过管理端 Fastify 的响应缓冲。每个日志根由一个 `better-sqlite3` 连接维护，SQLite 使用 WAL；同一日志根的写入经 `SerialWriteQueue` 串行化。

配置保存、监听器应用和失败回滚由 `ProxyManager` 的应用队列串行处理。配置提交成功后，保持监听地址的 pair 换用新的请求流水线；在途请求继续使用旧代运行时，监听地址变化或停用才会停止旧监听器。日志写入失败记录诊断，不修改客户端已经收到的上游响应。

## 2. 启动路径

源码入口是 `src/main.ts`，CLI 解析在 `src/cli/runner.ts`；Electron 入口是 `electron/index.ts`。两者都通过 `createNodeApplication()` 装配应用，然后调用 `Application.start()`。

`src/app/runtime.ts` 的装配顺序是：读取应用配置 → 创建 `ConfigRepository` → 加载代理配置 → 创建 `ProxyManager` → 启动启用的 pair → 创建 `LogQueryService` → 装配并检查管理服务 → 启动 `AdminControlPlane`。管理服务集合在端口绑定前通过 `assertAdminServicesComplete()` 检查，缺服务会在启动阶段失败，而不是等到路由返回 404。

应用生命周期只有 `created`、`starting`、`running`、`stopping`、`stopped`。默认管理地址是 `127.0.0.1:18080`，应用级配置文件是 `llm-proxy.json`；代理配置默认是 `logs/proxies.json`，默认日志根是 `logs`。应用级配置的类型、默认值和读写位于 `src/config/application-config.ts`，代理配置默认值位于 `src/config/defaults.ts`。

## 3. 配置归属与生效时机

| 对象 | 权威所有者 | 作用域 | 说明 |
| --- | --- | --- | --- |
| 应用配置 | `loadApplicationConfig()` | 进程启动 | 管理端 host/port；缺失时创建默认文件 |
| 已提交代理配置 | `ProxyManager.config` | 当前进程 | 经过校验并冻结；保存队列以它为下一次提交的基线 |
| 配置文件 | `ConfigRepository` | 文件 | 只负责读写 `proxies.json`，不持有运行态 |
| 监听器和请求流水线 | `ProxyRuntimeRegistry` | pair 运行代 | 监听器保持不变时可热换流水线；旧代排空后释放 |
| 历史日志 | `LogQueryService`、`Repository` | 每个日志根 | 查询时根据当前 pair 的日志根重新解析，不使用启动时快照 |
| 单请求计价 | 请求开始时冻结的价格配置 | 单次请求 | 配置变化不重算已经开始的请求；历史记录使用已存结果 |

配置文件中的相对日志根以应用配置文件所在目录为基准解析。旧扁平 pair 的 pair 级 `log_root` 作为未建模键保留；当前运行读取 target 的 `log_root`，缺失时使用应用默认日志根。这个兼容行为是现行合同，若要改变必须单独更新设计和迁移说明。

## 4. 代理请求路径

请求经过监听器、请求流水线、目标选择、请求改写、上游转发、响应解码/透传和日志写入。协议分析、任务身份、payload 和 stream 解析位于 `src/proxy/protocol/`，只依赖共享工具；transport、日志和存储依赖叶模块，不通过 `src/proxy/index.ts` 反向取得运行时对象。

必须保持的外部行为包括：重复 Header 的语义、hop-by-hop Header 处理、原始请求和上游请求的区别、SSE 分帧及时转发、压缩响应字节透传、客户端取消时中止上游、响应体解码后落日志而客户端继续收到原始编码字节，以及日志失败不改变数据面结果。相关边界见 `docs/decisions/adr/` 和 `proxy-runtime` skill。

## 5. 模块地图

| 目录 | 当前职责 |
| --- | --- |
| `src/app` | 应用装配、生命周期和管理服务集合 |
| `src/cli` | CLI 参数、源码启动、信号和浏览器打开 |
| `src/config` | 应用配置、代理配置、Zod schema、规范化、原子保存和未知键保留 |
| `src/proxy` | 监听器、代理管理、请求流水线、目标路由、流、协议分析和负载均衡 |
| `src/logging` | 请求事件、任务归并、写队列和正文写入协调 |
| `src/persistence` | SQLite 连接、schema v1–v14、迁移、repository、查询和正文分块 |
| `src/maintenance` | 历史查询、统计、导出、清理、压缩和任务简介生成 |
| `src/pricing` | 用量标准化、模型匹配、金额计算和请求计价 |
| `src/admin` | Fastify 管理控制面、响应合同、路由和静态资源装配 |
| `src/admin/static` | 一个入口、ES module 浏览器模块、CSS、HTML 和 UI 合同类型 |
| `src/shared` | 错误、时间、JSON、路径、ID、日志和运行诊断 |
| `electron` | 托盘、单实例、自动启动、退出和 Electron 宿主 |

管理路由按功能分布在 `src/admin/routes/`。完整路由表和响应字段以 `test-node/admin/api-contract.test.ts` 及各路由 schema 为准；文档不要自行维护路由数量。

任务简介的规范化与校验都在 `src/maintenance`：`summary-input.ts` 把一条已存请求变成带 `event_no` 的证据事件并配好 `call_id` 的调用/结果关系，`summary-answer.ts` 只接受引用了这些编号的时间线，`summary-generation-service.ts` 负责“先读缓存、按 task 串行、校验通过才写回”。事件编号在送给模型之前就已固定，因此模型拿到的顺序就是日志里的顺序；并行调用不得被说成有因果先后，隐藏的推理也不得被转述。

## 6. 依赖方向

`npm run check:modules` 对 `src/**` 和 `electron/**` 做 AST 依赖检查，当前目标是运行时无环、无越界导入。约束如下：

- `shared` 不依赖业务领域；任何 `src` 模块不依赖 `electron`。
- transport 由 `app`、`admin`、`cli` 和装配根持有；存储、日志和维护层不导入 transport barrel。
- `src/proxy/protocol` 是协议语义叶模块，transport、日志和存储可以同向依赖它。
- repository 不反向依赖维护服务；测试可以直接导入领域内部模块，但不改变产品模块图。

新增跨领域运行时导入后先运行 `npm run check:modules`，再决定是否需要调整边界文档。

## 7. 关闭顺序

`Application.stop()` 关闭管理控制面，再调用 `ProxyManager.stopAll()`，最后释放运行时注册表中的日志连接。装配或启动失败时只回收已创建的资源。Electron 退出通过 `electron/exit.ts` 走同一条关闭路径；交付冒烟使用 `LLM_PROXY_SMOKE_EXIT_FILE` 请求退出。

## 8. 验证入口

| 目的 | 命令 |
| --- | --- |
| 全量质量门禁 | `npm run check` |
| 技能与文档路由 | `npm run check:skills` |
| 产品模块依赖 | `npm run check:modules` |
| 类型检查 | `npm run typecheck` |
| UI bundle | `npm run bundle:ui` |
| UI 视觉基线 | `npm run regen:ui-baselines` |
| 便携版 | `npm run package:electron:portable` |
| 交付冒烟 | `npm run smoke:delivery` |
| Node ABI 证明 | `npm run abi:node` |
| Electron ABI 证明 | `npm run abi:electron` |
| 两种 ABI | `npm run abi:check` |

便携打包时先构建 Node 产物，再切换到 Electron ABI 并打包；打包和冒烟完成后恢复 Node ABI。构建会清理已经不存在的 UI bundle 输出，交付检查必须确认 `app.asar` 没有残留的旧 bundle 或已删除脚本。

## 9. 文档边界

- [产品行为](product.md) 描述用户可见能力和外部行为，不重复模块实现细节。
- [当前代码合同](contracts/) 描述 API、模块依赖和视觉基线等可验证边界。
- [ADR](../decisions/adr/) 解释已经作出的关键取舍。
- [功能设计](../design/) 说明功能语义；`active/` 是未完成设计，`accepted/` 是已接受设计。
- [计划](../plans/) 记录执行状态，不代表产品已经实现。
- [报告](../reports/) 和 [历史](../history/) 是证据与背景，不是当前入口。
