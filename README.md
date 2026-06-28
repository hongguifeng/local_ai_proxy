# LLM Proxy

English | [中文](README.cn.md)

LLM Proxy is a local HTTP proxy that forwards and records the complete interaction between an Agent and an OpenAI-compatible LLM API. The upstream target can be a local `llama.cpp` server, OpenRouter, an OpenAI-compatible gateway, or another remote API. A built-in web UI provides multi-proxy management, log browsing, and search.

## Features

- Listens on a local address, defaulting to `127.0.0.1:1234`.
- Forwards requests to an upstream LLM API, defaulting to `http://127.0.0.1:1235`.
- Supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `HEAD`.
- Records request and response headers, bodies, status codes, durations, client addresses, and target addresses.
- Writes human-readable Markdown/JSON logs.
- Groups multi-turn requests by task, making it easier to review a single Agent workflow.
- Generates compact summaries for OpenAI-compatible SSE streaming responses while preserving the complete original stream data.
- Can remove selected top-level sampling parameters before forwarding, such as `temperature`, `top_p`, and `seed`.
- Built-in web UI at `http://127.0.0.1:8088` for managing multiple proxy pairs and browsing logs.

## Project Structure

```text
llm_proxy/
  __init__.py       # Package exports for commonly used APIs
  __main__.py       # Entry point for python -m llm_proxy
  cli.py            # Command-line arguments and service startup
  constants.py      # Shared constants
  http_utils.py     # HTTP header helpers
  logger.py         # Readable log writer
  manager.py        # Multi-proxy pair management and config persistence
  payloads.py       # Body encoding, parsing, and rendering
  records.py        # Request/response record analysis and task fingerprints
  sanitize.py       # Request field sanitization
  server.py         # HTTP proxy server and handler
  streams.py        # Compact summaries for SSE streaming responses
  target.py         # Upstream address parsing and path joining
  time_utils.py     # Time formatting helpers for logs
  ui.py             # Admin web UI (proxy management + log browser)
tests/
  test_proxy.py     # Unit tests
examples/
  responses_client.py
proxy.py            # Backward-compatible entry script
pyproject.toml      # Python project metadata and console script
```

## Quick Start

Proxy a local `llama.cpp` server:

```powershell
python -m llm_proxy
```

The legacy entry point is still available:

```powershell
python proxy.py
```

Start with the built-in web UI for multi-proxy management:

```powershell
python -m llm_proxy --ui
```

Proxy a remote OpenAI-compatible API:

```powershell
python -m llm_proxy --target-url https://openrouter.ai/api/v1
```

Inject fixed upstream headers:

```powershell
python -m llm_proxy `
  --target-url https://openrouter.ai/api/v1 `
  --target-header "Authorization: Bearer sk-or-..." `
  --target-header "HTTP-Referer: http://localhost" `
  --target-header "X-Title: LLM Proxy"
```

Point your client or Agent base URL to:

```text
http://127.0.0.1:1234
```

## Web UI

When started with `--ui`, the proxy serves an admin web interface at `http://127.0.0.1:8088` (configurable via `--ui-host` and `--ui-port`). The UI supports:

- **Proxy management**: add, edit, enable/disable, and remove multiple listen/target pairs, persisted in a JSON config file (`logs/proxies.json` by default).
- **Log browser**: browse all recorded interactions with search across method, path, status code, target URL, and task ID. Logs are grouped into tasks automatically when detected.
- **Request/response detail view**: inspect full request/response bodies, headers, and streaming summaries inline.

### Screenshots

Proxy management interface:

![Proxy Management UI](doc/ui_proxy.png)

Log browser with history and search:

![History Logs UI](doc/ui_history_logs.png)

## Logs

Default log locations:

- Readable logs: `logs/readable/`
- Proxy config: `logs/proxies.json`

Each readable interaction is written to its own directory and includes:

- A Markdown summary
- `request.json`
- `response.json`

Requests recognized as part of the same task are also archived under:

```text
logs/readable/tasks/
```

If the response is an SSE stream, `response.json` shows the aggregated `stream_summary`, including fields such as `content`, `reasoning`, `tool_calls`, `finish_reasons`, and `usage`.

## Request Sanitization

Request sanitization is disabled unless fields are configured. The proxy can remove selected top-level JSON fields and inject custom top-level JSON fields before forwarding. The web UI shows these suggested fields to remove as the placeholder for new proxy configurations:

```text
temperature, top_p, top_k, min_p, typical_p, repeat_penalty,
presence_penalty, frequency_penalty, seed
```

Enable request sanitization from the CLI:

```powershell
python -m llm_proxy --strip-request-fields "temperature,top_p"
```

Inject custom request fields from the CLI by passing a JSON object:

```powershell
python -m llm_proxy --inject-request-fields '{"metadata":{"source":"proxy"},"stream":true}'
```

Leave unset, pass an empty string, or clear the UI field to keep request sanitization disabled:

```powershell
python -m llm_proxy --strip-request-fields ""
```

When sanitization occurs, the logs record:

- `request.stripped_fields`
- `request.injected_fields`
- `request.upstream_body`

## Configuration

Command-line arguments and environment variables:

- `--listen-host` / `LLM_PROXY_HOST`
- `--listen-port` / `LLM_PROXY_PORT`
- `--target-url` / `LLM_PROXY_TARGET_URL`
- `--target-scheme` / `LLM_PROXY_TARGET_SCHEME`
- `--target-host` / `LLM_PROXY_TARGET_HOST`
- `--target-port` / `LLM_PROXY_TARGET_PORT`
- `--target-header`
- `--log-file` / `LLM_PROXY_LOG_FILE` (deprecated; JSONL logs are no longer written)
- `--readable-log-dir` / `LLM_PROXY_READABLE_LOG_DIR`
- `--timeout` / `LLM_PROXY_TIMEOUT`
- `--strip-request-fields` / `LLM_PROXY_STRIP_REQUEST_FIELDS`
- `--inject-request-fields` / `LLM_PROXY_INJECT_REQUEST_FIELDS`
- `--access-log` / `LLM_PROXY_ACCESS_LOG=1`
- `--ui` / `LLM_PROXY_UI=1` (enable built-in web admin UI)
- `--ui-host` / `LLM_PROXY_UI_HOST` (default: `127.0.0.1`)
- `--ui-port` / `LLM_PROXY_UI_PORT` (default: `8088`)
- `--config-file` / `LLM_PROXY_CONFIG_FILE` (proxy pair config file path, default: `logs/proxies.json`)

`--target-url` takes precedence over `--target-scheme`, `--target-host`, and `--target-port`.

## Tests

```powershell
python -m unittest discover -s tests
```
