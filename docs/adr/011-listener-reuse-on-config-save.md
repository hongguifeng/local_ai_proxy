# ADR-011：保存配置时复用监听器并保留在途请求

- 状态：已接受
- 日期：2026-10-02
- 决策范围：配置应用、监听器生命周期、流量日志存储复用和 shutdown

## 背景

LLM 请求可持续数十秒到数分钟，SSE 流尤其长。ADR-004 的应用流程在保存配置前停止所有“受影响”的旧 listener，再按新配置启动，导致任何一次 target 级别的编辑（上游地址、API key、模型映射、价格）都会：

- 关闭该 pair 正在使用的 socket。
- 在 graceful 期（默认 2 秒）后 abort 全部在途请求。
- 客户端收到被截断或失败的响应。

大多数编辑并不改变监听地址，因此重启 listener 并不是让新配置生效的必要条件。

## 选项

1. 延长 graceful 期，等在途请求自然结束后再重启 listener。
   - `server.close()` 期间监听端口仍被占用，同地址重启会 `EADDRINUSE`。
   - 保存请求需要挂起直到最慢的请求结束，UI 体验不可接受。
2. 只替换 pair 的 request pipeline，保留同一个 listener 和端口。
   - 在途请求继续持有旧 pipeline、旧 target 和旧流量日志。
   - 新请求使用新配置，保存可以立即返回。
3. 继续整体重启（现状），接受在途请求被中断。

## 决策

选择方案 2：监听地址不变时原地换用新配置（reload），其余情况继续真实重启。

### 判定条件

pair 满足下列条件时走 reload：

- 新配置仍然 `enabled`。
- `listen_host`（规范化后）和 `listen_port` 与旧配置一致。

否则走 ADR-004 的 stop/start 事务：pair 被删除、被禁用、监听地址改变，或者需要占用其他 pair 释放的端口。

### reload 语义

- listener 与端口不动，runtime state 保持 `running`，`actual_listen_port` 不变。
- `pipeline + ActiveRequestRegistry` 作为一个整体原子替换，二者永远属于同一代配置。
- 已进入 `handle()` 的请求继续使用该代 pipeline、target、上游和流量日志存储，直到自然结束或客户端断开。
- 被替换掉的一代进入 drain：等待其请求清零（默认最长 30 分钟），超时则用 `drain timed out` abort 剩余请求。
- 只关闭 drain 结束后不再被引用的日志存储；日志根目录和脱敏设置未变的 target 复用同一个存储实例。

### 保存失败回滚

reload 是可逆的：回滚时把旧 pair 配置再次 reload 到同一个 listener，新配置那代资源随即进入 drain。端口迁移的 pair 继续按 ADR-004 重新拉起旧 listener。

## 日志存储复用

日志存储按 `解析后的日志根目录 + redact_logs` 缓存于 pair 运行时条目：

- reload 命中同一 key 时复用实例，不重新打开 SQLite 连接。
- 新建实例会执行 `markPendingPricingInterrupted()`，把在途请求的 `pending` 计费行改写为 `unpriced/incomplete_usage`；复用可避免这种不必要的改写。
- 日志根或脱敏设置改变时，旧实例进入 drain 后关闭，因此旧日志目录可以立即被删除。
- pair 被停止时清空缓存并关闭全部实例，下次启动重新打开，保留“进程重启后 pending 行即视为中断”的既有语义。

## 后果

- 常规 target 配置编辑不再中断在途请求，保存仍然立即返回。
- 保存后同一 pair 上可能同时存在两代配置：在途请求按旧配置记录，新请求按新配置记录，History 中两条记录的 target/上游可以不同，这是预期行为。
- 端口或启用状态变化仍会中断该 pair 的在途请求，因为必须释放监听端口。
- 诊断计数 `activeRequests` 包含 drain 中的在途请求，`resourcePairs` 只统计当前持有资源的 pair。
- drain 期间的日志存储和 AbortController 仍占用资源，由 `drainTimeoutMs` 上限兜底。
