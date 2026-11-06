# 会话头补齐的真实上游验收（2026-11-05）

> 状态：报告
> 权威性：一次验收的证据记录；数字和结论带着测量时点，不自动成为当前规则。
> 更新条件：只在补测或发现记录有误时更新。

被验对象：[上游会话头补齐设计](../design/accepted/session-header-injection.md)与 [ADR-016](../decisions/adr/016-upstream-session-header-injection.md)。当前行为以[产品当前行为](../current/product.md)为准。

## 1. 目的

证明两件事，且都不是 fixture 能回答的：

1. 真实 OpenCode Go 网关确实只因为缺少会话头而拒绝请求（对照组的 400 原文可复现）。
2. 打开 `session_header` 后，代理补出来的头能让同一个网关接受这个请求（同一个请求体 200）。

## 2. 环境

- 载荷：`npm run package:electron:portable` 的产物 `release/win-unpacked`（2026-11-05 10:53 打包，`app.asar` 18,529,672 字节）。
- 隔离：`LLM_PROXY_DATA_DIR=logs/sh-verify/data`，应用配置 `logs/sh-verify/llm-proxy.json`（`admin.port=18191`），独立 `proxies.json`，两个 pair 各带绝对 `log_root`（`logs/sh-verify/logs-a`、`logs/sh-verify/logs-b`）。
- 两个 pair 指向同一个真实目标 `https://opencode.ai/inference/go/openai` 和同一把用户 API key，唯一差别是 `session_header`：pair A 为 `x-opencode-session`，pair B 留空。
- 请求体是压缩请求的形状：一条 `developer` 摘要提示 + 一条 `user` 里带 `<conversation>` 文本，`model=deepseek-v4.1-flash`，`stream=true`，`max_output_tokens=64`；客户端**不带任何会话头**。

## 3. 结果

| 场景                                                              | 状态 | 响应                                                                                                                                         |
| ----------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一次尝试（无 `user-agent`，两个 pair 都是）                     | 403  | `error code: 1010`，Cloudflare 在网关前就拒了，与本次功能无关，但说明“UA 不是可省略的细节”                                                   |
| pair A（`session_header=x-opencode-session`），UA 模拟 `pi/1.5.0` | 200  | `event: response.created`，SSE 正常开始                                                                                                      |
| pair B（`session_header` 留空），同一请求体                       | 400  | `{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. …"}}` |

历史对照（同一台机器、用户实例的只读统计）：624 条打到 OpenCode 的记录里，带会话头的 554 条全部 200，不带会话头的 70 条全部失败（69 条这个 400，1 条客户端中断），见[设计第 2 节](../design/accepted/session-header-injection.md)。

## 4. 落库证据

验收实例自己的 `traffic.db`（只读打开）：

```
logs/sh-verify/logs-a/traffic.db  →  added_upstream_headers_json = ["x-opencode-session"]（3 条，含最后那条 200）
logs/sh-verify/logs-b/traffic.db  →  added_upstream_headers_json = []（2 条，含那条 400）
```

补了哪个头在记录里可见，补的值不在记录里（值可能是客户端自己的会话 id）。

## 5. 结论与限制

- 结论：`session_header` 打开的 target 能让无会话头的压缩请求通过真实网关；留空的 target 复现原始 400。因果关系由同一次运行的两组对照给出，不是推断。
- 限制 1：这次没有断言派生值在两次请求之间相同。那条性质由 `test-node/proxy/session-header.test.ts` 与 `load-balancer-pipeline.test.ts` 的 SH-09 覆盖；真实网关上无法观测路由桶。
- 限制 2：没有真实执行一次“先主对话、再压缩”的完整 pi 会话。pi 主对话链路自带 `session_id`，代理走的是复制分支，这条分支在中已由 `proxy-listener.test.ts` 用例钉住。
- 限制 3：`user-agent` 缺失会被 Cloudflare 403，这是客户端的责任（本轮请求是我自己用一个不带 UA 的脚本发的），代理不伪造它。
- 验收后按交付链顺序恢复了 Node ABI：`npm run rebuild:node` → `npm run abi:node` 报 `NODE_MODULE_VERSION 137` 且真实查询返回 `{"a":1}`。验收用的进程由本次任务自己启动并按 PID 结束，用户正在运行的实例没有被停止或改写。
