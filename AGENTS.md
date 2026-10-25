# Project Notes for Coding Agents

- Project is active: do not preserve old internal APIs by default. For UI/admin API changes, use the simplest current contract unless compatibility is requested. Document every new feature.
- UI changes: run `npm run regen:ui-baselines` before committing; update README images (`doc/ui_*.png`) and hashes in `docs/refactoring/ui-visual-baseline.md`. Inspect regenerated images in full before cropping. UI text changes also require `npx prettier --check .` and checking English baselines (`doc/ui_proxy_en.png`, `doc/ui_logs_en.png`) for stray Chinese.
- The admin UI browser suite is split by area into `test-node/ui/admin-ui-*.test.ts` on top of `admin-ui-fixture.ts`, `admin-ui-server.ts` and `admin-ui-page.ts`; dependencies only point page → server → fixture. Stub knobs stay inside the fixture module because ESM imports are read-only views, so a test-side write must go through a `setX()` call while plain reads keep working. Each file registers its own lifecycle hooks and Vitest isolates module state per file.
- `src/admin/static/app.css` is a cumulative stack of layout passes; later blocks in the file are not authoritative (e.g. the token card's 2x2 details grid is governed by a higher-specificity unmedia-queried `.stats-overview .stat-card-tokens .token-details` rule). When a layout change appears to have no effect, audit specificity via computed styles, not file order.
- Do not attempt a multi-layer `@layer` restructure of `app.css`: measured contests are decided by specificity, so crossing a layer boundary changes what the page draws; the census command and the reason are in `css-cascade-audit`.
- The Electron Chromium (v40) does not support the `:sticky` pseudo-class — neither in stylesheets nor in `querySelector` — so "style only while a sticky element is pinned" cannot be done in CSS; gate such effects in JS or make the style safe in both states.
- Run Vitest and UI baseline commands from an uppercase drive path (`cd /D/...`); lowercase `d:` can duplicate the runtime. After `npm run rebuild:electron`, run `npm rebuild better-sqlite3` before Node tests; an ABI mismatch surfaces at test start as `was compiled against a different Node.js version` / `cannot open shared object`.
- Do not pipe a long-running command through `head`: closing the pipe early kills the run with SIGPIPE, so a summary that looks complete can hide that a later step never ran at all. Write the output to a file and grep that file.
- `npm run build` type-checks `test-node/**` and `scripts/**`; verify unrelated errors against clean source, apply the smallest type-only fix, and disclose it.
- Bumping the traffic schema version breaks `test-node/persistence/database.test.ts`, which pins `readSchemaVersion` in two places (current schema + backup) and lists expected table names — update both numbers and add the new table to the list. TypeScript also rejects a bare `}` inside a regex literal (TS1508 "Unexpected '}'"); escape it as `\}`.
- UI modifications require screenshot verification. Clean temporary files and processes when done.
- After every task, build the portable executable: `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never`.
- Native module ABI: run `npm rebuild better-sqlite3` only before the final `npm run rebuild:electron`; never run the Node rebuild after Electron rebuild or before packaging, or the portable app will contain a Node ABI binary and fail at startup. Prove which ABI is installed by running a query: `require("better-sqlite3")` never touches the native binding, so it prints success in either state.
- Execution history logs: `D:\Portable Program\llm_proxy\logs`.
- The user runs a portable instance of this app while you work. Treat it as read-only: never stop it to simulate a failure, never write into its config or traffic database, and only kill processes you started. See `real-upstream-acceptance`.
- Release: `npm version <patch|minor|major> --message "chore(release): %s"`, then push branch and tag (`git push origin main vX.Y.Z`). Publishing occurs only from `v*` tags; tag pushes rerun CI.
- After completing a task, write a brief retrospective into this file **only** when project-level experiences or debugging methods worthy of long-term reuse are identified; do not add entries when the task is completed smoothly. Before writing, remove outdated details such as specific tasks, pages, buttons, or run numbers, verify all facts related to the codebase, and merge and deduplicate against existing rules. After modifications, confirm that git diff AGENTS.md contains only the expected content and run npx prettier --check AGENTS.md.

## Where the long verification recipes live

The detailed how-to of this project now lives in project skills under
`.agents/skills/`, which Pi advertises by name and description and reads only when
the task calls for them. When one of these areas is your task, open its SKILL.md
before working; the rules below are the ones that must stay in front of you all the
time.

- `ui-baseline-regen` - committed visual baselines, README images, hashes, drift
- `css-cascade-audit` - app.css cumulative passes and cascade-neutrality proof
- `live-ui-probing` - verify on the user's running instance without rebuilding
- `render-internals` - incremental rebuild, lazy JSON tree, scroll and freeze behavior
- `ui-markup-contracts` - header grids, reorder handles, pickers, switches
- `statistics-charts` - statistics page rendering and trend axis scaling
- `ui-test-quirks` - pinned Playwright and Vitest behavior
- `static-checks-and-split` - numbered classic scripts, tsconfig.ui.json, lint scope
- `admin-api-probing` - admin routes, optional services, 404 and 500 causes
- `proxy-runtime` - reloadPair, decoded-body logging and encoding regressions
- `traffic-log-forensics` - reading traffic.db without native modules
- `packaging-smoke` - app.asar inspection, smoke launches, single-instance lock
- `ci-triage` - Actions REST API triage without gh
- `real-upstream-acceptance` - proving changes against real traffic
- `design-doc-readability` - measured readability for design documents
- `safe-deletion` - proving a removal is complete

`test-node/docs/skills.test.ts` keeps that laziness honest: it pins the roster,
checks the frontmatter limits Pi enforces, and fails when a recipe names a file or
an `npm run` script that no longer exists. `passWithNoTests` is off, so a Vitest
filter that matches nothing exits 1 instead of looking like a pass.

`test-node/admin/api-contract.test.ts` pins the admin route table and the top-level
response keys by booting the real application. Only 17 of the 33 registrations carry a
response schema, so a rename on one of the other 16 is invisible to both typechecks and
would only show up as `undefined` in the UI; this test is where it fails instead.
