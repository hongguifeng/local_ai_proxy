# Real-upstream acceptance: the measurements behind the rules

Background for [SKILL.md](./SKILL.md).

## The empty and host-only config hang

Measured on `release/win-unpacked`: a throwaway application config carrying `admin.port`
served `/api/health` and `/api/logs`, while the host-only and the empty variants never bound
a port at all and wrote no log line. That is why "the exe hung" is a config-shape answer
first.

## Why load balancing cannot be measured by toggling it

Toggling load balancing off to measure routing overhead confounds the number with engine
contention, because every request then piles onto one default target. On two identical
engines the median was _lower_ with the group on than off. The hot path was instead proven
memory-only by timing the status endpoint (~0.75 ms) and comparing metrics-on against
metrics-off latency.

## Body size and prefill arithmetic

Read a record's `request_meta.duration_ms` / `response_meta.first_token_ms` before blaming the
API for late history: a 1.5 MB body is ~193k prompt tokens and 41 s of engine prefill, so
visibility follows the response, not the body read.

## Summary and brief checks

Real-model checks against the user's own config are cheap, because the summary model is a
local proxy port, and they are the only way to prove a prompt change extracts what it asks
for. Two lessons:

- Whatever the model must know has to be inside the input. `prepareSummaryRequest` keeps only
  `model`/`messages`/`input`/`instructions`, so request headers (client identity) are
  invisible unless sent alongside — the task brief passes them as a separate `client` block.
- A fixture that returns only `outcome`/`model_note` proves nothing about undeclared-key
  survival, because the parser refuses a payload without `segments` before it can answer.

## A harness bug once looked like a product failure

A target key written as `upstream_url` fell through `normalizeTargetConfig()` to
`DEFAULT_TARGET_URL`, the proxy answered 502, and the stored record's `response_meta.error`
named the refused port. `Bad Gateway` is produced by the pipeline when the upstream call
fails, so it is the application reporting a harness mistake, not the application failing.
