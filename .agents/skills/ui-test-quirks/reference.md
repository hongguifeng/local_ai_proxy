# Toolchain quirks: evidence and failure signatures

Background for [SKILL.md](./SKILL.md).

## Versions this was measured on

playwright-core 1.62.0 (installed by the lockfile; `package.json` carries a caret range) and
Vitest 4.x. The `postData()`/`postDataJSON()` synchronicity, the `toHaveValues` strict-mode
failure, the missing `APIResponse.request()` at runtime and the absent `locator.uncheckAll()`
are all properties of that pair. Re-check them after a Playwright bump instead of assuming
either behavior.

## waitForResponse timing

Observed when a handler fires a burst of fetches and an earlier-registered sibling wait or prior
assertions consume the window: the response was already delivered, the later wait never saw it,
and the test hung until the 30 s timeout. Registering all series waits in one `Promise.all`
with the triggering click fixed it; on re-open flows the requests have already fired, so the
retrying DOM assertions are the correct wait.

## The page-error drain

`closeTestPage` raises whatever the page collected before the page goes away, and before raising
it drains the page task queue with one `page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))`.
Without that drain a throw scheduled by `setTimeout(..., 0)` was reported after the hook had
already asserted, and the same test passed — measured: 1 passed without the drain, 1 failed with
it. CDP is one ordered connection, so a round trip the browser answers only after its queued
work cannot return before an earlier exception.

## Clock-driven tests

`page.clock.install()` must run before `goto`. It does **not** freeze the page: the controller is
resumed as part of installing it, so the fake clock keeps following real time — the implementation
advances it by the elapsed performance ticks and runs whatever became due (`_syncRealTime` and
`_updateRealTimeTimer` in `coreBundle.js`). `runFor` is the same thing on purpose: it pauses the
real-time sync, runs the requested ticks, and resumes it in a `finally`. So a `expect.poll` or a
web-first assertion, which are driven by real time, also moves the page clock and can let the
status poll answer in the middle of a sequence.

To keep the poll still, hold the clock instead of hoping it stays put: read `Date.now()` from the
page, `page.clock.pauseAt(that)`, drive time with `page.clock.runFor(ms)` only where the test means
to, and `page.clock.resume()` in a `finally`. The `finally` is not politeness: `closeTestPage`
drains the page with a `setTimeout(resolve, 0)` inside it, and a held clock never runs that timer,
so a test that leaves the clock paused hangs the `afterEach` hook until it times out. The cap case
in `test-node/ui/admin-ui-load-balancing-status.test.ts` is the measured instance of both halves — the
poll interleaved until the clock was held, and the hook timed out until the resume was added.

An always-on rAF loop never settles under the fake clock: the metrics auto-refresh test timed out
on a self-perpetuating chain. The guard-before-advance rule comes from the same family — a refresh
timer that returns early while `metricsState.loading` is true drops a tick, so the call count
came up short on slow CI runners until the test waited for the settle signal.

## One file is the wall-clock floor

Vitest gives a worker a whole file, so `Duration` in `npx vitest run` follows the longest file
rather than the sum of the suite. Four configurations on this machine landed within 1.5 s of
`admin-ui-load-balancing.test.ts`'s own duration: default 112.48 s against 110.82 s, `--maxWorkers=8`
107.68 against 106.57, `--maxWorkers=4` 106.39 against 105.50, `--isolate=false` 109.75 against
108.29. Raising the worker count moved the wall by less than a second, and `--isolate=false` broke
`test-node/persistence/migration-live-drift.test.ts` (`expected { request: 5, response: 2 } to deeply
equal { request: undefined, …(1) }`), so neither is a lever.

Two levers are, measured on this machine with an uppercase drive path on 2026-10-28:

1. **Split the file.** 60 cases went to `admin-ui-load-balancing-config|status|moves.test.ts` over
   `admin-ui-lb-harness.ts` - 25 / 15 / 20, same titles, same assertions - and the full run went
   113.02 s → 51.95 s. Grouping came from measured duration, not test count: the config-themed cases
   carry about 2 s of the roughly 55 s of real waiting, so a theme-only split would have produced
   8 s / 18.8 s / 76.8 s instead of the 24.4 / 39.8 / 41.5 s the three files actually ran.
2. **Advance the clock instead of letting wall time reach the tick.** The admin UI asks the load
   balancer for status every `loadBalancerStatusIntervalMs = 2000` ms
   (`src/admin/static/modules/load-balancing.js`), and a real `waitForLbPoll` spent that much per
   expected poll. 25 of them became `page.clock.runFor(2_000)` followed by
   `expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen)`; the full run went 51.95 s →
   43.62 s and the three files' own cost went 105.7 s → 69.1 s with all 60 passing.

What neither lever touches is a wait that races a real stub-server answer: the fake clock freezes
page timers, not the server's response. Advancing the clock makes the page's own request go out,
and whether the reply arrives is still the server's - so a `waitForTimeout(300)` that checks whether
a request was re-issued inside that window is a different test once the clock is moved. Those waits
stayed real time and are annotated where they sit.

GitHub Actions gains less than this machine did: the same test step went 4m30s → 3m57s on
`windows-latest` and 3m22s → 3m7s on `ubuntu-latest`, because a two-core runner keeps real waiting
real and carries per-step overhead. The single-file floor still came off, which is why the run's
wall went 9m17s → 8m31s.

## Counters filled by real timers

`expect(counter).toBeGreaterThan(0)` read straight after a fixed `sleep` fails whenever the runner
is busy and the tick that fills that counter has not fired yet.
`test-node/proxy/load-monitor.test.ts` - a Node test with no browser in it - failed that way once in
four full concurrent runs after the browser suite stopped holding one worker for the whole run
(`expected 0 to be greater than 0`, the sample count, not the advice). It passed 3 of 3 runs when
started on its own, and had shown no failure in 3 full runs on the previous scheduling. That is
evidence of scheduling sensitivity, not of the UI change breaking the product: nothing in that file
touches the browser suite.

The fix is to wait for the quantity the assertion is about instead of assuming real time already
delivered it:

```ts
await expect.poll(() => trio.busy.requests(), { timeout: 5_000, interval: 25 }).toBeGreaterThan(0);
```

The predicate does not move. A monitor that never samples still fails this, at the 5 s bound, which
is 200 ticks of the file's own 25 ms interval. After the change: 5 of 5 runs alone and 4 of 4 full
concurrent runs green.

## Socket exhaustion

`listen ENOBUFS: no buffer space available 127.0.0.1` appeared in a full concurrent run: not an
assertion failure and not a product defect, but the system running out of sockets. Rerunning the
single file passed 32 cases. The fixture-level fix is one keep-alive agent; a retry or a longer
timeout would hide it.

## Switch hit boxes

`.switch input` used to be `opacity: 0; width: 0; height: 0`, so a probe clicking
`[data-lb-toggle]` waited forever and had to hit `label.switch` instead. The input now covers
its whole 42 × 24 box (`position: absolute; inset: 0; z-index: 1`, still `opacity: 0`), so
`check()`/`uncheck()` act on the input directly while label clicks keep working.

## Lint collisions in tests

`noPropertyAccessFromIndexSignature: true` demands bracket access for index-signature
properties while `@typescript-eslint/dot-notation` demands dots. They only collide when the
local's type is a union with a concrete object shape, so one `Record<string, unknown>` type keeps
brackets legal. `Array.isArray` on an `unknown` narrows to `any[]`, which leaks an `any` element
into an object literal and trips `no-unsafe-assignment`; annotating the callback parameter as
`unknown` is the fix.
