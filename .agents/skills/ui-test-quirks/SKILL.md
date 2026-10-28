---
name: ui-test-quirks
description: >-
  Pinned toolchain behavior for UI and Node integration tests: waitForResponse timing,
  strict-mode selectors, synchronous postDataJSON, toHaveValues, clock.install with runFor and
  refresh guards, the missing it.setTimeout, lint bans on non-null assertions and null-stripping
  casts, focusable overlay rows, keepAlive agents against connect ENOBUFS, and page errors that
  fail the test that provoked them. Use when writing or debugging UI or Node integration tests.
---

# Pinned Playwright and Vitest behaviors in this repo

## When this applies

- You write or change a browser test under `test-node/ui/`.
- A Playwright locator, click or wait hangs, or an assertion reports a strict-mode violation.
- A clock-driven or connection-heavy test passes locally and fails on CI.

## Invariants

- `page.waitForResponse` waits for a response received _after_ the call. Register all series
  waits in one `Promise.all` together with the click that triggers the requests; for
  re-open/re-render flows where the requests already fired, skip the response waits and let the
  retrying `expect` assertions wait on the rendered DOM.
- When you duplicate an SVG chart for a second metric, give the new chart its own container
  class and share only the inner element classes; otherwise a strict-mode selector such as
  `#pricingPanel .token-chart svg` resolves to two elements. The same trap applies to tags: the
  breakpoint test selects `header:not(.summary-dialog-head)`, so a new `<dialog>` head must be a
  `<div>`.
- A `<form>` inside a `<dialog>` runs native constraint validation before `submit`: an empty
  `required` field means the submit event never fires at all, so a test that waits for a
  handler-level guard message has to fill the required fields first. The summary-model dialog test
  fills `#summaryUrl` and `#summaryModel` before it clicks `#summarySave` for exactly this reason
  (2026-10-28: the empty-custom-value assertion polled an empty `#toast` fourteen times until the
  required inputs were filled).
- In the pinned playwright-core, `Request.postData()` / `postDataJSON()` (reached through a page
  `response.request()`) are synchronous — do not `await` them. `expect(locator).toHaveValues([...])`
  throws a strict-mode violation even for a stable locator, and on a single `<select>` it answers
  "Not a select element with a multiple attribute" instead of comparing option values, so assert per
  element with `nth(i)` + `toHaveValue()`, or read the option values once with
  `locator.evaluate((element) => [...element.querySelectorAll("option")].map((option) => option.value))`
  when it is the option list that is under test. The `APIResponse` from `page.request` has `request()` in its
  typings but not at runtime, so body assertions go through page `response` events.
- Timer-driven UI is testable with `page.clock.install()` before `goto` plus
  `page.clock.runFor(ms)`. Installing does not freeze the clock: it keeps following real time, so
  a real-time `expect.poll` or web-first assertion moves it too and a status poll can answer in
  the middle of a sequence. To hold it still, read the page's own `Date.now()` and
  `page.clock.pauseAt(that)`, advance only on purpose with `runFor`, and `page.clock.resume()` in
  a `finally` — `closeTestPage` drains the page with an in-page `setTimeout` that a held clock
  never runs, so a paused clock hangs the `afterEach` hook. Other app timers fast-forward too, and
  a refresh timer that guards against overlapping requests silently drops a tick while the
  previous fetch is in flight, so wait for that settle signal (the metrics dialog's
  `#metricsRefresh` is disabled while loading) before advancing the clock.
- When a status poll is what the test waits for, advance exactly one poll interval per expected
  poll and read the counter after each step: `runFor(2_000)` then
  `expect.poll(() => counter).toBeGreaterThan(seen)`. One `runFor(4_000)` for two expected polls
  hides which of them moved the counter. A wait that races a real server answer - a response that
  may or may not arrive inside a stated window - stays in real time and says so in a comment: the
  fake clock freezes page timers, not the stub server's reply.
- `expect.poll` gets one second by default. A poll whose value moves only when a fetch lands needs
  an explicit `{ timeout, interval }`, otherwise a loaded runner turns a poll that was fired on
  purpose into what looks like a poll that never happened. `uiPollOptions` in
  `admin-ui-lb-harness.ts` is that bound, and every poll in the load-balancing suite uses it.
- Vitest has no `it.setTimeout`: pass the timeout as the third argument of `it()` / `describe()`.
  `UI_TEST_TIMEOUT_MS` in `test-node/ui/admin-ui-fixture.ts` is that value.
- Lint forbids both `!` and null-stripping `as` casts: keep the type nullable and guard, then
  throw a named error. `noPropertyAccessFromIndexSignature` and `@typescript-eslint/dot-notation`
  only collide on a union with a concrete object shape, so give such a local one
  `Record<string, unknown>` type and keep brackets. `Array.isArray` on `unknown` narrows to
  `any[]`, so annotate the callback parameter as `unknown`.
- `locator.uncheckAll()` does not exist in this version — loop `nth(i).uncheck()`. A checkbox
  inside a floating overlay times out as not visible until its toggle button is clicked.
- Styled toggle switches must keep a non-zero hit box: `.switch input` is `position: absolute;
inset: 0; z-index: 1` with `opacity: 0`, so `check()`/`uncheck()` act on the input directly.
  A zero-size or `display: none` input makes those calls hang again.
- A Node integration test that opens dozens of sequential connections to one listener fails on
  Windows with `connect ENOBUFS` while everything else is green. Share one
  `http.Agent({ keepAlive: true })` across the fixture's requests and destroy it in `afterEach`.
- Every page the UI suite creates carries a `pageerror` listener, and `closeTestPage` raises
  whatever it collected before the page goes away, so a browser test cannot pass on a page that
  threw. A test that provokes an error on purpose reads `unhandledPageErrors()` first, calls
  `closeTestPage()` itself and catches the throw. Nothing else consumes a page error: do not add
  a filter, an ignore list, or a retry.
- The browser suite is split by area into `test-node/ui/admin-ui-*.test.ts` on top of
  `admin-ui-fixture.ts`, `admin-ui-server.ts` and `admin-ui-page.ts`, with dependencies only
  pointing page → server → fixture. Stub knobs live inside the fixture module because ESM
  imports are read-only views, so a test-side write goes through a `setX()` call while plain
  reads keep working. Each file registers its own lifecycle hooks.
- Vitest gives a worker a whole file, so `Duration` in `npx vitest run` tracks the longest file and
  not the sum of the suite: adding workers moves it by under a second. The load-balancing browser
  suite is split into `admin-ui-load-balancing-config|status|moves.test.ts` over
  `admin-ui-lb-harness.ts` for that reason - the harness exports helpers and hooks and no `it()`,
  so Vitest never collects it as a suite.
- A Node integration test that reads a counter filled by real timers must wait for that counter
  instead of trusting that a fixed `sleep` delivered a tick. `expect.poll(() => count, { timeout,
interval }).toBeGreaterThan(0)` keeps the same predicate; the guess about real time is what goes
  away.

## Standard commands

```bash
npm test -- test-node/ui
npm run typecheck
npm run lint
```

## Reading the result

- `connect ENOBUFS` is a socket-resource failure, not a product failure; rerun the single file
  to confirm, then fix the fixture's agent.
- A 30-second timeout is usually a locator that matches nothing, a checkbox that is not visible,
  or a wait registered after the response already arrived.
- A test that reports a page error it did not provoke is a real page bug. Read the collected
  message instead of adding an ignore rule.

## Deeper material

- [reference.md](./reference.md) — the version-specific evidence and the measured failure
  signatures.
- [../render-internals/SKILL.md](../render-internals/SKILL.md) — why some waits never settle.
- `test-node/ui/admin-ui-server.ts` and `test-node/ui/admin-ui-page.ts` — the helpers these rules
  apply to.
