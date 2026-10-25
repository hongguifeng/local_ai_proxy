# Project Notes for Coding Agents

- Before changing behavior, read `docs/current-architecture.md`: it holds the current startup path, config ownership, module map, shutdown order and verification commands. History documents carry identity labels there; in `docs/module-design.md`, sections 2, 3 and 6 describe the pre-v0.3.0 Python baseline and are not current behavior.

- Project is active: do not preserve old internal APIs by default. For UI/admin API changes, use the simplest current contract unless compatibility is requested. Document every new feature.
- UI changes: run `npm run regen:ui-baselines` before committing; update README images (`doc/ui_*.png`) and hashes in `docs/refactoring/ui-visual-baseline.md`. Inspect regenerated images in full before cropping. UI text changes also require `npx prettier --check .` and checking English baselines (`doc/ui_proxy_en.png`, `doc/ui_logs_en.png`) for stray Chinese.
- The admin UI browser suite is split by area into `test-node/ui/admin-ui-*.test.ts` on top of `admin-ui-fixture.ts`, `admin-ui-server.ts` and `admin-ui-page.ts`; dependencies only point page → server → fixture. Stub knobs stay inside the fixture module because ESM imports are read-only views, so a test-side write must go through a `setX()` call while plain reads keep working. Each file registers its own lifecycle hooks and Vitest isolates module state per file.
- DOM lookups (`$`, `qs`, `qsOn`, `asElement`, `closestFrom`, `closestOn`, `parentOf`) are declared `UiElement | null`, but `tsconfig.ui.json` keeps `strictNullChecks` off, so the union collapses and a missing element is never a type error — `qs("#missing").value.trim()` checks clean. 325 lookup sites, 55 use `?.`. The measured cost of turning the flag on, and how to re-measure it, is in `static-checks-and-split`.
- `src/admin/static/app.css` is a cumulative stack of layout passes; later blocks in the file are not authoritative (e.g. the token card's 2x2 details grid is governed by a higher-specificity unmedia-queried `.stats-overview .stat-card-tokens .token-details` rule). When a layout change appears to have no effect, audit specificity via computed styles, not file order.
- Do not attempt a multi-layer `@layer` restructure of `app.css`: measured contests are decided by specificity, so crossing a layer boundary changes what the page draws; the census command and the reason are in `css-cascade-audit`.
- The Electron Chromium (v40) does not support the `:sticky` pseudo-class — neither in stylesheets nor in `querySelector` — so "style only while a sticky element is pinned" cannot be done in CSS; gate such effects in JS or make the style safe in both states.
- Run Vitest and UI baseline commands from an uppercase drive path (`cd /D/...`); lowercase `d:` can duplicate the runtime.
- Do not pipe a long-running command through `head`: closing the pipe early kills the run with SIGPIPE, so a summary that looks complete can hide that a later step never ran at all. Write the output to a file and grep that file.
- `prettier --write` on a file under `docs/` realigns every table in it, because the project's default configuration ignores that directory and those files were never formatted: a small prose addition then rewrites rows nobody touched and the review can no longer see what changed. Edit the prose to match the file's existing style instead of formatting it.
- A subagent watchdog reporting a long-open `bash` call is not proof of a hang: npm's child writes its log only when it exits, so a short log mid-run is normal, and a process filter on the worktree path never matches `npm run build` because npm omits the cwd. Judge by whether a matching process exists (filter by executable and arguments), whether produced artifacts keep advancing in mtime, and whether the child's turn and tool counters are still climbing. A wrong "stuck" verdict is expensive to undo: steering a writer to stop waiting can make it drop a verification it legitimately needed.
- Reconcile test counts with a precise declaration pattern, never `grep -c "it("`: `emit(`, `await(` and `submit(` all contain that substring, so a coarse scan over-counts (measured 52 against Vitest's 50). Use `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" <rev> -- test-node` together with a test-file count; that pair is what proves no case was silently deleted by a lane.
- `tsconfig.json` sets `exactOptionalPropertyTypes`, so handing a possibly-undefined value to a `readonly x?: T` parameter fails even when the key is present. Declare such parameters as `readonly x: T | undefined` — required key, explicit undefined — instead of optional.
- `consistent-type-definitions` and `consistent-indexed-object-style` contradict each other: an object `type` alias trips the first, an `[key: string]: unknown` index signature the second. A project-owned model that must still carry keys it does not declare (history and import fallbacks) is written as an `interface` of the declared fields crossed with `Record<string, unknown>` — an intersection is not an object literal, so neither rule fires and the value stays assignable to `RepositoryRecord`. Settle it with `npm run lint`, never with a disable comment.
- `no-implicit-globals` is not part of `eslint:recommended`, so a probe config that loads only recommended never enables it: "the rule stayed quiet" is not evidence about it. Enabled in script scope it reports top-level `var`/`function` even under a file-level `"use strict"`, which is why `eslint.config.js` turns the rule off for the generated `.ui-check/app.js` rather than carrying a file-level disable comment inside that artifact.
- To build "the complete value minus one member" in a test: `delete value[key]` trips `no-dynamic-delete` and `Object.fromEntries(...) as T` trips `no-unnecessary-type-assertion`, while destructuring with a rest sibling is clean and returns `Omit<T, K>` only when the key is a literal generic — a loop variable typed `keyof T` infers `K` as the whole union and strips every key. Write a loop's holes as explicit conditional spreads: a spread of a possibly-absent property makes that key optional in the result type, so the one member the interface still requires has to be written unconditionally for the hole to stay assignable.
- `npm run typecheck` covers `src`, `electron`, `test-node` and `scripts` through `tsconfig.json`, which is now `noEmit`, while `npm run build` compiles only `src`, `electron` and `scripts` through `tsconfig.build.json` — so a type error inside a test file fails `npm run check` but leaves the product compile green; verify unrelated errors against clean source, apply the smallest type-only fix, and disclose it.
- Bumping the traffic schema version breaks `test-node/persistence/database.test.ts`, which pins `readSchemaVersion` in two places (current schema + backup) and lists expected table names — update both numbers and add the new table to the list. TypeScript also rejects a bare `}` inside a regex literal (TS1508 "Unexpected '}'"); escape it as `\}`.
- Never read before the first write inside a `db.transaction(...)`: a deferred transaction that reads first takes a WAL read snapshot, and upgrading to a writer after another process advanced the log raises `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` never retries. The message is the generic `database is locked`, so check the error's `code` before blaming contention; hoist the read above the transaction call so its first statement is a write. This is what kills `serializes concurrent writes from separate processes` in `test-node/persistence/repository.test.ts` — it fails as three of four writer processes dying, not as a slow test.
- UI modifications require screenshot verification. Clean temporary files and processes when done.
- After every task, build the portable executable: `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never`.
- Native module ABI: packaging copies whichever `better_sqlite3.node` is installed at that moment, so never run `npm rebuild better-sqlite3` between `npm run rebuild:electron` and `electron-builder` — the portable app would ship a Node ABI binary and fail at startup. Once packaging has finished that rebuild is safe and is what Node tests need; an ABI mismatch then surfaces at test start as `was compiled against a different Node.js version` / `cannot open shared object`. Prove which ABI is installed by running a query: `require("better-sqlite3")` never touches the native binding, so it prints success in either state.
- Parallel writer lanes need their own git worktree **and** their own `node_modules` copy: managed worktree isolation symlinks the root checkout's `node_modules`, so one lane's `npm run rebuild:electron` flips the shared binary to the Electron ABI and the other lane's Node tests die at startup, and two writers in one checkout also fight over the same git working tree. Create the worktrees yourself and pass an explicit `cwd` per child instead of asking for managed isolation; a `robocopy /MT` copy of `node_modules` costs no GPU and leaves each lane free to switch its own ABI.
- The builtin `worker` agent pins `thinking: high`, which the local lmstudio endpoint rejects (`xhigh`, `medium` and `low` only): the child dies in about two seconds with HTTP 400 and never touches the tree. Request the level as a suffix on the child `model` (`provider/id:xhigh`), but that suffix is only honoured inside a workflow launch (`runs.all` / `runs.run`) — a direct one-child `subagent` call still sends `thinking: high` and dies exactly the same way, so a background child goes through a validated workflow script, not a direct call. `resume` replays the stored model and thinking contract, so it cannot repair a launch that died this way; relaunch instead.
- Execution history logs: `D:\Portable Program\llm_proxy\logs`.
- The user runs a portable instance of this app while you work. Treat it as read-only: never stop it to simulate a failure, never write into its config or traffic database, and only kill processes you started. See `real-upstream-acceptance`.
- The read/write tools resolve a leading `/tmp/...` against the current drive (`D:\tmp\...`), not the shell's `/tmp`: a log a bash redirection wrote to `/tmp` is invisible to them (`ENOENT … 'D:\tmp\smoke1.txt'`), and a scratch file they write there is invisible to `ls /tmp`. Keep scratch scripts and logs under a repo path whenever a tool and bash have to see the same file.
- Proving a refactor left an upstream request byte-identical needs no paid upstream: `git show <base>:<path>` the pre-change file into an untracked dot-directory at the repo root, rewrite its `../` import prefixes with one `sed`, then drive the old assembly and the new one against one seeded log root with a `fetch` stub that records URL, method, header order, body and signal presence. `tsconfig.json` includes `test-node/**` and `scripts/**` and the eslint globs cover those same paths, so a scratch file placed there is typechecked and linted alongside real code while a dot-directory outside the globs is neither. Normalize clock fields (`generated_at`, `durationMs`) before diffing, or the only reported difference is the timestamp.
- Release: `npm version <patch|minor|major> --message "chore(release): %s"`, then push branch and tag (`git push origin main vX.Y.Z`). Publishing occurs only from `v*` tags; tag pushes rerun CI.
- Seeding rows for a migration test has to happen before the migration that moves them: `schema-v3.ts` copies the inline body columns into `body_chunks` and NULLs them, so a record written after v3 has no chunks for `schema-v5.ts` to read and the token backfill quietly stores nothing. Write the rows, then run v3 and v4. To prove a conversion no longer reads live protocol code, `vi.mock` a predicate the live helper depends on — this repo had no `vi.mock` before, and replacing `isPythonTruthy` in `src/proxy/protocol/analysis.js` does move `responseTokenCounts` — then run the real migration: helper answer moves, stored values do not, dependency gone.
- Comparing a refactor against its base revision does not need a second checkout: `git checkout <base> -- <one file>`, measure, `git checkout HEAD -- <same file>`. Same build, same ABI, same machine, and the only variable is that file.
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
- `admin-api-probing` - admin routes, the required service set, 404 and 500 causes
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

Route registration itself is split by feature under `src/admin/routes/`; `createAdminServer`
only builds the server, the request hooks and `/api/health`, then calls the registrars behind
the same `options.X !== undefined` checks. Service interfaces live in `admin-contracts.ts` and
the JSON schemas in `admin-schemas.ts`. A guard that greps route source has to follow the file
the schema moved to, and a line-based scan misses generics written across several lines
(`server.post<{ Body: ... }>(` spans three), so count and split with the TypeScript AST.
