# 使用统计与成本分析开发 TODO

创建日期：2026-09-13。当前进度：6 / 12 项完成（STAT-07～STAT-09 仅部分完成）。

设计依据：[使用统计与成本分析界面设计](./usage-statistics-design.md)。本清单供后续 AI 按顺序执行；设计变更必须同步更新设计文档、本清单和测试。

## 1. 执行规则

每项任务都是一个可验证的提交单元，必须完成以下闭环：

1. 将状态改为“进行中”，实现代码与自动化测试；正常、边界、失败路径均需覆盖。
2. 运行任务相关测试、`npm run typecheck`，记录命令、结果和实际测试文件。
3. UI 任务提交前运行 `npm run regen:ui-baselines`，检查中英文截图并更新基线哈希。
4. 检查 diff，不混入无关改动；提交标题包含任务 ID，例如 `feat(stats): [STAT-01] add usage query indexes`。
5. 提交后运行 `git show --stat HEAD`，在完成记录填写真实 SHA、测试结果和设计偏差。
6. 全部任务完成后执行项目要求的 `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never`。

## 2. 进度表

| 完成 | ID | 任务 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [x] | STAT-01 | 统计数据模型、索引与迁移 | 无 | 已完成 |
| [x] | STAT-02 | repository 总量与分组查询 | STAT-01 | 已完成 |
| [x] | STAT-03 | repository 趋势 bucket 查询 | STAT-01 | 已完成 |
| [x] | STAT-04 | UsageStatisticsService 合并与口径 | STAT-02、03 | 已完成 |
| [x] | STAT-05 | 管理 API、schema 与鉴权 | STAT-04 | 基础路由已完成；严格 schema/完整测试待补 |
| [x] | STAT-06 | CSV 导出接口 | STAT-05 | 基础导出已完成；完整安全测试待补 |
| [ ] | STAT-07 | 页面导航、筛选和状态管理 | STAT-05、06 | 部分完成：缺少地址/模型联动、完整状态与交互测试 |
| [ ] | STAT-08 | 总体分布饼图与指标切换 | STAT-07 | 部分完成：当前为占位视觉容器，尚非 SVG 饼图 |
| [ ] | STAT-09 | 明细表格与趋势柱状图 | STAT-07、08 | 部分完成：仅有简单请求数柱，缺少四桶堆叠/费用柱与联动测试 |
| [ ] | STAT-10 | 中英文 UI | STAT-08、09 | 未开始 |
| [ ] | STAT-11 | 端到端、性能和视觉回归 | STAT-06、10 | 未开始 |
| [ ] | STAT-12 | 文档、验收与便携版构建 | STAT-11 | 未开始 |

## 3. 任务明细

### STAT-01：统计数据模型、索引与迁移

实现 `finished_at`、pricing status、target 快照、最终模型及四桶 token 的查询投影；添加时间、target、model、pricing status 复合索引。不得修改既有费用含义。

测试：空库迁移、旧库升级、索引存在、NULL/未计价记录保留。落点：`test-node/persistence/database.test.ts`、新增 `test-node/statistics/schema.test.ts`。提交：`feat(stats): [STAT-01] add statistics indexes`。

### STAT-02：repository 总量与分组查询

新增按范围、target、model 分组的参数化查询，返回 BigInt 安全计数、四桶 token、已计价纳元及未计价数量；不得读取正文。

测试：边界时间（开始包含、结束不包含）、多 target/模型、重复 task、金额大数、空结果。落点：新增 `test-node/statistics/repository-overview.test.ts`。提交：`feat(stats): [STAT-02] add overview aggregation`。

### STAT-03：repository 趋势 bucket 查询

支持 day/week/month 和 auto 粒度，按 UTC bucket 聚合请求数、去重 task 数、四桶 token、费用和未计价数，限制最多 366 点。

测试：跨日/跨月/时区、粒度边界、缺失 bucket、点数上限、筛选组合。落点：新增 `test-node/statistics/repository-trend.test.ts`。提交：`feat(stats): [STAT-03] add trend aggregation`。

### STAT-04：UsageStatisticsService 合并与口径

实现多日志目录聚合、BigInt 合并、top 9 及“其他”、占比计算、task 去重和 dataVersion。统一费用仅统计 priced，保留状态统计。

测试：跨库合并与重复数据、全未知费用、四桶合计、占比舍入和分类合并。落点：新增 `test-node/statistics/usage-statistics-service.test.ts`。提交：`feat(stats): [STAT-04] add statistics service`。

### STAT-05：管理 API、schema 与鉴权

注册 overview/trend/options 路由，严格校验时间、范围、metric、granularity 和 ID；无 service 时不注册。更新 Fastify schema 与 assembled-app smoke test。

测试：200/400/401/404、响应字段类型、大整数、无数据和鉴权。落点：新增 `test-node/admin/usage-statistics.test.ts`，扩展 `test-node/app/runtime.test.ts`。提交：`feat(stats): [STAT-05] expose statistics APIs`。

### STAT-06：CSV 导出接口

实现与 trend 参数一致的 export 路由，输出 UTF-8 BOM、筛选条件和生成时间；转义逗号、引号、换行和公式前缀。

测试：内容与 JSON 趋势逐项一致、中文、特殊字符、空结果和注入字符串。落点：新增 `test-node/admin/usage-statistics-export.test.ts`。提交：`feat(stats): [STAT-06] add statistics export`。

### STAT-07：页面导航、筛选和状态管理

在现有管理端增加“使用统计”导航、预设/自定义时间控件、结束时间跟随当前时刻、地址与模型联动、加载/错误/空状态。

测试：浏览器筛选交互、参数序列化、联动清空、重试及旧结果保留。落点：扩展 `test-node/ui/admin-ui.test.ts`。提交：`feat(stats): [STAT-07] add statistics view shell`。

### STAT-08：总体分布饼图与指标切换

用 SVG 实现地址/模型两张饼图，支持 token/cost 切换、top 9+其他、图例隐藏恢复和无数据状态；复用金额格式化。

测试：切换请求、占比合计、颜色稳定和空状态。提交前运行基线命令。提交：`feat(stats): [STAT-08] add overview charts`。

### STAT-09：明细表格与趋势柱状图

实现地址/模型明细、自动/手动粒度、四桶堆叠柱、费用柱、悬停详情及 CSV 下载。

测试：表格合计与图表一致、筛选联动、粒度切换和长名称。提交前运行基线命令。提交：`feat(stats): [STAT-09] add detail trends`。

### STAT-10：中英文 UI

补充中文/英文文案。

测试：静态资源、中英文截图无 stray Chinese。提交前运行基线命令。提交：`feat(stats): [STAT-10] polish statistics copy`。

### STAT-11：端到端、性能和视觉回归

覆盖 10,000 records、多日志目录、366 点查询、无正文读取和真实页面流程，记录 p95 耗时与内存。

测试：新增 `test-node/statistics/statistics-benchmark.test.ts`，运行完整相关 Vitest、`npm run regen:ui-baselines`。提交：`test(stats): [STAT-11] add statistics regression suite`。

### STAT-12：文档、验收与便携版构建

更新中英文 README、API 说明和本 TODO 完成记录，登记设计偏差；执行完整构建和 portable 打包。

测试：`npx prettier --check .`、`npm run build`、`npm run rebuild:electron`、`npx electron-builder -w portable --publish never`。提交：`docs(stats): [STAT-12] document statistics release`。

## 4. 完成记录模板

## 5. 当前未完成项

- **STAT-05**：补充 Fastify 请求/响应 schema、枚举和时间范围校验，并增加 overview/trend/options 的 200/400/401/404 集成测试。
- **STAT-06**：增加 CSV 内容一致性、特殊字符、中文、空结果和公式注入测试。
- **STAT-07**：接入 options API，实现转发地址与模型筛选联动，以及加载、错误、空结果和重试状态；补充页面交互测试。
- **STAT-08**：已替换为 SVG 饼图并支持 top 9 +“其他”及无数据提示；仍需图例交互。
- **STAT-09**：已加入日/周/月粒度选择、四类 token 趋势分段柱及费用指标柱；仍需悬停详情及一致性测试。
- **STAT-10**：补齐中英文文案并验证英文界面无中文残留。
- **STAT-11**：补充 10,000 records、跨日志目录、366 点、无正文读取和真实页面流程的端到端/性能回归测试。
- **STAT-12**：补齐中英文 README、API 文档和最终验收记录；完成完整构建及 portable 打包后再标记完成。

每项完成后追加：

```text
### STAT-XX 完成记录
- 实际实现：
- 实际测试命令与结果：
- 测试文件/用例：
- UI 基线（如适用）：
- 设计偏差与迁移影响：无 / 说明
- 提交：<title>；SHA：<sha>
```


