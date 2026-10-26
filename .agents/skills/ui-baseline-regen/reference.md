# Visual baselines: measurements and drift investigations

Background for [SKILL.md](./SKILL.md).

## The unit-sensitive statistics API

`overview` totals and `byTarget`/`byModel` `cost` are yuan strings, while trend `points[].cost`
is a nano-CNY integer that the UI divides by 1e9. Derived values such as averages must be
computed with exact integer division on the nano values and only then converted to a decimal
string: a naive float average produced `0.014249999999999998`, which formats as `0.0142` — one
last digit away from the exact integer mean `0.0143`.

## What a green assertion can hide

- Swapping two adjacent header controls moved 2952 of 1,508,040 pixels (0.2 %) and stayed under
  the 0.12 limit.
- Moving the target card's three action buttons out of the head, together with a card fill
  change, measured 8.9-10.2 % differing pixels against the committed PNG — still under the
  limit.
- Renaming a fixture target changed only glyph pixels (ratio ~0.0007) with an identical image
  size, because the name input has a fixed client width and does not reflow.

The pattern: a baseline test answers "did this page change a lot", not "did this page change".
Regenerate after any markup order or control relocation change, and pixel-diff the two images
to report the measured delta.

## Drift that is not your change

- Encoder metadata can change PNG bytes while pixels stay identical. Diff committed against
  regenerated images (`pixelmatch` + `pngjs`, threshold 0.1) before treating a baseline change
  as a visual regression.
- If the committed baseline came from another machine, a local regeneration can shift hashes
  for every page at once. Compare against a stash of the pre-change source to separate your
  effect from environment drift.
- Environment drift also shifts the document height with identical visible content: the
  adaptive viewport follows the font's wrapping, so the load-balancing page came out 17 px
  shorter in Chinese and 16 px taller in English on the Linux runner than on Windows. The helper
  therefore asserts the width only and asks that the other capture's extra rows be blank. A
  one-pixel viewport drift still fails that check when the splitter border (213,221,231) sits in
  the bottom row, because six pixels of it are not near-white.
- The `ui_stats_*` captures have drifted for a second, unrelated reason: the trend grouping
  fallback. See `statistics-charts`.

## Selective capture

`REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui-visual.test.ts -t "load balancing baseline"`
re-captured only the two load-balancing pages, and the other eight stayed byte-identical. A
panel-only change regenerating just the two task-detail baselines is enough for the same
reason. A full `npm run regen:ui-baselines` re-captures every page and can drift the statistics
page.

## Why the served-asset check comes first

The suite reads `app.css` and `index.html` from `src/admin/static` (the module URL resolves
there), while the built app serves the `dist-node` copies; the JavaScript is the opposite — one
bundle at `dist-node/src/admin/static-bundle/admin-app.js` that both read. So a CSS change can
look absent in the built app until `npm run build` refreshes the copies, and a JS change needs
`npm run bundle:ui`. Checking the served bytes before pixel archaeology costs seconds and rules
out both.
