# ADR-003：请求体和日志体大小策略

- 状态：已接受
- 日期：2026-07-18
- 决策范围：代理内存、临时文件、日志完整性和错误响应

## 背景

Python 版本把完整请求和响应 body 累积在内存中。SSE 虽然及时转发，但整个原始流仍保留到响应结束；ZIP 也整体在内存生成。超大或无限响应可能使进程内存持续增长。

Node.js 必须保留常规 LLM 请求的完整日志，同时不能允许单个连接无上限占用内存。

## 决策

采用“内存阈值 + 临时文件 spool + 硬上限后的结构化截断”策略。

### 默认限制

| 项目 | 默认值 | 行为 |
| --- | --- | --- |
| 请求体内存阈值 | 4 MiB | 超过后写入临时文件 |
| 最大代理请求体 | 64 MiB | 超过后返回 413，不转发上游 |
| 响应日志内存阈值 | 4 MiB | 超过后写入临时文件，客户端流不受影响 |
| 最大完整日志 body | 64 MiB | 超过后继续代理，但日志正文改为截断描述 |
| SSE 聚合文本上限 | 8 MiB | 超过后停止追加 content/reasoning，并记录截断信息 |

限制可通过启动配置或环境变量调整，具体名称在 CLI 阶段确定。配置值必须有安全的最小值和最大值。

### 请求体

1. Node IncomingMessage 的 Content-Length 和 chunked body 都通过统一 collector。
2. 0-4 MiB 保存在 Buffer。
3. 4-64 MiB spool 到应用临时目录。
4. 完成收集后执行 model route 和 JSON transform。
5. 超过 64 MiB：停止读取/销毁临时文件，返回 HTTP 413，写入带错误和 size 的日志，不向上游发送部分 body。

因为模型路由依赖顶层 JSON `model`，默认实现仍需在转发前完成 body 收集。未来如增加无需 body 路由的 passthrough 模式，可另行优化。

### 响应体

1. 上游响应始终使用 backpressure 流向客户端。
2. 日志 capture 是旁路 tee，不得阻塞或改变成功响应。
3. 0-4 MiB 保存在 Buffer；之后 spool 临时文件。
4. 总量不超过 64 MiB 时保存完整业务值。
5. 超过 64 MiB 后停止完整 capture，继续计数并保留：
   - `truncated: true`
   - `size_bytes`
   - `captured_bytes`
   - `sha256`（对完整流增量计算）
   - 可识别 SSE 的有界 stream summary
6. 不为了日志限制而中止上游或客户端响应。

### 临时文件

- 使用应用专用临时目录和不可预测文件名。
- 权限限制为当前用户。
- 请求完成、失败、client abort 和应用 shutdown 都必须删除。
- 启动时清理超过 24 小时的遗留 spool 文件。
- 临时文件路径不得写入用户可见日志正文。

### ZIP

ZIP 导出使用 streaming archive，不复用上述 64 MiB 总包限制。单条已截断记录按数据库实际内容导出。

## API 表达

截断 body 统一表示为：

```json
{
  "text": "<captured prefix or empty>",
  "size_bytes": 73400320,
  "captured_bytes": 67108864,
  "sha256": "...",
  "truncated": true,
  "truncation_reason": "log_body_limit"
}
```

若存在 stream summary，则与截断元数据放在同一响应日志对象中。

## 后果

- 常规请求保持完整日志。
- 超大请求明确失败，不再可能被静默视为空 body。
- 超大响应仍完整到达客户端，但日志正文可能截断；这是批准的安全差异，必须写入 release note。
- 需要 spool 清理、大小限制和压力测试。
