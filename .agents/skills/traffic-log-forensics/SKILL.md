---
name: traffic-log-forensics
description: >-
  Read logs/traffic.db with Python's stdlib sqlite3 when better-sqlite3 carries the Electron
  ABI: streamed bodies live in body_chunks reached through record_body_chunks and need
  zlib raw-deflate, the inline body columns are always NULL, bounded scans over a
  multi-gigabyte file are affordable, and pricing or speed questions are answered from stored
  usage and upstream counters. Use when studying request history without booting the app.
---

# Reading traffic history without the native module

## When this applies

- You need facts from request history and the app is running from the Electron build, so a
  plain Node process cannot load `better-sqlite3`.
- You are investigating an unpriced task, an unexpected model answer, or a routing decision.
- You need distribution answers (sessions, upstreams, model mix) without booting the app.

## Invariants

- Open the database with Python's stdlib `sqlite3`, read-only. After
  `npm run rebuild:electron`, `require("better-sqlite3")` from plain Node fails with
  `NODE_MODULE_VERSION`, which is the state this route exists for.
- Never commit a `.py` file: `test-node/docs/node-only-repository.test.ts` fails on any Python
  source in the tree. The scripts here are throwaway shell snippets.
- Bodies are stored per kind: `record_body_chunks(record_id, body_kind, chunk_index,
chunk_hash)` joins `body_chunks(hash, codec, raw_size, data)`. The three kinds are `request`,
  `original_request` and `response`.
- `codec` `deflate-raw-1` needs `zlib.decompress(data, -15)`, not the zlib wrapper, and chunks
  must be concatenated in `chunk_index` order per `(record_id, body_kind)`.
- The inline `request_body_json` / `original_request_body_json` / `response_body_json`
  columns are always NULL in this schema: the insert statement writes literal `NULL` and
  hands the text to `replaceRecordBody`, and `schema-v3.ts` nulled the old inline copies during
  its migration. So `json_extract(request_body_json, …)` always returns nothing; a body must be
  rebuilt from the chunks. `request_headers_json` _is_ stored inline and is cheap.
- A body is therefore never "missing" because of which storage path the record took: an absent
  body means nothing was recorded for that kind, so the check is whether
  `record_body_chunks` has rows for that `(record_id, body_kind)` before blaming the read.
- "Which upstream served this?" needs no body: `records.target_id` and `records.target_url` say
  it directly. `context_links` (`prompt_cache:<key>` → task) and `tasks.target` already exist
  for routing-affinity questions; `tasks.target` is `scheme://host:port` plus that record's
  request path, so match it against a node by origin and base path rather than verbatim.
- `first_token_ms` and `decode_window_ms` are sampled only for SSE responses. A buffered
  non-stream request legitimately has neither, and the UI falling back to end-to-end speed is
  expected, not a bug.
- A stored `cost_nano_cny` of NULL means the record is unpriced by design; the column type is
  what a schema question should assert.
- Never write to the file. The user's running instance owns it (WAL); a forensic read is a
  separate connection with `mode=ro`.

## Standard commands

```bash
python - <<'PY'
import sqlite3
db = sqlite3.connect("file:logs/traffic.db?mode=ro", uri=True)
db.row_factory = sqlite3.Row
for row in db.execute(
    "SELECT id, timestamp, target_url, model, pricing_reason, cost_nano_cny "
    "FROM records ORDER BY timestamp DESC LIMIT 20"
):
    print(dict(row))
PY
```

```bash
# Rebuild one body: header-only scan first, then the chunks for the id you picked.
python - <<'PY'
import sqlite3, zlib
db = sqlite3.connect("file:logs/traffic.db?mode=ro", uri=True)
record_id, kind = "…", "response"
chunks = db.execute(
    "SELECT b.data FROM record_body_chunks rb JOIN body_chunks b ON b.hash = rb.chunk_hash "
    "WHERE rb.record_id = ? AND rb.body_kind = ? ORDER BY rb.chunk_index",
    (record_id, kind),
).fetchall()
print(b"".join(zlib.decompress(row[0], -15) for row in chunks).decode("utf-8", "replace"))
PY
```

## Reading the result

- Judge token and speed claims against the upstream engine's `/metrics` counters
  (`prompt_tokens_by_source_total{source="local_compute"}` divided by
  `request_prefill_time_seconds_sum`) instead of the history chips: the Prefill chip divides by
  `first_token_ms`, which also covers proxy body parsing and tokenization, so it is an
  approximation.
- Triage an all-`unpriced` task by pulling the response `usage` object out of the chunks and
  reading it against `pricing_reason`. A whole task stuck on `invalid_usage` against an
  OpenAI-compatible upstream is normally an explicitly `null` optional field (vLLM sends
  `prompt_tokens_details: null` when cache accounting is off), not malformed token counts.
- A bounded scan is affordable: `SELECT … FROM (SELECT col FROM records ORDER BY timestamp DESC
LIMIT 3000)` costs milliseconds for a header-only column and well under a second when it
  parses 3000 headers.

## Deeper material

- [reference.md](./reference.md) — measured scan costs, the body-storage history and the
  pricing-accounting details.
- [ADR-009](../../../docs/decisions/adr/009-chunked-body-storage.md) — why bodies are chunked.
- `src/persistence/body-storage.ts` — the codec and the chunk layout this reads.
