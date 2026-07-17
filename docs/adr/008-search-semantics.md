# ADR-008：首个 Node 版本保留 LIKE 搜索语义

- 状态：已接受
- 日期：2026-07-18
- 决策范围：History 搜索、SQLite query 和 FTS5

## 背景

当前数据库包含 FTS5 `record_search` 虚表，但查询主要使用大小写归一后的 `LIKE '%term%'`。现有语义是：

- 搜索文本按空白拆分。
- 多个 term 之间为 AND。
- 每个 term 可匹配 task 或任意 record 内容。
- `%`、`_` 和反斜杠按字面字符转义。
- 支持子串，例如模型、ID 或 Header 的一部分。
- ISO 时间和本地格式化时间都可搜索。

FTS `MATCH` 的 token、标点、前缀和查询语法与这些行为不同，直接切换会产生用户可见差异。

## 决策

首个 Node parity 版本保留现有 LIKE 搜索语义和结果范围。

实现要求：

1. 使用相同的 whitespace term 拆分。
2. term 统一转小写。
3. `%`、`_`、`\\` 正确 ESCAPE。
4. 多 term 使用 AND。
5. task 搜索同时检查 task row、record_search 和 records row。
6. record 搜索限制在指定 task 内。
7. 写入搜索文本时同时包含 ISO 和本地显示时间。
8. 保留 limit/offset、排序和多 log root 合并行为。

`record_search` 表在 schema v1/v2 中继续维护，以保证旧数据库兼容和未来迁移空间，但 parity 阶段不依赖 FTS MATCH。

## 后续 FTS 优化

真正使用 FTS MATCH 作为 `OPT-005` 独立功能，必须：

- 定义公开搜索语法。
- 决定 substring、prefix、phrase、字段过滤和特殊字符行为。
- 提供旧 LIKE 与新 FTS 的结果对比基准。
- 更新 UI placeholder/help 和测试。
- 必要时重建搜索索引。

可以先增加内部候选集优化，再用 LIKE 做最终过滤，但不能改变结果。

## 后果

- Node 与 Python 搜索结果易于 parity。
- 大数据库搜索性能暂不显著改善。
- FTS5 仍需在驱动和打包环境验证，因为旧 schema 包含该虚表。
- 搜索性能改进与运行时迁移解耦。
