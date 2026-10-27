# app.css: the measurements behind the rules

Incident history for [SKILL.md](./SKILL.md). Every number here was measured on this
repository's sheet; re-measure rather than quoting them as current.

## Inherited rules in a new context

Reusing `.stat-card` in the task-detail summary silently inherited the stats block's
`clamp()` font-size and `white-space: nowrap` / ellipsis on `strong`. The new context had
to override those properties explicitly — `overflow-wrap: anywhere` alone does not beat
`white-space: nowrap`.

A page-wide `label span { overflow-wrap: anywhere; min-width: 0 }` plus the default
`flex-shrink` turned short inline-flex labels (checkbox plus text) into one-character
columns. Measured widths looked innocent while the text was still wrapping, so every new
inline-flex label context restates `flex: 0 0 auto` and `overflow-wrap: normal` on its
`> span`, and the fix is confirmed from the element height or the screenshot.

## Overlays, truncation and row height

- Without `.x[hidden] { display: none }` a "closed" panel still reported
  `aria-expanded=false` while its rows kept intercepting clicks and staying visible. Both
  `.target-options[hidden]` and `.lb-picker-pop[hidden]` exist for that reason.
- `text-overflow: ellipsis` on an inline-flex box does nothing to bare text inside it: the
  text becomes an anonymous flex item. A truncatable label needs its own child with
  `min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis`, and a container-only
  `scrollWidth <= clientWidth` reading proves nothing — compare the inner element's own
  `scrollWidth` with its `clientWidth`.
- Raising a shorter cell's `min-height` does not change the row height when the row was
  already sized by the taller sibling. Measure both boxes.

## Grid track sizing

An `auto` track absorbs leftover space and stretches its content: a header button in an
`auto` track grew to 316 px. `min-content` wrapped the same button's two-character label
onto two lines (36 × 57 px). `max-content` plus a trailing `1fr` track kept the button at
its natural 50 px while the last control stayed right-aligned through `justify-self: end`.

## Geometric glyphs

Windows Chromium renders `▾`, `▸` and `★` through a color font, so a glyph is not an icon.
The caret is a `background-image` SVG shared through a CSS custom property between the
native `select` (`appearance: none`) and the button's empty `<span>`. The match was proven
by clipping both controls' right 34 px and running pixelmatch (`differing pixels: 0`). A
hover rule must set `background-color`, never the `background` shorthand, which resets
`background-image` and makes the arrow disappear exactly when the user points at it.

## The `!important` audit

Proving an `!important` may be deleted is a per-declaration argument: no other rule that
can land on the same element may declare the same property with higher specificity, or
with `!important`, or at equal specificity written later in the file. That test cleared 4
of 36 flagged declarations; they were removed (86 down to 82) after the oracle reported no
difference and the pixel baselines stayed put.

Judge whether two selectors can style one element from their subject compounds alone.
Descendant combinators move class requirements onto ancestors, which coexist freely, so
comparing class token sets wrongly separates `.stats-live input[type=checkbox]` from
`.stats-date-row input`, both of which match one checkbox. Two selectors are impossible on
one element only when their subjects contradict: different element types, or one attribute
required with two values.

## Two script bugs that produced confident nonsense

- Passing a specificity tuple to `Math.max` yields `NaN`, after which every candidate
  survives the filter.
- Destructuring regex groups as `[, , a, b]` skips the first capture group, which is how a
  "zero harmful cross-area" table got printed.

Any all-zero result must be falsified with a change that is guaranteed visible before it is
believed.

## The rejected layered restructure

The opt-in census (`CSS_CENSUS=1`, `CSS_CENSUS_OUT=<path>`) reports which two declarations
compete for one element, what decided it, and whether stripping a `!important` would flip
it. On this sheet the specificity-decided contests tie shell, proxy, price, request
history, statistics and targets into one connected block, so no layer boundary can be
drawn between them without changing what the page draws. `docs/current/product.md` §6
carries the table.

## Section headers

The file opens with a `TABLE OF CONTENTS` comment and 24 `/* SECTION: <area> (n rules) */`
headers so `SECTION:` is searchable. Repeated area names are honest reporting: the areas
genuinely interleave (a 60-line slice produced 81 segments, request history in 20 of them
and statistics in 11).
