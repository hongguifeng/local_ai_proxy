# Traffic-database forensics: history and measurements

Background for [SKILL.md](./SKILL.md).

## Why Python instead of Node

After `npm run rebuild:electron` the installed `better-sqlite3` carries the Electron ABI, so a
plain `node -e` cannot open the database. Python's stdlib `sqlite3` has no native dependency
and is always available, which makes it the pragmatic read path while a packaged run is in
progress. `npm run rebuild:node` restores the Node ABI when that is acceptable.

## The chunked body layout

The inline body columns were the original design. When bodies moved into `body_chunks`, the
upsert began nulling `request_body_json` / `response_body_json` once the text was chunked, and
`getRecord` re-reads them through `loadRecordBody`. The practical consequences measured here:

- `json_extract(request_body_json, …)` returns NULL for any record that was updated rather than
  inserted once.
- `request_headers_json` stayed inline, so header questions never need the chunk join.
- The codec is `deflate-raw-1`, i.e. raw deflate with no zlib header, so
  `zlib.decompress(data, -15)` is the correct call. A zlib-wrapped read fails immediately.
- Three body kinds share the chunk tables: `request`, `original_request` (the pre-rewrite body)
  and `response`. Selecting without `body_kind` mixes them.

## Measured scan costs

The production database was ~14 GB when these were taken, and a bounded scan stays cheap:

- `SELECT … FROM (SELECT col FROM records ORDER BY timestamp DESC LIMIT 3000)` on a header-only
  column: ~20 ms.
- The same shape when it parses 3000 header JSON documents: ~450 ms.

That is why distribution questions about sessions, upstreams and model mix are answerable
without booting the app.

## Pricing and speed accounting

- An unpriced record stores `cost_nano_cny` as NULL on purpose; `typeof(cost_nano_cny)` on a
  fresh database is `null` by design and a schema check has to assert the declared column type
  instead (`PRAGMA table_info(records)`).
- `pricing_reason: invalid_usage` for a whole task against an OpenAI-compatible upstream is
  normally an explicitly `null` optional field — vLLM sends `prompt_tokens_details: null` when
  cache accounting is off — rather than malformed token counts.
- Real prefill throughput comes from the engine's own counters
  (`prompt_tokens_by_source_total{source="local_compute"}` divided by
  `request_prefill_time_seconds_sum`). The Prefill chip divides by `first_token_ms`, which
  includes proxy body parsing and upstream tokenization, so it approximates rather than
  measures.
- `first_token_ms` and `decode_window_ms` only exist for SSE responses; buffered requests have
  end-to-end timing only.
