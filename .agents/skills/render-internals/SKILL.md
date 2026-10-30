---
name: render-internals
description: >-
  How the admin UI rebuilds itself: renderLogs sections keyed by logGroupRenderSignature,
  task-detail panel skipping, JSON pane row reconciliation against remembered raw values, the
  lazy JSON tree with
  jsonMaterializeQueue, content-visibility with contain-intrinsic-size, the row-window rAF
  watcher, scroll anchoring and sticky header geometry, refresh pagination and the language
  panel registry. Use when a state change never shows up, the page freezes, scrolling
  blanks, or a UI test waits forever.
---

# How the admin UI rebuilds itself

## When this applies

- A state change does not reach the DOM, or a panel looks like it never rendered.
- The page freezes, scrolls blank, or lags on a large record.
- A browser test hangs while waiting for rows that never appear.

## Invariants

- `renderLogs` rebuilds only the task sections whose `logGroupRenderSignature` changed
  (cached in `state.logSections`) and leaves every other section's nodes in place, so any
  state that changes markup must be part of that signature: language, group checkbox,
  expanded/loading flags, the selected row, and every per-record field a row prints. A state
  missing from the signature fails as `element(s) not found`, not as a wrong value.
- The task-detail panel skips rebuilds the same way through `state.taskPricingRendered`; a
  new panel block must appear in `taskPricingRenderSignature` (pricing payload, all three
  series, `state.activeTaskGroup`) or a refresh keeps the old DOM.
- A native `<select>` popup is anchored to the element, not to the focus: a repaint that puts a
  new `<select>` where the open popup sits closes it, and restoring focus onto the rebuilt node
  cannot reopen it, so a focus assertion says nothing about whether the popup survived. The
  destination picker in the binding list holds its poll repaint until the user leaves it
  (`destinationPickerIsInUse`, passed as `renderBindingPanel(context, true)` only at the read's
  `finally`), and that wait dies the moment the row's `bindingId + incarnation` stops being the
  one the list reports. Prove it by marking the element and asserting the mark survives on the
  node a later poll finds, never by `toBeFocused`.
- The JSON pane reconciles the tree it already rendered instead of reassigning markup. Every
  rendered row remembers the raw value it was built from (`jsonRenderedRows`, seeded by
  `seedJsonRenderedRows`), and a refresh compares those raw values with `sameJsonValue` - which
  counts object key order as part of the value. So an identical body changes no DOM at all, and
  a body whose one leaf changed touches only that row. `state.jsonPaneHtml` now holds only the
  plain-text render: assigning the whole tree string is what used to cost the user time, because
  the tree is tens of thousands of `<details>` nodes.
- A refresh may reconcile only while the pane's _view_ state is unchanged. `jsonPaneSignature`
  covers language, tree mode, format mode, measured line width, wrap and lazy; any of those
  changed, another record selected, or `resetView` forces a rebuild, because line fitting and
  default expansion are recomputed and a width change cannot be reconciled. A row whose shape
  changed (leaf ↔ container, formatted string text) is replaced; a node that only gained or lost
  descendants keeps its own `<details>`, its child rows are matched by `data-json-child-key`, and
  a row that is merely in the wrong position is moved, never rebuilt.
- A reconcile must not resurrect a row it replaced, so `syncJsonRow` reports the element that now
  stands where the row was. Following the old, now-detached element re-inserts it and the pane
  shows the same key twice.
- Above `lazyJsonEntryLimit` the tree renders lazily: a node that starts collapsed is emitted
  with `data-json-lazy="1"` and an empty `.json-children`, and its children are built when the
  pane's capture-phase `toggle` listener fires. Every path that opens a node programmatically
  (notably `restoreJsonPaneViewState` assigning `detail.open`, and the expand-one-level
  button) must materialize as well.
- Lazy fills go through the time-budgeted `jsonMaterializeQueue`: each node is filled _before_
  it opens, and the drain is kicked from `setTimeout(0)`, never synchronously. A single node
  with many children is itself split into 96-row chunks, so the node queue budget cannot hide
  one large `innerHTML` assignment. Every path that opens a node programmatically (notably
  `restoreJsonPaneViewState` assigning `detail.open`, and the expand-one-level button) must
  materialize as well. A fill must also record the rows it produced (`recordJsonRenderedRows`),
  or the next refresh cannot tell them from rows it never rendered and tears the subtree the
  user just opened down. A fill that throws has to leave the queue runnable: the drain is wrapped
  in `try/finally` so one bad node cannot strand every node behind it.
- `materializeJsonNode` reads `jsonLineWidthCache` instead of measuring `clientWidth` after
  mutating the tree: that read forces a synchronous re-layout of the whole pane. The cache is
  kept fresh by a `ResizeObserver` and the render path, and the toggle listener's button
  refreshes coalesce through `schedulePaneButtonsUpdate`.
- `.json-row` carries `content-visibility: auto` plus a `contain-intrinsic-size` hint that
  `countJsonLinesWalk` estimates from the subtree's current open state and `jsonRowMarkup` bakes
  into the row. `materializeJsonNode` must refresh the parent row's hint after filling.
- Rows around the viewport are pre-realized by `updateJsonRowWindow` and a per-pane,
  scroll-armed `requestAnimationFrame` watcher. The walker moves by index through the cached
  flat `.json-row` list (document order is top-to-bottom order), bounds its step count, and
  re-anchors by striding when a jump is bigger than the viewport. Never leave an always-on rAF
  loop: a self-perpetuating chain never settles under `page.clock` and hangs fake-clock tests.
- Compare rects in scroll-content coordinates (`box.top - paneRect.top + scrollTop`). Rows
  taller than the scrollport are always realized, so they are not evidence of a blank.
- `.log-items` sets `overflow-anchor: none`: an incremental render replaces one section while
  its neighbours stay put, and the browser otherwise anchors on an unchanged node and jumps
  the list by the inserted body's height.
- A collapsed section is too short for the sticky constraint, so `toggleLogGroupBody` aligns
  the header with the scrollport's content top (`logListContentTop`) before expanding;
  otherwise the header paints over the first record.
- The record list reads 200 records when a group expands and appends 100 per
  `[data-load-more-records]` click (`loadLogGroup` / `loadMoreLogGroup`), and expanding one
  level creates new lazy nodes, so a deep record needs repeated clicks and an assertion about
  "every lazy node is done" can never pass — wait for the count that existed before the click.
- Refresh contracts: the automatic tick re-reads every group already on screen, so its `limit`
  must stay inside `LOG_GROUP_PAGE_MAX_LIMIT` and a truncated page carries over the groups the
  user paged past (`mergeLogGroupSummaries` with `keepMissing`). `loadLogs` coalesces a request
  that arrives while another is in flight (`state.logsQueued`) instead of dropping it, and the
  pending-row sweep reads one rotating slice per tick (`PENDING_REFRESH_BATCH`,
  `state.pendingSweepCursor`), so tests that count `detailReads` only see the current batch.
- In-flight rows are swept through `GET /api/logs/records?ids=a,b` (body-free rows plus
  `pending`), because one detail read inflates every stored chunk of a record. Batch rows carry
  no bodies, so the selected record has to stay out of `refreshedIds` for its detail to be
  fetched.
- The language switch redraws whatever registered itself: a panel calls
  `registerLanguagePanel(id, sequence, render, when?)`, and `setLanguage()` calls
  `rerenderLanguagePanels()`, which sorts by `sequence` and skips panels whose `when()` is
  false. A panel that never registers stays in the previous language and nothing fails;
  `test-node/admin/static-source.test.ts` pins the id/sequence table and rejects any `render*(`
  call left inside `setLanguage`.
- The page publishes no rendering function on `window` any more. Measure observable effects
  (mutation counts, mark-to-mutation timing) or patch the served bundle text; synthesize a body
  with `window.__adminUiTest.applySelectedLogDetail(...)` after unchecking `#autoRefreshLogs`,
  because the refresh tick overwrites it with the stub fixture.
- In UI fixtures, a value that reads a mutable test flag cannot be hoisted into a module-level
  const: it freezes at module load and the assertion silently sees the old flag.

## Standard commands

```bash
npm test -- test-node/ui
npm test -- test-node/admin/static-source.test.ts
npm run bundle:ui
```

## Reading the result

- A mark that never appears means the state driving it is not in the render signature. When you
  delete one of two areas that state the same fact, the surviving area's signature has to gain
  that state in the same change.
- Freezes are proven with an rAF-gap probe (gaps over 100 ms) and `scrollHeight` against a
  no-content-visibility baseline; CDP `Performance.getMetrics` `LayoutCount` deltas separate
  layout churn from script cost. A `PerformanceObserver(["longtask"])` probe on this page came
  back `{longtask: [], event: []}`, so longtask entries are not evidence here.
- A refresh's work is proven by counting DOM nodes - a `MutationObserver` on the pane tallying
  added and removed nodes - and by timing the synchronous apply against the next animation
  frame. `test-node/ui/admin-ui-json-pane-refresh.test.ts` pins that an identical body changes
  nothing, that one changed leaf touches one row, that bytes appended while a request is pending
  reach the pane, and that keys arriving in a new order show in that order.
- Responsiveness is proven by timing inside the click handler (sub-millisecond target) and by
  polling `data-json-lazy-done` for drain settle — interval timestamps mislead because timers
  are clamped while the main thread is busy.
- A blank patch while scrolling is a hint problem (the scrollbar underestimates the real
  height) or a watcher problem; check the row's inline `contain-intrinsic-size` first.

## Deeper material

- [reference.md](./reference.md) — the measured click chains, node counts, frame gaps and the
  probe recipes that produced these rules.
- [当前产品行为](../../../docs/current/product.md) §6 — 浏览器模块和 UI 合同。
- [../live-ui-probing/SKILL.md](../live-ui-probing/SKILL.md) — probing a running instance.
