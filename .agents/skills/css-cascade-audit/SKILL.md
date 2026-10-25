---
name: css-cascade-audit
description: >-
  Edit src/admin/static/app.css, a cumulative stack of layout passes where file order
  proves nothing: count duplication per context, selector and property, rank by importance
  then specificity then source order, delete only unreachable declarations, keep the
  statistics filter bar inside its owned COMPONENT block, and prove cascade neutrality
  with the computed-style oracle. Use when editing admin CSS or when a style change
  appears to have no effect.
---

# Auditing and editing the cumulative admin stylesheet

## When this applies

- You change `src/admin/static/app.css` or move a component's rules.
- A style change appears to have no effect, or an existing rule wins unexpectedly.
- You want to delete a declaration, a whole rule, or a `!important`.

## Invariants

- The sheet is a cumulative stack of layout passes. A later block wins only on a
  specificity tie, so position in the file is not authority; a rule in a new context also
  inherits every later same-class rule.
- Duplication is only countable per (context, selector, property). The cascade ranks by
  importance, then specificity, then source order, so only the top-ranked declaration is
  reachable. Every non-top declaration is deletable — including the earlier of two
  `!important` writings of the same selector. The honesty check after a cleanup is that
  the audit reports zero groups writing one property twice.
- Deleting a multi-line selector must start at the selector's first line. Starting at `{`
  leaves a dangling comma that fuses with the next rule's selector, and rule and
  declaration counts cannot see the damage: diff the (selector, declaration-list)
  inventory of the two files instead.
- Auditing needs a nesting- and at-rule-aware parser. The same selector under two
  different parents is not a duplicate, and an at-rule body holds rules, so the parser
  must switch back to selector mode after `@media {`.
- A class that sets `display` beats `[hidden]`'s UA `display: none`, so every overlay
  class restates `.x[hidden] { display: none }`.
- A page-wide element rule beats nothing on its own: `button` (0,0,1) and `button:hover`
  (0,1,1) lose to any card-prefixed rule. Wins come from specificity, not from where a
  block sits.
- Do not attempt a multi-layer `@layer` restructure. Layer order outranks specificity, and
  on this sheet the specificity-decided contests tie shell, proxy, price, request history,
  statistics and targets into one connected block, so any boundary changes pixels. Do it
  only after rewriting selectors so precedence comes from layers, with regenerated
  baselines.
- The statistics filter bar is the first owned component: its rules may only be written
  between `/* COMPONENT: statistics filter bar */` and
  `/* END COMPONENT: statistics filter bar */`.

## Standard commands

```bash
# Cascade neutrality of a candidate sheet: signature multisets and per-(property,value)
# element counts over four widths and nine states.
CSS_CANDIDATE=<candidate.css> npx vitest run test-node/ui/admin-ui-css-cascade.test.ts -t "candidate stylesheet"

# Which two declarations compete for one element, what decided it, and whether stripping
# a !important would flip it.
CSS_CENSUS=1 CSS_CENSUS_OUT=census.json npx vitest run test-node/ui/admin-ui-css-cascade.test.ts -t "cascade census records"

npm test -- test-node/ui/admin-ui-css-cascade.test.ts test-node/ui/admin-ui-css-ownership.test.ts
npm run regen:ui-baselines
```

## Reading the result

- The candidate case passes only when every signature and every per-value element count is
  identical. A reported signature that disappears and another that appears names the
  property that changed; `CSS.getMatchedStylesForNode` names the winning rule and
  `rule.style.range.startLine` its source line.
- An all-zero result must be falsified with a change that is guaranteed visible before it
  is believed: `*{letter-spacing:4px !important}` has to move something.
- `admin-ui-css-ownership.test.ts` fails on a rule written outside the block, a property
  written twice for one selector in it, a nested at-rule inside it, a `!important` set that
  differs from the pinned lines, or a breakpoint layout that moved.
- A comment-only change is proven harmless by walking `cssRules` in a live page and
  comparing the rule counts.

## Deeper material

- [reference.md](./reference.md) — the measured incidents behind these rules: inherited
  card rules, collapsed labels, grid track sizing, glyph arrows, the `!important` audit and
  the rejected layer plan.
- [module-design.md](../../../docs/module-design.md) §4.5, §4.6 and §4.9 — the cleanup, the
  layer rejection and the filter-bar ownership record.
- `test-node/ui/admin-ui-css-cascade.test.ts` and `test-node/ui/admin-ui-css-ownership.test.ts`
  — the executable contract.
