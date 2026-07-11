# Changelog

## Unreleased — Node.js rewrite

- Node.js 24 + TypeScript production runtime replaces the Python prototype.
- Admin contracts move to strict `/api/v1` schemas and never return complete secrets.
- Proxy streaming, bounded capture, SQLite Workers, retention, health, metrics and structured logging are production-composed.
- Distribution uses an installable npm CLI and a Windows portable package with a thin tray shell.
- Existing Python data migrates through the one-time `llm-proxy migrate` command; no runtime dual-read or dual-write layer is provided.

See `doc/node_acceptance_report.md` for the intentional behavior differences from Python v0.2.0.
