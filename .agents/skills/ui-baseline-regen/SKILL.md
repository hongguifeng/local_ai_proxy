---
name: ui-baseline-regen
description: >-
  Regenerate and sync the committed admin UI baselines: npm run regen:ui-baselines captures
  every page and rewrites the SHA-256 rows in docs/refactoring/ui-visual-baseline.md, a single
  baseline is re-captured with REGEN_BASELINES=1 and a -t filter, and a passing ratio assertion
  does not prove a baseline is current. Use whenever a UI text, layout or content change may
  move a committed baseline or a README image.
---

# Admin UI visual baselines: regenerate, sync, compare

## When this applies

- Any change to admin UI text, markup, layout or CSS lands.
- A visual regression test fails, or passes while the image looks wrong.
- You add a new baseline page or change a committed README image.

## Invariants

- `npm run regen:ui-baselines` runs the visual suite with `REGEN_BASELINES=1`, writes the ten
  `doc/ui_*.png` captures, and recomputes every SHA-256 row in
  `docs/refactoring/ui-visual-baseline.md`. Those PNGs are also the README images, so a
  regeneration is a README change and vice versa.
- One baseline can be re-captured with
  `REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui-visual.test.ts -t "<test name>"`
  (`screenshotDifference` writes the file and returns 0 in that mode). The doc row must then be
  filled in by hand with a complete 64-character hash — the regen script's row pattern only
  matches full hashes, so a `PENDING` or shortened cell breaks the next full regeneration.
- The assertion compares a differing-pixel ratio with `toBeLessThan(0.12)`, not a zero pixel
  count. A localized change such as swapping two adjacent header controls measured 2952 of
  1,508,040 pixels (0.2 %) and passed while the committed PNG still showed the old arrangement.
  Any markup-order or control-relocation change needs a re-capture plus a pixel diff against
  HEAD to prove the delta is real.
- The task-detail (pricing) and statistics baselines use an adaptive viewport: the test resizes
  to the panel's `scrollHeight` plus 52. Adding a panel block therefore changes the image
  height, which means the doc row (size column and hash) changes too.
- `screenshotDifference` asserts the width and never the height: it requires only that the
  rows one capture has and the other lacks carry no content, where "blank" means channels of at
  least 200 — the pane splitter border (213,221,231) sits in the bottom rows of the adaptive
  capture. A height assertion cannot hold, because the adaptive viewport follows how the
  installed fonts wrapped the text (the same load-balancing page is 17 px shorter in Chinese and
  16 px taller in English on the Linux runner). Do not reintroduce one.
- A hash change with a pixel-identical image can mean encoder metadata non-determinism, or a
  stale on-disk file: outside `REGEN_BASELINES` mode the helper only reads, so a green test
  proves nothing about the committed PNG.
- The statistics baseline has a pre-existing drift cause; read `statistics-charts` before
  restoring it.
- Restoring the baseline document with `git checkout` also discards any uncommitted table fix
  in it — re-apply those afterwards.
- Inspect each regenerated image in full before cropping or trusting it, read the English
  captures for stray Chinese — that image is the only proof the interface is fully translated,
  and a label left untranslated fails nothing on its own — and clean up the temporary files and
  processes the capture leaves behind.

## Standard commands

```bash
npm run regen:ui-baselines

# One baseline only; then hand-fill that row in docs/refactoring/ui-visual-baseline.md.
REGEN_BASELINES=1 npx vitest run test-node/ui/admin-ui-visual.test.ts -t "<test name>"

npm test -- test-node/ui/admin-ui-visual.test.ts
npx prettier --check .
```

## Reading the result

- When a baseline appears unresponsive to a UI change, verify in order: (1) the served assets
  actually contain the new text — a JS change needs `npm run bundle:ui` because both the suite
  and the app read that one bundle, while a CSS or HTML change needs the `dist-node` copy for
  the app and is read from source by the suite; (2) the new DOM actually renders, with a
  throwaway `page.evaluate` dump of the changed nodes; (3) then pixel-diff the on-disk file
  against HEAD.
- A localized difference well under the 0.12 ratio is still a real change: pixel-diff the two
  images and report the differing count instead of treating the green test as proof.
- A hash that matches the doc while the image does not is an environment drift, not your
  change; compare against a stash of the pre-change source to separate the two.

## Deeper material

- [reference.md](./reference.md) — the measured ratios, the drift investigations and the
  selective-capture history.
- [../statistics-charts/SKILL.md](../statistics-charts/SKILL.md) — the `ui_stats_*` drift cause.
- [ui-visual-baseline.md](../../../docs/refactoring/ui-visual-baseline.md) — the committed
  capture table this skill keeps in sync.
