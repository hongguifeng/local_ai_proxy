# Render internals: measurements and probe recipes

Background for [SKILL.md](./SKILL.md). Every number was measured on this machine against
this code; treat them as evidence for the shape of the rules, not as current thresholds.

## What "slow to show the JSON" actually was

For a 930 KB body the click chain measured: `renderLogs` ~9 ms, fetch ~50 ms (the server
assembles the body in ~23 ms, the browser reads ~1 MB in ~28 ms), `res.json` ~6 ms,
line-width probes ~13 ms, `renderJsonPane` ~23 ms. The detail round trip dominated, so the fix
was to take the fetch out of the critical path:

- `pointerover` on a row arms a 50 ms dwell, so a fast sweep across a long list does not turn
  every row into a megabyte request.
- `pointerdown`/`focusin` prefetch immediately, because the button is held for tens of
  milliseconds before the click event that follows the release.
- `logDetailPrefetch` is bounded by entry count and `content-length` bytes (a 5 MB body arrives
  as a ~10 MB JSON response), skips pending rows whose body is still growing, and awaits an
  in-flight entry instead of duplicating it.

Measured on the real instance with a 5.8 MB body: hover-then-click ~25 ms versus ~400 ms
before; a cold click with no hover is still bound by the transfer. HTTP compression is a trap
here: a base64 image body only reached 58.7 % with gzip and cost ~200 ms of CPU to save ~100 ms
of loopback transfer.

## Assigning markup, not building it

Building the tree string for a several-hundred-kilobyte body measured ~80 ms; assigning it is
what costs seconds, because the tree is tens of thousands of `<details>` nodes. A selected
record that was still pending used to be re-parsed on every auto-refresh tick, which froze the
page — that is where `state.jsonPaneHtml` and the lazy tree came from.

## Lazy fills and layout

- The residual lag on the _second_ expand click is layout, not JS: every fill re-lays-out the
  whole visible tree (16k+ nodes produced 100-300 ms frame gaps per drain batch), which is why
  `.json-row` carries `content-visibility: auto`.
- Rows the browser never realized need an accurate `contain-intrinsic-size`. Without the hint
  refresh after a fill, a hint of `auto 18px` gave a `scrollHeight` that never reached the real
  bottom — an underestimate of about 6×.
- Chromium still realizes a row that scrolled into view one frame _after_ it paints, which is
  the blank flash the pre-realization watcher exists for.
- Batch style writes after rect reads: interleaved write/read thrashing cost ~900 ms per scroll
  event, windowed and batched cost 5-20 ms.
- `scroll` events are dispatched after the frame's animation frame callbacks, so an
  `evaluate` that assigns `scrollTop` and waits a couple of rAFs measures before the watcher
  ran. Split the scroll and the measurement into two evaluates with real time between them —
  the fast-scroll UI test does exactly this.
- A probe that scans every visible row's `offsetHeight` manufactures the frame gaps it claims
  to measure.

## Pending-row sweep

One detail read inflates every stored chunk of a record: 22 pending records cost ~100-200 ms of
blocked event loop per tick as individual detail requests, and the same batch through
`GET /api/logs/records?ids=` measured ~2 ms.

## Probe traps that are specific to this page

- Instrument the served script with a global hit counter to prove a patch executed:
  `getEventListeners` is DevTools-only and CDP `DOMDebugger.getEventListeners` returns an empty
  description here.
- `jsonLineCache` is a `WeakMap`, and primitives are not valid keys: `WeakMap.set` on a string
  throws `Invalid value used as weak map key`. Because `selectLog` swallows errors, a thrown
  render leaves a silently empty pane — wrap the suspect function in the served script.
- Prove a forced rebuild with the formatted-string toggle button, which re-renders the same pane
  with different markup, and compare row/open/scroll counts rather than eyeballing.
- To reach scroll scale in a UI test, install a synthetic body with
  `window.__adminUiTest.applySelectedLogDetail(...)`; the refresh tick overwrites it with the
  stub fixture, so uncheck `#autoRefreshLogs` first.

## Scroll anchoring and sticky geometry

Key patching woke up Chromium's scroll anchoring: an incremental render replaces one task
section while every neighbour stays put, so the browser anchored on an unchanged node and
scrolled the list down by the inserted body's full height. That hid the whole second level
whenever the expanded task's header sat on the scrollport's content top — for the first section
that is any `scrollTop` above ~1 px, which made it look like "only the top entry does this".
`.log-items` now sets `overflow-anchor: none`; verify numerically with `#logItems.scrollTop`
before and after the caret click plus the first `.log-item`'s rect against the scrollport, and
keep the pinned-header UI test (`useLargeGroupLogFixture`) as the guard.

The same geometry bites expansion a second way: a collapsed section is too short for the sticky
constraint, so a header partly scrolled out of the scrollport is merely clipped, and the body it
is about to grow lets it stick at the top and paint over the first record by exactly the
clipped height. `toggleLogGroupBody` aligns the header with `logListContentTop` before it
expands, which makes the sticky offset zero. Measure it as the first `.log-item`'s rect top
minus the header's bottom.

## Fixture values and mutable flags

An array that a stub method builds per call cannot be hoisted into a module-level const:
values that read mutable test flags (`useSummarizedLogFixture`) freeze at module load, and the
assertion then silently sees the old flag. Test-side writes go through the fixture's `setX()`
helpers because ESM imports are read-only views.
