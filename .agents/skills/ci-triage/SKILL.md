---
name: ci-triage
description: >-
  Diagnose CI with curl against the Actions REST API: list runs for a sha, fetch job details and logs with a token from git credential fill, split npm run check into format/lint/typecheck/test/build, UI tests use Playwright Chromium never OS Chrome, poll until every run reports a terminal status and exit immediately, decode and print UTF-8 explicitly because Python here defaults to GBK. Use when a workflow fails, hangs or a pushed sha goes red.
---

# GitHub Actions triage without the gh CLI

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- CI without `gh`: query the public Actions REST API with `curl` (`/actions/runs`, details, `/jobs`). Job logs require a token (one is retrievable via `git credential fill`); diagnose `npm run check` by running `format:check`, `lint`, `typecheck`, `test`, and `build` separately. UI tests launch the Playwright-bundled Chromium (CI downloads it with `npx playwright install chromium`); never fall back to the OS Chrome, whose auto-updates on GH runners can hang `chromium.launch` (override with `CHROME_PATH` if needed). Poll that endpoint until every run for the pushed sha reports a terminal `status`, then exit the loop immediately - never sleep a fixed number of iterations, which keeps the session blocked for minutes after the workflows are already green. Decode the response body as UTF-8 explicitly (`sys.stdin.buffer.read().decode("utf-8")`): Python on this machine defaults to the GBK locale and a plain `text=True` capture dies on non-ASCII bytes in the JSON. The same default breaks _printing_: call `sys.stdout.reconfigure(encoding="utf-8")` before echoing fetched or decoded text, and remember that git-bash `/tmp` is `C:\Users\hong\AppData\Local\Temp`: hand Windows scripts that Windows path, never the literal `/tmp/...`, which is the form that fails (or pipe `curl` straight into the script instead of writing an intermediate file).
