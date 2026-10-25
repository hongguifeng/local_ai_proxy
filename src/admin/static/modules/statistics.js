// LLM Proxy admin UI -- usage statistics page: overview cards, trend chart, breakdown, export.
// ES module: imports the shared bootstrap (./core.js) and the display helpers; the page is
// rendered on demand and re-rendered in place when the language changes.

import { $, asElement, qsa, registerLanguagePanel, state, toast } from "./core.js";
import { formatCurrencyAmount, pricingAmount } from "./money.js";
import { pricingDecimalFromNano } from "./numbers.js";
import { escapeHtml } from "./text.js";

// The statistics page is rendered on demand; re-render it if it was loaded so its
// inline (non data-i18n) labels follow the new language without a refresh.
registerLanguagePanel(
  "statistics",
  90,
  () => {
    loadStatisticsOptions()
      .then(() => loadStatistics())
      .catch((error) => toast(error.message));
  },
  () => Boolean($("statsOverview")?.innerHTML),
);

// The chart geometry this page used to own (nice axis scale, mean line, peak label and
// cost tick labels) is now src/admin/static/modules/chart.js; the task-detail charts
// import it directly through the module graph.
let statisticsRequestId = 0;
export async function loadStatistics() {
  const requestId = ++statisticsRequestId;
  const metricState = state.statisticsMetrics || (state.statisticsMetrics = {});
  // Distribution legends retain the pie-legend class contract for downstream themes.
  const selectedBreakdown = $("statsBreakdown")?.value || "model";
  const trendMetric =
    metricState.trend || $("statsMetricTrend")?.value || $("statsMetric")?.value || "token";
  const targetMetric =
    metricState.target || $("statsMetricTarget")?.value || $("statsMetric")?.value || "token";
  const modelMetric =
    metricState.model || $("statsMetricModel")?.value || $("statsMetric")?.value || "token";
  const selectedGranularity = $("statsGranularity")?.value || "auto";
  const selectedTarget = $("statsTarget")?.value || "";
  const selectedModel = $("statsModel")?.value || "";
  const defaultTargetOption = `<option value="">${state.language === "en" ? "All targets" : "全部转发地址"}</option>`;
  const defaultModelOption = `<option value="">${state.language === "en" ? "All models" : "全部模型"}</option>`;
  const targetOptions = $("statsTarget")?.innerHTML || defaultTargetOption;
  const modelOptions = $("statsModel")?.innerHTML || defaultModelOption;
  if (state.language === "en") {
    $("statsTarget")?.querySelector('option[value=""]')?.replaceChildren("All targets");
    $("statsModel")?.querySelector('option[value=""]')?.replaceChildren("All models");
    $("statsGranularity")?.querySelector('option[value="day"]')?.replaceChildren("Daily");
    $("statsGranularity")?.querySelector('option[value="week"]')?.replaceChildren("Weekly");
    $("statsGranularity")?.querySelector('option[value="month"]')?.replaceChildren("Monthly");
    $("statsGranularity")?.querySelector('option[value="auto"]')?.replaceChildren("Auto");
  }
  $("statsUnpricedNote").textContent = "";
  $("statsOverview").innerHTML = `<div class="stats-loading">${
    state.language === "en" ? "Loading..." : "加载中…"
  }</div>`;
  const now = new Date();
  if ($("statsFollowNow")?.checked && $("statsTo")) $("statsTo").value = statsLocalInput(now);
  const from = $("statsFrom").value
    ? new Date($("statsFrom").value)
    : new Date(now.getTime() - 7 * 86400000);
  const to = $("statsTo").value ? new Date($("statsTo").value) : now;
  const iso = (d) => d.toISOString();
  const extra = `${$("statsTarget")?.value ? `&targetId=${encodeURIComponent($("statsTarget").value)}` : ""}${$("statsModel")?.value ? `&model=${encodeURIComponent($("statsModel").value)}` : ""}`;
  const timezoneOffset = -new Date().getTimezoneOffset();
  const overview = (metric) =>
    fetch(
      `/api/usage-statistics/overview?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}&metric=${metric}`,
    ).then(async (r) => {
      if (!r.ok)
        throw new Error(
          `${state.language === "en" ? "Statistics request failed" : "统计请求失败"} (${r.status})`,
        );
      return r.json();
    });
  const [result, targetResult, modelResult] = await Promise.all([
    overview(trendMetric),
    overview(targetMetric),
    overview(modelMetric),
  ]);
  if (requestId !== statisticsRequestId) return;
  const statisticsOptions = state.statisticsOptions || {};
  // The options endpoint may be the only source of choices (its DOM write lands
  // before these selects exist on first render), so fall back to overview rows.
  const targetSource =
    (statisticsOptions.targets?.length ? statisticsOptions.targets : undefined) ||
    targetResult.byTarget ||
    [];
  const modelSource =
    (statisticsOptions.models?.length ? statisticsOptions.models : undefined) ||
    modelResult.byModel ||
    [];
  const resolvedTargetOptions =
    targetOptions.includes("value=") && targetOptions !== defaultTargetOption
      ? targetOptions
      : defaultTargetOption +
        targetSource
          .map(
            (x) =>
              `<option value="${escapeHtml(String(x.id))}">${escapeHtml(String(x.name ?? x.id))}</option>`,
          )
          .join("");
  const resolvedModelOptions =
    modelOptions.includes("value=") && modelOptions !== defaultModelOption
      ? modelOptions
      : defaultModelOption +
        modelSource
          .map((m) => {
            const id = String(typeof m === "string" ? m : m.id);
            return `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
          })
          .join("");
  const metric = trendMetric;
  const maxVisibleCategories = 6;
  // Keep the leading categories and fold the low-share tail into one slice.
  // The selected metric determines the share, so cost charts use cost shares.
  const aggregateSmallShares = (items, displayMetric, otherLabel) => {
    const amountOf = (item) => Number(displayMetric === "cost" ? item.cost : item.value);
    const entries = items
      .map((item) => ({ item, amount: amountOf(item) }))
      .filter(({ amount }) => Number.isFinite(amount) && amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    if (entries.length <= maxVisibleCategories) return entries;
    let tailAmount = 0;
    let tailStart = entries.length;
    while (tailStart > 0 && (tailAmount + entries[tailStart - 1].amount) / total < 0.1) {
      tailAmount += entries[--tailStart].amount;
    }
    if (tailStart === entries.length) return entries;
    const tail = entries.slice(tailStart);
    const sum = (field) => tail.reduce((total, entry) => total + Number(entry.item[field] || 0), 0);
    return [
      ...entries.slice(0, tailStart),
      {
        item: {
          id: otherLabel,
          value: sum("value"),
          cost: sum("cost"),
        },
        amount: tailAmount,
      },
    ];
  };
  const pie = (items, displayMetric = metric) => {
    if (!items.length)
      return `<div class="pie-chart empty">${state.language === "en" ? "No data" : "暂无数据"}</div>`;
    const entries = aggregateSmallShares(
      items,
      displayMetric,
      state.language === "en" ? "Other" : "其他",
    );
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    if (!total)
      return `<div class="pie-chart empty">${state.language === "en" ? "No data" : "暂无数据"}</div>`;
    const colors = ["#31b981", "#f28c18", "#12b8e8", "#4679f6", "#9763d5", "#e36a91"];
    let offset = 0;
    const segments = entries.map((entry, index) => {
      const { item } = entry;
      const fraction = entry.amount / total;
      const angle = (offset + fraction / 2) * 2 * Math.PI - Math.PI / 2;
      const segment = {
        item,
        fraction,
        offset,
        angle,
        side: Math.cos(angle) >= 0 ? 1 : -1,
        color: colors[index % colors.length],
      };
      offset += fraction;
      return segment;
    });
    const rowGap = 42;
    const sideCount = Math.max(
      ...[-1, 1].map((side) => segments.filter((s) => s.side === side).length),
    );
    const height = Math.max(260, sideCount * rowGap + 40);
    const cx = 300,
      cy = height / 2,
      radius = 96,
      outerRadius = 116;
    for (const side of [-1, 1]) {
      const labels = segments
        .filter((s) => s.side === side)
        .sort((a, b) => Math.sin(a.angle) - Math.sin(b.angle));
      let previous = 4;
      for (const segment of labels) {
        segment.labelY = Math.max(previous + rowGap, cy + Math.sin(segment.angle) * 112);
        previous = segment.labelY;
      }
      let next = height - 4;
      for (const segment of [...labels].reverse()) {
        segment.labelY = Math.min(segment.labelY, next - rowGap);
        next = segment.labelY;
      }
    }
    const slices = segments
      .map((segment) => {
        const { item, fraction, angle, side, color, labelY } = segment;
        const value =
          displayMetric === "cost" ? formatCurrencyAmount(item.cost) : compactNumber(item.value);
        const percentage = `${(fraction * 100).toFixed(1)}%`;
        const name = String(item.id);
        const shortName =
          Array.from(name).length > 20 ? Array.from(name).slice(0, 19).join("") + "…" : name;
        const title = escapeHtml(`${name}: ${percentage} · ${value}`);
        // Extremely small arcs can render as a wedge at the SVG circle seam.
        // Keep their labels, but omit the sub-pixel stroke to avoid artifacts.
        const sliceWidth = fraction < 0.0005 ? 0 : 40;
        const x1 = cx + Math.cos(angle) * outerRadius,
          y1 = cy + Math.sin(angle) * outerRadius;
        const x2 = cx + side * 122,
          x3 = cx + side * 133,
          textX = cx + side * 140;
        return `<g class="pie-segment" tabindex="0" aria-label="${title}" style="--pie-color:${color}"><title>${title}</title><circle class="pie-slice" cx="${cx}" cy="${cy}" r="${radius}" pathLength="100" fill="none" stroke="${color}" stroke-width="${sliceWidth}" stroke-dasharray="${fraction * 100} ${100 - fraction * 100}" stroke-dashoffset="${-segment.offset * 100}" transform="rotate(-90 ${cx} ${cy})"/><path class="pie-connector" d="M ${x1} ${y1} L ${x2} ${labelY} L ${x3} ${labelY}"/><text x="${textX}" y="${labelY - 3}" text-anchor="${side > 0 ? "start" : "end"}" class="pie-label">${escapeHtml(shortName)}</text><text x="${textX}" y="${labelY + 15}" text-anchor="${side > 0 ? "start" : "end"}" class="pie-value">${percentage} · ${escapeHtml(value)}</text></g>`;
      })
      .join("");
    const costTotal = entries.reduce((sum, entry) => sum + Number(entry.item.cost || 0), 0);
    const centerValue =
      displayMetric === "cost" ? formatCurrencyAmount(costTotal) : compactNumber(total);
    return `<div class="pie-chart"><svg viewBox="0 0 600 ${height}" role="img" aria-label="${english ? "Distribution" : "占比分布"}">${slices}<text x="300" y="${cy - 4}" text-anchor="middle" class="pie-center-value">${escapeHtml(centerValue)}</text><text x="300" y="${cy + 16}" text-anchor="middle" class="pie-center-label">${displayMetric === "cost" ? (english ? "Priced cost" : "已计价费用") : english ? "Tokens" : "Token"}</text></svg></div>`;
  };
  const english = state.language === "en";
  const statDisplay = (key, value) =>
    key === "cost"
      ? formatCurrencyAmount(value)
      : Number(value).toLocaleString(english ? "en-US" : "zh-CN");
  const targetTitle = english ? "Target distribution" : "转发地址分布";
  const modelTitle = english ? "Model distribution" : "模型分布";
  const metricOptions = (selected) =>
    `<option value="token"${selected === "token" ? " selected" : ""}>${english ? "Tokens" : "Token"}</option><option value="cost"${selected === "cost" ? " selected" : ""}>${english ? "Cost" : "费用"}</option>`;
  const totalTokens = ["input", "output", "cache_read", "cache_write"].reduce(
    (sum, key) => sum + BigInt(String(result.totals[key] || 0)),
    0n,
  );
  const statLabels = english
    ? {
        requests: "Requests",
        tasks: "Tasks",
        input: "Input",
        output: "Output",
        cache_read: "Cache read",
        cache_write: "Cache write",
        cost: "Cost",
      }
    : {
        requests: "请求",
        tasks: "Task",
        input: "输入",
        output: "输出",
        cache_read: "缓存读",
        cache_write: "缓存写",
        cost: "费用",
      };
  const compactNumber = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (english)
      return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
    if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")} 亿`;
    if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
    return n.toLocaleString("zh-CN");
  };
  const fullNumber = (value) => Number(value).toLocaleString(english ? "en-US" : "zh-CN");
  const tokenDetails = ["input", "output", "cache_read", "cache_write"];
  const tokenTotalDisplay = compactNumber(totalTokens);
  const tokenDetailHtml = tokenDetails
    .map(
      (key) =>
        `<span><b>${statLabels[key]}</b><strong title="${fullNumber(result.totals[key] || 0)}">${compactNumber(result.totals[key] || 0)}</strong></span>`,
    )
    .join("");
  const unpricedTotal = Object.values(result.unpriced || {}).reduce((a, b) => a + Number(b), 0);
  $("statsUnpricedNote").textContent = unpricedTotal
    ? `${english ? " (" : "（"}${english ? "unpriced" : "未计价请求"} ${unpricedTotal.toLocaleString(
        english ? "en-US" : "zh-CN",
      )}${english ? ")" : "）"}`
    : "";
  const primaryStats = ["requests", "tasks"];
  $("statsOverview").innerHTML =
    primaryStats
      .map(
        (k) =>
          `<div class="stat-card stat-card-${k}" title="${escapeHtml(`${statLabels[k]}: ${statDisplay(k, result.totals[k])}`)}"><small>${statLabels[k]}</small><strong>${k === "cost" ? statDisplay(k, result.totals[k]) : compactNumber(result.totals[k])}</strong></div>`,
      )
      .join("") +
    `<div class="stat-card stat-card-tokens"><small>${english ? "Token total" : "Token 总量"}</small><div class="stat-card-token-body"><strong title="${fullNumber(totalTokens)}">${tokenTotalDisplay}</strong><div class="token-details">${tokenDetailHtml}</div></div></div>` +
    `<div class="stat-card stat-card-cost" title="${escapeHtml(`${statLabels.cost}: ${statDisplay("cost", result.totals.cost)}`)}"><small>${statLabels.cost}</small><strong>${statDisplay("cost", result.totals.cost)}</strong></div>` +
    `<div class="stat-groups"><section class="distribution-card"><div class="distribution-card-title"><h3>${targetTitle}</h3><label class="chart-control"><span>${english ? "Metric" : "指标"}</span><select id="statsMetricTarget" aria-label="${english ? "Target distribution metric" : "转发地址分布指标"}">${metricOptions(targetMetric)}</select></label></div>${pie(targetResult.byTarget, targetMetric)}</section><section class="distribution-card"><div class="distribution-card-title"><h3>${modelTitle}</h3><label class="chart-control"><span>${english ? "Metric" : "指标"}</span><select id="statsMetricModel" aria-label="${english ? "Model distribution metric" : "模型分布指标"}">${metricOptions(modelMetric)}</select></label></div>${pie(modelResult.byModel, modelMetric)}</section></div>`;
  const trend = await fetch(
    `/api/usage-statistics/trend?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(to.toISOString())}&granularity=${selectedGranularity}&timezoneOffset=${timezoneOffset}&breakdown=${selectedBreakdown}${extra}`,
  ).then(async (r) => {
    if (!r.ok)
      throw new Error(
        `${state.language === "en" ? "Trend request failed" : "趋势请求失败"} (${r.status})`,
      );
    return r.json();
  });
  if (requestId !== statisticsRequestId) return;
  const costMode = trendMetric === "cost";
  const breakdown = selectedBreakdown;
  const groupKey = breakdown === "model" ? "by_model" : breakdown === "target" ? "by_target" : null;
  const groupsFor = (point) =>
    groupKey && Array.isArray(point[groupKey]) && point[groupKey].length
      ? point[groupKey]
      : [
          {
            id: "total",
            input: point.input,
            output: point.output,
            cache_read: point.cache_read,
            cache_write: point.cache_write,
            cost: point.cost,
          },
        ];
  const colors = [
    "#2563eb",
    "#0f766e",
    "#c2410c",
    "#7c3aed",
    "#be123c",
    "#4d7c0f",
    "#a16207",
    "#0369a1",
  ];
  const tokenColor = {
    input: "#2f80ed",
    output: "#27ae60",
    cache_read: "#f2994a",
    cache_write: "#9b51e0",
  };
  const valueOf = (g) =>
    costMode
      ? Number(g.cost) / 1e9
      : Number(g.input) + Number(g.output) + Number(g.cache_read) + Number(g.cache_write);
  const trendOtherId = "__usage-statistics-other__";
  const groupLabel = (id) => (id === trendOtherId ? (english ? "Other" : "其他") : String(id));
  const groupTotals = new Map();
  if (groupKey) {
    trend.points.flatMap(groupsFor).forEach((group) => {
      const id = String(group.id);
      groupTotals.set(id, (groupTotals.get(id) || 0) + valueOf(group));
    });
  }
  const rankedGroups = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]);
  const groupedTotal = rankedGroups.reduce((sum, [, value]) => sum + value, 0);
  let smallGroupStart = rankedGroups.length;
  let smallGroupTotal = 0;
  while (
    rankedGroups.length > maxVisibleCategories &&
    smallGroupStart > 0 &&
    (smallGroupTotal + rankedGroups[smallGroupStart - 1][1]) / groupedTotal < 0.1
  ) {
    smallGroupTotal += rankedGroups[--smallGroupStart][1];
  }
  const smallGroupIds = new Set(rankedGroups.slice(smallGroupStart).map(([id]) => id));
  const displayGroupsFor = (point) => {
    const groups = groupsFor(point);
    if (!smallGroupIds.size) return groups;
    const tail = groups.filter((group) => smallGroupIds.has(String(group.id)));
    if (!tail.length) return groups;
    const sum = (field) => tail.reduce((total, group) => total + Number(group[field] || 0), 0);
    const cost = tail.reduce((total, group) => total + BigInt(String(group.cost || 0)), 0n);
    return [
      ...groups.filter((group) => !smallGroupIds.has(String(group.id))),
      {
        id: trendOtherId,
        input: sum("input"),
        output: sum("output"),
        cache_read: sum("cache_read"),
        cache_write: sum("cache_write"),
        cost: cost.toString(),
      },
    ];
  };
  const groupIds = [
    ...new Set(
      trend.points
        .flatMap(displayGroupsFor)
        .map((group) => String(group.id))
        .filter((id) => id !== "total"),
    ),
  ];
  const groupColorMap = new Map(groupIds.map((id, index) => [id, colors[index % colors.length]]));
  const groupColor = (id) => groupColorMap.get(String(id)) || colors[0];
  // A token axis never drops below one token, but a cost axis must not: the
  // old `Math.max(1, …)` floor pinned every cheap task onto a ¥1 axis, so a
  // ¥0.10 peak drew a bar one tenth of the plot height.
  const maxRequests = Math.max(
    costMode ? 1e-9 : 1,
    ...trend.points.map((point) =>
      displayGroupsFor(point).reduce((sum, group) => sum + valueOf(group), 0),
    ),
  );
  // The axis is rounded up to the first multiple of a nice tick step that
  // clears the tallest bar, not to a bare `niceCeil` of the peak.  Rounding
  // the peak itself jumps a ¥25 maximum onto a ¥50 axis, which leaves the
  // whole upper half of the chart empty the moment the metric switches to
  // cost.  Deriving the step from a fixed interval target keeps the labels
  // round while the bars keep filling the plot.
  const trendTickIntervals = 4;
  const niceCeil = (value) => {
    const exp = 10 ** Math.floor(Math.log10(Math.max(1e-9, value)));
    const f = value / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  };
  const tickStep = niceCeil(maxRequests / trendTickIntervals) || 1;
  const tickIntervals = Math.max(1, Math.ceil(maxRequests / tickStep));
  const niceMax = tickStep * tickIntervals;
  const trendTicks = Array.from({ length: tickIntervals + 1 }, (_unused, index) => ({
    fraction: index / tickIntervals,
    value: tickStep * index,
  }));
  const formatTick = (value) =>
    costMode ? pricingAmount(Math.round(value * 1e9)) : compactNumber(value);
  const tokenNames = {
    input: english ? "Input" : "输入",
    output: english ? "Output" : "输出",
    cache_read: english ? "Cache read" : "缓存读",
    cache_write: english ? "Cache write" : "缓存写",
  };
  const summary = $("statsFilterSummary");
  if (summary)
    summary.textContent = `${english ? "Showing" : "当前范围"} ${from.toLocaleString(english ? "en-US" : "zh-CN")} ${english ? "to" : "至"} ${to.toLocaleString(english ? "en-US" : "zh-CN")}`;
  const trendPoints = [...trend.points].sort((a, b) =>
    String(b.bucket).localeCompare(String(a.bucket)),
  );
  const trendBars = trend.points
    .map((point) => {
      const groups = displayGroupsFor(point);
      const metricValue = groups.reduce((sum, g) => sum + valueOf(g), 0);
      const h = Math.max(2, (metricValue / niceMax) * 200);
      const parts =
        breakdown === "total" && !costMode
          ? ["input", "output", "cache_read", "cache_write"].map((t) => ({
              key: t,
              value: Number(point[t]) || 0,
            }))
          : groups.map((g) => ({
              // Keep the group id in cost mode as well.  The value changes to
              // the group's priced cost, but the segment identity must remain
              // the model/target id so stacked breakdowns retain their colors.
              key: g.id,
              value: valueOf(g),
            }));
      const trendCost = formatCurrencyAmount(pricingDecimalFromNano(point.cost));
      const detail = `${point.bucket} | ${english ? "Requests" : "请求"} ${point.requests} | ${
        english ? "Tasks" : "Task"
      } ${point.tasks} | ${english ? "Cost" : "费用"} ${trendCost}`;
      const segments = parts
        .map((p) => {
          const color = costMode
            ? groupColor(p.key)
            : breakdown === "total"
              ? tokenColor[p.key]
              : groupColor(p.key);
          const height = p.value > 0 ? Math.max(1, (p.value / Math.max(1, metricValue)) * h) : 0;
          const label = costMode
            ? // `valueOf` is already converted from nano-CNY to CNY. Avoid
              // multiplying back to nanos: floating-point rounding can produce
              // a non-integer that the currency formatter cannot pass to BigInt.
              `${groupLabel(p.key)}: ${formatCurrencyAmount(p.value)}`
            : `${breakdown === "total" ? tokenNames[p.key] : groupLabel(p.key)}: ${compactNumber(p.value)}`;
          return `<i class="trend-segment ${costMode ? "cost" : breakdown === "total" ? p.key : "group"}" style="height:${height}px;background:${color}" title="${label}"></i>`;
        })
        .join("");
      return `<div class="trend-item"><span class="trend-bar" style="height:${h}px" title="${detail}" aria-label="${detail}">${segments}</span><small>${point.bucket}</small></div>`;
    })
    .join("");
  const trendContent = trend.points.length
    ? trendBars
    : `<div class="stats-empty">${english ? "No trend data" : "暂无趋势数据"}</div>`;
  const trendGrid = trendTicks
    .map(
      (tick) =>
        `<i class="trend-gridline${tick.fraction === 0 ? " base" : ""}" style="bottom:${22 + 200 * tick.fraction}px"></i>`,
    )
    .join("");
  const trendYaxis = `<div class="trend-yaxis" aria-hidden="true">${trendTicks
    .map(
      (tick) =>
        `<span style="bottom:${15 + 200 * tick.fraction}px">${formatTick(tick.value)}</span>`,
    )
    .join("")}</div>`;
  const headers = english
    ? [
        "Time",
        "Requests",
        "Tasks",
        "Input",
        "Output",
        "Cache read",
        "Cache write",
        "Cost",
        "Unpriced",
      ]
    : ["时间", "请求", "Task", "输入", "输出", "缓存读", "缓存写", "费用", "未计价"];
  $("statsTrend").innerHTML =
    `<section class="trend-card"><div class="trend-card-title"><h3>${english ? "Usage trend" : "使用趋势"}</h3><div class="trend-controls"><label class="chart-control"><span>${english ? "Metric" : "指标"}</span><select id="statsMetricTrend" aria-label="${english ? "Trend metric" : "趋势指标"}">${metricOptions(trendMetric)}</select></label><label class="chart-control"><span>${english ? "Granularity" : "时间粒度"}</span><select id="statsGranularity" aria-label="${english ? "Granularity" : "时间粒度"}"><option value="auto">${english ? "Auto" : "自动"}</option><option value="day">${english ? "Daily" : "按日"}</option><option value="week">${english ? "Weekly" : "按周"}</option><option value="month">${english ? "Monthly" : "按月"}</option></select></label><label class="chart-control"><span>${english ? "Target" : "转发地址"}</span><select id="statsTarget" aria-label="${english ? "Target" : "转发地址"}">${resolvedTargetOptions}</select></label><label class="chart-control"><span>${english ? "Model" : "模型"}</span><select id="statsModel" aria-label="${english ? "Model" : "模型"}">${resolvedModelOptions}</select></label><label class="chart-control"><span>${english ? "Trend grouping" : "趋势分组"}</span><select id="statsBreakdown" aria-label="${english ? "Trend grouping" : "趋势分组"}"><option value="total">${english ? "Total trend" : "总量趋势"}</option><option value="model">${english ? "By model" : "按模型叠加"}</option><option value="target">${english ? "By target" : "按转发地址叠加"}</option></select></label></div></div><div class="trend-legend">${
      breakdown === "total" && !costMode
        ? `<span><i class="input"></i>${english ? "Input" : "输入"}</span><span><i class="output"></i>${english ? "Output" : "输出"}</span><span><i class="cache_read"></i>${english ? "Cache read" : "缓存读"}</span><span><i class="cache_write"></i>${english ? "Cache write" : "缓存写"}</span>`
        : [
            ...new Map(
              trend.points.flatMap((p) =>
                displayGroupsFor(p)
                  .filter((g) => g.id !== "total")
                  .map((g) => [g.id, g]),
              ),
            ).keys(),
          ]
            .map(
              (id) =>
                `<span><i style="background:${groupColor(id)}"></i>${escapeHtml(groupLabel(id))}</span>`,
            )
            .join("")
    }</div><div class="trend-chart">${trendYaxis}<div class="trend-bars">${trendGrid}${trendContent}</div></div><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${trendPoints.map((p) => `<tr><td>${p.bucket}</td><td>${p.requests}</td><td>${p.tasks}</td><td title="${fullNumber(p.input)}">${compactNumber(p.input)}</td><td title="${fullNumber(p.output)}">${compactNumber(p.output)}</td><td title="${fullNumber(p.cache_read)}">${compactNumber(p.cache_read)}</td><td title="${fullNumber(p.cache_write)}">${compactNumber(p.cache_write)}</td><td>${formatCurrencyAmount(pricingDecimalFromNano(p.cost))}</td><td>${p.unpriced ?? 0}</td></tr>`).join("")}</tbody></table></section>`;
  $("statsBreakdown").value = breakdown;
  $("statsTarget").value = selectedTarget;
  $("statsModel").value = selectedModel;
  $("statsGranularity").value = selectedGranularity;
  $("statsMetricTrend")?.addEventListener("change", (event) => {
    metricState.trend = asElement(event.target).value;
    loadStatistics().catch(showStatisticsError);
  });
  $("statsMetricTarget")?.addEventListener("change", (event) => {
    metricState.target = asElement(event.target).value;
    loadStatistics().catch(showStatisticsError);
  });
  $("statsMetricModel")?.addEventListener("change", (event) => {
    metricState.model = asElement(event.target).value;
    loadStatistics().catch(showStatisticsError);
  });
  $("statsTarget")?.addEventListener("change", () => loadStatistics().catch(showStatisticsError));
  $("statsModel")?.addEventListener("change", () => loadStatistics().catch(showStatisticsError));
  $("statsGranularity")?.addEventListener("change", () =>
    loadStatistics().catch(showStatisticsError),
  );
  $("statsBreakdown")?.addEventListener("change", () =>
    loadStatistics().catch(showStatisticsError),
  );
}
function showStatisticsError(error) {
  $("statsOverview").innerHTML =
    `<div class="stats-error">${error.message} <button id="retryStatistics">${
      state.language === "en" ? "Retry" : "重试"
    }</button></div>`;
  $("retryStatistics")?.addEventListener("click", () =>
    loadStatistics().catch(showStatisticsError),
  );
  toast(error.message);
}
export async function loadStatisticsOptions() {
  const to = $("statsTo")?.value ? new Date($("statsTo").value) : new Date();
  const from = $("statsFrom")?.value
    ? new Date($("statsFrom").value)
    : new Date(to.getTime() - 7 * 86400000);
  const localInput = (value) => {
    const d = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  if ($("statsFrom") && !$("statsFrom").value) $("statsFrom").value = localInput(from);
  if ($("statsTo") && !$("statsTo").value) $("statsTo").value = localInput(to);
  const targetParam = $("statsTarget")?.value
    ? `&targetId=${encodeURIComponent($("statsTarget").value)}`
    : "";
  const data = await fetch(
    `/api/usage-statistics/options?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${targetParam}`,
  ).then((r) => r.json());
  state.statisticsOptions = data;
  const selectedTarget = $("statsTarget")?.value || "";
  const selectedModel = $("statsModel")?.value || "";
  if ($("statsTarget"))
    $("statsTarget").innerHTML =
      `<option value="">${state.language === "en" ? "All targets" : "全部转发地址"}</option>` +
      data.targets.map((x) => `<option value="${x.id}">${x.name}</option>`).join("");
  if ($("statsModel"))
    $("statsModel").innerHTML =
      `<option value="">${state.language === "en" ? "All models" : "全部模型"}</option>` +
      data.models.map((x) => `<option value="${x}">${x}</option>`).join("");
  if ($("statsTarget")?.querySelector(`option[value="${CSS.escape(selectedTarget)}"]`))
    $("statsTarget").value = selectedTarget;
  if ($("statsModel")?.querySelector(`option[value="${CSS.escape(selectedModel)}"]`))
    $("statsModel").value = selectedModel;
}
function statsLocalInput(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/**
 * Attaches the listeners of the page-level controls (refresh, quick ranges, follow-now,
 * export, apply/reset filters, the two time inputs). The controls the render itself emits
 * re-bind at the end of every render, because they are replaced along with it.
 * @returns {void}
 */
export function mountStatistics() {
  $("refreshStatistics")?.addEventListener("click", () =>
    loadStatistics().catch(showStatisticsError),
  );
  qsa("[data-stats-range]").forEach((button) =>
    button.addEventListener("click", () => {
      const days = Number(button.dataset.statsRange || 7);
      const to = new Date();
      const from =
        days === 0
          ? new Date(to.getFullYear(), to.getMonth(), to.getDate())
          : new Date(to.getTime() - days * 86400000);
      $("statsFrom").value = statsLocalInput(from);
      $("statsTo").value = statsLocalInput(to);
      qsa("[data-stats-range]").forEach((item) => item.classList.toggle("active", item === button));
      loadStatisticsOptions()
        .then(() => loadStatistics())
        .catch(showStatisticsError);
    }),
  );
  $("statsFollowNow")?.addEventListener("change", () => {
    if ($("statsFollowNow").checked) {
      $("statsTo").value = statsLocalInput(new Date());
      loadStatistics().catch(showStatisticsError);
    }
  });
  $("exportStatistics")?.addEventListener("click", () => {
    const now = new Date();
    const from = $("statsFrom").value
      ? new Date($("statsFrom").value)
      : new Date(now.getTime() - 7 * 86400000);
    const to = $("statsTo").value ? new Date($("statsTo").value) : now;
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity: $("statsGranularity")?.value || "day",
      timezoneOffset: String(-new Date().getTimezoneOffset()),
    });
    if ($("statsTarget")?.value) params.set("targetId", $("statsTarget").value);
    if ($("statsModel")?.value) params.set("model", $("statsModel").value);
    window.open(`/api/usage-statistics/export?${params.toString()}`, "_blank");
  });
  $("statsMetric")?.addEventListener("change", () =>
    loadStatistics().catch((e) => toast(e.message)),
  );
  $("statsTarget")?.addEventListener("change", () =>
    loadStatisticsOptions()
      .then(() => loadStatistics())
      .catch(showStatisticsError),
  );
  $("statsModel")?.addEventListener("change", () =>
    loadStatistics().catch((e) => toast(e.message)),
  );
  $("statsGranularity")?.addEventListener("change", () =>
    loadStatistics().catch((e) => toast(e.message)),
  );
  $("statsBreakdown")?.addEventListener("change", () =>
    loadStatistics().catch((e) => toast(e.message)),
  );
  $("applyStatsFilters")?.addEventListener("click", () => {
    loadStatisticsOptions()
      .then(() => loadStatistics())
      .catch(showStatisticsError);
  });
  $("resetStatsFilters")?.addEventListener("click", () => {
    const now = new Date();
    $("statsFrom").value = statsLocalInput(new Date(now.getTime() - 7 * 86400000));
    $("statsTo").value = statsLocalInput(now);
    $("statsMetricTrend") && ($("statsMetricTrend").value = "token");
    $("statsMetricTarget") && ($("statsMetricTarget").value = "token");
    $("statsMetricModel") && ($("statsMetricModel").value = "token");
    $("statsGranularity") && ($("statsGranularity").value = "auto");
    $("statsBreakdown") && ($("statsBreakdown").value = "model");
    $("statsTarget") && ($("statsTarget").value = "");
    $("statsModel") && ($("statsModel").value = "");
    state.statisticsMetrics = { trend: "token", target: "token", model: "token" };
    qsa("[data-stats-range]").forEach((item) =>
      item.classList.toggle("active", item.dataset.statsRange === "7"),
    );
    loadStatisticsOptions()
      .then(() => loadStatistics())
      .catch(showStatisticsError);
  });
  $("statsFrom")?.addEventListener("change", () => {
    loadStatisticsOptions().catch((e) => toast(e.message));
    loadStatistics().catch((e) => toast(e.message));
  });
  $("statsTo")?.addEventListener("change", () => {
    loadStatisticsOptions().catch((e) => toast(e.message));
    loadStatistics().catch((e) => toast(e.message));
  });
}
