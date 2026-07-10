# Language-neutral test fixtures

These files freeze externally observable behavior from Python `v0.2.0` for the Node.js rewrite. Production Node modules must not generate expected values. Tests read the committed JSON, SSE, gzip, malformed JSON, and binary files directly.

Regenerate after an intentional baseline decision:

```powershell
python scripts/export_python_fixtures.py
python scripts/export_python_fixtures.py --check
```

`manifest.json` contains a SHA-256 digest for every fixture. Regeneration is deterministic; review fixture diffs as product behavior changes. JSON fixture documents reference `schema/fixture-set.schema.json`. Binary files are described by their filename and manifest entry:

- `binary/invalid-utf8.bin`: invalid UTF-8 bytes.
- `binary/payload.json.gz`: deterministic gzip-compressed JSON.
- `binary/malformed.json`: truncated JSON bytes.
- `proxy/duplicate-headers.json`: ordered repeated header pairs.

Directories:

- `proxy`: URL join, model route/rewrite, field transformation, redaction, and header fixtures.
- `streams`: raw OpenAI Responses, Chat Completions, Completions, and Claude Messages SSE plus expected summaries.
- `tasks`: language-neutral request sequences and expected task relationships.
- `schema`: fixture document schema.

