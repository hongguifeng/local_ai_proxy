import { requiredTyped } from "./dom.js";
// LLM Proxy admin UI -- upstream metrics: Prometheus list, auto refresh, vLLM dashboard.
// ES module: imports the shared bootstrap (./core.js), the display helpers and the status
// label the list view reuses.

import { $, api, asElement, registerLanguagePanel, requiredDialog, state, t } from "./core.js";
import { formatIntegerValue } from "./numbers.js";
import { escapeHtml } from "./text.js";
import { formatDuration } from "./time.js";

/**
 * The metrics dialog's own state. The fetch result, the Prometheus text and the dashboard
 * view live here rather than in the shared `state` object, because no other module reads
 * them and the dialog is disposed with the page.
 */
/** @typedef {{name: string, value: string}} MetricLabel */
/** @typedef {{name: string, type: string, help: string, samples: {labels: MetricLabel[], value: string}[]}} MetricFamily */
/** @type {{url: string, apiKey: string, loading: boolean, error: string | null, text: string, truncated: boolean, status: number, durationMs: number, filter: string, view: string, openFamilies: Record<string, boolean>, families: MetricFamily[], familyByName: Map<string, MetricFamily>, refreshMs: number, refreshTimer: ReturnType<typeof setInterval> | null, refreshTicks: number, scrollY: {dashboard: number, list: number}}} */
const metricsState = {
  url: "",
  apiKey: "",
  loading: false,
  error: null,
  text: "",
  truncated: false,
  status: 0,
  durationMs: 0,
  filter: "",
  view: "dashboard",
  openFamilies: {},
  families: [],
  familyByName: new Map(),
  refreshMs: 0,
  refreshTimer: null,
  refreshTicks: 0,
  scrollY: { dashboard: 0, list: 0 },
};
function mdsStat(labelKey, value, sub, tipKey) {
  const tip = tipKey === undefined ? "" : ` title="${escapeHtml(t(tipKey))}"`;
  const subHtml = sub === undefined || sub === "" ? "" : `<em>${sub}</em>`;
  return `<div class="mds-stat"${tip}><small>${escapeHtml(t(labelKey))}</small><strong>${value}</strong>${subHtml}</div>`;
}

// Redraw on language change. The sequence mirrors the order the switch used to
// call these in by hand; see registerLanguagePanel in ./core.js.
registerLanguagePanel(
  "metricsDialog",
  70,
  () => renderMetricsDialog(),
  () => Boolean(requiredDialog("metricsDialog")?.open),
);
const PROMETHEUS_COMMENT = /^#\s*(HELP|TYPE)\s+(\S+)(?:\s+(.*))?$/;
const PROMETHEUS_SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\d+)?$/;
const PROMETHEUS_LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;
/** @param {string | undefined} text @returns {MetricLabel[]} */
function parseMetricLabels(text) {
  if (text === undefined || text === "") return [];
  const labels = [];
  for (const match of text.matchAll(PROMETHEUS_LABEL)) {
    labels.push({
      name: match[1],
      value: match[2].replace(/\\(.)/g, (_, ch) => (ch === "n" ? "\n" : ch)),
    });
  }
  return labels;
}
// Parse the Prometheus exposition format into metric families: HELP/TYPE
// comments open or update a family, sample lines attach label sets and
// values. Families keep file order so related vLLM metrics stay grouped.
/** @param {string} text @returns {MetricFamily[]} */
function parsePrometheusMetrics(text) {
  /** @type {MetricFamily[]} */
  const families = [];
  /** @type {Map<string, MetricFamily>} */
  const byName = new Map();
  const familyFor = (name) => {
    let family = byName.get(name);
    if (family === undefined) {
      family = { name, type: "", help: "", samples: [] };
      byName.set(name, family);
      families.push(family);
    }
    return family;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const comment = PROMETHEUS_COMMENT.exec(line);
      if (comment === null) continue;
      const family = familyFor(comment[2]);
      if (comment[1] === "TYPE") family.type = (comment[3] || "").trim();
      else if (family.help === "") family.help = (comment[3] || "").trim();
      continue;
    }
    const sample = PROMETHEUS_SAMPLE.exec(line);
    if (sample === null) continue;
    familyFor(sample[1]).samples.push({
      labels: parseMetricLabels(sample[2]),
      value: sample[3],
    });
  }
  return families;
}
function formatMetricBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${sign}${n.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}
function formatMetricSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) < 1) return `${(n * 1000).toFixed(1)} ms`;
  if (n < 60) return `${n.toFixed(2)} s`;
  return formatDuration(n * 1000);
}
function formatMetricValue(familyName, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  if (familyName.endsWith("_bytes")) return formatMetricBytes(n);
  if (familyName.endsWith("_seconds")) return formatMetricSeconds(n);
  if (familyName.endsWith("_created")) {
    const date = new Date(n * 1000);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(raw);
  }
  if (Number.isInteger(n)) return formatIntegerValue(n);
  return n.toLocaleString(state.language === "en" ? "en-US" : "zh-CN", {
    maximumFractionDigits: 6,
  });
}
function metricFamilyHtml(family) {
  const open = Boolean(metricsState.openFamilies[family.name]);
  const typeBadge =
    family.type === "" ? "" : `<span class="metrics-type">${escapeHtml(family.type)}</span>`;
  const rows = family.samples
    .map((sample) => {
      const labels =
        sample.labels.length === 0
          ? `<span class="metrics-label-empty">—</span>`
          : sample.labels
              .map(
                (label) =>
                  `<span class="metrics-label" title="${escapeHtml(`${label.name}=${label.value}`)}">${escapeHtml(label.name)}=${escapeHtml(label.value)}</span>`,
              )
              .join("");
      return `<tr><td class="metrics-labels">${labels}</td><td class="metrics-value">${escapeHtml(formatMetricValue(family.name, sample.value))}</td></tr>`;
    })
    .join("");
  return `<details class="metrics-family"${open ? " open" : ""} data-metrics-family="${escapeHtml(family.name)}"><summary><code class="metrics-family-name">${escapeHtml(family.name)}</code>${typeBadge}<span class="metrics-family-count">${family.samples.length}</span></summary>${family.help === "" ? "" : `<p class="metrics-family-help">${escapeHtml(family.help)}</p>`}<table class="metrics-table"><tbody>${rows}</tbody></table></details>`;
}
// --- vLLM dashboard helpers -------------------------------------------------
// The dashboard turns the raw exposition into a small set of derived numbers:
// counters are summed across engines, gauges read the first sample, and
// latency percentiles are interpolated from histogram buckets (approximate).
function metricCounterTotal(name) {
  const family = metricsState.familyByName.get(name);
  if (family === undefined) return undefined;
  let total = 0;
  let seen = false;
  family.samples.forEach((sample) => {
    const n = Number(sample.value);
    if (Number.isFinite(n)) {
      total += n;
      seen = true;
    }
  });
  return seen ? total : undefined;
}
function metricGauge(name) {
  const family = metricsState.familyByName.get(name);
  if (family === undefined) return undefined;
  for (const sample of family.samples) {
    const n = Number(sample.value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function metricLabel(name, labelName) {
  const family = metricsState.familyByName.get(name);
  if (family === undefined) return undefined;
  for (const sample of family.samples) {
    const label = sample.labels.find((entry) => entry.name === labelName);
    if (label !== undefined) return label.value;
  }
  return undefined;
}
function histogramBuckets(name) {
  // The TYPE comment names the histogram family but the samples live in its
  // `_bucket` companion family, so read the buckets from there.
  const family = metricsState.familyByName.get(`${name}_bucket`);
  if (family === undefined) return undefined;
  const cumulative = [];
  family.samples.forEach((sample) => {
    const le = sample.labels.find((entry) => entry.name === "le");
    if (le === undefined) return;
    const count = Number(sample.value);
    if (!Number.isFinite(count)) return;
    cumulative.push({
      upper: le.value === "+Inf" ? Infinity : Number(le.value),
      count,
    });
  });
  if (cumulative.length === 0) return undefined;
  cumulative.sort((a, b) => a.upper - b.upper);
  return cumulative;
}
// Linear interpolation inside the bucket that contains the target rank; the
// +Inf bucket has no width so its quantile falls back to the previous bound.
function histogramQuantile(name, q) {
  const cumulative = histogramBuckets(name);
  if (cumulative === undefined) return undefined;
  const total = cumulative[cumulative.length - 1].count;
  if (total <= 0) return undefined;
  const target = q * total;
  let prevUpper = 0;
  let prevCount = 0;
  for (const bucket of cumulative) {
    if (bucket.count >= target) {
      if (!Number.isFinite(bucket.upper)) return prevUpper;
      const span = bucket.count - prevCount;
      if (span <= 0) return bucket.upper;
      return prevUpper + ((target - prevCount) / span) * (bucket.upper - prevUpper);
    }
    prevUpper = bucket.upper;
    prevCount = bucket.count;
  }
  const last = cumulative[cumulative.length - 1];
  return Number.isFinite(last.upper) ? last.upper : prevUpper;
}
function histogramObservations(name) {
  return metricCounterTotal(`${name}_count`);
}
function histogramMean(name) {
  const sum = metricCounterTotal(`${name}_sum`);
  const count = histogramObservations(name);
  if (sum === undefined || count === undefined || count === 0) return undefined;
  return sum / count;
}
function histogramBarHtml(name) {
  const cumulative = histogramBuckets(name);
  if (cumulative === undefined) return "";
  const buckets = cumulative.map((bucket, index) => ({
    upper: bucket.upper,
    count: index === 0 ? bucket.count : bucket.count - cumulative[index - 1].count,
  }));
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return `<div class="mds-buckets">${buckets
    .map((bucket) => {
      const width = Math.max(1.5, (bucket.count / max) * 100);
      const label = Number.isFinite(bucket.upper) ? formatMetricSeconds(bucket.upper) : "\u221e";
      return `<div class="mds-bucket" title="${escapeHtml(`${label}: ${bucket.count}`)}"><span class="mds-bucket-le">${escapeHtml(label)}</span><span class="mds-bucket-track"><span class="mds-bucket-fill" style="width:${width.toFixed(1)}%"></span></span><span class="mds-bucket-count">${escapeHtml(formatIntegerValue(bucket.count))}</span></div>`;
    })
    .join("")}</div>`;
}
function mdsNoData() {
  return `<strong class="mds-empty">${escapeHtml(t("metricsNoData"))}</strong>`;
}
function mdsBar(ratio, cls) {
  if (ratio === undefined) return "";
  const width = Math.max(0, Math.min(100, ratio * 100)).toFixed(1);
  return `<span class="mds-bar"><span class="mds-bar-fill ${cls}" style="width:${width}%"></span></span>`;
}
function mdsSection(titleKey, noteKey, inner) {
  return `<section class="mds-section"><h3>${escapeHtml(t(titleKey))}</h3><p class="mds-note">${escapeHtml(t(noteKey))}</p>${inner}</section>`;
}
function mdsLatencyPanel(name, titleKey, tipKey) {
  const observations = histogramObservations(name);
  const mean = histogramMean(name);
  const quantileHtml = [0.5, 0.95, 0.99]
    .map((q, index) => {
      const label = t(index === 0 ? "metricsP50" : index === 1 ? "metricsP95" : "metricsP99");
      const value = histogramQuantile(name, q);
      return `<div class="mds-quantile"><small>${escapeHtml(label)}</small><strong>${value === undefined ? escapeHtml(t("metricsNoData")) : escapeHtml(formatMetricSeconds(value))}</strong></div>`;
    })
    .join("");
  const meanHtml =
    mean === undefined
      ? ""
      : `<div class="mds-quantile mds-quantile-mean"><small>${escapeHtml(t("metricsAvg"))}</small><strong>${escapeHtml(formatMetricSeconds(mean))}</strong></div>`;
  const countHtml =
    observations === undefined
      ? ""
      : `<span class="mds-panel-count" title="${escapeHtml(t("metricsObservations"))}">${escapeHtml(formatIntegerValue(observations))}</span>`;
  return `<div class="mds-panel" title="${escapeHtml(t(tipKey))}"><div class="mds-panel-head"><strong>${escapeHtml(t(titleKey))}</strong>${countHtml}</div><div class="mds-quantiles">${quantileHtml}${meanHtml}</div>${histogramBarHtml(name)}</div>`;
}
function vllmDashboardHtml() {
  // Engine status: model, uptime and the sleep-mode pill.
  const modelName = metricLabel("vllm:num_requests_running", "model_name");
  const startTime = metricGauge("process_start_time_seconds");
  const uptimeMs = startTime === undefined ? undefined : Math.max(0, Date.now() - startTime * 1000);
  let engineStateKey = "metricsUptimeUnknown";
  const sleepFamily = metricsState.familyByName.get("vllm:engine_sleep_state");
  if (sleepFamily !== undefined) {
    for (const sample of sleepFamily.samples) {
      if (Number(sample.value) > 0) {
        const state = sample.labels.find((entry) => entry.name === "sleep_state")?.value;
        if (state === "awake") engineStateKey = "metricsEngineAwake";
        else if (state === "weights_offloaded") engineStateKey = "metricsEngineSleeping";
        else if (state === "discard_all") engineStateKey = "metricsEngineDiscarded";
        break;
      }
    }
  }
  const statusCards = `<div class="mds-grid">${mdsStat(
    "metricsModelName",
    modelName === undefined ? mdsNoData() : escapeHtml(modelName),
    "",
    undefined,
  )}${mdsStat(
    "metricsUptime",
    uptimeMs === undefined ? mdsNoData() : escapeHtml(formatDuration(uptimeMs)),
    "",
    "metricsUptimeTip",
  )}<div class="mds-stat" title="${escapeHtml(t("metricsEngineSleepTip"))}"><small>${escapeHtml(t("metricsEngineAwake"))} / ${escapeHtml(t("metricsEngineSleeping"))}</small><strong class="mds-pill mds-pill-${engineStateKey === "metricsEngineAwake" ? "ok" : engineStateKey === "metricsEngineSleeping" ? "warn" : "danger"}">${escapeHtml(t(engineStateKey))}</strong></div></div>`;

  // Live load: running/waiting gauges, KV pressure and preemptions.
  const running = metricGauge("vllm:num_requests_running");
  const waiting = metricGauge("vllm:num_requests_waiting");
  const waitingReasons = metricsState.familyByName.get("vllm:num_requests_waiting_by_reason");
  const reasonsSub =
    waitingReasons === undefined || waitingReasons.samples.length === 0
      ? ""
      : escapeHtml(
          waitingReasons.samples
            .map(
              (sample) =>
                `${sample.labels.find((entry) => entry.name === "reason")?.value ?? "?"}=${formatIntegerValue(Number(sample.value))}`,
            )
            .join(" "),
        );
  const kvUsage = metricGauge("vllm:kv_cache_usage_perc");
  const kvCls =
    kvUsage === undefined ? "" : kvUsage < 0.7 ? "ok" : kvUsage < 0.9 ? "warn" : "danger";
  const loadCards = `<div class="mds-grid">${mdsStat(
    "metricsRequestsRunning",
    running === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(running)),
    "",
    "metricsLoadTip",
  )}${mdsStat(
    "metricsRequestsWaiting",
    waiting === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(waiting)),
    reasonsSub,
    "metricsLoadTip",
  )}${mdsStat(
    "metricsKvUsage",
    kvUsage === undefined ? mdsNoData() : `${(kvUsage * 100).toFixed(1)}%`,
    mdsBar(kvUsage, kvCls),
    "metricsKvUsageTip",
  )}${mdsStat(
    "metricsPreemptions",
    (() => {
      const total = metricCounterTotal("vllm:num_preemptions_total");
      return total === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(total));
    })(),
    "",
    "metricsPreemptionsTip",
  )}</div>`;

  // Cache & speculative decoding ratios since start.
  const ratioStat = (labelKey, tipKey, hitsName, queriesName) => {
    const hits = metricCounterTotal(hitsName);
    const queries = metricCounterTotal(queriesName);
    if (hits === undefined || queries === undefined || queries === 0)
      return mdsStat(labelKey, mdsNoData(), "", tipKey);
    const ratio = hits / queries;
    return mdsStat(labelKey, `${(ratio * 100).toFixed(1)}%`, mdsBar(ratio, "ok"), tipKey);
  };
  const specDraft = metricCounterTotal("vllm:spec_decode_num_draft_tokens_total") ?? 0;
  const mmQueries = metricCounterTotal("vllm:mm_cache_queries_total") ?? 0;
  const externalQueries = metricCounterTotal("vllm:external_prefix_cache_queries_total") ?? 0;
  const specHtml =
    specDraft > 0
      ? (() => {
          const accepted = metricCounterTotal("vllm:spec_decode_num_accepted_tokens_total") ?? 0;
          const ratio = accepted / specDraft;
          return mdsStat(
            "metricsSpecAccept",
            `${(ratio * 100).toFixed(1)}%`,
            mdsBar(ratio, "ok"),
            "metricsSpecAcceptTip",
          );
        })()
      : "";
  const mmHtml =
    mmQueries > 0
      ? ratioStat(
          "metricsMmCacheHit",
          "metricsMmCacheHitTip",
          "vllm:mm_cache_hits_total",
          "vllm:mm_cache_queries_total",
        )
      : "";
  const externalHtml =
    externalQueries > 0
      ? ratioStat(
          "metricsExternalPrefixHit",
          "metricsExternalPrefixHitTip",
          "vllm:external_prefix_cache_hits_total",
          "vllm:external_prefix_cache_queries_total",
        )
      : "";
  const configCards = (() => {
    const card = (labelKey, value, tipKey) => mdsStat(labelKey, value, "", tipKey);
    const pick = (labelName) => metricLabel("vllm:cache_config_info", labelName);
    const sizeTokens = pick("kv_cache_size_tokens");
    const blocks = pick("num_gpu_blocks");
    const blockSize = pick("block_size");
    const prefix = pick("enable_prefix_caching");
    const utilization = pick("gpu_memory_utilization");
    const numberish = (value) => {
      if (value === undefined || value === "None") return mdsNoData();
      return escapeHtml(formatIntegerValue(value));
    };
    return [
      card("metricsCacheBlocks", numberish(blocks), "metricsCacheConfigTip"),
      card("metricsCacheSizeTokens", numberish(sizeTokens), "metricsCacheConfigTip"),
      card("metricsCacheBlockSize", numberish(blockSize), "metricsCacheConfigTip"),
      card(
        "metricsPrefixCaching",
        prefix === undefined
          ? mdsNoData()
          : `<span class="mds-pill mds-pill-${prefix === "True" ? "ok" : "danger"}">${escapeHtml(t(prefix === "True" ? "metricsOn" : "metricsOff"))}</span>`,
        "metricsCacheConfigTip",
      ),
      card(
        "metricsGpuMemoryUtil",
        utilization === undefined || utilization === "None"
          ? mdsNoData()
          : escapeHtml(`${(Number(utilization) * 100).toFixed(0)}%`),
        "metricsCacheConfigTip",
      ),
    ].join("");
  })();
  const cacheCards = `<div class="mds-grid">${ratioStat(
    "metricsPrefixHit",
    "metricsPrefixHitTip",
    "vllm:prefix_cache_hits_total",
    "vllm:prefix_cache_queries_total",
  )}${externalHtml}${mmHtml}${specHtml}${configCards}</div>`;

  // Latency panels with interpolated percentiles and bucket bars.
  const latencyPanels = `<div class="mds-latency">${[
    mdsLatencyPanel("vllm:time_to_first_token_seconds", "metricsTtft", "metricsTtftTip"),
    mdsLatencyPanel("vllm:inter_token_latency_seconds", "metricsItl", "metricsItlTip"),
    mdsLatencyPanel("vllm:request_queue_time_seconds", "metricsQueueTime", "metricsQueueTimeTip"),
    mdsLatencyPanel(
      "vllm:request_prefill_time_seconds",
      "metricsPrefillTime",
      "metricsPrefillTimeTip",
    ),
    mdsLatencyPanel(
      "vllm:request_decode_time_seconds",
      "metricsDecodeTime",
      "metricsDecodeTimeTip",
    ),
    mdsLatencyPanel("vllm:e2e_request_latency_seconds", "metricsE2e", "metricsE2eTip"),
  ].join("")}</div>`;

  // Token throughput: lifetime totals, per-request averages, decode speed and
  // the prompt-source split (falls back to the cached-total ratio).
  const promptTotal = metricCounterTotal("vllm:prompt_tokens_total");
  const generationTotal = metricCounterTotal("vllm:generation_tokens_total");
  const decodeSum = metricCounterTotal("vllm:request_decode_time_seconds_sum");
  const decodeSpeed =
    generationTotal !== undefined && decodeSum !== undefined && decodeSum > 0
      ? `${(generationTotal / decodeSum).toFixed(1)} t/s`
      : undefined;
  const reasons = metricsState.familyByName.get("vllm:request_success_total");
  const reasonLabels = {
    stop: "metricsReasonStop",
    length: "metricsReasonLength",
    abort: "metricsReasonAbort",
    error: "metricsReasonError",
    repetition: "metricsReasonRepetition",
  };
  const reasonHtml =
    reasons === undefined
      ? ""
      : `<div class="mds-chips">${reasons.samples
          .map((sample) => {
            const reason =
              sample.labels.find((entry) => entry.name === "finished_reason")?.value ?? "?";
            const labelKey = reasonLabels[reason] ?? "metricsNoData";
            const count = Number(sample.value);
            const bad = (reason === "abort" || reason === "error") && count > 0;
            return `<span class="mds-chip${bad ? " mds-chip-danger" : ""}">${escapeHtml(t(labelKey))} ${escapeHtml(formatIntegerValue(count))}</span>`;
          })
          .join("")}</div>`;
  const sources = metricsState.familyByName.get("vllm:prompt_tokens_by_source_total");
  const sourceLabels = {
    local_compute: "metricsSourceLocalCompute",
    local_cache_hit: "metricsSourceLocalCacheHit",
    external_kv_transfer: "metricsSourceExternalKvTransfer",
  };
  const sourceTotal =
    sources === undefined
      ? 0
      : sources.samples.reduce((sum, sample) => sum + Number(sample.value || 0), 0);
  let sourceHtml = "";
  if (sources !== undefined && sourceTotal > 0) {
    const colors = {
      local_cache_hit: "var(--accent)",
      local_compute: "#e0a03a",
      external_kv_transfer: "#3b82f6",
    };
    const sorted = sources.samples
      .map((sample) => ({
        source: sample.labels.find((entry) => entry.name === "source")?.value ?? "?",
        value: Number(sample.value || 0),
      }))
      .sort((a, b) => b.value - a.value);
    const segments = sorted
      .filter((entry) => entry.value > 0)
      .map(
        (entry) =>
          `<span class="mds-stack-segment" style="flex:${entry.value};background:${colors[entry.source] ?? "var(--line)"}" title="${escapeHtml(`${entry.source}: ${formatIntegerValue(entry.value)} (${((entry.value / sourceTotal) * 100).toFixed(1)}%)`)}"></span>`,
      )
      .join("");
    const legend = sorted
      .map(
        (entry) =>
          `<span class="mds-legend"><i style="background:${colors[entry.source] ?? "var(--line)"}"></i>${escapeHtml(t(sourceLabels[entry.source] ?? "metricsNoData"))} ${escapeHtml(`${((entry.value / sourceTotal) * 100).toFixed(1)}%`)}</span>`,
      )
      .join("");
    sourceHtml = mdsStat(
      "metricsPromptSources",
      `<span class="mds-stack">${segments}</span>`,
      legend,
      "metricsPromptSourcesTip",
    );
  } else {
    const cached = metricCounterTotal("vllm:prompt_tokens_cached_total");
    if (cached !== undefined && promptTotal !== undefined && promptTotal > 0) {
      const ratio = cached / promptTotal;
      sourceHtml = mdsStat(
        "metricsPromptSources",
        `${(ratio * 100).toFixed(1)}%`,
        mdsBar(ratio, "ok"),
        "metricsPromptSourcesTip",
      );
    }
  }
  const avgStat = (labelKey, name, tipKey) => {
    const mean = histogramMean(name);
    return mdsStat(
      labelKey,
      mean === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(Math.round(mean))),
      "",
      tipKey,
    );
  };
  const cachedStat = (() => {
    const cached = metricCounterTotal("vllm:prompt_tokens_cached_total");
    return mdsStat(
      "metricsPromptCached",
      cached === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(cached)),
      "",
      "metricsPromptCachedTip",
    );
  })();
  const tokenCards = `<div class="mds-grid">${mdsStat(
    "metricsRequestsCompleted",
    (() => {
      const total = metricCounterTotal("vllm:request_success_total");
      return total === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(total));
    })(),
    reasonHtml,
    "metricsRequestsCompletedTip",
  )}${mdsStat(
    "metricsDecodeSpeed",
    decodeSpeed === undefined ? mdsNoData() : escapeHtml(decodeSpeed),
    "",
    "metricsDecodeSpeedTip",
  )}${mdsStat(
    "metricsPromptTokensTotal",
    promptTotal === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(promptTotal)),
    "",
    "metricsPromptTokensTotalTip",
  )}${mdsStat(
    "metricsGenerationTokensTotal",
    generationTotal === undefined ? mdsNoData() : escapeHtml(formatIntegerValue(generationTotal)),
    "",
    "metricsGenerationTokensTotalTip",
  )}${avgStat("metricsAvgPromptLength", "vllm:request_prompt_tokens", "metricsAvgPromptLengthTip")}${avgStat(
    "metricsAvgGenerationLength",
    "vllm:request_generation_tokens",
    "metricsAvgGenerationLengthTip",
  )}${cachedStat}${sourceHtml}</div>`;

  // Process resources: host memory, CPU and file descriptors.
  const openFds = metricGauge("process_open_fds");
  const maxFds = metricGauge("process_max_fds");
  const processCards = `<div class="mds-grid">${mdsStat(
    "metricsMemoryRss",
    (() => {
      const rss = metricGauge("process_resident_memory_bytes");
      return rss === undefined ? mdsNoData() : escapeHtml(formatMetricBytes(rss));
    })(),
    "",
    "metricsMemoryRssTip",
  )}${mdsStat(
    "metricsVirtualMemory",
    (() => {
      const value = metricGauge("process_virtual_memory_bytes");
      return value === undefined ? mdsNoData() : escapeHtml(formatMetricBytes(value));
    })(),
    "",
    "metricsVirtualMemoryTip",
  )}${mdsStat(
    "metricsCpuTime",
    (() => {
      const value = metricCounterTotal("process_cpu_seconds_total");
      return value === undefined ? mdsNoData() : escapeHtml(formatMetricSeconds(value));
    })(),
    "",
    "metricsCpuTimeTip",
  )}${mdsStat(
    "metricsOpenFds",
    openFds === undefined || maxFds === undefined
      ? mdsNoData()
      : escapeHtml(`${formatIntegerValue(openFds)} / ${formatIntegerValue(maxFds)}`),
    "",
    "metricsOpenFdsTip",
  )}</div>`;

  return `<div class="metrics-dashboard">${[
    mdsSection("metricsSectionStatus", "metricsSectionStatusNote", statusCards),
    mdsSection("metricsSectionLoad", "metricsSectionLoadNote", loadCards),
    mdsSection("metricsSectionCache", "metricsSectionCacheNote", cacheCards),
    mdsSection("metricsSectionTokens", "metricsSectionTokensNote", tokenCards),
    mdsSection("metricsSectionProcess", "metricsSectionProcessNote", processCards),
    mdsSection("metricsSectionLatency", "metricsSectionLatencyNote", latencyPanels),
  ].join("")}</div>`;
}
function renderMetricsDialog() {
  const result = $("metricsResult");
  const dashboard = $("metricsDashboard");
  const list = $("metricsList");
  $("metricsDialogUrl").textContent = metricsState.url;
  requiredTyped("#metricsRefresh", HTMLButtonElement).disabled =
    metricsState.loading || metricsState.url === "";
  result.hidden = true;
  result.textContent = "";
  result.className = "target-check-result";
  if (metricsState.loading) {
    result.hidden = false;
    result.className = "target-check-result testing";
    result.textContent = t("metricsLoading");
    dashboard.innerHTML = "";
    $("metricsListBody").innerHTML = "";
    return;
  }
  if (metricsState.error !== null) {
    result.hidden = false;
    result.className = "target-check-result failure";
    result.textContent = t("metricsFail").replace("{error}", metricsState.error);
    dashboard.innerHTML = "";
    $("metricsListBody").innerHTML = "";
    return;
  }
  const isVllm = metricsState.families.some((family) => family.name.startsWith("vllm:"));
  const view = isVllm ? metricsState.view : "list";
  dashboard.hidden = view !== "dashboard";
  list.hidden = view !== "list";
  requiredTyped("#metricsViewDashboard", HTMLButtonElement).classList.toggle(
    "primary",
    view === "dashboard",
  );
  requiredTyped("#metricsViewList", HTMLButtonElement).classList.toggle("primary", view === "list");
  if (view === "dashboard") {
    dashboard.innerHTML = vllmDashboardHtml();
    return;
  }
  const filter = metricsState.filter.trim().toLowerCase();
  const families = metricsState.families.filter(
    (family) => filter === "" || family.name.toLowerCase().includes(filter),
  );
  const meta = [
    `HTTP ${metricsState.status}`,
    `${Math.round(metricsState.durationMs)} ms`,
    filter === ""
      ? t("metricsFamilies").replace("{n}", String(metricsState.families.length))
      : `${families.length} / ${metricsState.families.length}`,
  ];
  if (metricsState.truncated) meta.push(t("metricsTruncated"));
  $("metricsListBody").innerHTML =
    `<p class="metrics-meta">${meta.map(escapeHtml).join(" · ")}</p>${isVllm ? "" : `<p class="metrics-note">${escapeHtml(t("metricsNotVllm"))}</p>`}${families
      .map(metricFamilyHtml)
      .join("")}`;
  $("metricsRawPre").textContent = metricsState.text;
}
export function openTargetMetricsDialog(target) {
  metricsState.url = target.target_url || "";
  metricsState.apiKey = target.target_api_key || "";
  metricsState.filter = "";
  requiredTyped("#metricsFilter", HTMLInputElement).value = "";
  metricsState.text = "";
  metricsState.families = [];
  metricsState.error = null;
  metricsState.truncated = false;
  metricsState.status = 0;
  metricsState.durationMs = 0;
  metricsState.loading = true;
  metricsState.openFamilies = {};
  metricsState.view = "dashboard";
  renderMetricsDialog();
  requiredDialog("metricsDialog").showModal();
  loadTargetMetrics();
  const intervalSelect = requiredTyped("#metricsRefreshInterval", HTMLSelectElement);
  if (intervalSelect) startMetricsAutoRefresh(Number(intervalSelect.value) || 0);
  syncMetricsRefreshCountdown();
}
function startMetricsAutoRefresh(intervalMs) {
  if (metricsState.refreshTimer !== null) {
    clearInterval(metricsState.refreshTimer);
    metricsState.refreshTimer = null;
  }
  metricsState.refreshMs = intervalMs;
  metricsState.refreshTicks = intervalMs;
  if (intervalMs <= 0) return;
  metricsState.refreshTimer = setInterval(() => {
    metricsState.refreshTicks -= 1000;
    if (metricsState.refreshTicks > 0) {
      syncMetricsRefreshCountdown();
      return;
    }
    metricsState.refreshTicks = intervalMs;
    if (!requiredDialog("metricsDialog")?.open) return;
    if (metricsState.loading) return;
    loadTargetMetrics({ showLoading: false });
  }, 1000);
}
function stopMetricsAutoRefresh() {
  if (metricsState.refreshTimer !== null) {
    clearInterval(metricsState.refreshTimer);
    metricsState.refreshTimer = null;
  }
  syncMetricsRefreshCountdown();
}
function syncMetricsRefreshCountdown() {
  const countdown = $("metricsRefreshCountdown");
  if (!countdown) return;
  if (metricsState.refreshTimer === null) {
    countdown.hidden = true;
    countdown.textContent = "";
    return;
  }
  countdown.hidden = false;
  countdown.textContent = `${Math.max(1, Math.round(metricsState.refreshTicks / 1000))} s`;
}
function loadTargetMetrics(options = {}) {
  // Capture the scroll positions before any re-render: the loading state
  // empties both bodies, which would otherwise collapse them to the top.
  metricsState.scrollY = {
    dashboard: $("metricsDashboard")?.scrollTop ?? 0,
    list: $("metricsList")?.scrollTop ?? 0,
  };
  metricsState.loading = true;
  // Auto-refresh skips the loading flash so the page stays visually stable.
  if (options.showLoading !== false) renderMetricsDialog();
  api("/api/target-metrics", {
    method: "POST",
    body: JSON.stringify({
      targetUrl: metricsState.url,
      ...(metricsState.apiKey === "" ? {} : { apiKey: metricsState.apiKey }),
    }),
  })
    .then((data) => {
      metricsState.loading = false;
      metricsState.status = data.status ?? 0;
      metricsState.durationMs = data.durationMs ?? 0;
      metricsState.truncated = data.truncated === true;
      metricsState.error = data.ok ? null : data.error || "unknown error";
      metricsState.text = data.ok ? data.text || "" : "";
      metricsState.families = data.ok ? parsePrometheusMetrics(metricsState.text) : [];
      metricsState.familyByName = new Map(metricsState.families.map((f) => [f.name, f]));
    })
    .catch((error) => {
      metricsState.loading = false;
      metricsState.error = error instanceof Error ? error.message : String(error);
      metricsState.text = "";
      metricsState.families = [];
      metricsState.familyByName = new Map();
    })
    .finally(() => {
      renderMetricsDialog();
      // Re-rendering replaces the bodies; put the user back where they were.
      const dashboard = $("metricsDashboard");
      const list = $("metricsList");
      if (dashboard) dashboard.scrollTop = metricsState.scrollY.dashboard;
      if (list) list.scrollTop = metricsState.scrollY.list;
      syncMetricsRefreshCountdown();
    });
}
/**
 * Attaches the metrics dialog's listeners: close, refresh, auto-refresh interval, the two
 * view switches, the filter input and the captured `toggle` events that remember which
 * Prometheus families were open across a filter re-render.
 * @returns {void}
 */
export function mountMetrics() {
  requiredTyped("#metricsClose", HTMLButtonElement).addEventListener("click", () =>
    requiredDialog("metricsDialog").close(),
  );
  requiredDialog("metricsDialog").addEventListener("close", stopMetricsAutoRefresh);
  requiredTyped("#metricsRefresh", HTMLButtonElement).addEventListener("click", () =>
    loadTargetMetrics(),
  );
  requiredTyped("#metricsRefreshInterval", HTMLSelectElement)?.addEventListener(
    "change",
    (event) => {
      const select = event.target;
      if (!(select instanceof HTMLSelectElement)) return;
      startMetricsAutoRefresh(Number(select.value) || 0);
      syncMetricsRefreshCountdown();
    },
  );
  requiredTyped("#metricsViewDashboard", HTMLButtonElement).addEventListener("click", () => {
    metricsState.view = "dashboard";
    renderMetricsDialog();
  });
  requiredTyped("#metricsViewList", HTMLButtonElement).addEventListener("click", () => {
    metricsState.view = "list";
    renderMetricsDialog();
  });
  requiredTyped("#metricsFilter", HTMLInputElement).addEventListener("input", () => {
    metricsState.filter = requiredTyped("#metricsFilter", HTMLInputElement).value;
    renderMetricsDialog();
  });
  // The `toggle` event does not bubble, so family open/collapse state must be
  // captured (not bubbled) on the container to survive filter re-renders.
  $("metricsListBody").addEventListener(
    "toggle",
    (event) => {
      const el = asElement(event.target);
      if (!(el instanceof HTMLDetailsElement)) return;
      const name = el.dataset.metricsFamily;
      if (typeof name !== "string" || name === "") return;
      if (el.open) metricsState.openFamilies[name] = true;
      else delete metricsState.openFamilies[name];
    },
    true,
  );
}

/**
 * Stops the auto-refresh timer. The dialog's `close` event also stops it, but a page
 * unload never fires one, and a timer that outlived the page would keep fetching metrics.
 * @returns {void}
 */
export function disposeMetrics() {
  stopMetricsAutoRefresh();
}
