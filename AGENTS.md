# Project Notes for Coding Agents

- Project is active: do not preserve old internal APIs by default. For UI/admin API changes, use the simplest current contract unless compatibility is requested. Document every new feature.
- UI changes: run `npm run regen:ui-baselines` before committing; update README images (`doc/ui_*.png`) and hashes in `docs/refactoring/ui-visual-baseline.md`. Inspect regenerated images in full before cropping. UI text changes also require `npx prettier --check .` and checking English baselines (`doc/ui_proxy_en.png`, `doc/ui_logs_en.png`) for stray Chinese.
- Run Vitest and UI baseline commands from an uppercase drive path (`cd /D/...`); lowercase `d:` can duplicate the runtime. After `npm run rebuild:electron`, run `npm rebuild better-sqlite3` before Node tests.
- `npm run build` type-checks `test-node/**` and `scripts/**`; verify unrelated errors against clean source, apply the smallest type-only fix, and disclose it.
- Admin service methods are optional and routes register only when present. For a 404, compare `src/app/runtime.ts` wiring with `LogAdminService`, `PairAdminService`, and `SummaryModelAdminService`; add new-route coverage to the assembled-app smoke test in `test-node/app/runtime.test.ts`.
- UI modifications require screenshot verification. Clean temporary files and processes when done.
- After every task, build the portable executable: `npm run build && npm run rebuild:electron && npx electron-builder -w portable --publish never`.
- Execution history logs: `D:\Portable Program\llm_proxy\logs`.
- Release: `npm version <patch|minor|major> --message "chore(release): %s"`, then push branch and tag (`git push origin main vX.Y.Z`). Publishing occurs only from `v*` tags; tag pushes rerun CI.
- CI without `gh`: query the public Actions REST API with `curl` (`/actions/runs`, details, `/jobs`). Job logs require a token; diagnose `npm run check` by running `format:check`, `lint`, `typecheck`, `test`, and `build` separately.
- After completing a task, write a brief retrospective into this file **only** when project-level experiences or debugging methods worthy of long-term reuse are identified; do not add entries when the task is completed smoothly. Before writing, remove outdated details such as specific tasks, pages, buttons, or run numbers, verify all facts related to the codebase, and merge and deduplicate against existing rules. After modifications, confirm that git diff AGENTS.md contains only the expected content and run npx prettier --check AGENTS.md.
