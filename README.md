# LLM Proxy

本地 HTTP 代理，用于记录 agent 和上游 LLM API 之间的完整交互。上游可以是本地 llama.cpp，也可以是 OpenRouter 等远程 OpenAI-compatible API。

默认行为按当前代码配置：

- 代理监听：`127.0.0.1:1234`
- 默认上游：`http://127.0.0.1:1235`
- 机器日志：`logs/interactions.jsonl`
- 可读日志：`logs/readable/*.md`

## 本地 llama.cpp

先启动 llama.cpp server，确保它监听在 `1235`：

```powershell
python proxy.py
```

然后把 agent 的 OpenAI-compatible base URL 改成：

```text
http://127.0.0.1:1234
```

## 远程 API

使用 `--target-url` 指定完整上游 base URL。比如代理 OpenRouter：

```powershell
python proxy.py --target-url https://openrouter.ai/api/v1
```

agent 仍然请求本地代理：

```text
http://127.0.0.1:1234
```

代理会把 `/chat/completions`、`/models` 等路径拼接到 `--target-url` 后面。例如：

```text
http://127.0.0.1:1234/chat/completions
=> https://openrouter.ai/api/v1/chat/completions
```

认证 header 可以由 agent 原样传进来，例如 `Authorization: Bearer ...`。也可以让代理固定注入上游 header：

```powershell
python proxy.py `
  --target-url https://openrouter.ai/api/v1 `
  --target-header "Authorization: Bearer sk-or-..." `
  --target-header "HTTP-Referer: http://localhost" `
  --target-header "X-Title: LLM Proxy"
```

`--target-header` 可以重复使用；如果和客户端传入的 header 同名，代理侧配置会覆盖客户端 header。

## 日志

代理会写两种日志，并且都保留完整 body 数据。

`logs/interactions.jsonl` 是机器可解析日志，每次交互一行 JSON。body 同时保存：

- `base64`：完整原始字节，可无损还原
- `text`：完整 UTF-8 文本，方便检索和阅读

`logs/readable/*.md` 是面向人工阅读的日志，每次交互一个 Markdown 文件，包含：

- Summary
- Request Headers
- Request Body
- Response Headers
- Response Body

如果响应是 OpenAI-compatible 的流式 SSE，例如多条 `data: {...}` chunk，可读日志会自动压缩重复字段，只展示聚合后的有效信息：

- `content`
- `reasoning`
- `tool_calls`
- `finish_reasons`
- `usage`
- `event_count`

原始流数据不会丢失，仍完整保存在 `logs/interactions.jsonl` 的 `response.body.text` 和 `response.body.base64` 中。

## 请求清洗

代理会在转发给上游前，默认移除请求 JSON 顶层的采样参数：

- `temperature`
- `top_p`
- `top_k`
- `min_p`
- `typical_p`
- `repeat_penalty`
- `presence_penalty`
- `frequency_penalty`
- `seed`

客户端原始请求仍会完整记录在 `request.body`。如果发生了清洗，日志会额外记录：

- `request.stripped_fields`：实际移除的字段
- `request.upstream_body`：实际转发给上游的 body

自定义要移除的字段：

```powershell
python proxy.py --strip-request-fields "temperature,top_p"
```

关闭请求清洗：

```powershell
python proxy.py --strip-request-fields ""
```

查看最新的可读日志：

```powershell
Get-ChildItem logs/readable -Filter *.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content
```

## 配置

常用参数：

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

`--target-url` 优先级高于 `--target-scheme/--target-host/--target-port`。

如果只想保留 JSONL，不生成 Markdown：

```powershell
python proxy.py --readable-log-dir ""
```

`--text-limit` / `LLM_PROXY_TEXT_LIMIT` 为兼容旧命令保留，但现在不再生效，日志总是保存完整数据。
