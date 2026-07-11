# LLM Proxy v0.3.0-rc.1

This release candidate makes the Node.js 24 + TypeScript implementation the sole production runtime.

## Highlights

- Streaming HTTP/1.1 proxy with OpenAI-compatible and Claude Messages routing and summaries.
- Strict atomic configuration, secret-safe `/api/v1` admin API, and Vite browser UI.
- Bounded request/response capture, per-root SQLite Workers, searchable task history, cleanup and streaming ZIP export.
- Structured logs, health, metrics, retention, capacity limits, fault containment, and remote-admin security gates.
- Installable npm CLI, Windows portable ZIP with bundled Node 24.18.0, optional thin tray shell, checksums, SBOM, license inventory and provenance.
- One-time `llm-proxy migrate` command for Python v0.2.0 config and SQLite data.

## Upgrade

Stop the Python service, make an offline backup, and follow `doc/migration_guide.md`. Node uses a separate target directory and never dual-writes. Verify proxy traffic, task history and health before retiring the source directory.

## Known limitations

- Supported release platforms are Windows 10/11 x64 and mainstream glibc Linux x64; ARM64 and macOS are not release-qualified.
- Data plane is inbound HTTP/1.1 only. CONNECT, WebSocket upgrade, HTTP/2/3 and forward-proxy absolute-form requests are unsupported.
- Inbound TLS termination and OS credential storage are not built in. Use a hardened reverse proxy and protected local config when required.
- JSON request transformation requires a bounded buffered JSON object; non-JSON/encoded bodies stream unchanged.
- Traffic logging is best-effort. Storage failure or queue overload preserves forwarding but may omit captures.
- Windows tray support is a PowerShell/WinForms thin shell around the independent CLI, not a native single-file application.

## Verification target

The RC is accepted only after clean Windows/Linux build and package smoke, a 60-minute mixed ordinary/SSE soak, migration and rollback rehearsal, checksum/SBOM/license verification, and database/socket/Worker/temp-file cleanup checks.
