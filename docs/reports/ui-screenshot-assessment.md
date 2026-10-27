# UI Screenshot Assessment

> 状态：报告
> 权威性：特定时间点的测量或验收证据。
> 更新条件：补充复验结果，不改写原始结论。

The Node admin UI intentionally preserves the existing Proxy and History layouts. Automated Chromium
visual tests compare every checked-in Chinese/English screenshot (Proxy, History, Usage statistics, Task
detail, and Load balancing — ten files registered in `docs/current/contracts/ui-visual-baseline.md`) against the
migrated UI, and the current images remain within the approved pixel-difference thresholds. The responsive
760 px layout is also covered separately.

No screenshot replacement is required for the existing Proxy and History baselines. Replacing those files
without a user-visible UI change would only introduce rendering-environment noise. The Usage statistics
baselines are new and were captured together with the statistics feature.

The load balancing group cards have their own pair of baselines, `doc/ui_lb_cn.png` and `doc/ui_lb_en.png`,
added together with the group-card layout rework. They come from the `visualLbPairs()` fixture in
`test-node/ui/admin-ui-fixture.ts` and captured by `test-node/ui/admin-ui-visual.test.ts`, which keeps only the first proxy pair so the whole page stays a reasonable
height, and show that page in full: the viewport height is adapted to the page, so nothing below the fold is
cut off. The plain `ui_proxy_*` baselines keep both pairs and `load_balancers: []` and stay byte-identical,
while `npm run regen:ui-baselines` captures the load balancing pair and syncs their hashes in the baseline
register.
