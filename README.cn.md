# LLM Proxy

[English](README.md)

LLM Proxy 是使用 Node.js 24 + TypeScript 开发的本地 LLM 网关，支持 OpenAI 兼容协议和 Claude Messages 流量，提供按模型选择上游、有界流式捕获、SQLite 历史记录和内置浏览器管理界面。

## 安装和启动

源码开发需要 Node.js 24.x 和 pnpm 11.11.0。

```powershell
pnpm install --frozen-lockfile
pnpm build
node apps/server/dist/cli.js
```

管理界面默认打开 `http://127.0.0.1:8088`。配置默认位于 `logs/proxies.json`，流量数据库默认位于 `logs/traffic.db`。相对路径以进程工作目录为基准，部署为服务时建议使用绝对路径。

使用发布的 npm tarball：

```powershell
npm install -g .\llm-proxy-contracts-<version>.tgz .\llm-proxy-server-<version>.tgz
llm-proxy --help
llm-proxy --no-browser
```

Windows 用户可解压便携 ZIP 后运行 `start.cmd`；需要托盘时运行 `scripts/windows/start-tray.cmd`，托盘只是管理独立 Node CLI 的薄外壳。

## 核心流程

1. 在 Proxy 页面创建一个监听器和一个或多个上游 target。
2. 把 SDK 地址指向本地监听器，例如 `http://127.0.0.1:1234/v1`。
3. LLM Proxy 根据 JSON 顶层 `model` 选择 target，应用字段或模型改写，并流式转发响应。
4. 在 Logs 页面搜索任务、查看有界请求/响应捕获、导出 ZIP 或清理旧数据。

数据面支持 HTTP/1.1 常用 method、普通流式响应和 SSE，以及 OpenAI Responses/chat/completions 与 Claude Messages 摘要。不支持 CONNECT、WebSocket upgrade、入站 HTTP/2/3 和正向代理 absolute-form URL。

## CLI

```text
llm-proxy [--host HOST] [--port PORT] [--config-file PATH] [--log-root PATH]
          [--no-browser] [--allow-remote-admin] [--admin-token TOKEN]
llm-proxy migrate --source <python-data-dir> --target <node-data-dir>
```

admin 默认只监听 loopback。绑定非 loopback 地址时必须同时提供 `--allow-remote-admin` 和 bearer token。可用环境变量：`LLM_PROXY_UI_HOST`、`LLM_PROXY_UI_PORT`、`LLM_PROXY_CONFIG_FILE`、`LLM_PROXY_LOG_ROOT`、`LLM_PROXY_NO_BROWSER=1`、`LLM_PROXY_ADMIN_TOKEN`；CLI 参数优先。

## 开发命令

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm pack:npm
pnpm smoke:npm
pnpm pack:portable
pnpm smoke:portable
```

目录结构：

- `apps/server`：CLI、管理服务、代理数据面、运行时装配和 SQLite Worker。
- `apps/web`：Vite + TypeScript 管理界面。
- `packages/contracts`：共享 Zod 运行时 schema 和 DTO。
- `packages/test-fixtures`：语言无关协议 fixture。
- `scripts`：发布、打包、smoke、性能和 Windows shell 工具。
- `doc`：架构决策、迁移、验收、运维和配置文档。

## 更多文档

- [配置 schema、默认值和示例](doc/configuration.md)
- [运维、备份、排障、发布和回滚](doc/operations.md)
- [Python 到 Node 数据迁移](doc/migration_guide.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [Node 主实现验收和有意差异](doc/node_acceptance_report.md)

许可证：MIT。
