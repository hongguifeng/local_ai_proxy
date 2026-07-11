# Node.js 性能基线

测量时间：2026-07-11。环境：Windows、Node.js v24.18.0。命令：`pnpm benchmark`。基准使用本机 loopback fixture upstream，生产结果需在目标硬件上重新执行。

| 场景 | 结果 |
| --- | --- |
| 普通 JSON，50 并发，1,000 请求 | 1,614 req/s；p50 25.83 ms；p95 81.43 ms；p99 84.42 ms |
| SSE，100 并发，目标 60 秒 | 61.09 秒完成；无失败；heap 增量 6.64 MiB |
| event loop / CPU（上述完整运行） | event-loop p99 32.36 ms；user CPU 1,266 ms；system CPU 594 ms |
| storage queue，10,000 events | 5.36 ms；10,000 committed；0 failed/dropped；max commit 1 ms |
| 100 MiB response | 自动化测试约 1.85 秒；hash 完全一致；capture 有界 |
| 慢 downstream | 自动化测试约 0.99 秒；背压传播，无无界缓冲 |
| 100,000 tasks recent query | 自动化测试约 0.45 秒；查询计划使用索引 |

## 复现

1. 使用 Node.js 24 和锁定的 pnpm 版本执行 `pnpm install --frozen-lockfile`。
2. 执行 `pnpm benchmark`。SSE 默认持续 60 秒；短诊断可设置 `LLM_PROXY_SSE_BENCHMARK_MS`。
3. 运行 `pnpm test -- apps/server/test/proxy-response-pipeline.test.ts apps/server/test/storage-repository.test.ts apps/server/test/storage-write-queue.test.ts` 验证大响应、慢客户端、队列和查询不变量。

当前数据未显示需要无测量依据的专项优化。下一次依赖升级、代理流水线变更或发布候选构建应保存同类机器的对比结果。
