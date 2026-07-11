# Configuration reference

The persisted file is strict JSON with `version: 1`. Unknown keys, duplicate IDs, invalid ports, invalid default targets, unsupported URLs, and out-of-range limits are rejected. Admin updates are validated by the same runtime schema and written atomically with restricted file permissions.

```json
{
  "version": 1,
  "capture": {
    "maxRequestBodyBytes": 33554432,
    "requestBytes": 8388608,
    "responseBytes": 8388608
  },
  "retention": { "days": 30 },
  "proxies": [
    {
      "id": "local-openai",
      "name": "Local OpenAI gateway",
      "enabled": true,
      "listenHost": "127.0.0.1",
      "listenPort": 1234,
      "accessLog": false,
      "defaultTargetId": "primary",
      "targets": [
        {
          "id": "primary",
          "name": "Primary upstream",
          "enabled": true,
          "url": "https://provider.example/v1",
          "targetApiKey": "env-or-local-secret",
          "headers": [{ "name": "x-client", "value": "llm-proxy" }],
          "stripRequestFields": ["metadata"],
          "injectRequestFields": { "stream": true },
          "timeouts": { "connectMs": 10000, "responseHeadersMs": 60000, "idleMs": 600000 },
          "logRoot": null,
          "redactLogs": true,
          "modelMappings": [{ "listen": "local-gpt", "upstream": "gpt-5" }]
        }
      ]
    }
  ]
}
```

## Defaults and limits

| Field | Default | Important constraint |
| --- | --- | --- |
| `capture.maxRequestBodyBytes` | 32 MiB | Oversized buffered JSON requests are rejected |
| `capture.requestBytes` | 8 MiB | 64 MiB hard maximum |
| `capture.responseBytes` | 8 MiB | 64 MiB hard maximum |
| `retention.days` | 30 | 0–3650 days |
| proxy `enabled` | false | Enabled proxy needs an enabled default target |
| `listenHost` / `listenPort` | `127.0.0.1` / 1234 | Listener pairs must be unique; port 0 is test-only dynamic binding |
| target `enabled` | true | Default target must remain enabled |
| `targetApiKey` | empty | Sent as `Bearer` unless already prefixed; never returned by admin API |
| `headers` | empty | Rejects invalid names and CR/LF injection |
| strip/inject/mappings | empty | Only top-level JSON fields are transformed |
| timeouts | 10s / 60s / 600s | Connect, response-header, and idle phases are separate |
| `logRoot` | null | null inherits CLI default; empty string disables target logging |
| `redactLogs` | false | Transport secrets are always removed before storage; true adds payload redaction |

Model mappings are evaluated in configuration order. Disabled non-default targets are skipped; unmatched or invalid/non-object JSON requests use the default target. Target URLs accept only HTTP/HTTPS origins and an optional base path, without query or fragment.

The public admin API represents secrets as masked state. Updates use `{ "action": "keep" }`, `{ "action": "clear" }`, or `{ "action": "set", "value": "..." }`.
