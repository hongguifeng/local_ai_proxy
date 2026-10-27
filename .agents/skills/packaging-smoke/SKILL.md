---
name: packaging-smoke
description: >-
  Build and smoke-test the portable exe: inspect release/win-unpacked app.asar instead of
  the NSIS-wrapped exe, delete ELECTRON_RUN_AS_NODE before spawning it, isolate a run with
  LLM_PROXY_DATA_DIR, a free port and LLM_PROXY_SMOKE_EXIT_FILE, resolve history log roots
  from the application config's directory, and prove SQLite with a real query. Use when
  building, packaging or smoke-testing the packaged app or its installer.
---

# Portable packaging and smoke launches

## When this applies

- You build the Windows portable exe or the installer, and need to know what shipped.
- A packaged launch fails to become healthy, or answers 500 on a database route.
- You change the smoke harness entry points or the Electron main process.

## Invariants

- The portable exe is an NSIS wrapper around a 7z-compressed `win-unpacked` payload, so raw
  string search in the `.exe` finds nothing. Verify contents in
  `release/win-unpacked/resources/app.asar` (or extract the 7z payload with 7-Zip).
- The exe name and version do not change between consecutive same-version builds. Tell your
  launch from the user's by process creation time and unpack path (portables unpack into a
  `Temp` directory), and only kill processes you started.
- `npm run package:electron:portable` builds the portable target only; `package:electron:dir`
  skips exe compression for local debugging. `electron-builder.env` sets the compression
  level (a shell variable overrides it) and `win.electronLanguages` trims the locales
  directory — its entries must be exact codes such as `en-US`/`zh-CN`, because a prefix like
  `en` deletes every locale and breaks the UI.
- Delete `ELECTRON_RUN_AS_NODE` from the child environment before spawning a packaged exe.
  `npm run smoke:payload` and `npm run smoke:artifact` do it in `smokeChildEnvironment`
  (`scripts/smoke_harness.ts`), guarded by
  `test-node/electron/smoke-harness.test.ts`; a manual spawn that keeps it degrades to plain
  Node and dies with no output (exit 0 for the unpacked exe, exit 9 `bad option` through the
  portable stub), and app flags such as `--port` only reach the app when it runs as Electron.
- Isolate every run: the single-instance lock is namespaced by the userData directory, so a
  fresh `LLM_PROXY_DATA_DIR`, a free `--port`, an absolute log root and
  `LLM_PROXY_SMOKE_EXIT_FILE` let a packaged exe run beside the user's instance and exit
  cleanly. The portable stub unpacks into a Temp directory named for the app version, so a
  same-version instance that is already running shares it and the app never binds its admin
  port; `did not become healthy` there is not a packaging regression.
- History log roots resolve relative to the **application config file's directory**
  (`logRootBaseDirectory: path.dirname(options.applicationConfigFile)` in
  `src/app/runtime.ts`), not the child's cwd. A run whose `--application-config` is a
  throwaway copy shows an empty history even when the real log root is named.
- A smoke that only fetches `/`, `/static/app.css` and `/static/app.js` does not prove
  SQLite works in the payload: a fresh data dir with no configured proxy never opens the
  database. Ask `GET /api/logs?limit=5` and confirm `traffic.db` appears in that run's log
  root.
- `require("better-sqlite3")` never touches the native binding, so it prints success under
  either ABI. Prove the ABI by opening a database and running a query: `npm run abi:check`,
  or `npm run smoke:database` against the packaged production dependencies.
- Offline packing uses the runtime already unpacked in the worktree:
  `-c.electronDist=node_modules/electron/dist`, after confirming `npm ls electron` matches the
  `electron` devDependency — `electron-builder.yml` pins no `electronVersion`, so that installed
  version is what gets packaged.
- After `npm run rebuild:electron`, a plain-Node run of the DB-backed admin APIs returns 500
  `ERR_DLOPEN_FAILED`. That is the Electron ABI state, not an app bug; `npm run rebuild:node`
  restores the Node one.

## Standard commands

```bash
npm run package:electron:portable
npm run smoke:payload
npm run smoke:artifact
npm run smoke:delivery
npm run abi:check
npm run smoke:database

npx asar list release/win-unpacked/resources/app.asar
```

## Reading the result

- A clean smoke proves: `/api/health` healthy, one real proxy round trip at 200,
  `GET /api/logs?limit=5` at 200 with `total >= 1`, and `traffic.db` present in that run's log
  root; the temporary config and data directory are removed afterwards.
- A 500 on the logs API is a SQLite binding problem (ABI or packaging), not a route problem.
- When the wrapper smoke fails, run `npm run smoke:payload` first: the stub releases its
  unpack directory on exit, so a concurrent same-version run can hit "unpack directory
  conflict", which the harness reports as a conflict rather than a payload regression.
- The health deadline is 60 s (`DEFAULT_HEALTH_DEADLINE_MS` in `scripts/smoke_harness.ts`),
  so a timeout points at the launch environment or a shared unpack directory, not at a
  deadline that is too short.

## Deeper material

- [reference.md](./reference.md) — asar path semantics, payload entry counts, measured
  startup times, login-item registration and the shell traps around spawning.
- [current-architecture.md](../../../docs/current/architecture.md) §7 — the delivery entry
  table and the ABI rules.
- [real-upstream-acceptance.md](../real-upstream-acceptance/SKILL.md) — running a payload
  against real traffic.
