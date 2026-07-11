# LLM Proxy

[中文](README.cn.md)

LLM Proxy is a local Node.js 24 + TypeScript gateway for OpenAI-compatible and Claude Messages traffic. It provides model-based upstream routing, bounded streaming capture, SQLite-backed history, and a built-in browser admin console.

## Install and run

Requirements for source development: Node.js 24.x and pnpm 11.11.0.

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/server/dist/cli.js
```

The admin UI opens at `http://127.0.0.1:8088`. Configuration defaults to `logs/proxies.json`; traffic databases default to `logs/traffic.db`. Relative paths resolve from the process working directory, so services should use absolute paths.

For a released npm tarball, install both matching packages and run the CLI:

```bash
npm install -g ./llm-proxy-contracts-<version>.tgz ./llm-proxy-server-<version>.tgz
llm-proxy --help
llm-proxy --no-browser
```

On Windows, extract the portable ZIP and run `start.cmd`, or `scripts/windows/start-tray.cmd` for the optional thin tray shell.

## Core workflow

1. Open the Proxy tab and create a listener with one or more upstream targets.
2. Point an SDK at the listener, for example `http://127.0.0.1:1234/v1`.
3. LLM Proxy selects a target from the top-level JSON `model`, applies configured field/model rewrites, and streams the upstream response.
4. Open the Logs tab to search tasks, inspect bounded request/response captures, export ZIP archives, or clean old data.

Supported data plane: HTTP/1.1 `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `HEAD`; ordinary streaming responses and SSE; OpenAI Responses/chat/completions-style and Claude Messages summaries. CONNECT, WebSocket upgrades, inbound HTTP/2/3, and forward-proxy absolute-form URLs are not supported.

## CLI

```text
llm-proxy [--host HOST] [--port PORT] [--config-file PATH] [--log-root PATH]
          [--no-browser] [--allow-remote-admin] [--admin-token TOKEN]
llm-proxy migrate --source <python-data-dir> --target <node-data-dir>
```

Admin binds to loopback by default. A non-loopback host requires both `--allow-remote-admin` and a bearer token. Equivalent environment variables are `LLM_PROXY_UI_HOST`, `LLM_PROXY_UI_PORT`, `LLM_PROXY_CONFIG_FILE`, `LLM_PROXY_LOG_ROOT`, `LLM_PROXY_NO_BROWSER=1`, and `LLM_PROXY_ADMIN_TOKEN`; CLI arguments take precedence.

## Development

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm pack:npm && pnpm smoke:npm
pnpm pack:portable && pnpm smoke:portable   # Windows
```

Workspace layout:

- `apps/server`: CLI, admin server, proxy data plane, runtime composition, SQLite Workers.
- `apps/web`: Vite + TypeScript admin UI.
- `packages/contracts`: shared Zod runtime schemas and DTOs.
- `packages/test-fixtures`: language-independent protocol fixtures.
- `scripts`: release, package, smoke, performance, and Windows shell tooling.
- `doc`: architecture decisions, migration, acceptance, operations, and configuration.

## Documentation

- [Configuration schema and examples](doc/configuration.md)
- [Operations, backup, troubleshooting, release and rollback](doc/operations.md)
- [Python-to-Node migration](doc/migration_guide.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Node acceptance and intentional differences](doc/node_acceptance_report.md)

License: MIT.
