---
name: statistics-charts
description: >-
  How the usage-statistics page renders and scales: on-demand loadStatistics with inline
  language strings instead of data-i18n, the usage-trend y-axis nice-tick step with the 2.5
  rung and the one-nano cost floor, currency-formatted cost ticks, and the pre-existing
  ui_stats_* baseline drift. Use when changing the statistics page, its axis scales or its
  language-dependent text.
---

# The usage-statistics page and its chart scales

## When this applies

- You change the statistics page markup, its filters, or its chart axis.
- You add language-dependent text on that page.
- A statistics baseline moves and you need to know whether the chart or the capture caused it.

## Invariants

- The y-axis is derived from a nice tick step (`tickStep = niceCeil(peak / trendTickIntervals)`,
  four intervals, and the ladder includes 2.5) and stops at the first multiple of that step
  above the tallest stacked bar. A bare `niceCeil` of the peak jumped a ¥25 daily cost onto a
  ¥50 axis and left the upper half of the chart blank.
- Cost ticks are currency-formatted, and the axis floor is one nano rather than one unit
  (`costMode ? 1e-9 : 1`) — a floor of one pinned every cheap task onto a ¥1 axis.
- The committed baselines capture the token mode only, and the 2.5 rung keeps the baseline
  fixture's quarter-fraction axis byte-identical, so a cost-only axis change needs no baseline
  regen. Still run the baseline tests to prove the token axis did not move.
- The page is rendered on demand by `loadStatistics` and `loadStatisticsOptions` with inline
  `state.language === "en" ? … : …` strings, not `data-i18n` attributes. Any language switch
  must therefore re-run that render, and `setLanguage()` only does so when the page was already
  loaded; new language-dependent UI has to be reachable from an existing re-render path (the
  page registers itself as a language panel).
- The trend grouping is read as
  `optionalTyped("#statsBreakdown", HTMLSelectElement)?.value || "model"` before the select
  exists on the first load, so the rendered control can show "Total" while the data is grouped
  by model. That is the pre-existing cause of `ui_stats_*` drift on a full baseline regen, not
  a chart bug.
- The two chart axes use deliberately different rules and both are pinned by tests.
  `src/admin/static/modules/chart.js` owns the task-detail line-chart scale
  (`niceAxisScale`: the 1/2/5 step that leaves 3 to 8 intervals with the smallest axis maximum,
  plus the mean line, the peak label and the cost label). The statistics trend axis in
  `statistics.js` derives its step from a fixed four-interval target instead, because a
  `niceAxisScale` maximum on bars leaves the upper half of the plot empty. Do not unify them,
  and do not re-derive a third scale next to either one.

## Standard commands

```bash
npm test -- test-node/ui/admin-ui-statistics.test.ts
npm test -- test-node/ui/admin-ui-visual.test.ts
# Only needed when the statistics capture itself moved; read ui-baseline-regen first.
npm run regen:ui-baselines
```

## Reading the result

- The statistics browser test asserts the rendered axis labels and the stacked series; a chart
  whose axis top is roughly double the tallest bar is the `niceCeil` regression.
- A baseline difference confined to `ui_stats_*` with no statistics source change is the
  breakdown drift: compare hashes before restoring anything.
- A language switch that leaves the page in the previous language means the page's re-render is
  not registered, and nothing will fail on its own.

## Deeper material

- [reference.md](./reference.md) — the axis measurements and the drift reproduction.
- [../ui-baseline-regen/SKILL.md](../ui-baseline-regen/SKILL.md) — regenerating the committed
  statistics captures.
- [module-design.md](../../../docs/module-design.md) §4.3 — the shared UI state model.
