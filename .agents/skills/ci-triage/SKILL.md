---
name: ci-triage
description: >-
  Diagnose a red or hanging GitHub Actions run with the gh CLI or, when it holds no
  credentials, with curl against the Actions REST API: gh is installed here but gh auth
  status reports no host, so every call needs GH_TOKEN taken from git credential fill and
  --commit needs the full 40-character sha; list runs for a sha, read job details, fetch
  job logs, reproduce a failing step by running format:check, lint, typecheck,
  check:modules, test and build separately, and poll until every run reaches a terminal
  status instead of sleeping a fixed count. Use when a workflow fails, hangs, or a pushed
  sha goes red.
---

# GitHub Actions triage with gh, or the REST API without it

## When this applies

- A pushed sha or a pull request shows a red or stuck workflow.
- You need one job's log, whether or not gh has a token it can read.
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
- `gh` is installed here (2.101.0 at `C:\Program Files\GitHub CLI`) but owns no stored
  credentials: `gh auth status` answers "You are not logged into any GitHub hosts", so a
  bare call dies on the `gh auth login` hint. The token `git credential fill` hands curl
  works for gh too — export it as `GH_TOKEN` per command instead of running an interactive
  login. Proved with `gh api`, `gh run list` and `gh run view --job <id> --log` on run 40513888611.
- `gh run list --commit` matches the full head sha only. A shortened sha returns an empty
  list, which reads as "CI never ran for this commit"; repeat with the 40-character sha
  before drawing that conclusion (observed with `6e43be1` against
  `6e43be14fea7d25dcb87fd69223df47fafe706d2`).
- The machine's Python locale is GBK: decode the response body as UTF-8 explicitly and
  call `sys.stdout.reconfigure(encoding="utf-8")` before printing fetched text, or the
  command dies on the first non-ASCII byte in the JSON.
- git-bash `/tmp` is `C:\Users\hong\AppData\Local\Temp`: hand Windows scripts that path,
  never the literal `/tmp/...`, or pipe `curl` straight into the script instead of
  writing an intermediate file.

## Standard commands

```bash
# gh is installed but holds no stored credentials; the token git credential fill gives curl
# works for gh too. --commit needs the full 40-character sha.
export GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | awk -F= '/^password=/{print $2}')"
gh run list --commit "$(git rev-parse HEAD)" --json workflowName,status,conclusion,databaseId
gh run view <run_id> --json jobs --jq '.jobs[] | "\(.name) | \(.conclusion) | failed: \([.steps[] | select(.conclusion=="failure") | .name] | join(", "))"'
gh run view --job <job_id> --log

# The same three reads without gh, for when no token is usable.
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
- An empty `gh run list --commit` answer means the sha was shortened, not that CI never ran;
  repeat with the full sha before saying anything about that commit.
- `gh run view --log` prints the log with control characters in caret notation, so the escape
  sequences arrive as the literal text `^[[31m` and a `\x1b` pattern matches nothing. Strip
  them as text: `tr -d '\r' | sed -E 's/^[^\t]*\t[^\t]*\t[0-9T:.Z-]+ //; s/\^\[\[[0-9;]*m//g'`
  removes the `node-group\tstep\ttimestamp` prefix and the colour codes; without that the
  failure block is unreadable and every failure shows once per platform.
- A failure only on `ubuntu-latest` is platform behavior, not this change, and the two seen
  here are now explained. SQLite reports "the path I was given is a directory" with the
  extended `SQLITE_CANTOPEN_ISDIR` on the Windows VFS and the primary `SQLITE_CANTOPEN` on the
  unix VFS, same message: opening a directory named `traffic.db` with better-sqlite3 12.11.1
  produced exactly those two answers on win32 and on Linux. The binding-history service records
  the driver's code verbatim, so the test must pin the code family and not a VFS suffix.
  The other one, an integration request answered 431 where the expectation was 200, did not
  reproduce in a full Linux node-suite run at CI's two workers and stayed an unreproduced
  single-run flake. Read the runner's own log and its uploaded capture before touching product
  code; reach for a second operating system only when those cannot answer, and say so.
- `npm run check:skills` is what fails when a skill, its reference files or the AGENTS.md
  routing index drift apart; run it first for a documentation-only change.
- The workflow file is the source of truth for what CI runs; read it rather than assuming
  a step exists.

## Deeper material

- [reference.md](./reference.md) — the polling loop, the job-log redirect and the
  terminal-status details.
- [ci.yml](../../../.github/workflows/ci.yml) — the jobs and steps CI actually runs.
- [current-architecture.md](../../../docs/current/architecture.md) §7 — the full
  verification entry table.
