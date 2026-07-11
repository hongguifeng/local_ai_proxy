# Language-neutral test fixtures

These files freeze externally observable behavior from the historical Python `v0.2.0` baseline. They are committed language-neutral inputs and expected outputs; production modules must not generate expected values.

The original Python exporter is preserved in the `python-runtime-final` tag. Current changes should add or update fixtures explicitly with a reviewed product decision and update `manifest.json` hashes. JSON fixture documents reference `schema/fixture-set.schema.json`. Binary files are described by their filename and manifest entry:

- `binary/invalid-utf8.bin`: invalid UTF-8 bytes.
- `binary/payload.json.gz`: deterministic gzip-compressed JSON.
- `binary/malformed.json`: truncated JSON bytes.
- `proxy/duplicate-headers.json`: ordered repeated header pairs.

Directories:

- `proxy`: URL join, model route/rewrite, field transformation, redaction, and header fixtures.
- `streams`: raw OpenAI Responses, Chat Completions, Completions, and Claude Messages SSE plus expected summaries.
- `tasks`: language-neutral request sequences and expected task relationships.
- `schema`: fixture document schema.
