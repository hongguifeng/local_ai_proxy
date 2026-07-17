# ADR-002：同时保存原始请求体与上游请求体

- 状态：已接受
- 日期：2026-07-18
- 决策范围：日志 schema、详情 API 和 ZIP 导出

## 背景

当前 Python 转发流程在内存记录中同时存在：

- 客户端原始 request body。
- model rewrite、strip、inject 后的 upstream body。

但写入 SQLite 时，`request_body` 在存在 `upstream_body` 的情况下优先保存上游版本。因此 History 和 `request.json` 展示的是最终发往上游的内容，原始客户端内容没有独立持久化。

这会影响调试：用户知道字段被删除或注入，但无法完整查看改写前的原始请求。

## 选项

1. 完全复制当前行为，只保存上游 body。
2. 把 `request_body` 改为原始 body。
3. 保持 `request_body` 现有语义，同时增加可选 original body。

## 决策

选择方案 3。

数据合同：

- `request_body_json`：继续表示最终发往上游的 body，保持现有 History 和导出行为。
- `original_request_body_json`：表示客户端原始 body。
- 当原始 body 与上游 body 完全相同时，`original_request_body_json` 保存为 `NULL`，由读取层解释为“与 request body 相同”，避免重复存储。
- 当发生 model rewrite、strip 或 inject 时，保存两个版本。

## Schema

引入 schema version 2：

```sql
ALTER TABLE records ADD COLUMN original_request_body_json TEXT;
```

迁移不重写旧记录。旧记录的 `NULL` 仅表示历史版本没有独立保存原始 body，不能绝对证明两个 body 相同；API 应通过版本/字段缺失语义避免误导。

## API 和 UI

- 现有详情字段 `request` 继续返回上游 body。
- 新增可选字段 `original_request`，只有确实保存且与上游 body 不同时返回。
- 第一阶段 UI 主 Request pane 保持显示上游 body，以保证视觉和使用习惯不变。
- request metadata 增加“original request available”标记，后续可增加切换控件；不阻塞 runtime parity。

## 导出

- `request.json` 继续保存上游 body。
- 存在独立原始 body 时，额外写入 `original-request.json`。
- `summary.md` 说明请求是否经过模型改写、strip 或 inject。

## 脱敏

- 开启日志脱敏时，两个 body 都必须在持久化前脱敏。
- 不允许为了比较是否相同而把未脱敏 body 写入临时日志或错误输出。

## 后果

- 新数据库升级到 schema version 2。
- 发生请求改写时数据库占用增加。
- 现有 UI/API 主要字段保持兼容，不需要双版本 shim。
- Node.js parity 测试需要同时验证原始和上游 body。
