# Reload and encoding regressions: how they were measured

Background for [SKILL.md](./SKILL.md).

## The reload observation

Before the fix, a `PUT /api/pairs` issued mid-stream while an SSE response was open returned
~2 s later on a **new** port with a `terminated` stream. After switching to
`reloadPair()`, the same call returned in milliseconds on the same port with every chunk
delivered. Unit and UI tests never see this, because nothing else exercises in-flight
semantics; the built app has to be spawned with `--port`, `--config-file`, `--log-root`,
`--application-config` and `--no-browser`, and the save has to happen while a stream is open.

The double-counting symptom came from replacing only the pipeline: `diagnostics()` kept
reading `resources.activeRequests` from the superseded registry, so old requests stayed
counted and new ones never appeared.

## The encoding harness

A throwaway `.mts` at the repository root (deleted afterwards) with `ProxyRequestPipeline`, a
stub `TrafficLogWriter` and a fixture upstream:

- Compress per SSE event with `createGzip()` and then `flush()`. Without the flush a split
  compressed frame produces no output, so the first-token timing measures nothing and the test
  proves the wrong thing.
- Node's `http` client leaves `content-encoding` bodies encoded, so assert client-side
  passthrough by decompressing the received bytes inside the test.
- Point the same harness at the user's real target (read the URL and API key out of
  `proxies.json`, never print them) to prove the upstream's own framing decodes.
- Wait on a promise resolved by the `request_finished` write; the client sees `end` before the
  pipeline logs it.

The pre-fix shape was a stored `{ text, size_bytes }` body of U+FFFD replacement characters —
the UTF-8 decode had already destroyed the compressed bytes at store time, so those records
cannot be recovered. Node 24 / undici does auto-decode all four encodings, which is why
clients never noticed.

## Proving an unchanged upstream request without a paid upstream

- `git show <base>:<path>` the pre-change file into an untracked dot-directory at the
  repository root, and rewrite its `../` import prefixes with one `sed` so it loads beside the
  current code.
- Drive the old assembly and the new one against one seeded log root with a `fetch` stub that
  records URL, method, header order, body and signal presence.
- Compare the two recordings after normalizing clock fields (`generated_at`, `durationMs`);
  otherwise the only reported difference is the timestamp.
- `tsconfig.json` includes `test-node/**` and `scripts/**` and the eslint globs cover the same
  paths, so a scratch file under them is typechecked and linted with real code, while a
  dot-directory outside the globs is neither. Keep the scratch code in a dot-directory.
