---
name: proxy-runtime
description: >-
  Proxy runtime semantics: reloadPair swaps pipeline and activeRequests as one object and
  drains the superseded generation, traffic log services are cached per resolved log root
  and redact flag, and the traffic log stores the decoded body while the client keeps the
  compressed bytes. Verify with a throwaway pipeline harness whose fixture upstream flushes
  per SSE frame, and prove an unchanged upstream request by diffing a base-revision assembly
  against the current one. Use when changing proxy pipelines, config save/reload, or
  response and usage logging.
---

# Proxy runtime reload and response logging semantics

## When this applies

- You change config save/reload, listener lifetime, or `ProxyManager` / `ProxyRuntimeRegistry`.
- You change how response bodies, SSE timings or usage numbers are captured.
- You need to prove a refactor left the upstream request byte-identical.

## Invariants

- A config save does not restart a listener whose listen address and enabled flag are
  unchanged. `ProxyManager` routes such pairs to `ProxyRuntimeRegistry.reloadPair()`, which
  swaps `{ pipeline, activeRequests }` as one object on the live listener and drains the
  superseded generation (ADR-011). Replacing only the pipeline leaves
  `resources.activeRequests` on the superseded registry, so `diagnostics()` double-counts the
  old requests and never sees the new ones.
- Traffic log services are cached per runtime entry by resolved `log_root` + `redact_logs`.
  Reusing the instance also avoids `markPendingPricingInterrupted()` rewriting in-flight
  `pending` pricing rows.
- Upstream responses arrive compressed (`gzip`/`br`/`zstd`/`deflate`), because the client's
  `Accept-Encoding` is forwarded upstream and Node's `http` client does not decode it. The
  traffic log stores the **decoded** body while the client keeps the encoded bytes verbatim
  (ADR-012, `src/proxy/response-decoder.ts` feeding `ResponseLogCapture`). A stored
  `{ text, size_bytes }` body full of U+FFFD replacement characters is the pre-fix shape:
  those compressed bytes were destroyed by the UTF-8 decode at store time and are
  unrecoverable.
- Node 24 / undici auto-decodes all four encodings, so the client was never broken — only the
  log, the SSE observer (`first_token_ms`, `decode_window_ms`) and the usage capture were.
- A pipeline test must wait on a promise resolved by the `request_finished` write: the client
  sees `end` before the pipeline logs it, so an array read straight after the client promise
  resolves is still empty.
- `first_token_ms` and `decode_window_ms` are sampled only for SSE responses; a buffered
  non-stream request legitimately has neither.

## Standard commands

```bash
npm test -- test-node/proxy test-node/logging
npm run typecheck
npm run check:modules

# The real save path, which unit and UI tests do not cover: spawn the built app in a
# throwaway cwd, open an SSE request through the proxy port, then PUT /api/pairs mid-stream.
node dist-node/src/main.js --port <admin> --config-file <pairs> --log-root <dir> \
  --application-config <file> --no-browser
```

## Reading the result

- A save that still moves the stream to a new port, or terminates it, means the listener was
  restarted instead of reloaded; a save that returns in milliseconds on the same port with
  every chunk delivered is the fix.
- `npm run check:modules` reports any new runtime import cycle as a dependency chain; the
  proxy barrel is the usual suspect because it carries the transport runtime.
- A stored body is correct when decompressing it yields the model's text; replacement
  characters mean the decode ran on compressed bytes.

## Deeper material

- [reference.md](./reference.md) — the before/after reload observation, the harness recipe
  and the byte-identical upstream proof.
- [ADR-011](../../../docs/decisions/adr/011-listener-reuse-on-config-save.md) and
  [ADR-012](../../../docs/decisions/adr/012-decoded-response-body-in-logs.md) — the reload and
  response-logging decisions.
- [current-architecture.md](../../../docs/current/architecture.md) §1 and §4 — the runtime
  model and the shutdown order.
