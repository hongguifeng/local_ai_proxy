import { optionalTyped } from "./dom.js";
// LLM Proxy admin UI -- task detail panel: pricing summary, breakdown table, trend charts, task brief.
// ES module: imports the shared bootstrap (./core.js), the display helpers and the chart
// geometry; the history list opens this panel and refreshes it.

import {
  $,
  api,
  closestFrom,
  parentOf,
  qsa,
  qsOn,
  registerLanguagePanel,
  state,
  t,
  toast,
} from "./core.js";
import { chartMeanLine, chartPeakLabel, costAxisLabel, niceAxisScale } from "./chart.js";
import { formatCurrencyAmount, formatGroupCost, pricingAmount } from "./money.js";
import {
  compactNumber,
  formatDecodeSpeed,
  formatIntegerValue,
  formatTokenCount,
  fullNumber,
  pricingDecimalFromNano,
} from "./numbers.js";
import { escapeHtml } from "./text.js";
import { displayTimestampParts, formatDuration } from "./time.js";

// Redraw on language change. The sequence mirrors the order the switch used to
// call these in by hand; see registerLanguagePanel in ./core.js.
registerLanguagePanel("requestPricing", 50, () => renderRequestPricing());
registerLanguagePanel("taskPricing", 60, () => renderTaskPricingPanel());

function pricingBucketAmount(tokens, price) {
  if (tokens === null || tokens === undefined || price === null || price === undefined) return "—";
  const [whole = "0", fraction = ""] = String(price).split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,12}$/.test(fraction)) return "—";
  const priceUnits =
    BigInt(whole) * 1_000_000_000_000n + BigInt((fraction + "000000000000").slice(0, 12));
  const product = BigInt(String(tokens)) * priceUnits;
  const integer = product / 1_000_000_000_000_000_000n;
  const decimal = (product % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return decimal ? `${integer}.${decimal}` : integer.toString();
}
function pricingPercentage(amount, totalAmount) {
  const decimalParts = (value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? ""));
    return match ? { whole: match[1], fraction: match[2] || "" } : null;
  };
  const numerator = decimalParts(amount);
  const denominator = decimalParts(totalAmount);
  if (!numerator || !denominator) return "—";
  const scale = Math.max(numerator.fraction.length, denominator.fraction.length);
  const toScaledInteger = ({ whole, fraction }) => BigInt(whole + fraction.padEnd(scale, "0"));
  const total = toScaledInteger(denominator);
  if (total === 0n) return "—";
  const ratio = (toScaledInteger(numerator) * 10_000n + total / 2n) / total;
  const whole = ratio / 100n;
  const fraction = (ratio % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}
function pricingPercentNumber(amount, totalAmount) {
  const decimalParts = (value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? ""));
    return match ? { whole: match[1], fraction: match[2] || "" } : null;
  };
  const n = decimalParts(amount);
  const d = decimalParts(totalAmount);
  if (!n || !d) return null;
  const scale = Math.max(n.fraction.length, d.fraction.length);
  const toScaled = ({ whole, fraction }) => BigInt(whole + fraction.padEnd(scale, "0"));
  const den = toScaled(d);
  if (den === 0n) return null;
  return (Number(toScaled(n)) / Number(den)) * 100;
}
/** @param {unknown} amount @param {unknown} totalAmount @param {string | null} [kind] */
function shareCellHtml(amount, totalAmount, kind = null) {
  const pct = pricingPercentNumber(amount, totalAmount);
  // The bar inherits the metric's semantic color (teal token shares, green
  // cost shares) instead of always green, matching the chart colors.
  const barClass = kind === "tokens" ? "share-bar share-bar-tokens" : "share-bar share-bar-cost";
  const bar =
    pct === null
      ? ""
      : `<span class="${barClass}"><span class="share-bar-fill" style="width:${Math.max(
          0,
          Math.min(100, pct),
        ).toFixed(2)}%"></span></span>`;
  return `<td class="share-cell"><span class="share-value">${escapeHtml(
    pricingPercentage(amount, totalAmount),
  )}</span>${bar}</td>`;
}
function pricingStatusValue(pricing) {
  if (!pricing || pricing.pricing_status === "unpriced") return "—";
  if (pricing.pricing_status === "pending") return t("calculating");
  return pricingAmount(pricing.cost_nano_cny);
}
const pricingBuckets = [
  ["inputUncachedTokens", "input_per_million", "inputUncached"],
  ["outputTokens", "output_per_million", "output"],
  ["cacheReadTokens", "cache_read_per_million", "cacheRead"],
  ["cacheWriteTokens", "cache_write_per_million", "cacheWrite"],
];
function pricingUsageTotalTokens(breakdown) {
  return pricingBuckets.reduce((sum, [usageKey]) => {
    const value = Number(breakdown?.[usageKey]?.tokens ?? 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}
/** @param {unknown} breakdown @param {Record<string, string> | null} [price] @param {string | null} [totalAmount] */
function pricingTableHtml(breakdown, price = null, totalAmount = null) {
  const rows = pricingBuckets
    .map(([usageKey, priceKey, label]) => {
      const bucket = breakdown?.[usageKey] || breakdown?.[usageKey.replace("Tokens", "")] || {};
      const tokens = bucket.tokens ?? breakdown?.[usageKey] ?? "—";
      const amount = bucket.amount ?? "—";
      return `<tr><th>${escapeHtml(t(label))}</th><td>${escapeHtml(formatIntegerValue(tokens))}</td><td>${escapeHtml(price?.[priceKey] ?? "—")}</td><td>${escapeHtml(typeof amount === "string" ? formatCurrencyAmount(amount) : String(amount))}</td>${shareCellHtml(amount, totalAmount, "cost")}</tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table class="pricing-table"><thead><tr><th></th><th>${escapeHtml(t("tokensBilled"))}</th><th>${escapeHtml(t("pricePerMillion"))}</th><th>${escapeHtml(t("amountCny"))}</th><th>${escapeHtml(t("costShare"))}</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>${escapeHtml(t("total"))}</th><td>${escapeHtml(formatIntegerValue(pricingUsageTotalTokens(breakdown)))}</td><td></td><td>${escapeHtml(formatCurrencyAmount(totalAmount))}</td><td></td></tr></tfoot></table></div>`;
}
export function renderRequestPricing() {
  const el = $("responsePricing");
  const pricing = state.requestPricing;
  const open = Boolean(pricing && state.requestPricingOpen);
  el.hidden = !open;
  updateRequestPricingButton();
  if (!open || !pricing) {
    el.innerHTML = "";
    return;
  }
  const snapshot = pricing.pricing_snapshot || {};
  const usage = pricing.usage || {};
  const reason = pricing.pricing_reason;
  const breakdown = Object.fromEntries(
    pricingBuckets.map(([usageKey, priceKey]) => [
      usageKey,
      {
        tokens: usage[usageKey] ?? "—",
        amount: pricingBucketAmount(usage[usageKey], snapshot[priceKey]),
        price: snapshot[priceKey] ?? "—",
      },
    ]),
  );
  el.hidden = false;
  el.innerHTML = `<section class="pricing-card"><div class="pricing-card-head"><strong>${escapeHtml(t("costEstimate"))}</strong><strong>${escapeHtml(pricingStatusValue(pricing))}</strong></div>
    <dl class="pricing-facts"><dt>${escapeHtml(t("billingModel"))}</dt><dd>${escapeHtml(pricing.billing_model || "—")}</dd><dt>${escapeHtml(t("matchedRule"))}</dt><dd>${escapeHtml(snapshot.model_pattern || "—")}</dd><dt>${escapeHtml(t("priceSource"))}</dt><dd>${escapeHtml(snapshot.target_name || "—")}</dd><dt>${escapeHtml(t("pricingUsage"))}</dt><dd>${escapeHtml(usage.source || "—")}</dd>${reason ? `<dt>${escapeHtml(t("pricingReason"))}</dt><dd>${escapeHtml(reason)}</dd>` : ""}</dl>
    ${pricing.pricing_status === "priced" ? pricingTableHtml(breakdown, snapshot, pricingDecimalFromNano(pricing.cost_nano_cny)) : ""}</section>`;
}
function taskBreakdownTotalTokens(breakdown) {
  return ["input_uncached", "output", "cache_read", "cache_write"].reduce((sum, key) => {
    const value = Number(breakdown?.[key]?.tokens ?? 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}
/** @param {unknown} breakdown @param {string | null} totalAmount @param {Record<string, string> | null} [price] */
function taskBreakdownTableHtml(breakdown, totalAmount, price = null) {
  const priceHeader = price ? `<th>${escapeHtml(t("pricePerMillion"))}</th>` : "";
  const priceCell = (value) =>
    price
      ? `<td>${escapeHtml(value === null || value === undefined ? "—" : String(value))}</td>`
      : "";
  const totalTokens = taskBreakdownTotalTokens(breakdown);
  const rows = [
    ["input_uncached", "inputUncached", "input_per_million"],
    ["output", "output", "output_per_million"],
    ["cache_read", "cacheRead", "cache_read_per_million"],
    ["cache_write", "cacheWrite", "cache_write_per_million"],
  ]
    .map(([key, label, priceKey]) => {
      const bucket = breakdown?.[key] || {};
      return `<tr><th>${escapeHtml(t(label))}</th><td>${escapeHtml(formatIntegerValue(bucket.tokens ?? 0))}</td>${shareCellHtml(bucket.tokens ?? 0, totalTokens, "tokens")}${priceCell(price?.[priceKey])}<td>${escapeHtml(formatCurrencyAmount(bucket.amount ?? null))}</td>${shareCellHtml(bucket.amount, totalAmount, "cost")}</tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table class="pricing-table task-breakdown"><thead><tr><th></th><th>${escapeHtml(t("tokensBilled"))}</th><th>${escapeHtml(t("tokenShare"))}</th>${priceHeader}<th>${escapeHtml(t("amountCny"))}</th><th>${escapeHtml(t("costShare"))}</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>${escapeHtml(t("total"))}</th><td>${escapeHtml(formatIntegerValue(totalTokens))}</td><td></td>${price ? "<td></td>" : ""}<td>${escapeHtml(formatCurrencyAmount(totalAmount))}</td><td></td></tr></tfoot></table></div>`;
}
// Raw SVG line chart for the task-detail token trend: x = request sequence,
// y = total tokens (request + response) of each finished request. Requests
// whose token counts are still unknown are skipped, so the x positions can be
// non-contiguous; the axis always shows the real sequence numbers.
function taskTokenChartHtml(points) {
  const known = (points || []).filter(
    (point) => point?.total_tokens !== null && Number(point.total_tokens) >= 0,
  );
  const english = state.language === "en";
  if (known.length === 0)
    return `<div class="token-chart-empty">${escapeHtml(t("tokenTrendNoData"))}</div>`;
  const width = 728,
    height = 190,
    padTop = 14,
    padRight = 14,
    padBottom = 26,
    padLeft = 56;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxSequence = Math.max(...known.map((point) => Number(point.sequence)));
  const minSequence = Math.min(...known.map((point) => Number(point.sequence)));
  const maxTokens = Math.max(...known.map((point) => Number(point.total_tokens)));
  const { step: niceStep, axisMax } = niceAxisScale(maxTokens);
  const xFor = (sequence) =>
    maxSequence === minSequence
      ? padLeft + plotWidth / 2
      : padLeft + ((Number(sequence) - minSequence) / (maxSequence - minSequence)) * plotWidth;
  const yFor = (tokens) => padTop + (1 - Number(tokens) / axisMax) * plotHeight;
  const gridLines = [];
  for (let value = 0; value <= axisMax; value += niceStep) {
    const y = yFor(value);
    gridLines.push(
      `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="token-chart-grid"/><text x="${padLeft - 8}" y="${y + 4}" text-anchor="end" class="token-chart-tick">${compactNumber(value)}</text>`,
    );
  }
  const labelCount = Math.min(8, known.length, maxSequence - minSequence + 1);
  const labelSteps = labelCount <= 1 ? [0] : Array.from({ length: labelCount }, (_, i) => i);
  const xLabels = labelSteps
    .map((i) => {
      const index = Math.round((i * (known.length - 1)) / (labelCount - 1 || 1));
      const point = known[index];
      return `<text x="${xFor(point.sequence)}" y="${height - 8}" text-anchor="middle" class="token-chart-tick">${Number(point.sequence)}</text>`;
    })
    .join("");
  const area =
    known.length >= 2
      ? `<polygon class="token-chart-area" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(point.total_tokens)}`)
          .join(
            " ",
          )} ${xFor(known.at(-1).sequence)},${padTop + plotHeight} ${xFor(known[0].sequence)},${padTop + plotHeight}"/>`
      : "";
  const line =
    known.length >= 2
      ? `<polyline class="token-chart-line" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(point.total_tokens)}`)
          .join(" ")}"/>`
      : "";
  const dots = known
    .map((point) => {
      const x = xFor(point.sequence);
      const y = yFor(point.total_tokens);
      const title = escapeHtml(
        `${english ? "Request" : "请求"} #${Number(point.sequence)}: ${fullNumber(point.total_tokens)} ${t("tokens")}`,
      );
      return `<circle class="token-chart-dot" cx="${x}" cy="${y}" r="3.5"><title>${title}</title></circle>`;
    })
    .join("");
  const peak = known.reduce(
    (best, point) => (Number(point.total_tokens) > Number(best.total_tokens) ? point : best),
    known[0],
  );
  const peakLabel = chartPeakLabel(
    xFor(peak.sequence),
    yFor(peak.total_tokens),
    escapeHtml(fullNumber(peak.total_tokens)),
    width,
    padRight,
  );
  return `<div class="token-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("tokenTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}${peakLabel}</svg></div>`;
}
// Raw SVG line chart for the task-detail cost trend: x = request sequence,
// y = that request's own cost (yuan). Only priced requests appear, so the x
// positions can be non-contiguous; the axis always shows the real sequence
// numbers.
function taskCostChartHtml(points) {
  const known = (points || []).filter(
    (point) => point?.cost_nano_cny !== null && point?.cost_nano_cny !== "",
  );
  const english = state.language === "en";
  if (known.length === 0)
    return `<div class="cost-chart-empty">${escapeHtml(t("costTrendNoData"))}</div>`;
  const width = 728,
    height = 190,
    padTop = 14,
    padRight = 14,
    padBottom = 26,
    padLeft = 56;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const valueFor = (point) => Number(point.cost_nano_cny) / 1e9;
  const values = known.map(valueFor);
  // The per-request mean as an exact BigInt division in nano-CNY, so the
  // label is not affected by floating-point drift in the sum of yuan doubles
  // (0.01425 would otherwise round to $0.0142).
  const meanNano =
    values.length >= 2
      ? known.reduce((sum, point) => sum + BigInt(String(point.cost_nano_cny)), 0n) /
        BigInt(known.length)
      : 0n;
  const meanCost = Number(meanNano) / 1e9;
  const maxSequence = Math.max(...known.map((point) => Number(point.sequence)));
  const minSequence = Math.min(...known.map((point) => Number(point.sequence)));
  const { step: niceStep, axisMax } = niceAxisScale(Math.max(...values));
  const xFor = (sequence) =>
    maxSequence === minSequence
      ? padLeft + plotWidth / 2
      : padLeft + ((Number(sequence) - minSequence) / (maxSequence - minSequence)) * plotWidth;
  const yFor = (cost) => padTop + (1 - Number(cost) / axisMax) * plotHeight;
  const gridLines = [];
  for (let value = 0; value <= axisMax; value += niceStep) {
    const y = yFor(value);
    gridLines.push(
      `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="token-chart-grid"/><text x="${padLeft - 8}" y="${y + 4}" text-anchor="end" class="token-chart-tick">${costAxisLabel(value)}</text>`,
    );
  }
  const labelCount = Math.min(8, known.length, maxSequence - minSequence + 1);
  const labelSteps = labelCount <= 1 ? [0] : Array.from({ length: labelCount }, (_, i) => i);
  const xLabels = labelSteps
    .map((i) => {
      const index = Math.round((i * (known.length - 1)) / (labelCount - 1 || 1));
      const point = known[index];
      return `<text x="${xFor(point.sequence)}" y="${height - 8}" text-anchor="middle" class="token-chart-tick">${Number(point.sequence)}</text>`;
    })
    .join("");
  const area =
    known.length >= 2
      ? `<polygon class="token-chart-area" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(valueFor(point))}`)
          .join(
            " ",
          )} ${xFor(known.at(-1).sequence)},${padTop + plotHeight} ${xFor(known[0].sequence)},${padTop + plotHeight}"/>`
      : "";
  const line =
    known.length >= 2
      ? `<polyline class="token-chart-line" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(valueFor(point))}`)
          .join(" ")}"/>`
      : "";
  const dots = known
    .map((point) => {
      const x = xFor(point.sequence);
      const y = yFor(valueFor(point));
      const title = escapeHtml(
        `${english ? "Request" : "请求"} #${Number(point.sequence)}: ${formatCurrencyAmount(
          pricingDecimalFromNano(point.cost_nano_cny),
        )}`,
      );
      return `<circle class="token-chart-dot" cx="${x}" cy="${y}" r="3.5"><title>${title}</title></circle>`;
    })
    .join("");
  const peak = known.reduce(
    (best, point) => (Number(point.cost_nano_cny) > Number(best.cost_nano_cny) ? point : best),
    known[0],
  );
  const peakLabel = chartPeakLabel(
    xFor(peak.sequence),
    yFor(valueFor(peak)),
    escapeHtml(formatCurrencyAmount(pricingDecimalFromNano(peak.cost_nano_cny))),
    width,
    padRight,
  );
  const meanLine = chartMeanLine(
    yFor,
    meanCost,
    escapeHtml(`${t("trendAvgPrefix")} ${formatCurrencyAmount(pricingDecimalFromNano(meanNano))}`),
    padTop,
    padLeft,
    padRight,
    plotHeight,
    width,
  );
  return `<div class="cost-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("costTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}${meanLine}${peakLabel}</svg></div>`;
}
// Raw SVG line chart for the task-detail token output trend: x = request
// sequence, y = this request's own output (response) tokens. Requests whose
// output token count is still unknown are not shown, so the x positions can
// be non-contiguous; the axis always shows the real sequence numbers.
function taskOutputTokenChartHtml(points) {
  const known = (points || []).filter(
    (point) => point?.output_tokens !== null && point?.output_tokens !== undefined,
  );
  const english = state.language === "en";
  if (known.length === 0)
    return `<div class="output-token-chart-empty">${escapeHtml(t("outputTokenTrendNoData"))}</div>`;
  const width = 728,
    height = 190,
    padTop = 14,
    padRight = 14,
    padBottom = 26,
    padLeft = 56;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxSequence = Math.max(...known.map((point) => Number(point.sequence)));
  const minSequence = Math.min(...known.map((point) => Number(point.sequence)));
  const values = known.map((point) => Number(point.output_tokens));
  const meanOutput = values.length >= 2 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const { step: niceStep, axisMax } = niceAxisScale(Math.max(...values));
  const xFor = (sequence) =>
    maxSequence === minSequence
      ? padLeft + plotWidth / 2
      : padLeft + ((Number(sequence) - minSequence) / (maxSequence - minSequence)) * plotWidth;
  const yFor = (tokens) => padTop + (1 - Number(tokens) / axisMax) * plotHeight;
  const gridLines = [];
  for (let value = 0; value <= axisMax; value += niceStep) {
    const y = yFor(value);
    gridLines.push(
      `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="token-chart-grid"/><text x="${padLeft - 8}" y="${y + 4}" text-anchor="end" class="token-chart-tick">${compactNumber(value)}</text>`,
    );
  }
  const labelCount = Math.min(8, known.length, maxSequence - minSequence + 1);
  const labelSteps = labelCount <= 1 ? [0] : Array.from({ length: labelCount }, (_, i) => i);
  const xLabels = labelSteps
    .map((i) => {
      const index = Math.round((i * (known.length - 1)) / (labelCount - 1 || 1));
      const point = known[index];
      return `<text x="${xFor(point.sequence)}" y="${height - 8}" text-anchor="middle" class="token-chart-tick">${Number(point.sequence)}</text>`;
    })
    .join("");
  const area =
    known.length >= 2
      ? `<polygon class="token-chart-area" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(point.output_tokens)}`)
          .join(
            " ",
          )} ${xFor(known.at(-1).sequence)},${padTop + plotHeight} ${xFor(known[0].sequence)},${padTop + plotHeight}"/>`
      : "";
  const line =
    known.length >= 2
      ? `<polyline class="token-chart-line" points="${known
          .map((point) => `${xFor(point.sequence)},${yFor(point.output_tokens)}`)
          .join(" ")}"/>`
      : "";
  const dots = known
    .map((point) => {
      const x = xFor(point.sequence);
      const y = yFor(point.output_tokens);
      const title = escapeHtml(
        `${english ? "Request" : "请求"} #${Number(point.sequence)}: ${fullNumber(
          point.output_tokens,
        )} ${english ? " output tokens" : " 个输出 token"}`,
      );
      return `<circle class="token-chart-dot" cx="${x}" cy="${y}" r="3.5"><title>${title}</title></circle>`;
    })
    .join("");
  const peak = known.reduce(
    (best, point) => (Number(point.output_tokens) > Number(best.output_tokens) ? point : best),
    known[0],
  );
  const peakLabel = chartPeakLabel(
    xFor(peak.sequence),
    yFor(peak.output_tokens),
    escapeHtml(fullNumber(peak.output_tokens)),
    width,
    padRight,
  );
  const meanLine = chartMeanLine(
    yFor,
    meanOutput,
    escapeHtml(`${t("trendAvgPrefix")} ${fullNumber(Math.round(meanOutput))}`),
    padTop,
    padLeft,
    padRight,
    plotHeight,
    width,
  );
  return `<div class="output-token-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("outputTokenTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}${meanLine}${peakLabel}</svg></div>`;
}
const pricingGroupOpenStorageKey = "llmProxyPricingGroupOpen";
export function loadPricingGroupOpenState() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(pricingGroupOpenStorageKey) || "{}");
  } catch {
    parsed = null;
  }
  state.pricingGroupOpen = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    Object.entries(parsed).forEach(([groupId, models]) => {
      if (!models || typeof models !== "object" || Array.isArray(models)) return;
      state.pricingGroupOpen[groupId] = Object.fromEntries(
        Object.keys(models)
          .filter((model) => Boolean(models[model]))
          .map((model) => [model, true]),
      );
    });
  }
}
function savePricingGroupOpenState() {
  localStorage.setItem(pricingGroupOpenStorageKey, JSON.stringify(state.pricingGroupOpen));
}
// Shrink task-summary values one pixel at a time until they fit on one
// The model card value wraps at narrow widths; shrink it (to a 12px floor)
// before it wraps more than necessary, keeping the summary rows compact.
// Wrapping remains the last-resort fallback.
function fitTaskSummaryValues(root) {
  const model = qsOn(root, ".task-stat-model > strong");
  if (!model) return;
  let fs = parseFloat(getComputedStyle(model).fontSize);
  while (fs > 12) {
    const lh = parseFloat(getComputedStyle(model).lineHeight) || fs * 1.35;
    if (model.scrollHeight <= lh * 1.5) break;
    fs -= 1;
    model.style.fontSize = `${fs}px`;
  }
}
// Stacked start/end time range for the task-detail time bar: each time row
// carries its own left label (“Start time” / “End time”), so the range reads
// as an upper (start) and a lower (end) row; the two date badges stack in
// the middle column and the two times stack on the right.
function taskTimeRangeHtml(group) {
  const start = displayTimestampParts(group.started_at);
  const end = displayTimestampParts(group.last_activity_at);
  if (!start.time && !end.time && !(start.date && end.date)) {
    return `<span class="log-group-time-fallback">${escapeHtml(group.id || t("task"))}</span>`;
  }
  // Each time row has its own label (start / end) instead of one shared header.
  // Both date badges always render, even for same-day ranges, so the two time
  // values stay in the same column.
  const showStart = Boolean(start.time || start.date);
  const showEnd = Boolean(end.time || end.date);
  const badge = (parts, cls) =>
    parts.date ? `<span class="log-group-date ${cls}">${escapeHtml(parts.shortDate)}</span>` : "";
  const inner = [
    `<small class="task-time-range-label">${t("startTime")}</small>`,
    showStart ? badge(start, "task-time-date-start") : "",
    showStart && start.time ? `<span class="task-time-start">${escapeHtml(start.time)}</span>` : "",
    `<small class="task-time-range-label task-time-range-label-end">${t("endTime")}</small>`,
    showEnd ? badge(end, "task-time-date-end") : "",
    showEnd && end.time ? `<span class="task-time-end">${escapeHtml(end.time)}</span>` : "",
  ].join("");
  return `<span class="log-group-time" title="${escapeHtml(
    [group.started_at, group.last_activity_at].filter(Boolean).join(" - "),
  )}"><span class="task-time-range">${inner}</span></span>`;
}
// The task-detail summary card mirrors the left list facts (model, time range,
// request count, average decode speed). Both places read the same group
// summary, so mirror the freshest list entry into the panel on every refresh
// instead of freezing one snapshot when the panel opens: the counters of a task
// that is still running then keep moving while the panel stays open. A group
// that is not part of the current page (search / pagination) keeps the last
// known values. Returns true when something changed, so the caller can skip a
// redundant re-render.
function syncActiveTaskGroup(groupId) {
  const group = state.logGroups.find((item) => item.id === groupId);
  if (!group) return false;
  const next = {
    id: groupId,
    started_at: group.started_at ?? null,
    last_activity_at: group.last_activity_at ?? null,
    model: group.model ?? null,
    request_count: group.request_count ?? null,
    decode_speed_tps: group.decode_speed_tps ?? undefined,
  };
  const previous = state.activeTaskGroup;
  if (previous && sameTaskGroupSnapshot(previous, next)) return false;
  state.activeTaskGroup = next;
  return true;
}
function sameTaskGroupSnapshot(a, b) {
  return (
    a.id === b.id &&
    a.started_at === b.started_at &&
    a.last_activity_at === b.last_activity_at &&
    a.model === b.model &&
    a.request_count === b.request_count &&
    a.decode_speed_tps === b.decode_speed_tps
  );
}
// The task-brief card: a free-form paragraph the summary model writes for the
// whole task, generated only when the user asks for it (the model call costs
// money, so nothing is generated on panel open).
/**
 * Labels for the environment facts the brief model extracts. Known keys are
 * localized; anything else the model returned is shown under its own name.
 */
const taskBriefFactLabels = {
  zh: {
    agent: "客户端",
    cwd: "工作目录",
    git_branch: "分支",
    os: "系统",
    shell: "Shell",
    terminal: "终端",
    platform: "平台",
    container: "容器",
    remote: "远程主机",
    workspace: "工作区",
    project: "项目",
    repo: "仓库",
    model: "模型",
  },
  en: {
    agent: "Client",
    cwd: "Working dir",
    git_branch: "Branch",
    os: "OS",
    shell: "Shell",
    terminal: "Terminal",
    platform: "Platform",
    container: "Container",
    remote: "Remote host",
    workspace: "Workspace",
    project: "Project",
    repo: "Repo",
    model: "Model",
  },
};
function taskBriefFactsHtml(context) {
  const entries = Object.entries(context || {});
  if (entries.length === 0) return "";
  const labels = taskBriefFactLabels[state.language] || taskBriefFactLabels.zh;
  return `<div class="task-brief-facts">${entries
    .map(
      ([key, value]) =>
        `<span class="task-brief-fact"><span class="task-brief-fact-key">${escapeHtml(
          labels[key] || key,
        )}</span><span class="task-brief-fact-value">${escapeHtml(String(value))}</span></span>`,
    )
    .join("")}</div>`;
}
function taskBriefCardHtml(groupId, taskBrief = state.taskBrief) {
  const brief = taskBrief && taskBrief.id === groupId ? taskBrief : null;
  const data = brief ? brief.data : null;
  const text = data ? String(data.text || "") : "";
  const facts = data ? taskBriefFactsHtml(data.context) : "";
  const meta = data
    ? `<p class="task-brief-meta">${[
        data.model ? escapeHtml(String(data.model)) : "",
        data.generated_at ? escapeHtml(formatBriefTime(String(data.generated_at))) : "",
      ]
        .filter((item) => item !== "")
        .join(" · ")}</p>`
    : "";
  const button =
    brief && brief.loading
      ? `<button type="button" data-generate-brief disabled>${escapeHtml(t("taskBriefGenerating"))}</button>`
      : `<button type="button" data-generate-brief>${escapeHtml(
          text ? t("regenerate") : t("taskBriefGenerate"),
        )}</button>`;
  const body =
    brief && brief.loading
      ? `<p class="task-brief-text">${escapeHtml(t("loading"))}</p>`
      : brief && brief.error
        ? `<p class="task-brief-error">${escapeHtml(`${t("taskBriefFailed")}: ${brief.error}`)}</p>`
        : text
          ? `${facts}<p class="task-brief-text">${escapeHtml(text)}</p>${meta}`
          : `<p class="task-brief-empty">${escapeHtml(t("taskBriefNone"))}</p>`;
  return `<section class="task-brief"><div class="task-brief-head"><strong>${escapeHtml(
    t("taskBrief"),
  )}</strong>${button}</div>${body}</section>`;
}
function formatBriefTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString(state.language === "en" ? "en-US" : "zh-CN", {
    hour12: false,
  });
}
function loadTaskBrief(groupId, signal) {
  return api(`/api/log-groups/${encodeURIComponent(groupId)}/brief`, { signal })
    .then((data) => {
      if (state.activeTaskPricing !== groupId) return;
      state.taskBrief = { id: groupId, loading: false, error: false, data: data || null };
      renderTaskPricingPanel();
    })
    .catch((error) => {
      if (state.activeTaskPricing !== groupId || error?.name === "AbortError") return;
      state.taskBrief = { id: groupId, loading: false, error: false, data: null };
      renderTaskPricingPanel();
    });
}
async function regenerateTaskBrief() {
  const groupId = state.activeTaskPricing;
  if (!groupId || state.taskBrief?.loading) return;
  state.taskBrief = { id: groupId, loading: true, error: false, data: null };
  renderTaskPricingPanel();
  try {
    const data = await api(`/api/log-groups/${encodeURIComponent(groupId)}/brief`, {
      method: "POST",
    });
    if (state.activeTaskPricing !== groupId) return;
    state.taskBrief = { id: groupId, loading: false, error: false, data: data || null };
    toast(t("taskBriefGenerated"));
  } catch (error) {
    if (state.activeTaskPricing !== groupId) return;
    state.taskBrief = {
      id: groupId,
      loading: false,
      error: String(error?.message || error),
      data: null,
    };
  }
  renderTaskPricingPanel();
}
function taskPricingRenderInput(groupId, data, openGroups) {
  const seriesPoints = (series) =>
    series !== null && series !== undefined && series.id === groupId ? series.points : null;
  return {
    language: state.language,
    groupId,
    data,
    brief: state.taskBrief,
    activeTaskGroup: state.activeTaskGroup,
    tokenSeries: seriesPoints(state.taskTokenSeries),
    costSeries: seriesPoints(state.taskCostSeries),
    outputTokenSeries: seriesPoints(state.taskOutputTokenSeries),
    openGroups: Object.keys(openGroups)
      .sort()
      .reduce((result, key) => {
        result[key] = Boolean(openGroups[key]);
        return result;
      }, {}),
  };
}
function taskPricingRenderSignature(input) {
  return JSON.stringify(input);
}

export function renderTaskPricingPanel() {
  const panel = $("pricingPanel");
  const detail = $("detail");
  const pricing = state.taskPricing;
  const active = state.activeTaskPricing;
  detail.classList.toggle("pricing-open", Boolean(active));
  panel.hidden = !active;
  if (!active) {
    panel.innerHTML = "";
    state.taskPricingRendered = "";
    return;
  }
  // A deleted task has no pricing data, so handle the explicit error before the
  // data-null loading guard; otherwise deletion would remain stuck on "Loading".
  if (pricing && pricing.id === active && pricing.error) {
    const deleted = pricing.error === "deleted";
    panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div><p>${escapeHtml(deleted ? t("taskDeleted") : t("pricingUnavailable"))}</p>${deleted ? "" : `<button type="button" data-retry-pricing>${escapeHtml(t("retry"))}</button>`}`;
    state.taskPricingRendered = "";
    return;
  }
  if (!pricing || pricing.id !== active || pricing.loading || pricing.data === null) {
    panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div><p>${escapeHtml(t("loading"))}</p>`;
    state.taskPricingRendered = "";
    return;
  }
  const pricingData = pricing.data;
  const savedOpenGroups = state.pricingGroupOpen[active] || {};
  const presentModels = new Set(
    (pricingData.groups || []).map((group) => group.billing_model || "—"),
  );
  Object.keys(savedOpenGroups).forEach((model) => {
    if (!presentModels.has(model)) delete savedOpenGroups[model];
  });
  if (Object.keys(savedOpenGroups).length === 0) delete state.pricingGroupOpen[active];
  // The panel draws one chart point per request, so rebuilding it is the most
  // expensive render on the page; a refresh round-trip that returned the same
  // numbers keeps the existing DOM instead of drawing it again.
  const renderInput = taskPricingRenderInput(active, pricingData, savedOpenGroups);
  const { data, openGroups } = renderInput;
  const signature = taskPricingRenderSignature(renderInput);
  if (signature === state.taskPricingRendered) {
    // The values stay on screen, but a narrower window can still make the model
    // name overflow, so the shrink-to-fit pass runs even on a skipped rebuild.
    fitTaskSummaryValues(panel);
    return;
  }
  state.taskPricingRendered = signature;
  const groups = (data.groups || [])
    .map((group) => {
      const model = group.billing_model || "—";
      return `<details${openGroups[model] ? " open" : ""} data-price-group-model="${escapeHtml(model)}"><summary><span class="price-group-model">${escapeHtml(model)}</span> · ${escapeHtml(String(group.request_count))} ${escapeHtml(t("requests"))} · <span class="price-group-cost">${escapeHtml(pricingAmount(group.cost_nano_cny))}</span></summary>${taskBreakdownTableHtml(group.breakdown, pricingDecimalFromNano(group.cost_nano_cny), group.price)}</details>`;
    })
    .join("");
  const reasons = Object.entries(data.unpriced_reasons || {})
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(" · ");
  const cost = {
    known_amount: pricingDecimalFromNano(data.cost_nano_cny),
    priced_request_count: data.priced_request_count,
    unpriced_request_count: data.unpriced_request_count,
    pending_request_count: data.pending_request_count,
  };
  const durationText = formatDuration(data.active_request_ms);
  const totalDurationText = formatDuration(data.total_request_ms);
  const group = renderInput.activeTaskGroup;
  const decodeSpeed = group ? formatDecodeSpeed(group.decode_speed_tps) : "";
  const decodeSpeedTip = `${t("avgDecodeSpeed")}: ${t("avgDecodeSpeedTip")}`;
  const statCard = (label, value, sub, title, accent) =>
    `<div class="stat-card task-stat${accent ? ` task-stat-${accent}` : ""}"${title ? ` title="${escapeHtml(title)}"` : ""}><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${
      sub ? `<em>${escapeHtml(sub)}</em>` : ""
    }</div>`;
  const taskStats = [];
  if (group && group.model) {
    taskStats.push(
      `<div class="stat-card task-stat-model" title="${escapeHtml(group.model)}"><small>${t("model")}</small><strong title="${escapeHtml(group.model)}">${escapeHtml(group.model)}</strong></div>`,
    );
  }
  // The long time bar sits right of the model on the first row: the time
  // range takes its top row and the two durations split the second row, so
  // all the time facts read together instead of as orphan cards.
  if (group) {
    const timeItems = [
      // No header label here: the "Time range" label lives on the same line
      // as the start timestamp (see taskTimeRangeHtml) instead of floating
      // above the two stacked time rows.
      `<span class="task-stat-time-item task-stat-time-period">${taskTimeRangeHtml(group)}</span>`,
    ];
    if (totalDurationText !== "") {
      timeItems.push(
        `<span class="task-stat-time-item"><small>${t("totalDuration")}</small><strong>${totalDurationText}</strong></span>`,
      );
    }
    if (durationText !== "") {
      timeItems.push(
        `<span class="task-stat-time-item"><small>${t("activeDuration")}</small><strong>${durationText}</strong></span>`,
      );
    }
    taskStats.push(`<div class="stat-card task-stat-time">${timeItems.join("")}</div>`);
  }
  if (group && group.request_count !== null && group.request_count !== undefined) {
    taskStats.push(
      statCard(t("requestCount"), group.request_count.toLocaleString(), null, null, "count"),
    );
  }
  if (data.breakdown) {
    taskStats.push(
      statCard(
        t("totalTokens"),
        formatTokenCount(taskBreakdownTotalTokens(data.breakdown)),
        null,
        null,
        "tokens",
      ),
    );
  }
  if (decodeSpeed) {
    // The card title is the metric itself ("average decode speed"); no
    // separate sub-line is needed since the label already says what it is.
    taskStats.push(
      statCard(t("avgDecodeSpeed"), `${decodeSpeed}t/s`, null, decodeSpeedTip, "speed"),
    );
  }
  // The target address lives in its own full-width line above the cards: it
  // can be a long URL that a card cell cannot fit without truncating.
  const targetLine = `<div class="task-summary-target"><span class="task-summary-target-label">${t("target")}</span><span class="task-summary-target-value" title="${escapeHtml(data.target || "")}">${escapeHtml(data.target || "—")}</span></div>`;
  // The cost card shows only the total; the priced/unpriced/pending split is
  // a detail the user asked to keep out of the top card.
  taskStats.push(statCard(t("cost"), formatGroupCost(cost), null, null, "cost"));
  const summaryCard = `<section class="task-summary">${targetLine}<div class="task-stat-cards">${taskStats.join("")}</div></section>`;
  // The task brief is its own card at the very top of the panel, above the
  // fact grid: it is free-form prose, so it does not fit the stat-card shape.
  const briefCard = taskBriefCardHtml(renderInput.groupId, renderInput.brief);
  const tokenSeries = renderInput.tokenSeries;
  const tokenChart = `<h3 class="section-token">${escapeHtml(t("tokenTrend"))}</h3>${tokenSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskTokenChartHtml(tokenSeries)}<p class="pricing-note">${escapeHtml(t("tokenTrendNote"))}</p>`;
  const costSeries = renderInput.costSeries;
  const costChart = `<h3 class="section-cost">${escapeHtml(t("costTrend"))}</h3>${costSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskCostChartHtml(costSeries)}<p class="pricing-note">${escapeHtml(t("costTrendNote"))}</p>`;
  const outputTokenSeries = renderInput.outputTokenSeries;
  const outputTokenChart = `<h3 class="section-output">${escapeHtml(t("outputTokenTrend"))}</h3>${outputTokenSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskOutputTokenChartHtml(outputTokenSeries)}<p class="pricing-note">${escapeHtml(t("outputTokenTrendNote"))}</p>`;
  panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div>${briefCard}${summaryCard}${data.priced_request_count ? taskBreakdownTableHtml(data.breakdown, pricingDecimalFromNano(data.cost_nano_cny)) : `<p>${escapeHtml(reasons || t("unpriced"))}</p>`}<p class="pricing-note">${escapeHtml(t("taskWholeScope"))}</p>${costChart}${tokenChart}${outputTokenChart}<h3 class="section-groups">${escapeHtml(t("priceGroups"))}</h3>${groups || `<p>${escapeHtml(t("unpriced"))}</p>`}`;
  fitTaskSummaryValues(panel);
}
function loadTaskTokenSeries(groupId, signal) {
  return api(`/api/log-groups/${encodeURIComponent(groupId)}/pricing/tokens`, { signal })
    .then((points) => {
      if (state.activeTaskPricing !== groupId) return;
      state.taskTokenSeries = { id: groupId, points };
      renderTaskPricingPanel();
    })
    .catch((error) => {
      if (error?.name === "AbortError" || state.activeTaskPricing !== groupId) return;
      state.taskTokenSeries = { id: groupId, points: [] };
      renderTaskPricingPanel();
    });
}
function loadTaskCostSeries(groupId, signal) {
  return api(`/api/log-groups/${encodeURIComponent(groupId)}/pricing/costs`, { signal })
    .then((points) => {
      if (state.activeTaskPricing !== groupId) return;
      state.taskCostSeries = { id: groupId, points };
      renderTaskPricingPanel();
    })
    .catch((error) => {
      if (error?.name === "AbortError" || state.activeTaskPricing !== groupId) return;
      state.taskCostSeries = { id: groupId, points: [] };
      renderTaskPricingPanel();
    });
}
function loadTaskOutputTokenSeries(groupId, signal) {
  return api(`/api/log-groups/${encodeURIComponent(groupId)}/pricing/output-tokens`, { signal })
    .then((points) => {
      if (state.activeTaskPricing !== groupId) return;
      state.taskOutputTokenSeries = { id: groupId, points };
      renderTaskPricingPanel();
    })
    .catch((error) => {
      if (error?.name === "AbortError" || state.activeTaskPricing !== groupId) return;
      state.taskOutputTokenSeries = { id: groupId, points: [] };
      renderTaskPricingPanel();
    });
}
export async function showTaskPricing(groupId) {
  state.taskPricingAbort?.abort();
  const controller = new AbortController();
  state.taskPricingAbort = controller;
  state.activeTaskPricing = groupId;
  // Reveal the panel for this task: always re-read the current list facts for
  // it so re-opening a still-running task never shows the counters of an
  // earlier visit, while a group that has left the list (search / pagination)
  // keeps the last known snapshot.
  if (state.activeTaskGroup?.id !== groupId) state.activeTaskGroup = null;
  syncActiveTaskGroup(groupId);
  state.taskPricing = { id: groupId, loading: true, error: false, data: null };
  state.taskBrief = { id: groupId, loading: true, error: false, data: null };
  state.taskTokenSeries = { id: groupId, points: null };
  state.taskCostSeries = { id: groupId, points: null };
  state.taskOutputTokenSeries = { id: groupId, points: null };
  renderTaskPricingPanel();
  const series = loadTaskTokenSeries(groupId, controller.signal);
  const brief = loadTaskBrief(groupId, controller.signal);
  const costSeries = loadTaskCostSeries(groupId, controller.signal);
  const outputTokenSeries = loadTaskOutputTokenSeries(groupId, controller.signal);
  try {
    const data = await api(`/api/log-groups/${encodeURIComponent(groupId)}/pricing`, {
      signal: controller.signal,
    });
    if (state.activeTaskPricing !== groupId) return;
    state.taskPricing = { id: groupId, loading: false, error: false, data };
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (state.activeTaskPricing !== groupId) return;
    state.taskPricing = { id: groupId, loading: false, error: true, data: null };
  }
  renderTaskPricingPanel();
  await Promise.all([series, costSeries, outputTokenSeries, brief]);
}
export function closeTaskPricing() {
  state.taskPricingAbort?.abort();
  state.taskPricingAbort = null;
  state.activeTaskPricing = null;
  state.activeTaskGroup = null;
  state.taskBrief = null;
  state.taskTokenSeries = null;
  state.taskCostSeries = null;
  state.taskOutputTokenSeries = null;
  renderTaskPricingPanel();
}
export async function refreshTaskPricingPanel() {
  const groupId = state.activeTaskPricing;
  if (!groupId || state.taskPricing?.loading) return;
  // The summary card also carries list facts (model / time range / request
  // count / decode speed); mirror them before the pricing round-trip so a
  // running task's counters move on screen at the list's cadence instead of
  // waiting for the cost response.
  if (syncActiveTaskGroup(groupId)) renderTaskPricingPanel();
  const controller = new AbortController();
  state.taskPricingAbort?.abort();
  state.taskPricingAbort = controller;
  const series = loadTaskTokenSeries(groupId, controller.signal);
  const costSeries = loadTaskCostSeries(groupId, controller.signal);
  const outputTokenSeries = loadTaskOutputTokenSeries(groupId, controller.signal);
  try {
    const data = await api(`/api/log-groups/${encodeURIComponent(groupId)}/pricing`, {
      signal: controller.signal,
    });
    if (state.activeTaskPricing !== groupId || controller.signal.aborted) return;
    state.taskPricing = { id: groupId, loading: false, error: false, data };
    renderTaskPricingPanel();
  } catch (error) {
    if (error?.name === "AbortError" || state.activeTaskPricing !== groupId) return;
    state.taskPricing = { id: groupId, loading: false, error: true, data: null };
    renderTaskPricingPanel();
  }
  await Promise.all([series, costSeries, outputTokenSeries]);
}
function updateRequestPricingButton() {
  const button = optionalTyped('[data-pricing="response"]', HTMLButtonElement);
  if (!button) return;
  const available = Boolean(state.requestPricing);
  button.disabled = !available;
  button.classList.toggle("active", available && state.requestPricingOpen);
  button.title =
    available && state.requestPricingOpen ? t("hideCostDetails") : t("showCostDetails");
  button.setAttribute("aria-expanded", String(available && state.requestPricingOpen));
}

/**
 * Attaches the listeners the detail panel owns: the pricing panel's own clicks (model
 * groups, close, re-try, regenerate brief) and the request-pricing toggle.
 * @returns {void}
 */
export function mountTaskDetail() {
  $("pricingPanel").addEventListener("click", (event) => {
    if (closestFrom(event.target, "[data-generate-brief]")) {
      regenerateTaskBrief().catch((e) => toast(e.message));
      return;
    }
    const summary = closestFrom(event.target, "summary");
    if (summary && state.activeTaskPricing) {
      const details = parentOf(summary);
      if (details instanceof HTMLDetailsElement && details.hasAttribute("data-price-group-model")) {
        const openGroups =
          state.pricingGroupOpen[state.activeTaskPricing] ||
          (state.pricingGroupOpen[state.activeTaskPricing] = {});
        const model = details.dataset.priceGroupModel;
        if (model === undefined) throw new Error("Missing data-price-group-model");
        if (details.open) delete openGroups[model];
        else openGroups[model] = true;
        savePricingGroupOpenState();
        return;
      }
    }
    if (closestFrom(event.target, "[data-close-pricing]")) {
      closeTaskPricing();
      return;
    }
    if (closestFrom(event.target, "[data-retry-pricing]") && state.activeTaskPricing) {
      showTaskPricing(state.activeTaskPricing).catch((e) => toast(e.message));
    }
  });
  qsa("[data-pricing]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!state.requestPricing) return;
      state.requestPricingOpen = !state.requestPricingOpen;
      renderRequestPricing();
    }),
  );
}

/**
 * Releases what outlives the page: the controller of the in-flight pricing, series and
 * brief requests, so a page unload never leaves four fetches running into a dead panel.
 * @returns {void}
 */
export function disposeTaskDetail() {
  state.taskPricingAbort?.abort();
  state.taskPricingAbort = null;
}
