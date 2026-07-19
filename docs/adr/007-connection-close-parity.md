# ADR-007：首个 Node 版本继续强制关闭连接

- 状态：已接受
- 日期：2026-07-18
- 决策范围：客户端响应连接、上游连接池和 parity

## 背景

Python 版本对每个代理请求：

- 创建新的 HTTP/HTTPS 上游连接。
- 响应 Header 删除原 Content-Length 和 hop-by-hop Header。
- 向客户端发送 `Connection: close`。
- 请求结束后关闭客户端和上游连接。

Node.js 原生 HTTP 默认可以复用 keep-alive 连接。立即启用连接池可能改善性能，但会同时改变 Header、socket 生命周期、timeout 和错误传播，是运行时迁移之外的额外变量。

## 决策

首个 Node parity 版本继续保持 `Connection: close` 合同：

- 向客户端明确发送 `Connection: close`。
- 响应完成后关闭客户端连接。
- 上游请求不使用长期 keep-alive agent。
- 每个请求结束、失败或 abort 后销毁/释放对应 upstream socket。

这适用于普通响应和 SSE。

## 后续引入 keep-alive 的条件

keep-alive 作为 `OPT-003` 独立优化，必须在 Node 正式切换后满足：

1. 数据面 parity 测试稳定。
2. 有 Python/Node 延迟和并发基准，证明连接建立是实际瓶颈。
3. 增加 socket pool 上限、idle timeout、DNS/TLS 失败和 shutdown 测试。
4. 验证不同 target/API Key/Header 不会错误复用状态。
5. SSE 长连接不会耗尽 pool。
6. 默认行为变更写入 release note；必要时提供配置开关。

可以先只复用上游连接而继续对客户端发送 close，但这也必须作为单独变更验收。

## 后果

- 最大化 Python/Node HTTP 行为等价。
- 初期不会获得 keep-alive 性能提升。
- socket 生命周期简单，便于实现 abort 和 graceful shutdown。
- 性能优化不会与语言迁移混在同一发布风险中。
