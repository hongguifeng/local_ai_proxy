---
name: css-cascade-audit
description: >-
  Work in src/admin/static/app.css, a cumulative stack of layout passes: measure duplication per (context, selector, property), rank declarations by importance then specificity then source order, delete unreachable declarations safely, merge only same-context disjoint pairs, draw glyphs as background SVG, and prove cascade neutrality with the computed-style oracle. Use when editing admin CSS or when a style change appears to have no effect.
---

# Auditing and editing the cumulative admin stylesheet

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

The sheet audited here is `src/admin/static/app.css`: a cumulative stack of layout
passes where a later block wins only on a specificity tie, so file order proves
nothing.

- Reusing a generic class in a new context (e.g. `.stat-card` in the task-detail summary) silently inherits later same-class rules (the stats block sets `clamp()` font-size + `white-space: nowrap`/ellipsis on `strong`), so the new context must explicitly override those properties — `overflow-wrap: anywhere` alone does not beat `white-space: nowrap`. A page-wide `label span { overflow-wrap: anywhere; min-width: 0 }` rule plus default `flex-shrink` turns short inline-flex labels (checkbox plus text) into one-character columns, so every new inline-flex label context must restate `flex: 0 0 auto` and `overflow-wrap: normal` on its `> span`; measured widths alone look innocent while the text is still wrapping, so confirm single-line rendering from the screenshot or the element height. A class that sets `display` also beats `[hidden]`'s UA `display: none`, so every overlay class has to restate `.x[hidden] { display: none }` (that is why both `.target-options[hidden]` and `.lb-picker-pop[hidden]` exist) — without it a "closed" panel still reports `aria-expanded=false` while its rows keep intercepting clicks and staying visible. `text-overflow: ellipsis` on an inline-flex box does nothing to bare text inside it - the text becomes an anonymous flex item - so a truncatable label needs its own child element with `min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis`, and a container-only `scrollWidth <= clientWidth` reading proves nothing about that text: compare the inner element's own `scrollWidth` with its `clientWidth`. Raising a shorter cell's `min-height` to match a taller sibling does not change the row height when the row was already sized by that sibling, so measure both boxes instead of assuming the card grew. Grid track sizing is also not obvious from the markup: an `auto` track absorbs leftover space and stretches its content, so a header button in an `auto` track grew to 316 px, while `min-content` wrapped the same button's two-character label onto two lines (36 x 57 px) - `max-content` plus a trailing `1fr` track is what keeps the button its natural 50 px while the last control stays right-aligned through `justify-self: end`. Auditing its re-declared selectors needs a nesting- and at-rule-aware parser: this file uses CSS nesting, so the same selector under two different parents is not a duplicate, and a scanner that pops the at-rule stack on every `}` scrambles media contexts and invents duplicates - and because an at-rule body holds rules, the parser must switch back to selector mode after `@media {`, otherwise every rule inside a media block loses its selector and unrelated selectors get grouped as one chain. Duplication is only countable per (context, selector, _property_), not per rule block: the cascade ranks by importance, then specificity, then source order, so only the top-ranked declaration is reachable - an earlier `!important` beats a later plain one, and deleting anything below the top cannot change the winner however other selectors compete. That makes every non-top declaration deletable, including the earlier of two `!important` writings of the same selector; the honesty check after a cleanup is that the audit reports zero groups writing one property twice. Deleting lines has its own trap: a block whose selector spans several lines must be removed from the selector's first line, because starting at `{` leaves a dangling comma that fuses with the next rule's selector and sprays the deleted block's values onto unrelated elements - rule and declaration counts cannot see this, so diff the (selector, declaration-list) inventory of the two files instead. A comment-only change is proven harmless by walking `cssRules` in a live page and comparing counts. The sheet now carries a `TABLE OF CONTENTS` comment and 24 `/* SECTION: <area> (n rules) */` headers to search; repeated area names are honest reporting because the areas genuinely interleave.
- Windows Chromium renders geometric glyphs (`▾`, `▸`, `★`) through a color font, so a glyph is not an icon: draw a caret as a `background-image` SVG shared via a CSS custom property between the native `select` (`appearance: none`) and the button's empty `<span>`, then prove the match by clipping both controls' right 34 px and running pixelmatch - `differing pixels: 0` beats eyeballing two screenshots. A hover rule must set `background-color`, never the `background` shorthand, which resets `background-image` and makes the arrow disappear exactly when the user points at it. Page-wide element rules (`button`, specificity 0,0,1; `button:hover`, 0,1,1) lose to a card-prefixed rule (0,2,1 / 0,2,2), so these wins came from specificity, not from where the block sits in the cumulative `app.css`.

## Why a layered restructure was measured and rejected

Layer order outranks specificity, so a contest decided by specificity survives only
while both declarations stay inside the same layer. The opt-in census in
`test-node/ui/admin-ui.test.ts` measures those contests on stubbed data and frozen
page time:

```bash
CSS_CENSUS=1 CSS_CENSUS_OUT=census.json npx vitest run test-node/ui/admin-ui.test.ts -t "cascade census records"
```

It reports which two declarations compete for one element, what decided it, and
whether stripping a `!important` would flip it. On this sheet the specificity-decided
contests tie shell, proxy, price, request history, statistics and targets into one
connected block, so any layer boundary between them changes what the page draws.
`docs/module-design.md` §4.6 carries the measurements. Do not attempt a multi-layer
`@layer` restructure here without first rewriting selectors so precedence comes from
layers instead of specificity - that changes pixels and needs regenerated baselines.

Proving an `!important` may be deleted is a per-declaration argument: no other rule
that can land on the same element may declare the same property with higher
specificity, or with `!important`, or at equal specificity written later in the file.
That test cleared 4 of the 36 declarations at the flagged rules here; those were
removed (86 down to 82) after the oracle reported no difference and pixel baselines
stayed put. Judge whether two selectors can style one element from their subject
compounds alone: descendant combinators move class requirements onto ancestors, which
coexist freely, so comparing class token sets wrongly separates
`.stats-live input[type=checkbox]` from `.stats-date-row input`, both of which match
one checkbox. Two selectors are impossible on one element only when their subjects
contradict - different element types, or one attribute required with two values.

Two script bugs produced confident nonsense while measuring this, and both are worth
remembering: passing a specificity tuple to `Math.max` yields `NaN`, after which every
candidate survives the filter; and destructuring regex groups as `[, , a, b]` skips the
first capture group, which is how a "zero harmful cross-area" table got printed. Any
all-zero result must be falsified with a change that is guaranteed visible before it is
believed.
