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
