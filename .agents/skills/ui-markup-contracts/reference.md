# Markup contracts: the measurements behind them

Background for [SKILL.md](./SKILL.md).

## Chip and name-input sizing

A realistic fact line (long model, 3-digit count and speed, 4-digit cost) fits the default
330 px sidebar exactly with 10 px text, `padding: 0 5px` and `gap: 4px`. That is the reference
row to re-measure before enlarging any chip.

The `.target-head` name input has a fixed ~95 px client width; a longer name makes `scrollWidth`
slightly exceed `clientWidth` and clips instead of reflowing. Renaming a fixture target
therefore changes only glyph pixels — measured pixel-diff ratio ~0.0007 with an identical image
size — so only the two affected baselines need a selective re-capture.

## The time-range geometry

The user asked for the two time centers ~30 px apart; the time rows use `line-height: 1` and
the arrow row `line-height: 0.8`, and the spacing was tuned with a `getBoundingClientRect`
center-gap probe rather than by eye.

A previous round's date badges only carried the shared `task-time-date` class while the CSS
targeted `-start`/`-end`, so the badges fell back to grid auto-placement and the rows
misaligned. That is why the class names are part of the contract and why alignment changes are
confirmed with rect probes.

## Header grid history

The ⓘ task-detail icon button was removed once the head itself became details-only. The caret
button kept an explicit `grid-row: 3` because auto-placement would otherwise pull it into the
row the icon vacated. Separate stacked grids with manual gaps could not keep the checkbox and
the text rows aligned across columns, which is why `grid-template-rows: subgrid` is the pinned
shape.

The first section of a large list is also the case where a sticky header can paint over the
first record; `toggleLogGroupBody` aligns the header with `logListContentTop` before expanding.
See `render-internals` for the geometry.

## The picker row

Clicking a non-focusable row blurred the field that opened the overlay, the field's `focusout`
handler hid the panel before the browser dispatched the click, and the click landed on
whatever the panel had covered. The tell was an assertion that the text field still held what
had been typed after a "successful" row click.

A caret button nested inside the field box inherited the row rule and came out 2 px taller than
the text beside it, which is why `.target-check-model-row > button` carries the child
combinator.
