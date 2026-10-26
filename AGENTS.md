# Project Notes for Coding Agents

This file carries only the rules that must stay in front of you on every task. The long
how-to — recipes, measurements and incident histories — lives in the project skills listed at
the end and is read on demand.

## Before changing behavior

- Read `docs/current-architecture.md` first: startup path, config ownership, module map,
  shutdown order and verification commands. `docs/module-design.md` sections 2, 3 and 6 describe
  the pre-v0.3.0 Python baseline and are not current behavior; `docs/current-architecture.md` §8
  labels every other historical document.
- The project is active: do not preserve old internal APIs by default. For UI and admin API
  changes use the simplest current contract unless compatibility is requested, and document
  every new feature.
- Release: `npm version <patch|minor|major> --message "chore(release): %s"`, then push the branch
  and the tag (`git push origin main vX.Y.Z`). Publishing runs only from `v*` tags.

## Verification entry points

- `npm run check` is the full gate: `format:check` → `lint` → `typecheck` → `check:modules` →
  `test` → `build`. Run a failing step on its own instead of the whole chain.
- `npm run check:skills` validates the skills themselves — frontmatter, roster, the AGENTS.md
  routing index, required sections, local links, and every file and command a skill names.
- `npm run typecheck` checks `src`, `electron`, `test-node` and `scripts` through `tsconfig.json`
  (now `noEmit`), while `npm run build` compiles only `src`, `electron` and `scripts` through
  `tsconfig.build.json`. A type error inside a test file therefore fails `npm run check` but
  leaves the product compile green: verify unrelated errors against clean source, apply the
  smallest type-only fix, and disclose it.
- Every task ends with the portable executable: `npm run package:electron:portable`
  (= `build` → `rebuild:electron` → `electron-builder -w portable`), then
  `npm run smoke:delivery`, and `npm run abi:node` to restore the Node ABI afterwards.
- UI changes require screenshot verification, and a regenerated baseline plus its hash row in
  `docs/refactoring/ui-visual-baseline.md` is part of the change, never a later cleanup.
  `ui-baseline-regen` owns the regeneration, the full-size image inspection, the README images
  and the stray-Chinese check on the English captures.
- Run Vitest and UI baseline commands from an uppercase drive path (`cd /D/...`); a lowercase
  `d:` can duplicate the runtime.
- Reconcile test counts with a precise declaration pattern, never `grep -c "it("`: `emit(`,
  `await(` and `submit(` all contain that substring, so a coarse scan over-counts (measured 52
  against Vitest's 50). Use
  `git grep -cE "^[[:space:]]*(it|test)(\.[a-z]+)?\(" <rev> -- test-node` together with a
  test-file count; that pair is what proves no case was silently deleted by a lane.

## Safety boundaries

- The user runs a portable instance of this app while you work. Treat it as read-only: never
  stop it to simulate a failure, never write into its config or traffic database, and only kill
  processes you started. See `real-upstream-acceptance` for the isolation recipe.
- Native module ABI: packaging copies whichever `better_sqlite3.node` is installed at that
  moment, so never run `npm rebuild better-sqlite3` between `npm run rebuild:electron` and
  `electron-builder` — the portable app would ship a Node ABI binary and fail at startup. Once
  packaging has finished that rebuild is safe and is what Node tests need. Prove which ABI is
  installed with a real query (`npm run abi:check`): `require("better-sqlite3")` never touches
  the native binding, so it prints success in either state.
- Parallel writer lanes need their own git worktree **and** their own `node_modules` copy:
  managed worktree isolation symlinks the root checkout's `node_modules`, so one lane's
  `npm run rebuild:electron` flips the shared binary to the Electron ABI and the other lane's
  Node tests die at startup, and two writers in one checkout also fight over the same working
  tree. Create the worktrees yourself and pass an explicit `cwd` per child instead of asking for
  managed isolation; a `robocopy /MT` copy of `node_modules` costs no GPU and leaves each lane
  free to switch its own ABI.
- The builtin `worker` agent pins `thinking: high`, which the local lmstudio endpoint rejects
  (`xhigh`, `medium` and `low` only), so the child dies in about two seconds with HTTP 400. The
  level is requested as a suffix on the child `model` (`provider/id:xhigh`), and that suffix is
  honoured only inside a workflow launch — a direct one-child `subagent` call still sends
  `thinking: high`. `resume` replays the stored contract and cannot repair such a death;
  relaunch instead.

## Judging a long-running command

- Do not pipe a long-running command through `head`: closing the pipe early kills the run with
  SIGPIPE, so a summary that looks complete can hide that a later step never ran at all. Write
  the output to a file and grep that file.
- A long-open `bash` call is not proof of a hang. npm's child writes its log only when it exits,
  so a short log mid-run is normal, and a process filter on the worktree path never matches
  `npm run build` because npm omits the cwd. Judge by whether a matching process exists (filter
  by executable and arguments), whether produced artifacts keep advancing in mtime, and whether
  the child's turn and tool counters are still climbing. A wrong "stuck" verdict is expensive to
  undo: steering a writer to stop waiting can make it drop a verification it legitimately
  needed.
- A harness that prints its final line and then never exits keeps the launcher's `bash` call open
  forever: a listening fixture server holds the Node event loop. The tell is the log stopping
  while the fixture port is still `LISTENING` and the application ports are free — the script
  finished, the process did not. Ending the process that holds the fixture port lets the call
  return, and the log it already wrote is the evidence. Harnesses must `unref()` server and
  socket handles or call `process.exit` once the checks are done.

## Type and lint contracts

- `tsconfig.json` sets `exactOptionalPropertyTypes`, so handing a possibly-undefined value to a
  `readonly x?: T` parameter fails even when the key is present. Declare such parameters as
  `readonly x: T | undefined` — required key, explicit undefined.
- `consistent-type-definitions` and `consistent-indexed-object-style` contradict each other: an
  object `type` alias trips the first, an `[key: string]: unknown` index signature the second. A
  project-owned model that must still carry keys it does not declare (history and import
  fallbacks) is written as an `interface` of the declared fields crossed with
  `Record<string, unknown>` — an intersection is not an object literal, so neither rule fires and
  the value stays assignable to `RepositoryRecord`. Settle it with `npm run lint`, never with a
  disable comment.
- To build "the complete value minus one member" in a test: `delete value[key]` trips
  `no-dynamic-delete` and `Object.fromEntries(...) as T` trips `no-unnecessary-type-assertion`,
  while destructuring with a rest sibling is clean and returns `Omit<T, K>` only when the key is
  a literal generic — a loop variable typed `keyof T` infers `K` as the whole union and strips
  every key. Write a loop's holes as explicit conditional spreads, and write the one member the
  interface still requires unconditionally.

## Data and persistence

- Never read before the first write inside a `db.transaction(...)`: a deferred transaction that
  reads first takes a WAL read snapshot, and upgrading to a writer after another process advanced
  the log raises `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` never retries. The message is the
  generic `database is locked`, so check the error's `code` before blaming contention; hoist the
  read above the transaction call so its first statement is a write. This is what kills
  `serializes concurrent writes from separate processes` in
  `test-node/persistence/repository.test.ts` — it fails as three of four writer processes dying,
  not as a slow test.
- Seeding rows for a migration test has to happen before the migration that moves them:
  `schema-v3.ts` copies the inline body columns into `body_chunks` and NULLs them, so a record
  written after v3 has no chunks for `schema-v5.ts` to read and the token backfill quietly stores
  nothing. To prove a conversion no longer reads live protocol code, `vi.mock` a predicate the
  live helper depends on — replacing `isPythonTruthy` in `src/proxy/protocol/analysis.ts` does
  move `responseTokenCounts` — then run the real migration: the helper answer moves, the stored
  values do not.
- Bumping the traffic schema version breaks `test-node/persistence/database.test.ts`, which pins
  `readSchemaVersion` in two places (current schema + backup) and lists expected table names —
  update both numbers and add the new table to the list. TypeScript also rejects a bare `}` inside
  a regex literal (TS1508); escape it as `\}`.

## Tools and environment

- The read and write tools resolve a leading `/tmp/...` against the current drive
  (`D:\tmp\...`), not the shell's `/tmp`, so a log a bash redirection wrote to `/tmp` is
  invisible to them. Keep scratch scripts and logs under a repo path whenever a tool and bash
  have to see the same file.
- `docs/` is listed in `.prettierignore`, so a plain `prettier --write docs/<file>` silently
  formats nothing, while the `--ignore-path .gitignore` form that `design-doc-readability` uses
  does format it — and then every table in that file is realigned, because these files were
  never formatted: a small prose addition rewrites rows nobody touched and the review can no
  longer see what changed. Edit the prose to match the file's existing style instead of
  formatting it.
- Incremental TypeScript builds leave generated files for deleted source files; when removing a
  generated asset or compiler input, add an explicit cleanup step in the build path and inspect
  the packaged `app.asar` for stale outputs.
- The packaged Chromium (Electron 40 ships Chromium 144) has no `:sticky` pseudo-class:
  `CSS.supports("selector(:sticky)")` is false and `querySelector(":sticky")` throws a
  `SyntaxError`, so "style only while a sticky element is pinned" is done in JS or made safe in
  both states.
- Comparing a refactor against its base revision does not need a second checkout:
  `git checkout <base> -- <one file>`, measure, `git checkout HEAD -- <same file>`. Same build,
  same ABI, same machine, and the only variable is that file.
- Execution history logs: `D:\Portable Program\llm_proxy\logs`.

## Project facts worth knowing before a review

- Admin routes are registered per feature under `src/admin/routes/` and pinned by
  `test-node/admin/api-contract.test.ts`, which boots the real application; the split, the
  response schemas and the rule for recounting the table live in `admin-api-probing`. Five of
  the registrations carry no response schema, so a rename on one of them is invisible to both
  typechecks and shows up only as `undefined` in the UI.
- `passWithNoTests` is off, so a Vitest filter that matches nothing exits 1 instead of looking
  like a pass.

## Where the long verification recipes live

The detailed how-to lives in project skills under `.agents/skills/`, which Pi advertises by name
and description and reads only when the task calls for them. Open the matching SKILL.md before
working; each one states when it applies, what must hold, the standard commands, how to read the
result, and links to its reference file and deeper docs.

- `ui-baseline-regen` - committed visual baselines, README images, hashes, drift
- `css-cascade-audit` - app.css cumulative passes and cascade-neutrality proof
- `live-ui-probing` - verify on the user's running instance without rebuilding
- `render-internals` - incremental rebuild, lazy JSON tree, scroll and freeze behavior
- `ui-markup-contracts` - header grids, reorder handles, pickers, switches
- `statistics-charts` - statistics page rendering and trend axis scaling
- `ui-test-quirks` - pinned Playwright and Vitest behavior
- `static-checks-and-split` - the bundled module graph, tsconfig.ui.json, lint scope
- `admin-api-probing` - admin routes, the required service set, 404 and 500 causes
- `proxy-runtime` - reloadPair, decoded-body logging and encoding regressions
- `traffic-log-forensics` - reading traffic.db without native modules
- `packaging-smoke` - app.asar inspection, smoke launches, single-instance lock
- `ci-triage` - Actions REST API triage without gh
- `real-upstream-acceptance` - proving changes against real traffic
- `design-doc-readability` - measured readability for design documents
- `safe-deletion` - proving a removal is complete

After completing a task, write a brief retrospective into this file **only** when project-level
experiences or debugging methods worthy of long-term reuse are identified; do not add entries
when the task is completed smoothly. Before writing, remove outdated details such as specific
tasks, pages, buttons, or run numbers, verify all facts related to the codebase, and merge and
deduplicate against existing rules. After modifications, confirm that `git diff AGENTS.md`
contains only the expected content and run `npx prettier --check AGENTS.md` plus
`npm run check:skills`.
