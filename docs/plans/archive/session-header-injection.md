# 上游会话头补齐实施计划

> 状态：历史计划
> 权威性：历史执行记录，不作为当前待办。
> 更新条件：只补充归档说明或修正链接。

当前状态：SH-01～SH-04 完成（2026-11-05 收口），SH-05 交付链在本次收口时跑完。设计权威见[上游会话头补齐设计](../../design/accepted/session-header-injection.md)，决策记录见 [ADR-016](../../decisions/adr/016-upstream-session-header-injection.md)，当前行为见[产品当前行为](../../current/product.md)。

## 1. 任务表

| 编号  | 任务                                                                                                        | 依赖         | 验收证据                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| SH-01 | 配置合同：`session_header` 进 schema、normalizer、preservation 键表、默认值和负载均衡的目标设置指纹         | 无           | `test-node/config/*`、`npm run check:modules`                                                              |
| SH-02 | 代理数据面：新增 `src/proxy/session-header.ts`（纯函数），在请求流水线里补头并记录 `added_upstream_headers` | SH-01        | `test-node/proxy/session-header.test.ts`、`proxy-listener.test.ts`、`load-balancer-pipeline.test.ts`       |
| SH-03 | 管理端 UI：目标“更多目标选项”里的输入框与中英文案                                                           | SH-01        | `test-node/ui/admin-ui-proxy.test.ts`、可能的视觉基线重拍                                                  |
| SH-04 | 当前文档与 ADR 收口：`docs/current/product.md`、设计文档转 accepted、计划归档                               | SH-02、SH-03 | `npx vitest run test-node/docs`、`npx prettier --check`、`git diff --check`                                |
| SH-05 | 便携交付链与包内内容证明                                                                                    | SH-02～SH-04 | `package:electron:portable` → `smoke:delivery` → `rebuild:node` → `abi:node`，并在 `app.asar` 内确认新字段 |

## 2. 执行约定

开始前读根目录 `AGENTS.md`、[现行架构](../../current/architecture.md)，以及 `proxy-runtime`、`admin-api-probing`、`ui-markup-contracts`、`packaging-smoke` 里与本次任务相关的部分。用户正在运行的便携版实例只读：不停止它、不改它的配置，实验一律用隔离数据目录、独立端口和独立日志根。

## 3. 验收检查顺序

1. 定向 Vitest 先跑热：`npx vitest run test-node/proxy/session-header.test.ts test-node/proxy/proxy-listener.test.ts --coverage.enabled=false`。
2. `npm run typecheck`、`npm run lint`、`npm run format:check`、`git diff --check`。
3. UI 改动后跑 `test-node/ui/admin-ui-proxy.test.ts`，并确认目标卡片的视觉基线是否需要重拍。
4. `npx vitest run test-node/docs` 与新文档的 `npx prettier --check`。
5. `npm run check` 全量收口。
6. 交付链 `package:electron:portable` → `smoke:delivery` → `rebuild:node` → `abi:node`。

## 4. 风险与停止条件

- 如果补头改变了关闭状态下的转发集合（R1），停止：这个功能的第一条价值就是不启用时零风险。
- 如果覆盖了客户端已经带来的同名头（R2），停止：那会把客户端自己的路由分桶改掉。
- 如果派生 id 在同一会话的连续请求之间不稳定（R4），停止：不稳定的 id 比没有 id 更糟，它会让路由和缓存来回抖。
- 如果补头让日志记下了头的值（R6），停止：值可能等于客户端的会话 id。

## 5. 完成后要做的文档动作

- 当前行为：把字段语义、取值顺序和“压缩请求只换一次桶”的代价写进 `docs/current/product.md`。
- 设计：从 `docs/design/active/` 收口到 `docs/design/accepted/`，并按 `docs/README.md` 的入口表更新。
- 决策：[ADR-016](../../decisions/adr/016-upstream-session-header-injection.md) 写清为什么不覆盖客户端头、为什么不做模糊匹配。
- `npm run check:skills`：本计划未新增或删除 skill，只改文档路径，由 `test-node/docs` 覆盖。✅

## 6. 收口记录

- 新增与改写的测试：`session-header.test.ts` 12 项（关闭时零改动、已有同名头零改动、三个来源头的顺序、同会话相同、跨会话不同、非 JSON 退回路径哈希、大文本前缀上界）；`proxy-listener.test.ts` 新增四条真实监听器用例；`load-balancer-pipeline.test.ts` 新增 SH-09 切换复用同一个值；`admin-ui-proxy.test.ts` 新增保存与回填一条；`config-schema.test.ts` 新增字段与非法头名六条。
- 视觉基线：重拍中文代理页后与 HEAD 的提交件比对，内容差异全部都在单通道 ±三十二个色阶以内（无超过八个亮度级别的像素），属于渲染噪声；因此不提交这张图的改动，基线表不变。
- 未做：`summary_model` 侧的同类兼容（`summary_model.target_headers` 里仍只能写固定值），见设计第 4 节。
- 交付链（2026-11-05）：`package:electron:portable` 产出 `release/LLM-Proxy-0.4.11-x64-portable.exe`（10:53），`smoke:delivery` 两个冒烟都 `exit code 0`，随后 `rebuild:node` → `abi:node` 报 `NODE_MODULE_VERSION 137`、真实查询返回 `{"a":1}`。
- 真实上游对照验收：同一个打包产物、两个只差 `session_header` 的隔离 pair，指向真实 OpenCode Go。打开字段的 pair 拿到 200 的 SSE 开头，留空的 pair 拿到原始的 400 `MissingSessionID`；两边记录里的 `added_upstream_headers` 分别是 `["x-opencode-session"]` 和 `[]`。证据见[验收报告](../../reports/session-header-acceptance.md)。
