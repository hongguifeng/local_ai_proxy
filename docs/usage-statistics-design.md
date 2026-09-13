# 使用统计与成本分析界面设计

## 1. 目标与范围

在“监听转发”和“历史日志”之外增加“使用统计”入口，用于回答两个问题：

1. 选定时间范围内，整体消耗由哪些转发地址、哪些模型构成；
2. 选定一个转发地址和模型后，请求、task、四类 token 及费用如何随时间变化。

首版沿用现有计价口径：金额为 CNY，价格单位为元/M token；只聚合日志中已完整计价的请求。缺少价格或 usage 的记录单独计数，不伪造为 0 元。统计时间使用请求完成时间（`finished_at`），未完成请求不进入趋势；用户可在界面查看“未计价/进行中”数量。

## 2. 页面信息架构

顶部为统一筛选栏：预设“今天、1d、7d、14d、30d”和自定义日期时间选择器（参考附件图 1），支持“结束时间跟随当前时刻”。时间按本地时区显示，提交时转换为 ISO UTC；默认 7 天，最大范围 366 天。

下方分为“总体分布”和“明细趋势”两块。筛选变化、指标切换或手动刷新后，两块同时更新；请求期间显示骨架屏，失败显示可重试错误，不清空上一次成功结果。

### 2.1 总体分布

显示总请求数、task 数、输入/输出/缓存读/缓存写 token 总量、已计价费用和未计价数量。提供指标切换：`token 使用量`、`费用价格`。两张并列饼图分别按转发地址、实际模型分组；图例展示名称、数值和占比，超过 10 个分类时仅显示前 9 名，其余合并为“其他”，点击图例可隐藏/恢复。费用模式下未知费用不计入饼图，并在图下注明“已计价费用”。无数据时显示空状态。

### 2.2 明细趋势

提供转发地址和模型两个下拉框，均支持“全部”；模型列表随地址筛选联动。显示请求次数、task 数、四类 token、费用卡片及数据表。表格按日（范围不超过 31 天）、按周（不超过 180 天）或按月（更大范围）自动选择粒度，也允许用户切换；列为时间、请求数、task 数、输入、输出、缓存读取、缓存写入、费用、未计价数。

使用堆叠柱状图表示 token 趋势（四类 token 分色），费用模式改为单系列费用柱；悬停显示完整数值。图表和表格使用同一 API 返回值，避免视觉与导出不一致。支持 CSV 导出当前筛选和粒度。

## 3. 数据口径

- 地址维度使用请求计价快照中的 target id/名称；删除或改名后的历史记录仍显示快照名称，并以 id 作为稳定键。
- 模型维度使用请求最终发送给上游的模型（不是响应中的模型）。
- token 采用现有四桶：`input_uncached_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`；不重复累加推理 token。
- 费用累加已保存的 `cost_nano_cny`，最后转换为元展示；不以当前价格重新计算历史数据。
- task 数按现有单地址 task 边界去重；一个 task 跨多个模型时，模型明细按请求归属，模型计数可能小于各模型请求所在 task 的简单相加，UI 提示“task 为去重计数”。
- 进行中、`legacy_record`、`incomplete_usage`、`unsupported_usage` 等不可计价记录进入状态统计，但不进入费用和 token 饼图/趋势数值。

## 4. API 设计

新增只读接口（管理员鉴权与现有 `/api/log-groups` 相同）：

`GET /api/usage-statistics/overview?from=&to=&metric=token|cost&targetId=` 返回 `{range, totals, byTarget, byModel, unpriced}`。`byTarget/byModel` 每项含稳定 id、显示名、token 四桶、`token_total`、`cost`、`share`。

`GET /api/usage-statistics/trend?from=&to=&targetId=&model=&granularity=auto|day|week|month` 返回 `{range, granularity, filters, totals, points[]}`；每个 point 含 bucket 起止时间、请求数、去重 task 数、四桶 token、已计价费用和未计价数。

`GET /api/usage-statistics/options?from=&to=` 返回时间范围内出现过的地址和模型，供联动选择。`GET /api/usage-statistics/export` 参数与 trend 相同，返回 UTF-8 BOM CSV，并在首行写入筛选条件和生成时间。

所有参数进行严格 schema 校验：`from < to`、范围上限、未知 metric/granularity 返回 400；金额和计数以字符串或安全整数传输，防止大整数精度丢失。响应增加 `dataVersion`，便于未来口径升级。

## 5. 后端实现方案

在 maintenance 层新增 `UsageStatisticsService`，复用 repository 的日志根目录遍历和 pricing 聚合，不读取 request/response 正文。repository 增加两类参数化 SQL：

1. 按范围、target、模型分组的总量查询；
2. 按 UTC bucket 分组的趋势查询，并以 `COUNT(DISTINCT task_id)` 计算 task。

为性能建立 `(finished_at, pricing_status)`、`(target_id, finished_at)`、`(model, finished_at)` 索引；多日志目录先各库聚合，再在服务层以 BigInt 合并。限制单次返回分类数和趋势点数（最多 366），并记录查询耗时日志。运行时在 `src/app/runtime.ts` 注入可选 service，在 `admin-server.ts` 注册路由；缺少 service 时路由不注册，保持现有可选服务约定。

## 6. 前端实现方案

在现有 `src/admin/static/app.js/css/index.html` 增加导航项和视图状态：`range`, `metric`, `targetId`, `model`, `granularity`。使用现有原生 JS，不引入重量级图表依赖；优先采用 SVG 绘制饼图和柱状图。日期选择器沿用现有控件样式；图表颜色按模型/地址稳定 hash 分配，确保刷新后颜色不跳变。所有文案加入中英文资源，金额格式化复用现有 CNY formatter。

## 7. 测试与验收

- repository/service：时区边界、跨目录合并、BigInt 金额、去重 task、空范围、未知/未计价状态。
- API：schema、鉴权、参数错误、无 service 404、CSV 注入防护。
- UI：筛选联动、指标切换、空/错误/加载态、中文无 stray 文案。
- 性能：至少 10,000 records、366 个趋势点，多目录查询无正文读取；记录 p95 查询耗时和内存。

验收标准：相同筛选下饼图合计与趋势表总计一致；费用与历史日志详情中的 task/request 费用一致；切换当前价格不会改变历史统计；自定义时间端点行为明确（开始包含、结束不包含）；导出内容与表格逐项一致。

## 8. 实施拆分与后续扩展

建议按“查询模型与索引 → service/API → SVG 组件与页面 → 导出 → 测试和基线”五个提交实施。首版暂不包含预算告警、供应商账单对账、汇率、多币种、实时 websocket 和按缓存 TTL 分档；这些能力可在 `dataVersion` 和聚合接口稳定后扩展。
