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

## 不可越过的边界

- 用户正在运行的便携版实例只读。不要停止它，不要写它的配置或流量数据库；只允许结束自己启动的进程。
- 测试、临时配置、数据库、日志根和端口必须隔离。真实上游验收使用 `real-upstream-acceptance` skill 的隔离方案。
- `better-sqlite3` 的 Node ABI 和 Electron ABI 必须串行切换。打包顺序是：`build` → `rebuild:electron` → Electron 打包 → 交付冒烟 → 恢复 Node ABI。
- 并行写入任务必须使用独立工作树和独立 `node_modules`。不要让两个写入者编辑同一文件族。
- 不为了让门禁变绿而降低有意义的测试、视觉像素检查、宽度检查、空白行检查或打包检查；先定位证据，再修实现或记录真实限制。

## 标准验证

- 日常门禁：`npm run check`。
- 技能和文档路由：`npm run check:skills`。
- 模块依赖：`npm run check:modules`。
- 便携交付：`npm run package:electron:portable`，随后 `npm run smoke:delivery`，最后 `npm run abi:node`。
- 文档格式：`npx prettier --ignore-path .gitignore --check <修改的 docs 文件>`。
- UI 改动还要运行对应浏览器测试、检查全尺寸截图、更新视觉基线登记和英文截图检查；细节由 `ui-baseline-regen` skill 负责。
- Windows 上运行 Vitest 或 UI 基线命令时从大写盘符路径进入，例如 `cd /D/code/local_ai_proxy`。

失败时先单独重跑失败步骤。全量并发测试偶发资源或 teardown 失败时，必须用隔离套件和串行全量结果区分测试问题与产品问题；不能删除测试或放宽断言。

## Skill 路由

按问题读取对应 `.agents/skills/<name>/SKILL.md`，不要把所有 skill 一次性加载：

- `admin-api-probing` - admin-api-probing 的专项操作手册。
- `ci-triage` - ci-triage 的专项操作手册。
- `css-cascade-audit` - css-cascade-audit 的专项操作手册。
- `design-doc-readability` - design-doc-readability 的专项操作手册。
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
- `ui-baseline-regen` - ui-baseline-regen 的专项操作手册。
- `ui-markup-contracts` - ui-markup-contracts 的专项操作手册。
- `ui-test-quirks` - ui-test-quirks 的专项操作手册。

Skill 中的命令和链接必须指向当前存在的文件和脚本；改名、删除或移动文档后运行 `npm run check:skills`。
Skill 中的命令和链接必须指向当前存在的文件和脚本；改名、删除或移动文档后运行 `npm run check:skills`。
