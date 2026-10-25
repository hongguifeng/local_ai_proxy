# Statistics axis measurements and the baseline drift

Background for [SKILL.md](./SKILL.md).

## The axis regression

A bare `niceCeil` of the peak produced a ¥50 axis for a ¥25 daily cost, leaving the whole
upper half of the chart blank. The shape that replaced it derives a tick step from
`peak / 4`, rounds it up on a ladder that includes 2.5, and stops at the first multiple of that
step above the tallest stacked bar. The 2.5 rung matters beyond rounding: it reproduces the
quarter-fraction axis the committed baseline fixture was captured with, which is why a
cost-only change does not force a baseline regeneration.

The cost axis originally floored at one unit, which pinned every cheap task onto a ¥1 axis. The
floor is one nano (`1e-9`) now, and cost ticks are currency-formatted rather than raw numbers.

## The `ui_stats_*` drift

`loadStatistics` reads the trend grouping as
`optionalTyped("#statsBreakdown", HTMLSelectElement)?.value || "model"` at the start of a load.
On the first load the select does not exist yet, so the fallback `"model"` applies while the
rendered select's default option is `"total"`. A full baseline regeneration can therefore
capture the statistics page with the model breakdown, which changes the legend and bar colors
and moves the document height by about 2 px. The committed `ui_stats_*` PNG bytes have at times
not matched the committed doc hashes either, because the two artifacts were captured in
different environments.

Resolution order when only the statistics baseline moves: compare hashes, pixel-diff against
HEAD, and adopt the regenerated statistics PNGs when they converge exactly to the doc hashes;
restore the committed PNGs only when the regenerated hash matches neither.

## Why the page is rendered on demand

The statistics page is not mounted at startup: `setLanguage` re-runs the render only when the
page was already loaded, and the page registers itself as a language panel so a switch redraws
it. That registration is the reason inline `state.language === "en" ? … : …` strings are
sufficient and `data-i18n` is not used here.
