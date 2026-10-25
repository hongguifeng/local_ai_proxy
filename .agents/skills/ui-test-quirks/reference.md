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

`page.clock.install()` must run before `goto`. In-page timers advance only when the clock is run
forward, while `expect.poll` and web-first assertions still use real time. An always-on rAF loop
never settles under the fake clock: the metrics auto-refresh test timed out on a
self-perpetuating chain. The guard-before-advance rule comes from the same family — a refresh
timer that returns early while `metricsState.loading` is true drops a tick, so the call count
came up short on slow CI runners until the test waited for the settle signal.

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
