# LLM Proxy

English | [中文](README.cn.md)

LLM Proxy is a local HTTP proxy that forwards and records the complete interaction between an Agent and an OpenAI-compatible LLM API. The upstream target can be a local `llama.cpp` server, OpenRouter, an OpenAI-compatible gateway, or another remote API.

## Features

- Listens on a local address, defaulting to `127.0.0.1:1234`.
- Forwards requests to an upstream LLM API, defaulting to `http://127.0.0.1:1235`.
- Supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `HEAD`.
- Records request and response headers, bodies, status codes, durations, client addresses, and target addresses.
- Writes both machine-readable JSONL logs and human-readable Markdown/JSON logs.
- Groups multi-turn requests by task, making it easier to review a single Agent workflow.
- Generates compact summaries for OpenAI-compatible SSE streaming responses while preserving the complete original stream data.
- Removes selected top-level sampling parameters before forwarding by default, such as `temperature`, `top_p`, and `seed`.

## Project Structure

```text
llm_proxy/
  __init__.py       # Package exports for commonly used APIs
  __main__.py       # Entry point for python -m llm_proxy
  cli.py            # Command-line arguments and service startup
  constants.py      # Shared constants
  http_utils.py     # HTTP header helpers
  logger.py         # JSONL and readable log writers
  payloads.py       # Body encoding, parsing, and rendering
  records.py        # Request/response record analysis and task fingerprints
  sanitize.py       # Request field sanitization
  server.py         # HTTP proxy server and handler
  streams.py        # Compact summaries for SSE streaming responses
  target.py         # Upstream address parsing and path joining
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

## Logs

Default log locations:

- JSONL: `logs/interactions.jsonl`
- Readable logs: `logs/readable/`

Each readable interaction is written to its own directory and includes:

- A Markdown summary
- `request.json`
- `response.json`

Requests recognized as part of the same task are also archived under:

```text
logs/readable/tasks/
```

If the response is an SSE stream, `response.json` shows the aggregated `stream_summary`, including fields such as `content`, `reasoning`, `tool_calls`, `finish_reasons`, and `usage`. The raw response is not discarded; it remains available in `response.body.text` and `response.body.base64` in the JSONL log.

## Request Sanitization

By default, these top-level JSON fields are removed before a request is forwarded upstream:

```text
temperature, top_p, top_k, min_p, typical_p, repeat_penalty,
presence_penalty, frequency_penalty, seed
```

Customize the fields to remove:

```powershell
python -m llm_proxy --strip-request-fields "temperature,top_p"
```

Disable request sanitization:

```powershell
python -m llm_proxy --strip-request-fields ""
```

When sanitization occurs, the logs record:

- `request.stripped_fields`
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
- `--log-file` / `LLM_PROXY_LOG_FILE`
- `--readable-log-dir` / `LLM_PROXY_READABLE_LOG_DIR`
- `--timeout` / `LLM_PROXY_TIMEOUT`
- `--strip-request-fields` / `LLM_PROXY_STRIP_REQUEST_FIELDS`
- `--access-log` / `LLM_PROXY_ACCESS_LOG=1`

`--target-url` takes precedence over `--target-scheme`, `--target-host`, and `--target-port`.

## Tests

```powershell
python -m unittest discover -s tests
```
