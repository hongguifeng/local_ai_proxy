---
name: ui-markup-contracts
description: >-
  Structural contracts the admin UI depends on: the three-row task header grid with subgrid and
  the caret button, fact-line flex clipping with the model-name exception, target-card pointer
  reordering, fixed-width name inputs, zod stripping UI-only config fields, the task-summary
  grid with its time-range classes, focusable picker rows, and the `min-width: 0` chain that
  keeps a wrapping binding line from widening its card. Use when moving, aligning or adding
  admin UI controls, when a Playwright click hangs or a control renders wrong, or when a block
  comes out wider than the container holding it.
---

# Admin UI markup and interaction contracts

## When this applies

- You add or move a control in the log list, the proxy/target cards, or the task-detail panel.
- A Playwright click hangs, or an alignment change seems to have no effect.
- You hang UI state off a config object and it disappears after a save.

## Invariants

- The group fact line (`.log-group-fact-line`, `history.js`) clips right-to-left: children are
  `flex: 0 0 auto` and only the row keeps `overflow: hidden`. The model name is the one
  deliberate exception — `.log-group-fact-line > .log-model` gets `flex: 0 1 auto`,
  `min-width: 0`, ellipsis and a `title` — so an over-long model truncates first and the metric
  chips stay readable. Do not make another item shrinkable: one accidental extra shrinkable
  child steals width from the metrics and truncates the wrong value. Chip sizing is budgeted
  for the default 330 px sidebar, so re-measure before enlarging them.
- The task header (`.log-group-head`) is a 3-row grid whose control column
  (`.log-group-controls`: checkbox plus the caret button) and `.log-group-summary` share those
  rows through `grid-template-rows: subgrid`, so each control centers against its text row. The
  caret needs an explicit `grid-row: 3` because auto-placement would pull it up into the row the
  removed ⓘ button vacated. Keep new header controls in that shared-row structure.
- Interaction model: a head click (or Enter/Space) opens the task-detail panel and never touches
  body expansion; expanding/collapsing the request list is the caret button's exclusive job
  (`.log-group-caret`, `data-group-toggle` — a real `<button>`, so the head's keydown handler
  must keep skipping `button` targets). Expanding lazy-loads the group's records, so a test that
  needs the second level clicks the caret.
- Locator trap: `[data-group-id]` is the head div itself, not the `.log-group` section, so
  `[data-group-id="…"] .log-group-head` matches nothing and the click hangs until the test
  timeout. Scope with `.log-group:has([data-group-id="…"])` or use the element directly.
- Target-card reordering (the `⠿` handle in `.target-title`, `proxy-config.js`) uses pointer
  events, not the HTML5 drag API: `pointerdown` runs `collectPairs()` and then moves the card
  nodes in the DOM live, and the drop maps DOM order back to `state.pairs` through each card's
  `data-target-index`. Never call `collectPairs()` after the nodes moved, and make the drop side
  follow the layout axis — grid rows compare the pointer against the x midpoint, a single-column
  stack against the y midpoint.
- The `.target-head` name input is a default-sized `<input>` (fixed ~95 px client width), so a
  longer name clips instead of reflowing and renaming a target never moves its neighbours.
- Config round trips erase UI state: `zod`'s `z.object()` strips unknown keys, so anything the
  UI hangs off config objects (`target.expanded`, `prices_expanded`, a new card's open flag) is
  gone once `PUT /api/pairs` returns. Remember it in `localStorage` (the
  `state.pricingGroupOpen` pattern) instead of the payload. New _real_ config fields need no
  schema edit because the `PAIRS_*` schemas are `additionalProperties: true`, and fields added
  to a record's `request.model_route` become searchable through the FTS `request_text` sources
  without a schema bump — keep verbose decision detail in an in-memory admin snapshot instead.
- The task-detail panel head (`.pricing-panel-head`, `task-detail.js`) is one flex row that
  `pricingPanelHeadHtml` builds and all three panel states (loading, load error, loaded) reuse:
  title, the task id, the close button. The id sits next to the title rather than against the
  close button: `margin-left: auto` lives on the head's own `> button`, so the free space opens
  between the id and the button, and the title carries `flex: 0 0 auto` — the id, not the title,
  is what clips. The id is `flex: 0 1 auto` with `min-width: 0`, an ellipsis and a `title`
  carrying the whole value, so it takes only the room left between the title and the button and
  still answers for a 32-character id in a narrow pane; `user-select: all` makes one click select
  all of it for copying. Where the id sits is an alignment claim, so `admin-ui-history.test.ts`
  measures it with `getBoundingClientRect`: the id starts one head gap after the title ends and
  the free space lies before the close button.
- The task-detail summary (`.task-summary`, `task-detail.js`) is the 2-row × 4-column card grid
  alone: the model is the first card and the time bar spans the remaining three cells. Neither the
  task id nor the target address has a line of its own in it — the id is on the panel head and the
  address is the log list's header third row. `fitTaskSummaryValues` shrinks the model's `strong`
  1 px at a time (floor 12 px) until it fits one line, and re-runs on every panel re-render.
- The Time range sub-card is a three-column (label | date | time) grid: the label shares the
  start-time row, and both date badges always render — even for same-day ranges. `taskTimeRangeHtml`
  writes them with the distinct classes `task-time-date-start` / `task-time-date-end` plus
  explicit grid placement, and the arrow row renders only when both timestamps exist. A shared
  `task-time-date` class alone falls back to auto-placement and misaligns the rows.
- A clickable row inside a floating picker must be focusable (`tabIndex = -1`): clicking a
  non-focusable row blurs the field that opened the overlay, whose `focusout` handler hides the
  panel before the browser dispatches the click, so the pick is silently lost.
- A wrapping line or a grid item left at `min-width: auto` sizes itself to its own min-content, so
  one unbreakable token — a long model name under `overflow-wrap: normal` — pushes the whole
  ancestor chain wider, not just the line. The compact binding list measured a 525 px panel inside a
  318 px card until every nested container carried `min-width: 0`: the panel, the binding block, its
  line, the task continuation line and the move row. New wrapping or compact list markup needs that
  whole chain, and the claim is proved by asserting the list is no wider than its card and that the
  long name still clips at a narrow viewport.
- Scope a shared row height with `>` (`.target-check-model-row > button`); a caret button
  nested inside the field box otherwise inherits the row rule and comes out taller than the text
  beside it.
- A bare `<small>` with no class never matches a `.small` rule, and grid auto-placement can make
  a broken layout look plausible: confirm the selector matches the rendered markup before
  claiming a spacing change took effect.

## Standard commands

```bash
npm test -- test-node/ui/admin-ui-history.test.ts
npm test -- test-node/ui/admin-ui-proxy.test.ts
npm test -- test-node/ui/admin-ui-load-balancing-config.test.ts
npm test -- test-node/ui/admin-ui-load-balancing-status.test.ts
npm test -- test-node/ui/admin-ui-load-balancing-moves.test.ts
npm run bundle:ui
```

## Reading the result

- An alignment claim needs a `getBoundingClientRect` probe (center gaps, row tops), not a
  screenshot read by eye.
- A control that "did nothing" usually lost the cascade or never matched a selector; a control
  that moved the wrong neighbour usually means a second shrinkable flex child.
- A field that keeps the old value after a "successful" row click is the focusable-row bug.
- When a block comes out wider than its container, do not guess which child is at fault: walk the
  ancestor chain and print each element's `getBoundingClientRect().width` beside its `scrollWidth`
  and computed `min-width`. The first ancestor whose width equals the block's is the one carrying
  the min-content, and that is where `min-width: 0` belongs.

## Deeper material

- [reference.md](./reference.md) — the measurements behind the grid, chip, name-input and
  picker rules.
- [../render-internals/SKILL.md](../render-internals/SKILL.md) — the render signatures these
  contracts live in.
- [../css-cascade-audit/SKILL.md](../css-cascade-audit/SKILL.md) — when the cause is specificity
  rather than markup.
