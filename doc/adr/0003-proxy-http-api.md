# ADR-0003: 代理数据面使用 Node 核心 HTTP API

- 状态：已接受
- 日期：2026-07-10
- 决策阶段：0.1

## 背景

代理必须精确控制 header、多值语义、流式响应、背压、取消、timeout 和连接池。管理 API 则更需要 schema、路由和统一错误处理，两者的约束不同。

## 候选方案

1. 数据面和管理面全部使用 Fastify。
2. 数据面使用通用代理中间件。
3. 数据面使用 Node `http`/`https`，管理面使用 Fastify。
4. 使用 Undici/fetch 实现数据面。

## 决策

选择方案 3。代理 listener、upstream request 和 streaming pipeline 使用 Node 核心 `http`/`https` API；管理 API 使用 Fastify。首发只支持入站 HTTP/1.1 和出站 HTTP/1.1/HTTPS，不支持 CONNECT、WebSocket、入站 HTTP/2 或 HTTP/3。

## 原因

核心 API 暴露原始 header、socket 生命周期和 stream 背压，能直接实现并测试当前协议边界。Fastify 留在管理面，发挥 runtime schema 和依赖注入优势，而不会把 Web 框架抽象带入数据面。

## 影响

- 必须自行实现 hop-by-hop header 清理、`Connection` 动态 token、取消传播和安全错误映射。
- response 使用 stream pipeline，不聚合完整 body。
- capture、SSE 摘要和日志是旁路 tap，失败不得中断转发。
- 不支持的协议必须返回明确错误或拒绝升级，不能静默误处理。

## 重新评估条件

- 黑盒协议测试证明核心 API 无法可靠保留已承诺语义。
- Node 的 HTTP 客户端 API 出现具备等价控制能力且明显降低维护成本的稳定替代。
- 产品明确要求 HTTP/2、WebSocket 或 CONNECT。

