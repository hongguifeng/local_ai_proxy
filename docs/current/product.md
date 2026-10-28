# 当前产品行为

> 状态：当前
> 权威性：用户可见能力、配置语义和代理外部行为的总览。
> 更新条件：新增、删除或改变用户可见功能、配置字段、协议行为或数据兼容时更新。

本文只描述当前 Node.js 24 + Electron 实现。实现位置、生命周期和验证入口见[当前架构](architecture.md)；历史 Python 行为见 `docs/history/`，不能用来推断当前产品。

## 1. 产品边界

LLM Proxy 是本地 HTTP 代理和 Web 控制台，用于检查 Agent、SDK 或其他客户端发往 OpenAI-compatible、Anthropic/Claude Messages 风格上游的请求和响应。用户通过管理控制面配置多个本地代理 pair、多个上游 target 和可选的负载均衡组；代理数据面接收请求、选择目标、改写请求并透传响应；日志系统把请求、响应和任务关系保存到 SQLite，供历史浏览、搜索、统计、导出和清理。

产品有三类入口：

1. 源码 CLI：`npm start` 启动管理端和启用的代理。
2. Electron 托盘：单实例启动管理端，提供打开管理页面、自动启动和退出。
3. 管理控制台：配置代理、查看历史、查看统计和管理目标状态。

## 2. 配置模型

配置文件分为两层：应用配置 `llm-proxy.json` 只包含管理端 host/port；代理配置 `logs/proxies.json` 包含 pair、target、model mapping、价格规则和负载均衡组。相对路径以应用配置文件所在目录为基准。

| 对象 | 关键字段 | 行为 |
| --- | --- | --- |
| Pair | `id`、`name`、`enabled`、`listen_host`、`listen_port` | 一个本地监听器和一组上游目标 |
| Target | `id`、`target_url`、headers、字段改写、`log_root`、价格 | 一个上游服务和它的日志/计价设置 |
| Model mapping | `listen`、`upstream` | 按顺序匹配模型名，可改写上游模型名 |
| Load balancer group | `model_pattern`、策略、members | 对同一模型的多个 target 做任务粘性和负载选择 |
| Summary model | provider、model、endpoint 等 | 任务简介生成的控制面配置，不参与代理路由 |

配置保存是整体提交：先校验新配置，再保存并应用运行态；失败时恢复配置和监听器。保持 host/port 的 pair 使用新流水线，旧请求继续完成；改变监听地址、停用或删除 pair 会停止旧监听器。未知的配置键会随所属对象保留，以便打开并保存较旧或较新的配置时不静默丢数据。

负载均衡组另有一个自动再均衡模式 `rebalance_mode`：`off`（默认）、`advise`、`auto`。`off` 的组不计算任何自动动作；
`advise` 的组只在状态 API 与运行日志里给建议，不改绑定；`auto` 在今天与 `advise` 行为相同，并在状态里命名
`disabledReason: "not_calibrated"`——真实引擎校准尚未完成，自动改绑不存在。建议只存在内存里，随 pair 停止一起丢弃，
不落盘、不进 traffic 数据库。

## 3. 请求与响应

请求路由规则如下：

1. 尝试把完整请求体解析为 JSON object，并读取字符串字段 `model`。
2. 启用的负载均衡组优先匹配 `model_pattern`；命中后按组成员的 `model_id` 改写模型，成员自身的 model mapping 不参与。
3. 普通路由按配置顺序检查目标和 `model_mappings`，第一个匹配项选中目标。
4. 没有模型、JSON 非法、没有映射命中或默认目标兜底时使用 `default_target_id`。
5. 目标配置按顺序执行字段删除、字段注入、Header 处理和上游路径拼接。

当前代理合同包括：

- 支持常见 HTTP 方法和 HTTP/HTTPS 上游；不提供 HTTP/2、WebSocket 或 CONNECT 隧道。
- 过滤 hop-by-hop Header，处理 Host、鉴权和自定义 Header；重复 Header 的语义由 Node HTTP 层和当前测试合同共同定义。
- SSE 逐帧转发，普通响应按流转发；不等待整个响应体才向客户端写入。
- 客户端取消后中止对应上游请求；上游已经返回的响应字节保持已发送结果。
- 压缩响应的客户端字节保持原样；日志在可解码时保存解码后的正文。
- 日志写入失败只进入运行诊断，不把已经成功完成的上游响应改成失败。

这些边界的详细依据见 [代理运行 ADR-005](../decisions/adr/005-client-abort-behavior.md)、[ADR-012](../decisions/adr/012-decoded-response-body-in-logs.md) 和 `proxy-runtime` skill。

## 4. 历史与统计

历史页面以 task 为一级分组、以 record 为请求级明细，支持分页、搜索、JSON 树、正文复制、导出和删除。请求体和响应体使用分块存储与去重；历史数据库由 `src/persistence/database.ts` 按 schema v1–v14 迁移。打开历史时按当前配置得到日志根，不能把运行时事件列当成“仍在处理”的唯一依据；待响应语义以统计摘要的 `cost.pending_request_count` 为准。

统计页面读取日志根内的已存 token、价格和请求时间，展示总量、费用、未计价数和趋势。单次请求的计价在请求开始时冻结，历史记录不会因后来修改价格配置而被重新解释。价格匹配和金额精度规则见 [模型定价设计](../design/accepted/model-token-pricing.md)。

任务简介是任务明细面板里按需生成的执行过程说明，不是日志之外的第二份真相。生成时服务端先把该 task 最新一次已完成请求规范化成按 `event_no` 编号的证据事件（Responses `input` 与 Chat `messages` 同一套规则，`tool_call` 与 `tool_result` 按 `call_id` 配对，未配对的结果只保留自己的编号），再把编号事件交给总结模型；模型只能解释这些事件，不能新增没出现的操作，也不能引用不存在的编号。事件的顺序由服务端固定，所以并行发出的工具调用不会被解释成有先后的因果关系。只有日志里公开的推理摘要会成为事件，隐藏的 chain-of-thought 不读取、不保存也不转述。时间线写回缓存前逐条校验：`evidence` 越界、阶段没有证据、首阶段不从 1 开始、阶段没写操作，或 `basis` 不是 `unknown` 却没写目的/结果，都算生成失败，旧缓存保持不变（`unknown` 就是“日志没说”，允许那一项留空）。阶段数量、每条阶段引用的证据数量和缺口数量都不设上限——长任务就产生长时间线，长时间线不会把面板拉长：卡片里只留概述、环境信息和元信息，阶段、缺口和原始事件放在点开“执行过程”按钮后才弹出的窗口里，窗口头部不滚、正文自己滚；只有单个文本字段按 `TASK_TIMELINE_TEXT_LIMIT` 截断、概述按 `TASK_BRIEF_TEXT_LIMIT` 截断。缓存里的时间线、来源事件、来源 request 序号、事件数和一份覆盖整个送模型输入的指纹一起落库（schema v14）；面板把概述、环境信息标签和元信息留在卡片里，把阶段、依据（observed / inferred / unknown）、缺口和可展开的原始事件放在点开“执行过程”后才弹出的窗口里（只有带时间线的简介才给这枚按钮），并在来源不再是最新请求时把“较早记录”标在元信息行最前面。指纹是这份输入的凭证，不是“较早记录”的判据：判断新旧比的是 record id，因为重算指纹要把请求体解出来，而打开面板不该付这个代价。打开面板只读缓存，不调用总结模型；只有点击按钮才 POST。已写入但没有时间线的旧缓存仍显示其段落与环境信息，不伪造阶段。

## 5. 管理控制面

管理 API 是 UI 与后端共同拥有的内部合同，不作为外部 SDK 承诺。路由按功能分布在 `src/admin/routes/`，服务装配在 `src/app/admin-services.ts`，schema 和公开类型分别位于 `src/admin/admin-schemas.ts`、`src/admin/admin-contracts.ts`。完整字段以代码和 `test-node/admin/` 合同测试为准，文档只保留语义和入口。

控制面包括：

- pair 和 target 的配置、校验、保存、启停与监听状态。
- 目标测试、模型列表拉取、模型映射和价格配置。
- 负载均衡组、节点状态、成员选择和粘性任务状态；组的自动再均衡模式、建议列表与未校准降级。
- 历史 task/record 查询、搜索、详情、导出、清理和删除。
- 使用统计、任务简介和运行健康状态。

## 6. UI 合同

浏览器代码是由 `src/admin/static/entry.js` 和 `modules/` 组成的单一 ES module bundle。页面状态由模块持有，测试接口只有冻结的 `__adminUiTest`；不要恢复旧的全局渲染函数或按编号拼接脚本。UI 类型和 DOM 合同见 [模块边界](contracts/module-boundaries.md)，视觉基线和截图规则见 [视觉基线](contracts/ui-visual-baseline.md)。

中文和英文是两个完整界面 locale。当前文档正文统一使用中文；UI 文案、API 字段和代码标识符按产品需要保留英文。

## 7. 数据与兼容

用户数据包括应用配置、代理配置和每个日志根下的 `traffic.db`。迁移只在隔离副本上验证；正式操作遵循[迁移与回滚手册](../operations/migration-rollback.md)。当前兼容边界如下：

- 旧配置中的未知键保留；旧扁平 pair 的 pair 级 `log_root` 保留但不决定 target 日志根。
- 旧 traffic database 通过迁移打开；正文分块、FTS 和任务关联必须保持可读。
- 历史 JSON 请求/响应和 meta 字典保持开放，以容纳协议字段；已定义的核心字段仍由类型和测试约束。
- 内部 TypeScript API 没有 Python 兼容层，也不因历史文档中的模块名保留旧路径。

## 8. 非目标

当前产品不承诺：

- 用户登录、多租户云部署或远程管理端鉴权。
- HTTP/2、WebSocket、CONNECT 或通用反向代理协议扩展。
- 把历史记录自动重算为新价格，或用历史日志伪造实时路由锁。
- 把尚未完成的 `docs/design/active/` 设计当作已发布功能。
