---
name: real-upstream-acceptance
description: >-
  Prove a change against real upstream traffic without touching the user's instance: rebuild
  the payload so a stale asar cannot answer 404, launch the unpacked exe with a throwaway
  application config that sets admin.port, absolute log roots and a fresh
  LLM_PROXY_DATA_DIR, get ECONNREFUSED from a closed port instead of stopping a service, and
  read the stored record before blaming the product. Use when a change must be verified
  against real upstream behavior rather than fixtures.
---

# Acceptance against real upstreams without touching the user's instance

## When this applies

- A change affects forwarding, streaming, token accounting or summary generation, and
  fixtures cannot prove it.
- You need to reproduce a failure that only appears with a real engine, a real body size or a
  real model.
- You are about to call something "verified end to end".

## Invariants

- Rebuild the payload first (`npm run package:electron:dir`). The shipped
  `release/win-unpacked` asar keeps the previous build's routes, so a stale artifact answers
  404 for every new endpoint and the whole verification proves nothing.
- The throwaway application config must set `admin.port`. A file that is `{}` or carries only
  `admin.host` makes the exe exit before it writes a log line, which looks like a silent hang
  rather than a config error. `--port` sets the admin/UI port, not the proxy listen port,
  which comes from the pair config.
- Pair members need an **absolute** `log_root`. Relative roots resolve against the application
  config file's directory, so a copied config writes straight into the user's `traffic.db`.
  Pass a fresh `LLM_PROXY_DATA_DIR`, delete `ELECTRON_RUN_AS_NODE`, and keep `--log-root` as a
  fallback only.
- Never stop or kill a user service to simulate a dead node. Point a group member at a port
  that was bound and then closed: that produces a real `ECONNREFUSED`.
- Tell your own processes apart by creation time and kill only those. With `psutil` read
  `p.info["create_time"]`, not `p.create_time`, which is a bound method and dies with
  `TypeError`.
- Target objects read `target_url`, not `upstream_url`. A misspelled key falls through
  `normalizeTargetConfig()` to `DEFAULT_TARGET_URL` (`src/config/defaults.ts`), the proxy
  answers `502 Bad Gateway`, and the stored record's `response_meta.error` names the refused
  port: the application is reporting, not failing.
- Header redaction is gated by the target's `redact_logs` (default false). A harness that
  asserts `[redacted]` without turning it on reads the client's real `authorization` back and
  calls that a leak, while `strip_request_fields` only shapes the forwarded upstream request
  and never what is stored.
- The summary model only sees `model`/`messages`/`input`/`instructions` (`prepareSummaryRequest`),
  so client identity has to travel as a separate `client` block. A summary endpoint also
  rejects any payload without a `segments` array (`parseSummaryPayload` in
  `src/maintenance/summary-answer.ts`) with `summary_failed` and "did not return the
  expected JSON shape".
- The usage-statistics routes answer 400 when `from` and `to` are missing. Copy the query
  shapes from `probeUrl` in `test-node/admin/api-contract.test.ts` instead of inventing them.
- An unpriced record stores `cost_nano_cny` as NULL on purpose, so the runtime type of a
  value that is legitimately absent proves nothing. Assert the declared column type with
  `PRAGMA table_info(records)`.
- Do not judge routing overhead by toggling load balancing: every request then piles onto one
  default target and engine contention dominates the number.

## Standard commands

```bash
npm run package:electron:dir
# Delete ELECTRON_RUN_AS_NODE from the environment first.
release/win-unpacked/LLM\ Proxy.exe --no-browser --port <free> \
  --application-config <throwaway.json>

curl -s http://127.0.0.1:<free>/api/health
curl -s "http://127.0.0.1:<free>/api/logs?limit=5"
```

## Reading the result

- A 404 on a new endpoint means the payload is stale; rebuild before reading anything else.
- `502 Bad Gateway` names a target problem (`target_url` or a dead port), not a proxy defect.
- An empty history (0 groups, task brief 404 for every id) means the log root resolved
  somewhere else: check the application config file's directory.
- The hot path is memory-only when the status endpoint answers in under a millisecond and
  latency does not move between metrics-on and metrics-off.
- A late history row is usually the response, not the API: read `request_meta.duration_ms`
  and `response_meta.first_token_ms` before blaming the query.

## Deeper material

- [reference.md](./reference.md) — the measurements that produced these rules (empty config,
  load-balancing confound, body-size arithmetic) and the summary-model checks.
- [../packaging-smoke/SKILL.md](../packaging-smoke/SKILL.md) — isolation and launch mechanics.
- [ADR-012](../../../docs/adr/012-decoded-response-body-in-logs.md) — what a stored body must
  contain.
