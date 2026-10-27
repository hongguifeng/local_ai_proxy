# 故障排查

> 状态：运维手册
> 权威性：本地开发、测试和交付故障的排查入口。
> 更新条件：命令、产物路径、运行时错误或隔离规则变化时更新。

先确认工作目录、Node 版本和当前实例边界。不要停止用户正在运行的便携版；所有验证使用临时配置、独立数据目录和空闲端口。

## CLI 无法启动

先运行：

```bash
npm run build
npm start
```

检查 `llm-proxy.json` 是否是合法 JSON，管理端 host/port 是否可用，`logs/proxies.json` 是否能通过配置 schema。应用配置缺失时会创建默认文件；JSON 非法或 schema 错误会让启动失败并保留错误原因。

Electron 运行失败时先运行源码 CLI 排除核心服务问题，再按 [打包与交付 skill](../../.agents/skills/packaging-smoke/SKILL.md) 检查 `release/win-unpacked` 的 payload。启动时删除 `ELECTRON_RUN_AS_NODE`，否则 Electron 会被 Node 模式接管。

## SQLite 原生模块错误

`better-sqlite3` 必须与当前运行时 ABI 匹配：

```bash
npm run abi:node
npm run abi:electron
```

`require("better-sqlite3")` 本身不能证明绑定可加载，ABI 探针必须实际打开 `:memory:` 并执行 `select 1`。打包顺序固定为 `npm run build` → `npm run rebuild:electron` → Electron 打包；打包之后才恢复 Node ABI。不要在 Electron 重建和打包之间执行 `npm rebuild better-sqlite3`。

## 管理端或历史页面报错

先请求 `/api/health`，再请求具体接口。路由由 `src/admin/routes/` 注册，服务由 `src/app/admin-services.ts` 装配；启动阶段服务集合不完整会失败，不应该靠重启解决。管理 API 的 400/404/500 语义见 [API 合同](../current/contracts/admin-api.md)。

历史查询按当前 pair 的日志根读取。确认配置中的 target `log_root`、日志根下的 `traffic.db`、数据库 schema 版本和 Node ABI；不要只看启动时曾经使用过的目录。

## UI 或浏览器测试失败

先单独运行对应文件：

```bash
npx vitest run test-node/ui/<相关文件>.test.ts
```

UI 是一个 bundle；读取 `static-checks-and-split`、`ui-test-quirks` 和 `render-internals` skill。视觉失败时保留 runner 实拍图，检查宽度、重叠像素比例和多余空白行，再决定是否需要重新生成基线。不要因为 hash 不同就直接提交新图片。

## 响应内容或速度看起来错误

确认上游是否返回压缩内容、是否为 SSE、客户端是否提前断开，以及日志读取的是解码正文还是客户端收到的原始字节。速度指标只代表已存的请求和响应时间，缺失 usage 不得当成真实 token。详细请求生命周期见 `proxy-runtime` skill 和相关 ADR。

## CI 失败

使用 `ci-triage` skill 通过 GitHub Actions API 读取 job 和 artifact。先下载失败 runner 的原始日志，再区分断言失败、资源超时、ABI、视觉环境差异和打包错误。不能通过增加重试、删除测试或降低像素阈值来消除未知失败。

### Vitest worker 在 windows runner 上因 V8 堆耗尽退出

日志签名是这三行同时出现：

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
[vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly
```

这不是断言失败：汇总行仍然写着全部文件通过（例如 `150 passed | 1 skipped`），只有那个 worker 手里的文件没跑完，若干用例根本没执行，最后包装步骤以 `exit code 1` 收尾。判断 CI 是否真的红，要看 job 级结论和 `FAIL` 行，不能只看 run 级结论。

已测到的证据：

- 只在 windows-latest 出现。同一次 run 里 ubuntu-latest 的 job 是绿的（CI#213）。
- 这是拆文件之前就住在这里的老住户。CI#203（sha `2f86e69`，负载均衡套件还是单文件）与 CI#213（sha `38a80dc`）的 windows 日志含同一组三行。拆完之后 windows 4 次崩 1 次，拆之前 8 次崩 1 次，没有变频繁的证据。
- 不是某个单文件过重：`test-node/pricing/pricing-benchmark.test.ts` 单独跑，在 `--max-old-space-size=512` 下也过。
- 配置本身不必然复现：本地用 `CI=true`（仓库配置因此取 `maxWorkers: 2`）加 `--max-old-space-size=2048` 跑全量，1573 通过、2 跳过，没有崩。

因此它指向的是“同一个 forked worker 连跑几十个文件后累积的状态”撞上了 Windows 的提交内存上限，而 Linux 的 overcommit 让它从不出现。再次发生时，记下 run 号和 job 号、把这三行原文留在报告里，再决定是调 worker 堆还是调并发；不要先动测试。
