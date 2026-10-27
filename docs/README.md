# 文档导航

> 状态：历史
> 权威性：背景材料，不作为当前实现依据。
> 更新条件：仅在补充历史事实或修正链接时更新。

本目录按文档的**用途和生命周期**组织。AI 开始修改代码时只需要先读“当前”目录；设计、计划、报告和历史材料按任务需要读取。

## 先读什么

| 任务 | 首要材料 | 继续阅读 |
| --- | --- | --- |
| 修改运行时、配置、存储或启动 | [当前架构](current/architecture.md) | [当前产品行为](current/product.md)、相关 ADR |
| 修改管理 API 或浏览器 UI | [当前架构](current/architecture.md) | [API 合同](current/contracts/admin-api.md)、[模块边界](current/contracts/module-boundaries.md)、对应 UI skill |
| 修改代理数据面、日志或重载 | [当前架构](current/architecture.md) | [当前产品行为](current/product.md)、`proxy-runtime` skill、相关 ADR |
| 实现新功能 | 当前架构 | [已接受设计](design/accepted/)、[进行中设计](design/active/)、对应计划 |
| 排查构建、打包、数据或运行问题 | 当前架构的验证入口 | [运维手册](operations/)、对应 skill |
| 研究历史行为或迁移原因 | 当前架构的文档边界 | [历史材料](history/)、[决策记录](decisions/adr/) |

## 关键入口

| 文档 | 用途 |
| --- | --- |
| [当前架构](current/architecture.md) | 启动、配置、模块、关闭和验证 |
| [当前产品行为](current/product.md) | 用户能力、代理合同、数据兼容和非目标 |
| [管理 API 合同](current/contracts/admin-api.md) | schema、服务接线、开放字段和错误语义 |
| [模块边界](current/contracts/module-boundaries.md) | TypeScript、barrel、UI bundle 和依赖检查 |
| [UI 视觉基线](current/contracts/ui-visual-baseline.md) | 截图、哈希和视觉差异规则 |
| [task 路由设计](design/active/task-routing.md) | 当前仍在收敛的功能设计 |
| [task 路由计划](plans/active/task-routing.md) | 当前执行状态和验收项 |


- `current/` 只描述当前代码、当前用户行为和当前仍需遵守的内部合同。它是修改代码的默认入口。
- `decisions/adr/`：记录 13 项已作出的架构决策。
- `design/accepted/`：保存[历史摘要](design/accepted/history-summary.md)、[负载均衡](design/accepted/load-balancing.md)、[模型定价](design/accepted/model-token-pricing.md)、[任务简介](design/accepted/task-brief.md)和[使用统计](design/accepted/usage-statistics.md)设计；`design/active/` 目前只有 [task 路由](design/active/task-routing.md)。
- `plans/active/`：目前只有 [task 路由执行计划](plans/active/task-routing.md)；完成的计划进入 `plans/archive/`。
- `operations/` 保存可重复执行的故障处理、迁移和发布操作。
- `reports/` 保存一次验收、基准或实验的结果。报告中的数字带有测量时点，不自动成为当前规则。
- `history/` 保存 Python 基线、Node 迁移过程和旧版本发布材料，仅用于追溯，不能作为当前实现依据。

## 状态和语言规则

每份新增或重构的文档开头都要写明 `状态`、`权威性` 和 `更新条件`。状态只使用：`当前`、`设计中`、`计划中`、`决策记录`、`报告`、`历史`。

当前文档、进行中的设计和计划统一用中文叙述；代码符号、文件名、命令、HTTP 字段和协议名称保留原文。历史发布说明保留当时的原始语言，以免改写发布证据；历史文档必须在开头明确标记为历史。不要在同一份当前文档中交替使用中英文段落表达同一概念。

每份文档只保留一个权威入口。复制另一份文档的整段合同会制造漂移；需要引用时链接到权威文档，并说明本文件只保留什么范围。

## 维护检查

改动文档后至少检查：

1. 目标文档中的本地链接和命令仍然存在。
2. 当前文档没有把历史实现写成现行行为。
3. 设计、计划、报告分别标明状态，不用“TODO”标题掩盖完成或取消的工作。
4. 中文正文没有无意混入另一种自然语言；代码和命令不算混用。
5. 使用 `npx prettier --ignore-path .gitignore --check <文件>` 检查 `docs/` 下的改动。
6. 改动 `AGENTS.md` 或 `.agents/skills/` 时运行 `npm run check:skills`。
