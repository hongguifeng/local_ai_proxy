---
name: live-ui-probing
description: >-
  Check an admin UI change against the user's already-running portable instance without
  rebuilding: read its admin port from the portable llm-proxy.json, intercept the instance's
  own /static/app.js and serve it patched, measure click-to-visible with in-page marks, and
  digest computed styles as a set of signatures. Nothing but __adminUiTest is on window
  after the ES module migration, so drive the DOM instead of calling page functions. Use
  when a UI change must be verified on real data instead of a stub.
---

# Probing the admin UI without rebuilding

## When this applies

- You must verify a `src/admin/static` change against the user's real instance and its
  real traffic, and a rebuild plus packaging is too slow or too invasive.
- You need one number (layout height, click-to-visible time, cascade signature set) rather
  than a baseline image.
- A visual regression test is too coarse to explain a difference you already suspect.

## Invariants

- The user's portable instance is read-only: read its admin port from
  `D:\Portable Program\llm_proxy\llm-proxy.json`, never write its config or database, never
  stop it, and only kill processes you started.
- Serve the _instance's own_ script with the patch applied, through Playwright route
  interception of `**/static/app.js`. Serving the working tree's bundle on an older page
  dies at load, because the bundle text still carries the `__SUGGESTED_STRIP_REQUEST_FIELDS__`
  placeholder that the server substitutes.
- After the ES module migration the page publishes nothing but the frozen
  `__adminUiTest` object (`src/admin/static/modules/test-adapter.js`). There is no
  `window.renderLogs`, no `window.setLanguage` and no `state` on `window`. To reach a module
  function, patch the served bundle text at its definition site — the bundle is unminified
  and keeps source names — or drive the real control.
- A modal `<dialog>` makes the page behind it inert, so a probe cannot click page controls
  while one is open. Dispatch the event instead: set `#languageSelect.value` and dispatch
  `new Event("change")`; `__adminUiTest.applySelectedLogDetail(...)` synthesizes a body.
- Measure click-to-visible with in-page marks: a capture-phase click listener plus a
  `MutationObserver`. Wall-clock around `page.click` measures Playwright's hover, stability
  and hit-target work (~100 ms on a paged list), not the app.
- Compare computed styles as the _set_ of style signatures, not element by element: the
  live instance keeps ingesting records, so the two loads have different element counts.
  Sample longhands (a digest keyed on the shorthand names misses what shorthands control)
  and sample `getComputedStyle(el, "::before")` separately.
- Falsify the probe before trusting a clean run: `*{letter-spacing:4px !important}` must move
  every signature. An edit that shows zero deltas may simply have lost the cascade, which is
  a valid result, not a blind probe.
- The live instance cannot judge the statistics page: it ingests traffic, so even the
  identical sheet moves signatures between loads. Cascade neutrality is decided by the
  stubbed harness instead (see `css-cascade-audit`).
- A probe driven through `npx tsx` cannot use named helpers inside `page.evaluate`: tsx
  transforms them into a `__name` helper that does not exist in the browser. Keep evaluated
  code helper-free, or drive the interaction with locators.

## Standard commands

```bash
# The bundle both the instance and a throwaway harness serve; rebuild it after editing JS.
npm run bundle:ui
# After editing app.css or index.html the built copies must be refreshed as well.
npm run build

# Deterministic cascade comparison on stubbed data.
CSS_CANDIDATE=<file> npx vitest run test-node/ui/admin-ui-css-cascade.test.ts -t "candidate stylesheet"
```

## Reading the result

- A click-to-visible mark pair gives a duration the app owns; anything around 100 ms more
  than that is probe overhead.
- A signature that disappears and another that appears names the changed property; the
  winning rule and its source line come from `CSS.getMatchedStylesForNode` plus
  `rule.style.range.startLine`.
- `scrollWidth === clientWidth` only proves no horizontal clipping; it cannot see wrapping.
  Pair it with a measured element height or a screenshot.
- An element screenshot covers only the viewport part of the element; a narrow-viewport
  capture of a tall card silently omits the section below the fold. Screenshot the inner
  element instead.

## Deeper material

- [reference.md](./reference.md) — the measured probe results (prefetch, layout heights,
  cascade digests) and the throwaway harness recipe.
- [../render-internals/SKILL.md](../render-internals/SKILL.md) — what the measured
  code paths do.
- [../ui-baseline-regen/SKILL.md](../ui-baseline-regen/SKILL.md) — when the answer belongs
  in a committed baseline instead.
