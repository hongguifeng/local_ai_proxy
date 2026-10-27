# LLM Proxy v0.3.2

> 状态：历史
> 权威性：背景和追溯材料，不作为当前实现依据。
> 更新条件：只在历史事实或链接有误时更新。

## Fixes

- Persist portable application settings, proxy configuration, and logs beside the original EXE
  instead of Electron's temporary extraction directory.
- Change the default admin UI port from `8088` to `18080` and make the admin host and port
  configurable through `llm-proxy.json`.
- Package native Windows application and tray icons so the tray icon renders reliably.

## Configuration

The portable application creates `llm-proxy.json` beside the EXE on first launch:

```json
{
  "admin": {
    "host": "127.0.0.1",
    "port": 18080
  }
}
```

Command-line arguments and `LLM_PROXY_UI_HOST` / `LLM_PROXY_UI_PORT` override the file values.
