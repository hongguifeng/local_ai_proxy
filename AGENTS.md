# 面向 AI 的项目规则

## 任务入口

开始任何代码任务前，先读 [文档导航](docs/README.md) 和 [当前架构](docs/current/architecture.md)。当前架构说明启动路径、状态归属、模块边界、关闭顺序和验证入口；历史文档不能替代它。

项目只维护 Node.js 24、TypeScript、Electron 实现。内部模块可以按当前设计调整，不为已经删除的 Python API 保留兼容层。用户配置、`traffic.db`、代理 HTTP 行为、SSE、响应字节、取消和压缩语义属于外部合同；改变它们前必须更新当前文档、相关 ADR 和测试。

## 文档路由

- 当前行为：`docs/current/`
- 已作出的架构决定：`docs/decisions/adr/`
- 已接受或进行中的功能设计：`docs/design/`
- 当前执行计划：`docs/plans/active/`
- 故障、迁移和发布操作：`docs/operations/`
- 验收、基准和实验结果：`docs/reports/`
- Python 基线和迁移史：`docs/history/`

新增功能先写设计，再写计划；实现完成后把计划收口，把当前行为写入 `docs/current/`。不要把一次运行结果写成永久合同，也不要在计划里重复维护当前 API 字段表。

每个任务结束时，按 [`documentation-maintenance`](.agents/skills/documentation-maintenance/SKILL.md) skill 检查是否产生了可复用的坑、验证方法或当前合同变化：有证据才沉淀，按生命周期放入唯一权威文档；只有跨任务且代价高的长期边界才进入本文件。

## 不可越过的边界

- 用户正在运行的便携版实例只读。不要停止它，不要写它的配置或流量数据库；只允许结束自己启动的进程。
- 测试、临时配置、数据库、日志根和端口必须隔离。真实上游验收使用 `real-upstream-acceptance` skill 的隔离方案。
- `better-sqlite3` 的 Node ABI 和 Electron ABI 必须串行切换。打包顺序是：`build` → `rebuild:electron` → Electron 打包 → 交付冒烟 → 恢复 Node ABI。
- 长任务或独立 worktree 委派按实现、专项验证、文档收口和交付验证分阶段执行；每阶段留下可审查提交或结果记录，超时后从最近 checkpoint 恢复，不把无输出的长时间等待当成成功证据。
- 会打开交互式编辑器的 git 命令（`rebase --continue`、需要写提交信息的 `merge`/`cherry-pick`、不带 `-m` 的 `commit --amend`、`tag -a`）必须带 `GIT_EDITOR=true`；命令停在编辑器 TUI 里被中断不是 git 失败，续跑前先读 `git status`，配方见 `todo-workflow`。
- 不为了让门禁变绿而降低有意义的测试、视觉像素检查、宽度检查、空白行检查或打包检查；先定位证据，再修实现或记录真实限制。

## 标准验证

- 日常门禁：`npm run check`。
- 技能和文档路由：`npm run check:skills`。
- 模块依赖：`npm run check:modules`。
- 便携交付：`npm run package:electron:portable`，随后 `npm run smoke:delivery`，最后 `npm run abi:node`。
- 文档验证：新建或整篇重写的 `docs/` 正文运行 `npx prettier --ignore-path .gitignore --check <文件>`；从已有完成记录搬迁生成的报告保留来源排版；已有表格密集文档的局部修改运行 `git diff --check` 和 `npx vitest run test-node/docs`，避免无关表格重排。
- UI 改动还要运行对应浏览器测试、检查全尺寸截图、更新视觉基线登记和英文截图检查；细节由 `ui-baseline-regen` skill 负责。
- Windows 上运行 Vitest 或 UI 基线命令时从大写盘符路径进入，例如 `cd /D/code/local_ai_proxy`。

失败时先单独重跑失败步骤。全量并发测试偶发资源或 teardown 失败时，必须用隔离套件和串行全量结果区分测试问题与产品问题；不能删除测试或放宽断言。

## Skill 路由

按问题读取对应 `.agents/skills/<name>/SKILL.md`，不要把所有 skill 一次性加载：

- `admin-api-probing` - admin-api-probing 的专项操作手册。
- `ci-triage` - ci-triage 的专项操作手册。
- `css-cascade-audit` - css-cascade-audit 的专项操作手册。
- `design-doc-readability` - design-doc-readability 的专项操作手册。
- `documentation-maintenance` - 维护 AGENTS.md、skills 和分类文档中的长期经验。
- `feature-design-review` - feature-design-review 的专项操作手册。
- `live-ui-probing` - live-ui-probing 的专项操作手册。
- `packaging-smoke` - packaging-smoke 的专项操作手册。
- `proxy-runtime` - proxy-runtime 的专项操作手册。
- `real-upstream-acceptance` - real-upstream-acceptance 的专项操作手册。
- `render-internals` - render-internals 的专项操作手册。
- `safe-deletion` - safe-deletion 的专项操作手册。
- `static-checks-and-split` - static-checks-and-split 的专项操作手册。
- `statistics-charts` - statistics-charts 的专项操作手册。
- `traffic-log-forensics` - traffic-log-forensics 的专项操作手册。
- `todo-workflow` - 编写、执行、收口和归档 TODO / active plan 的专项流程。
- `ui-baseline-regen` - ui-baseline-regen 的专项操作手册。
- `ui-markup-contracts` - ui-markup-contracts 的专项操作手册。
- `ui-test-quirks` - ui-test-quirks 的专项操作手册。

Skill 中的命令和链接必须指向当前存在的文件和脚本；改名、删除或移动文档后运行 `npm run check:skills`。
