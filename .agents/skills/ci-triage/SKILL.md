---
name: ci-triage
description: >-
  Diagnose a red or hanging GitHub Actions run with curl against the Actions REST API
  because the gh CLI is not installed: list runs for a sha, read job details, fetch job
  logs with a token from git credential fill, reproduce a failing step by running
  format:check, lint, typecheck, check:modules, test and build separately, and poll until
  every run reaches a terminal status instead of sleeping a fixed count. Use when a
  workflow fails, hangs, or a pushed sha goes red.
---

# GitHub Actions triage without the gh CLI

## When this applies

- A pushed sha or a pull request shows a red or stuck workflow.
- You need one job's log and only have the public REST API.
- `npm run check` fails in CI but not locally, or the reverse.

## Invariants

- `npm run check` is the full gate, and its step order is pinned in AGENTS.md's verification
  entry points; the steps below are the ones to run one at a time. A whole-chain rerun hides
  which step failed and costs minutes each time.
- The UI tests launch the Playwright-bundled Chromium, which CI installs with
  `npx playwright install chromium`. Never fall back to an OS Chrome on a runner: its
  auto-update can hang `chromium.launch`.
- Poll runs until every run for the pushed sha reports a terminal `status`, then exit the
  loop. Never sleep a fixed number of iterations — that keeps the session blocked after
  the workflows are already green.
- The machine's Python locale is GBK: decode the response body as UTF-8 explicitly and
  call `sys.stdout.reconfigure(encoding="utf-8")` before printing fetched text, or the
  command dies on the first non-ASCII byte in the JSON.
- git-bash `/tmp` is `C:\Users\hong\AppData\Local\Temp`: hand Windows scripts that path,
  never the literal `/tmp/...`, or pipe `curl` straight into the script instead of
  writing an intermediate file.

## Standard commands

```bash
# Runs for the pushed sha, and the jobs of one run.
curl -s "https://api.github.com/repos/hongguifeng/local_ai_proxy/actions/runs?head_sha=$(git rev-parse HEAD)"
curl -s "https://api.github.com/repos/hongguifeng/local_ai_proxy/actions/runs/<run_id>/jobs"

# A job log needs a token; git credential fill answers it for this remote.
printf 'protocol=https\nhost=github.com\n\n' | git credential fill
curl -sL -H "Authorization: Bearer <token>" \
  "https://api.github.com/repos/hongguifeng/local_ai_proxy/actions/jobs/<job_id>/logs"

# Reproduce the chain one step at a time.
npm run format:check
npm run lint
npm run typecheck
npm run check:modules
npm run test
npm run build
```

## Reading the result

- Compare the per-step exit codes with the log: a `format:check` failure names files, a
  `lint` failure names rules, `typecheck` names files and line numbers, `check:modules`
  prints the offending dependency chain, and `test` failure names the file and case.
- `npm run check:skills` is what fails when a skill, its reference files or the AGENTS.md
  routing index drift apart; run it first for a documentation-only change.
- The workflow file is the source of truth for what CI runs; read it rather than assuming
  a step exists.

## Deeper material

- [reference.md](./reference.md) — the polling loop, the job-log redirect and the
  terminal-status details.
- [ci.yml](../../../.github/workflows/ci.yml) — the jobs and steps CI actually runs.
- [current-architecture.md](../../../docs/current-architecture.md) §7 — the full
  verification entry table.
