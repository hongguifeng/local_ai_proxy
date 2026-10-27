---
name: todo-workflow
description: >-
  Write and execute repository TODO and task-plan documents without stale status, duplicated
  contracts or unverifiable completion claims. Use when creating, revising, executing, closing,
  archiving or recovering work from a TODO, active plan or historical task list.
---

# TODO 文档与执行流程

## When this applies

- 新建或修改 `docs/plans/active/`、`docs/plans/archive/` 中的 TODO、执行计划或完成记录。
- 根据 TODO 实现代码、配置、API、持久化、UI、打包或验证工作。
- 关闭一项任务、记录阻塞、把历史完成记录从 active plan 移到报告或历史目录。
- 长任务、委派任务或超时恢复需要 checkpoint、独立验证和证据收口。
- 评审 TODO 中的状态、依赖、验收项、命令、链接或历史事实是否仍与当前仓库一致。

## Invariants

### 1. 先确定文档和状态的权威

- `docs/current/` 只描述已经由代码、测试或实测确认的当前行为。
- `docs/design/` 描述产品语义、替代方案、非目标和未解决问题；它不能单独宣布实现完成。
- `docs/plans/active/` 只保留当前执行状态、依赖、待办、当前任务完成记录和未解决阻塞。
- `docs/reports/` 保存带版本、输入、命令和边界的一次验收、实验或历史整合证据。
- `docs/plans/archive/` 和 `docs/history/` 只用于追溯，不能作为当前实现入口。
- 一个当前合同只能有一个权威入口；TODO 通过链接引用合同，不复制完整 API 字段表或运行语义。

### 2. TODO 的状态、依赖和任务形状必须可执行

- 文档元数据的 `状态` 必须符合目录约定；任务行只能使用 `未开始`、`进行中`、`阻塞`、`已完成`。
- 每个任务必须写明任务 ID、前置任务、代码入口、实现清单、验收条件和验证命令。
- “已完成”要求实现、相关测试、文档同步和任务验收都完成；代码合并或一次测试通过都不够。
- “阻塞”必须写清缺少的证据、禁止的替代品、解除条件和下一次可执行动作。
- 依赖图只允许引用当前计划中的任务或明确链接到外部前置；发现循环依赖时先改计划，不能靠跳项继续。
- 单项任务应能在一个可审查范围内完成；大任务按实现、专项验证、文档收口和交付验证拆成子阶段。

### 3. 开始任务前重新核对当前事实

- 先读 `AGENTS.md`、`docs/README.md`、`docs/current/architecture.md`，再读任务引用的设计和专项 skill。
- 从当前源码和测试追踪状态所有者、读入口、写入口、失败路径、reload/stop、删除和重启行为。
- 搜索完整引用和全部写入口后再写“全部”“唯一”“不会”等断言；历史 TODO 只能提供线索。
- 区分当前事实、设计合同、测量结果、假设、历史记录和未验证风险；不要把一次运行结果写成永久阈值。
- 先验证夹具确实创建了目标状态，再测性能或收益；合成 fixture 只能证明它覆盖的逻辑，不能证明真实引擎收益。

### 4. 用同一验收链连接实现、文档和测试

- 每个验收项都要能指向代码入口、测试名称或可复跑命令；找不到证明方法的验收项仍是提案。
- 当前行为改变时更新 `docs/current/`；设计语义改变时先更新设计文档；一次运行结果进入报告或完成记录。
- API 变化要同步 service 装配、请求/响应 schema、API contract 测试和当前 API 文档。
- 配置变化要同步 schema、默认值、normalizer、保存/读取回归和当前产品合同。
- UI 变化要同步浏览器测试、全尺寸截图、视觉基线登记和英文截图检查；只有改 UI 测试夹具时才按证据说明为何不重录。
- 每项记录实际运行的命令、结果、测试数量、版本或 commit、隔离方式和剩余限制；不要只写“测试通过”。

### 5. 保持 active plan 短且可导航

- active plan 的开头必须给出当前状态和下一步，进度表必须与完成记录一致。
- 完成记录保留当前任务所需的语义和证据；旧任务的整合日志、重复门禁输出和历史返工细节移到 `docs/reports/`，并从 active plan 链接过去。
- 搬迁历史记录时保留来源 commit、输入、结果和限制；不要为了格式化历史材料改写事实。
- 删除或移动文档前全局搜索旧路径，修复当前入口、skill、README、测试和计划中的引用。
- 计划不能同时维护一份当前 API 合同和一份复制的字段表；冲突时以 `docs/current/contracts/` 和代码 schema 为准。

### 6. 长任务必须可恢复

- 每个阶段结束时留下干净提交或明确结果文件，写清下一阶段和未完成项。
- 不要让一个 worker 同时独占大规模实现、全量测试、文档迁移和 portable 交付而没有 checkpoint。
- 超时不等于失败，也不等于成功；先检查工作树、提交、进程、产物和日志，再从最近 checkpoint 恢复。
- 恢复时只接受可复验的代码和命令结果；不要根据 worker 的最后一句总结补写缺失证据。
- 同一文件族只能有一个写入者；需要并行时使用独立 worktree 和独立 native-module 环境。

## Standard commands

从仓库根目录执行；Windows Git Bash 的 Vitest 和 UI 命令使用大写盘符路径。

```bash
git status --short
git rev-parse HEAD
rg --files docs/plans docs/reports docs/current .agents/skills
rg -n "任务 ID|前置任务|状态|验收|验证|完成记录|阻塞" docs/plans/active
npx vitest run test-node/docs/document-structure.test.ts
npm run check:skills
```

开始实现前，读取当前架构和任务入口；按任务实际涉及的模块运行对应测试、`npm run typecheck`、`npm run lint` 和 `npm run check:modules`。完成行为变化后运行：

```bash
npm run check
```

文档局部修改使用 `git diff --check`、`npx vitest run test-node/docs` 和本地链接检查；新建或整篇重写的正文才使用 `npx prettier --ignore-path .gitignore --check <文件>`。从已有完成记录搬迁生成的报告保留来源排版，并用 diff 和文档测试验证。

每项任务最后按项目约定串行执行交付尾链：

```bash
npm run package:electron:portable
npm run smoke:delivery
npm run rebuild:node
npm run abi:node
```

在 Electron 重建和打包之间不要运行 Node ABI 重建。真实上游、UI 基线、管理 API、代理生命周期和数据库取证分别使用对应专项 skill；不要用本 skill 的通用命令替代专项验收。

## Reading the result

收口前按以下顺序检查：

1. 进度表状态、任务段落状态和文档元数据一致。
2. 所有前置任务已完成，或阻塞项写有证据、边界和解除条件。
3. 每个验收项都有对应实现、测试或实测命令，命令确实匹配了测试。
4. 当前合同、设计语义、TODO 状态和代码 schema 没有互相矛盾。
5. 历史记录不再伪装成当前待办，移动后的链接和来源 commit 可追溯。
6. 测试失败与基线失败已经区分；没有删除断言、放宽阈值或用重试隐藏问题。
7. 交付冒烟证明的是隔离运行和真实数据库查询；ABI 探针证明的是当前 native binding 能执行真实查询。
8. 仍未验证的收益、真实引擎校准、跨重启语义或跨 runtime 行为继续保持未完成或阻塞，不得为了勾选清单而改名。

完成记录至少回答：改了什么、为什么改、谁持有状态、何时生效、什么会拒绝或失效、运行了什么、结果是什么、证据到哪里、还缺什么。

## Deeper material

- [文档导航](../../../docs/README.md) — 文档分类、状态和唯一权威入口。
- [当前架构](../../../docs/current/architecture.md) — 当前启动、状态所有者、模块边界和验证入口。
- [task-routing 执行计划](../../../docs/plans/active/task-routing.md) — 当前计划、阻塞和完成记录示例。
- [历史 AI 优化计划](../../../docs/plans/archive/ai-development-optimization.md) — 已归档的多阶段 TODO 示例。
- [TRI-01～TRI-09 历史报告](../../../docs/reports/task-routing-tri-01-09-history.md) — 从 active plan 搬迁历史记录的示例。
- [documentation-maintenance](../documentation-maintenance/SKILL.md) — 经验分类、路径维护和唯一权威规则。
- [design-doc-readability](../design-doc-readability/SKILL.md) — 设计文档结构和测量规则。
- [feature-design-review](../feature-design-review/SKILL.md) — 状态所有权、生命周期和实验边界。
- [reference.md](./reference.md) — TODO 模板、状态转换和 checkpoint 自检表。
