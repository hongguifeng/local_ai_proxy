# ADR-005：客户端断开后立即中止上游

- 状态：已接受
- 日期：2026-07-18
- 决策范围：client abort、upstream request、日志完成状态和 shutdown

## 背景

LLM 请求可能持续较长时间并消耗付费 Token。客户端主动取消、网络断开或应用关闭时，代理必须决定是否继续读取上游以获得完整日志。

继续读取可以得到完整响应，但会浪费上游计算、网络和本地资源；立即中止会使日志只有部分响应。

## 决策

客户端连接在响应完成前断开时，立即通过共享 `AbortController` 中止上游请求和响应流。

优先级：停止无消费者的上游工作高于获得完整响应日志。

## 行为

### 上游尚未返回 Header

- 销毁 upstream request/socket。
- 不再尝试向客户端写错误响应。
- 最终日志事件为 `request_aborted`。
- `status` 为 `null`。
- `error` 使用结构化类别 `client_aborted`，内部可附带安全的系统错误信息。

### 上游已经返回 Header/部分 Body

- 停止读取并销毁 upstream response。
- 最终日志保留已经看到的 upstream status、Header 和有限 body/stream summary。
- 记录 `response_truncated=true` 和 `truncation_reason=client_aborted`。
- 最终事件仍为 `request_aborted`。

### 请求上传期间断开

- 停止 request body collector。
- 删除 spool 临时文件。
- 不向上游发送部分请求。
- 写入 aborted 日志，包含已接收字节数。

## 日志写入

- abort 后的日志 finalize 不依赖客户端 socket。
- 日志写入有独立短超时；不能无限延迟资源释放。
- 日志写入失败只记录内部告警。
- pending record 必须更新为 aborted，而不是永久停留 pending。

## 应用关闭

应用 graceful shutdown 分两阶段：

1. 停止接受新连接，在 grace period 内允许活跃请求完成。
2. grace period 到期后使用 `shutdown` abort reason 中止剩余 client/upstream 流。

shutdown abort 与 client abort 使用不同错误类别，便于 History 和诊断区分。

## 后果

- 客户端取消会尽快释放上游资源和成本。
- aborted 日志可能只有部分响应，这是批准行为。
- 需要测试上传中断、Header 前中断、Header 后中断、SSE 中断和 shutdown 中断。
- Node 数据面中的所有 stream 必须连接到同一个请求级 abort signal。
