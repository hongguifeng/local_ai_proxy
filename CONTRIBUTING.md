# Contributing

Use Node.js 24.x and pnpm 11.11.0. Install with `pnpm install --frozen-lockfile`; do not add a second production runtime or bypass shared schemas in `packages/contracts`.

Before committing, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Changes to proxy protocols, SQLite schema, admin contracts, security boundaries, or packaging require focused tests and relevant documentation. Keep synchronous SQLite work inside Workers, capture bounded, proxy forwarding independent from logging success, secret values out of public DTOs/logs, and configuration updates recoverable on failure.

The project is actively developed. Prefer the simplest current UI/admin contract; do not introduce backward-compatibility shims unless explicitly required.
