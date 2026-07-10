# ADR-0002: SQLite driver 与 Worker ownership

- 状态：已接受
- 日期：2026-07-10
- 决策阶段：0.1

## 背景

流量记录和查询不能阻塞代理数据面的 Node.js 主事件循环。多个 proxy 可以共享同一 `log_root`，数据库连接、migration、写事务和维护任务需要清晰的唯一 owner。

## 候选方案

1. 主线程直接调用同步 SQLite driver。
2. 使用异步 SQLite wrapper，让底层线程模型由依赖管理。
3. 使用 `better-sqlite3`，所有数据库访问放在专用 Worker Thread，通过有界 RPC 队列调用。
4. 改用独立数据库服务。

## 决策

选择方案 3。每个规范化绝对 `log_root` 只创建一个 Worker，通过引用计数 registry 共享。Worker 独占连接、migration 和 transaction。主线程只发送经过 schema 校验且已经脱敏的消息；大 binary payload 使用 transferable `ArrayBuffer`。写队列有界，过载时降级或丢弃日志事件，不阻塞代理转发。

## 原因

`better-sqlite3` 的事务语义直接、性能稳定，Worker 能把同步调用与数据面隔离。按 `log_root` 唯一 ownership 避免多个连接重复 migration 和写入竞争，同时保留 SQLite 的本地部署优势。

## 影响

- 所有 repository API 都是异步 RPC contract，即使 Worker 内部使用同步 driver。
- Worker crash、队列深度、延迟和 dropped events 必须可观测。
- 关闭时必须先停止接收新任务，再 drain/close Worker。
- native addon 的目标平台构建与发布 smoke test 是发布门槛。

## 重新评估条件

- `better-sqlite3` 无法在正式支持平台可靠构建或打包。
- transferable 消息仍导致不可接受的内存复制。
- 单机 SQLite 的写入或查询容量无法达到已记录的性能目标。

