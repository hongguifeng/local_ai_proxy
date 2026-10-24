---
name: statistics-charts
description: >-
  How the usage-statistics page renders: loadStatistics on demand with inline language strings instead of data-i18n, the usage-trend y-axis nice-tick step and one-nano floor, currency-formatted cost ticks, breakdown legends and the pre-existing ui_stats_* drift cause. Use when changing the statistics page, its axis scales or its language-dependent text.
---

# The usage-statistics page and its chart scales

These traps were learned in this repository and moved here verbatim from `AGENTS.md`;
nothing was paraphrased.

- The usage-trend y-axis is derived from a nice tick step (`tickStep = niceCeil(peak / trendTickIntervals)`, ladder includes 2.5) and stops at the first multiple of that step above the tallest stacked bar; a bare `niceCeil` of the peak jumped a ¥25 daily cost onto a ¥50 axis and left the whole upper half of the chart blank. Cost ticks are currency-formatted and the axis floor is one nano rather than one unit — that floor pinned every cheap task onto a ¥1 axis. The statistics baselines are captured in Token mode only, and the 2.5 rung keeps the baseline fixture's quarter-fraction axis byte-identical, so a cost-only axis change needs no baseline regen; still run the baseline tests to prove the token axis did not move.
- The usage-statistics page is rendered on demand by `loadStatistics`/`loadStatisticsOptions` with inline `state.language === "en" ? … : …` strings (not `data-i18n`); any language switch must therefore re-run that render, which `setLanguage` does only when the page was already loaded. New language-dependent UI must be reachable from an existing re-render path.
