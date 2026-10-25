import { requiredTyped } from "./dom.js";
// LLM Proxy admin UI -- request history: log group list, selection, detail prefetch, summaries.
// ES module: imports the shared bootstrap (./core.js), the money display helpers, the JSON
// panes it feeds, and the task-detail panel a group header opens.

import {
  $,
  api,
  asElement,
  closestFrom,
  qsa,
  requiredDialog,
  qsOn,
  registerLanguagePanel,
  state,
  t,
  toast,
} from "./core.js";
import { renderJsonPane, renderMetaPane, updateResponseTiming } from "./json-pane.js";
import { formatGroupCost, formatRequestCost } from "./money.js";
import { escapeHtml } from "./text.js";
import { displayTimestampParts } from "./time.js";
import { formatDecodeSpeed, optionalFiniteNumber } from "./numbers.js";
import {
  closeTaskPricing,
  refreshTaskPricingPanel,
  renderRequestPricing,
  renderTaskPricingPanel,
  showTaskPricing,
} from "./task-detail.js";

// Redraw on language change. The sequence mirrors the order the switch used to
// call these in by hand; see registerLanguagePanel in ./core.js.
registerLanguagePanel("logs", 20, () => {
  renderLogs();
  // The select-all label flips to "clear selected" while every group is selected, and it
  // carries a data-i18n attribute, so the dictionary pass alone would put the wrong text back.
  updateSelectAllLogsButton();
});
registerLanguagePanel("metaPanes", 40, () => {
  renderMetaPane("request");
  renderMetaPane("response");
});

function logMetricHtml(className, label, value, title = label) {
  return `<span class="log-metric ${className}" title="${escapeHtml(title)}">
    <span class="log-metric-label">${escapeHtml(label)}</span>
    <strong class="log-metric-value">${escapeHtml(value)}</strong>
  </span>`;
}
function logItemMetricsHtml(item) {
  const metrics = [];
  const messageCount = optionalFiniteNumber(item.message_count);
  const requestTokenCount = optionalFiniteNumber(item.request_token_count);
  const responseTokenCount = optionalFiniteNumber(item.response_token_count);
  if (messageCount !== null) {
    metrics.push(logMetricHtml("messages", t("messages"), messageCount));
  }
  if (requestTokenCount !== null || responseTokenCount !== null) {
    metrics.push(
      logMetricHtml(
        "request-tokens",
        t("request"),
        requestTokenCount ?? "-",
        `${t("request")} ${t("tokens")}`,
      ),
      logMetricHtml(
        "response-tokens",
        t("response"),
        responseTokenCount ?? "-",
        `${t("response")} ${t("tokens")}`,
      ),
    );
  }
  const decodeSpeed = formatDecodeSpeed(item.decode_speed_tps);
  const endToEndSpeed = formatDecodeSpeed(item.end_to_end_speed_tps);
  if (decodeSpeed === "" && endToEndSpeed !== "") {
    metrics.push(
      logMetricHtml(
        "end-to-end-speed",
        state.language === "en" ? "E2E" : t("endToEndSpeed"),
        `${endToEndSpeed}t/s`,
        t("endToEndSpeed"),
      ),
    );
  }
  if (decodeSpeed !== "") {
    metrics.push(logMetricHtml("decode-speed", t("speed"), `${decodeSpeed}t/s`, t("speed")));
  }
  metrics.push(logMetricHtml("cost", t("cost"), formatRequestCost(item.cost), t("cost")));
  return (
    metrics.join("") ||
    `<span class="log-item-empty">${escapeHtml(formatStatus(item.status))}</span>`
  );
}

/**
 * A record whose response has not arrived yet. The server leaves the status out until the
 * exchange finishes, so "no status" and the literal "pending" are the same state.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isPendingStatus(status) {
  return status === undefined || status === null || status === "pending";
}

/**
 * @param {unknown} status
 * @returns {string}
 */
export function formatStatus(status) {
  return isPendingStatus(status) ? t("pending") : String(status);
}

/**
 * The CSS class of a status chip: pending, success for 2xx/3xx, error from 400 up.
 * @param {unknown} status
 * @returns {string}
 */
export function logStatusClass(status) {
  if (isPendingStatus(status)) return "pending";
  const code = Number(status);
  if (Number.isFinite(code) && code >= 200 && code < 400) return "success";
  if (Number.isFinite(code) && code >= 400) return "error";
  return "neutral";
}

function logGroupTimeHtml(group) {
  const start = displayTimestampParts(group.started_at);
  const activity = displayTimestampParts(group.last_activity_at);
  const fallback = group.started_at || group.last_activity_at || group.id || group.taskLabel;
  if (!start.date && !activity.date) {
    return `<span class="log-group-time-fallback">${escapeHtml(fallback)}</span>`;
  }
  const primary = start.date ? start : activity;
  const activityText =
    activity.date && activity.date !== primary.date
      ? `${activity.shortDate} ${activity.time}`
      : activity.time;
  const range = [
    primary.time ? `<span>${escapeHtml(primary.time)}</span>` : "",
    primary.time && activityText ? '<span class="log-time-arrow" aria-hidden="true">→</span>' : "",
    activityText ? `<span>${escapeHtml(activityText)}</span>` : "",
  ].join("");
  return `<span class="log-group-time" title="${escapeHtml([group.started_at, group.last_activity_at].filter(Boolean).join(" - "))}">
    <span class="log-group-date">${escapeHtml(primary.shortDate)}</span>
    <span class="log-time-range">${range}</span>
  </span>`;
}

function logGroupFactsHtml(group) {
  const decodeSpeed = group.decodeSpeed;
  const decodeSpeedTip = group.decodeSpeedTip;
  const cost = group.costText;
  const costHtml =
    cost === "—"
      ? `<span class="log-group-cost log-fact-empty">—</span>`
      : `<span class="log-group-cost">${escapeHtml(cost)}</span>`;
  return `<span class="log-group-facts">
    <span class="log-group-fact-line">${group.model ? `<span class="log-model" title="${escapeHtml(group.model)}">${escapeHtml(group.model)}</span>` : ""}<span class="log-request-count"><strong>${escapeHtml(group.request_count ?? 0)}</strong> ${escapeHtml(group.requestsLabel)}</span>${decodeSpeed ? `<span class="log-group-decode-speed" title="${escapeHtml(decodeSpeedTip)}">${escapeHtml(decodeSpeed)}t/s</span>` : ""}${costHtml}</span>
    <span class="log-group-fact-line log-target" title="${escapeHtml(group.target || "")}">${escapeHtml(group.target || "—")}</span>
  </span>`;
}
async function exportLogs() {
  const res = await fetch("/api/logs/export");
  if (!res.ok) throw new Error(res.statusText);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "llm-proxy-logs.zip";
  link.click();
  URL.revokeObjectURL(url);
  toast(t("exportedLogs"));
}
async function cleanupLogs() {
  const groupIds = Object.keys(state.selectedLogGroups).filter(
    (groupId) => state.selectedLogGroups[groupId],
  );
  if (!groupIds.length) {
    toast(t("noSelectedLogs"));
    return;
  }
  const data = await api("/api/logs/cleanup", {
    method: "POST",
    body: JSON.stringify({ group_ids: groupIds }),
  });
  state.logOffset = 0;
  state.logGroups = [];
  state.logs = [];
  state.selectedLogGroups = {};
  await loadLogs();
  toast(`${t("cleanedLogs")}: ${data.deleted_count || 0}`);
}
// Removes every task in the whole list (all pages, current search included)
// whose group contains exactly one request.
async function cleanupSingleRequestLogs() {
  const button = requiredTyped("#cleanupSingleRequestLogs", HTMLButtonElement);
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = t("cleaningSingleRequestLogs");
  $("logListProgress").hidden = false;
  try {
    const q = encodeURIComponent(state.logQuery);
    const limit = 100;
    let offset = 0;
    const groupIds = [];
    for (;;) {
      const data = await api(`/api/logs?q=${q}&limit=${limit}&offset=${offset}`);
      for (const group of data.groups || []) {
        if (group.request_count === 1) groupIds.push(group.id);
      }
      if (!data.has_more || !data.next_offset) break;
      offset = data.next_offset;
    }
    if (!groupIds.length) {
      toast(t("noSingleRequestLogs"));
      return;
    }
    const data = await api("/api/logs/cleanup", {
      method: "POST",
      body: JSON.stringify({ group_ids: groupIds }),
    });
    state.logOffset = 0;
    state.logGroups = [];
    state.logs = [];
    state.selectedLogGroups = {};
    await loadLogs();
    toast(`${t("cleanedLogs")}: ${data.deleted_count || 0}`);
  } finally {
    $("logListProgress").hidden = true;
    button.disabled = false;
    button.textContent = t("cleanupSingleRequestLogs");
  }
}
function scheduleLogRefresh(delay = 3000) {
  if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
  if (!requiredTyped("#autoRefreshLogs", HTMLInputElement).checked) return;
  state.refreshTimer = setTimeout(() => {
    if (state.splitterDragging || document.hidden || !$("logs").classList.contains("active")) {
      scheduleLogRefresh(delay);
      return;
    }
    // A search query deliberately freezes the result list, but the task-detail
    // panel describes a single task rather than that result set, so it keeps
    // refreshing on the same cadence (a no-op when no panel is open).
    if (state.logQuery !== "") {
      refreshTaskPricingPanel().catch(() => {});
      scheduleLogRefresh(delay);
      return;
    }
    loadLogs({ quiet: true }).catch((e) => toast(e.message));
  }, delay);
}
function allLogGroupsSelected() {
  return (
    state.logGroups.length > 0 &&
    state.logGroups.every((group) => state.selectedLogGroups[group.id])
  );
}
function updateSelectAllLogsButton() {
  requiredTyped("#selectAllLogs", HTMLButtonElement).textContent = t(
    allLogGroupsSelected() ? "clearSelectedLogs" : "selectAllLogs",
  );
}
function toggleSelectAllLogs() {
  const selectAll = !allLogGroupsSelected();
  state.logGroups.forEach((group) => {
    state.selectedLogGroups[group.id] = selectAll;
  });
  renderLogs();
}
function logGroupsSignature(groups) {
  return (groups || []).map((group) => logGroupSummarySignature(group)).join("\n");
}
function logGroupSummarySignature(group) {
  return [
    group.id,
    group.dir,
    group.started_at,
    group.last_activity_at,
    group.model,
    group.request_count,
    group.decode_speed_tps,
    group.target,
    group.cost?.known_amount,
    group.cost?.priced_request_count,
    group.cost?.unpriced_request_count,
    group.cost?.pending_request_count,
  ].join("|");
}
function sameLogGroups(nextGroups) {
  return logGroupsSignature(state.logGroups) === logGroupsSignature(nextGroups);
}
function mergeLogGroupSummaries(currentGroups, nextGroups, query = "", options = {}) {
  const currentById = new Map(currentGroups.map((group) => [group.id, group]));
  const merged = nextGroups.map((group) => {
    const existing = currentById.get(group.id);
    if (!existing) return group;
    const summaryChanged =
      logGroupSummarySignature(existing) !== logGroupSummarySignature(group) ||
      (existing.searchQuery ?? "") !== query;
    return {
      ...group,
      logs: summaryChanged ? group.logs : existing.logs,
      logsLoaded: summaryChanged ? group.logsLoaded : existing.logsLoaded,
      logsHasMore: summaryChanged ? group.logsHasMore : existing.logsHasMore,
      logsTotal: summaryChanged ? group.logsTotal : existing.logsTotal,
      logsOffset: summaryChanged ? group.logsOffset : existing.logsOffset,
      searchQuery: summaryChanged ? group.searchQuery : existing.searchQuery,
    };
  });
  // A truncated page only describes the first rows of the list; the groups the
  // user already paged past have to be carried over instead of dropped.
  if (options.keepMissing) {
    const returnedIds = new Set(nextGroups.map((group) => group.id));
    merged.push(...currentGroups.filter((group) => !returnedIds.has(group.id)));
  }
  return merged;
}
// The /api/logs page schema rejects a limit above this, so an automatic refresh
// must never ask for more rows than the API can return in one page.
const LOG_GROUP_PAGE_MAX_LIMIT = 500;
export async function loadLogs(options = {}) {
  if (state.logsLoading) {
    // Coalesce instead of dropping: a click on 刷新/加载更多 while a (possibly
    // slow) load is in flight still runs as soon as that load settles, so the
    // list never looks dead. An explicit request outranks a queued automatic
    // tick, but an automatic tick never replaces an explicit one.
    if (state.logsQueued === null || options.append || options.search) state.logsQueued = options;
    return;
  }
  state.logsLoading = true;
  const showSearchProgress = Boolean(options.search) || !options.quiet;
  if (showSearchProgress) $("logListProgress").hidden = false;
  const q = encodeURIComponent(state.logQuery);
  try {
    const offset = options.append ? state.logOffset : 0;
    // An automatic refresh has to re-read every group already on screen so it
    // never drops the pages the user loaded, but the API caps a page at 500.
    const limit =
      options.quiet && !options.append
        ? Math.min(
            LOG_GROUP_PAGE_MAX_LIMIT,
            Math.max(state.logLimit, state.logOffset || state.logGroups.length),
          )
        : state.logLimit;
    const data = await api(`/api/logs?q=${q}&limit=${limit}&offset=${offset}`);
    if (q !== encodeURIComponent(state.logQuery)) return;
    const nextGroups = (data.groups || []).map(({ preview, ...group }) =>
      preview
        ? {
            ...group,
            logs: preview.logs,
            logsLoaded: true,
            logsHasMore: preview.has_more,
            logsTotal: preview.total,
            logsOffset: preview.next_offset,
            searchQuery: state.logQuery,
          }
        : group,
    );
    state.logOffset = data.next_offset || state.logGroups.length;
    state.logsHasMore = Boolean(data.has_more);
    state.logsTotal = Number(data.total || state.logs.length);
    let rendered = false;
    if (options.append) {
      const mergeResult = appendLogGroups(state.logGroups, nextGroups);
      state.logGroups = mergeResult.groups;
      state.logs = state.logGroups.flatMap((group) => group.logs || []);
      renderLogs();
      rendered = true;
    } else if (state.lastLogQuery !== state.logQuery || !sameLogGroups(nextGroups)) {
      const keepMissing = options.quiet === true && Boolean(data.has_more);
      state.logGroups = mergeLogGroupSummaries(state.logGroups, nextGroups, state.logQuery, {
        keepMissing,
      });
      // A page that stopped at the cap continues after everything the list
      // already holds, not after the rows the API returned.
      if (keepMissing) state.logOffset = state.logGroups.length;
      state.logs = state.logGroups.flatMap((group) => group.logs || []);
      renderLogs();
      rendered = true;
      state.logGroups
        .filter((group) => state.collapsedGroups[group.id] && !group.logsLoaded)
        .forEach((group) => loadLogGroup(group.id).catch((e) => toast(e.message)));
    }
    if (!rendered) renderLogs();
    if (state.activeTaskPricing) {
      if (!state.logGroups.some((group) => group.id === state.activeTaskPricing)) {
        state.taskPricingAbort?.abort();
        state.taskPricing = {
          id: state.activeTaskPricing,
          loading: false,
          error: "deleted",
          data: null,
        };
        renderTaskPricingPanel();
      } else {
        refreshTaskPricingPanel().catch(() => {});
      }
    }
    state.logsLoadedAt = Date.now();
    state.lastLogQuery = state.logQuery;
    try {
      const refreshedPendingIds = await refreshPendingLogItems();
      if (!refreshedPendingIds.has(state.selected)) await refreshSelectedLogDetail();
    } catch (e) {
      if (!options.quiet) toast(e.message);
    }
  } finally {
    if (showSearchProgress) $("logListProgress").hidden = true;
    state.logsLoading = false;
    if (q !== encodeURIComponent(state.logQuery)) {
      loadLogs({ search: showSearchProgress }).catch((e) => toast(e.message));
    } else if (state.logsQueued !== null) {
      const queued = state.logsQueued;
      state.logsQueued = null;
      loadLogs(queued).catch((e) => toast(e.message));
    } else {
      scheduleLogRefresh();
    }
  }
}
// A refresh tick re-reads one bounded slice of the pending rows with only a few
// requests in flight, and rotates through the whole pending set across ticks.
// Re-reading every pending row at once put hundreds of detail requests on the
// wire every few seconds whenever a large task was expanded, which saturated the
// browser's per-host connection pool and left the user's own clicks waiting.
const PENDING_REFRESH_BATCH = 24;
function nextPendingRefreshBatch(pendingItems) {
  const size = Math.min(PENDING_REFRESH_BATCH, pendingItems.length);
  if (size === 0) {
    state.pendingSweepCursor = 0;
    return [];
  }
  const cursor = state.pendingSweepCursor % pendingItems.length;
  const batch = Array.from({ length: size }, (_, index) => {
    return pendingItems[(cursor + index) % pendingItems.length];
  });
  state.pendingSweepCursor = (cursor + size) % pendingItems.length;
  return batch;
}
async function refreshPendingLogItems() {
  const pendingItems = state.logGroups
    .filter((group) => group.logsLoaded && state.collapsedGroups[group.id])
    .flatMap((group) => group.logs || [])
    .filter((item) => isPendingStatus(item.status));
  const batch = nextPendingRefreshBatch(pendingItems);
  const refreshedIds = new Set();
  let listChanged = false;
  if (batch.length === 0) return refreshedIds;
  // One batched read instead of one detail request per row: the detail endpoint
  // inflates every stored body chunk of a record, which blocked the event loop
  // for 14-23 ms per row while requests were in flight.
  let records;
  try {
    const query = new URLSearchParams({ ids: batch.map((item) => item.id).join(",") }).toString();
    const data = await api(`/api/logs/records?${query}`);
    records = Array.isArray(data?.records) ? data.records : [];
  } catch (error) {
    console.warn("pending records refresh failed", error);
    return refreshedIds;
  }
  const rowsById = new Map(batch.map((item) => [item.id, item]));
  records.forEach((record) => {
    if (!record || typeof record.id !== "string") return;
    refreshedIds.add(record.id);
    const item = rowsById.get(record.id);
    if (!item || record.pending) return;
    /** @type {Array<[keyof typeof item, unknown]>} */
    const changedFields = [
      ["message_count", record.message_count],
      ["status", record.status],
      ["request_token_count", record.request_token_count],
      ["response_token_count", record.response_token_count],
      ["decode_speed_tps", record.decode_speed_tps],
      ["end_to_end_speed_tps", record.end_to_end_speed_tps],
    ];
    const changed = changedFields.some(
      ([key, value]) => value !== undefined && item[key] !== value,
    );
    const costChanged =
      record.cost !== undefined && JSON.stringify(item.cost) !== JSON.stringify(record.cost);
    if (changed || costChanged) listChanged = true;
    item.message_count = record.message_count ?? item.message_count;
    item.status = record.status ?? item.status;
    item.request_token_count = record.request_token_count ?? item.request_token_count;
    item.response_token_count = record.response_token_count ?? item.response_token_count;
    item.decode_speed_tps = record.decode_speed_tps ?? item.decode_speed_tps;
    item.end_to_end_speed_tps = record.end_to_end_speed_tps ?? item.end_to_end_speed_tps;
    item.cost = record.cost ?? item.cost;
  });
  // The selected record still needs its own detail request: batch rows carry no
  // bodies, and only the detail endpoint can grow or replace the JSON panes
  // while a request is in flight.
  refreshedIds.delete(state.selected);
  if (listChanged) {
    state.logs = state.logGroups.flatMap((group) => group.logs || []);
    renderLogs();
  }
  return refreshedIds;
}
function appendLogGroups(currentGroups, nextGroups) {
  const merged = currentGroups.map((group) => ({ ...group, logs: [...(group.logs || [])] }));
  const byId = new Map(merged.map((group) => [group.id, group]));
  const addedGroupIds = new Set();
  nextGroups.forEach((group) => {
    const existing = byId.get(group.id);
    if (!existing) {
      const copied = { ...group, logs: [...(group.logs || [])] };
      merged.push(copied);
      byId.set(group.id, copied);
      if ((copied.logs || []).length) addedGroupIds.add(copied.id);
      return;
    }
    Object.assign(existing, { ...group, logs: existing.logs, logsLoaded: existing.logsLoaded });
  });
  return { groups: merged, addedGroupIds };
}
async function loadLogGroup(groupId) {
  const group = state.logGroups.find((item) => item.id === groupId);
  if (!group || state.loadingLogGroups[groupId]) return;
  if (group.logsLoaded && (group.searchQuery ?? "") === state.logQuery) return;
  state.loadingLogGroups[groupId] = true;
  renderLogs();
  try {
    const q = encodeURIComponent(state.logQuery);
    const data = await api(
      `/api/log-groups/${encodeURIComponent(groupId)}/logs?q=${q}&limit=200&offset=0`,
    );
    group.logs = data.logs || [];
    group.logsLoaded = true;
    group.logsHasMore = Boolean(data.has_more);
    group.logsTotal = Number(data.total || group.logs.length);
    group.logsOffset = Number(data.next_offset ?? group.logs.length);
    group.searchQuery = state.logQuery;
    state.logs = state.logGroups.flatMap((item) => item.logs || []);
  } finally {
    delete state.loadingLogGroups[groupId];
    renderLogs();
  }
}
async function loadMoreLogGroup(groupId) {
  const group = state.logGroups.find((item) => item.id === groupId);
  if (!group || !group.logsLoaded || !group.logsHasMore || state.loadingMoreLogGroups[groupId]) {
    return;
  }
  state.loadingMoreLogGroups[groupId] = true;
  renderLogs();
  try {
    const q = encodeURIComponent(state.logQuery);
    const offset = Number(group.logsOffset ?? (group.logs || []).length);
    const data = await api(
      `/api/log-groups/${encodeURIComponent(groupId)}/logs?q=${q}&limit=100&offset=${offset}`,
    );
    const existingIds = new Set((group.logs || []).map((item) => item.id));
    group.logs = [
      ...(group.logs || []),
      ...(data.logs || []).filter((item) => !existingIds.has(item.id)),
    ];
    group.logsHasMore = Boolean(data.has_more);
    group.logsTotal = Number(data.total || group.logs.length);
    group.logsOffset = Number(data.next_offset ?? offset + (data.logs || []).length);
    state.logs = state.logGroups.flatMap((item) => item.logs || []);
  } finally {
    delete state.loadingMoreLogGroups[groupId];
    renderLogs();
  }
}
function logGroupBodyHtml(group) {
  const logs = group.items;
  return group.loading || (!group.loaded && !logs.length)
    ? `<div class="log-item log-loading">${escapeHtml(group.labels.loading)}</div>`
    : logs.length
      ? logs
          .map(
            (item) => `
        <button class="log-item ${item.selected ? "active" : ""}" data-log-id="${escapeHtml(item.id)}">
          <span class="log-sequence">${escapeHtml(item.sequence ? `#${item.sequence}` : "-")}</span>
          <span class="log-item-content">
            <span class="log-item-metrics">${item.metricsHtml}</span>
            <span class="log-item-subline">
              <span class="log-timestamp">${escapeHtml(item.timestamp || "")}</span>${item.has_summary ? `<span class="log-summary-star" title="${escapeHtml(group.labels.summaryStar)}" aria-label="${escapeHtml(group.labels.summaryStar)}">★</span>` : ""}${(() => {
                const statusClass = item.statusClass;
                const statusLabel = item.statusLabel;
                if (statusClass === "success") return "";
                return `<span class="log-status ${statusClass}" title="${escapeHtml(statusLabel)}" aria-label="${escapeHtml(statusLabel)}"><span class="log-status-dot" aria-hidden="true"></span>${escapeHtml(statusLabel)}</span>`;
              })()}
            </span>
          </span>
        </button>`,
          )
          .join("") +
        (group.hasMore
          ? `<button class="load-more log-group-load-more" data-load-more-records="${escapeHtml(group.id || "")}" ${group.loadingMore ? "disabled" : ""}>${escapeHtml(group.loadingMore ? group.labels.loading : group.labels.loadMore)} (${logs.length}/${group.total})</button>`
          : "")
      : `<div class="log-item log-group-empty">${escapeHtml(group.labels.noMatchedLogs)}</div>`;
}
function logGroupSectionHtml(group) {
  return `
    <section class="log-group">
      <div class="log-group-head" data-group-id="${escapeHtml(group.id || "")}" role="button" tabindex="0" aria-label="${escapeHtml(group.labels.viewTaskPricing)}">
        <div class="log-group-controls">
          <input class="log-group-select" type="checkbox" data-select-group="${escapeHtml(group.id || "")}" title="${escapeHtml(group.labels.selectLogGroup)}" ${group.selected ? "checked" : ""}>
          <button type="button" class="log-group-caret" data-group-toggle="${escapeHtml(group.id || "")}" title="${escapeHtml(group.labels.toggleTaskRecords)}" aria-label="${escapeHtml(group.labels.toggleTaskRecords)}" aria-expanded="${group.expanded ? "true" : "false"}">${!group.expanded ? "▸" : "▾"}</button>
        </div>
        <div class="log-group-summary">
          ${logGroupTimeHtml(group.summary)}
          ${logGroupFactsHtml(group.summary)}
        </div>
      </div>
      ${
        !group.expanded
          ? ""
          : `<div class="log-group-body">
            ${logGroupBodyHtml(group)}
          </div>`
      }
    </section>`;
}
// Everything a task section renders from: the summary facts plus the flags that
// decide its body (expanded, loading, selected row). A refresh only rebuilds the
// sections whose signature changed, so the rest of the list keeps its DOM nodes.
function logItemRenderInput(item) {
  return {
    id: item.id,
    sequence: item.sequence,
    timestamp: item.timestamp,
    statusClass: logStatusClass(item.status),
    statusLabel: formatStatus(item.status),
    metricsHtml: logItemMetricsHtml(item),
    has_summary: Boolean(item.has_summary),
    selected: state.selected === item.id,
  };
}
function logGroupRenderInput(group) {
  return {
    id: group.id,
    summary: {
      id: group.id,
      started_at: group.started_at,
      last_activity_at: group.last_activity_at,
      model: group.model,
      request_count: group.request_count,
      target: group.target,
      decodeSpeed: formatDecodeSpeed(group.decode_speed_tps),
      decodeSpeedTip: `${t("avgDecodeSpeed")}: ${t("avgDecodeSpeedTip")}`,
      costText: formatGroupCost(group.cost),
      taskLabel: t("task"),
      requestsLabel: t("requests"),
    },
    labels: Object.fromEntries(
      [
        "loading",
        "summaryStar",
        "loadMore",
        "noMatchedLogs",
        "viewTaskPricing",
        "selectLogGroup",
        "toggleTaskRecords",
      ].map((key) => [key, t(key)]),
    ),
    selected: Boolean(state.selectedLogGroups[group.id]),
    expanded: Boolean(state.collapsedGroups[group.id]),
    loading: Boolean(state.loadingLogGroups[group.id]),
    loadingMore: Boolean(state.loadingMoreLogGroups[group.id]),
    loaded: Boolean(group.logsLoaded),
    hasMore: Boolean(group.logsHasMore),
    total: group.logsTotal,
    items: (group.logs || []).map(logItemRenderInput),
  };
}
function logGroupRenderSignature(input) {
  return JSON.stringify(input);
}
function logListTailHtml() {
  return state.logsHasMore
    ? `<button class="load-more" data-load-more>${escapeHtml(t("loadMore"))} (${state.logGroups.length}/${state.logsTotal})</button>`
    : "";
}
// Re-key the signature cache after a whole-list write so the next render can
// still patch individual sections instead of replacing everything again.
function seedLogSections(groups, tailHtml) {
  state.logSections = new Map(groups.map((group) => [group.id, logGroupRenderSignature(group)]));
  state.logTailHtml = tailHtml;
}
function logSectionNodes(list) {
  const sections = new Map();
  for (const node of list.children) {
    if (!node.classList.contains("log-group")) continue;
    const head = qsOn(node, ".log-group-head[data-group-id]");
    const id = head === null ? "" : head.dataset.groupId || "";
    if (id !== "") sections.set(id, node);
  }
  return sections;
}
function renderLogs() {
  updateSelectAllLogsButton();
  const list = $("logItems");
  const groups = state.logGroups.map(logGroupRenderInput);
  const tailHtml = logListTailHtml();
  // A task without an id cannot be keyed, so the whole list is rebuilt for it.
  const keyed = groups.every((group) => typeof group.id === "string" && group.id !== "");
  if (groups.length === 0 || !keyed) {
    list.innerHTML =
      (groups.map((group) => logGroupSectionHtml(group)).join("") ||
        `<div class="empty">${escapeHtml(t("noLogs"))}</div>`) + tailHtml;
    seedLogSections(groups, tailHtml);
    return;
  }
  const sections = logSectionNodes(list);
  const rendered = state.logSections;
  const ids = groups.map((group) => group.id);
  const listChanged =
    ids.join("\u0000") !== [...sections.keys()].join("\u0000") || tailHtml !== state.logTailHtml;
  sections.forEach((node, id) => {
    if (ids.includes(id)) return;
    node.remove();
    rendered.delete(id);
  });
  qsOn(list, ".empty")?.remove();
  groups.forEach((group) => {
    const id = group.id;
    const signature = logGroupRenderSignature(group);
    if (rendered.get(id) === signature && sections.has(id)) return;
    const template = document.createElement("template");
    template.innerHTML = logGroupSectionHtml(group);
    const section = template.content.firstElementChild;
    if (section === null) throw new Error("Log group template must contain an element");
    const existing = sections.get(id);
    if (existing !== undefined) list.replaceChild(section, existing);
    else list.insertBefore(section, qsOn(list, "[data-load-more]"));
    sections.set(id, section);
    rendered.set(id, signature);
  });
  // Newly matched tasks sort to the top, so the DOM order has to follow the
  // list order whenever the two drift apart.
  if (listChanged) {
    ids.forEach((id) => {
      const node = sections.get(id);
      if (node !== undefined) list.appendChild(node);
    });
  }
  if (tailHtml !== state.logTailHtml) {
    state.logTailHtml = tailHtml;
    qsOn(list, "[data-load-more]")?.remove();
    if (tailHtml !== "") {
      const template = document.createElement("template");
      template.innerHTML = tailHtml;
      const tail = template.content.firstElementChild;
      if (tail === null) throw new Error("Log tail template must contain an element");
      list.appendChild(tail);
    }
  }
  // The reordering above can leave the "load more" button behind the sections.
  const tail = qsOn(list, "[data-load-more]");
  if (tail !== null && list.lastElementChild !== tail) list.appendChild(tail);
}
// Top of the log list's scrollport content: border box + client border + the
// container's own padding. A header exactly on this line is neither clipped by
// the scrollport nor offset by sticky positioning.
function logListContentTop(list) {
  return (
    list.getBoundingClientRect().top +
    list.clientTop +
    parseFloat(getComputedStyle(list).paddingTop)
  );
}
// Caret button handler: expands the second level (lazily fetching that
// group's records when they are not loaded yet) or collapses it back to the
// summary row. Header clicks never call this; they only open the detail panel.
async function toggleLogGroupBody(groupId) {
  if (state.collapsedGroups[groupId]) {
    collapseLogGroup(groupId);
    return;
  }
  const list = $("logItems");
  const head = qsOn(list, `.log-group-head[data-group-id="${CSS.escape(groupId)}"]`);
  if (head !== null) {
    // A header that is partly scrolled out cannot stick yet - its collapsed
    // section is too short for the sticky constraint to allow the offset. Once
    // the body is inserted the section is tall enough, the header sticks at the
    // scrollport top, and it paints over the first record by exactly the amount
    // it was clipped. Aligning it with the content top first makes the sticky
    // offset zero, so the second level starts right below the header.
    const clipped = logListContentTop(list) - head.getBoundingClientRect().top;
    if (clipped > 0.5) list.scrollTop -= clipped;
  }
  state.collapsedGroups[groupId] = true;
  renderLogs();
  await loadLogGroup(groupId);
}
// When a group is collapsed while its header is pinned to the top of the log
// list, removing the body would shift the whole list up; compensate by
// scrolling down by the removed height so the header keeps its position.
function collapseLogGroup(groupId) {
  // Note: state.collapsedGroups holds the EXPANDED state (flag set = body
  // visible); collapsing a group clears its flag.
  const list = $("logItems");
  const head = qsOn(list, `.log-group-head[data-group-id="${CSS.escape(groupId)}"]`);
  // Pinned: the header's border box sits at the scrollport content top
  // (list border + padding). At its natural (top of list) position the
  // section's 1 px border pushes it down one more pixel, and while
  // releasing from the pin it sits above the content top; only the pinned
  // state is worth compensating.
  const wasPinned = (() => {
    if (!head) return false;
    const contentTop = logListContentTop(list);
    const headTop = head.getBoundingClientRect().top;
    return headTop >= contentTop - 0.5 && headTop <= contentTop + 0.75;
  })();
  state.collapsedGroups[groupId] = false;
  renderLogs();
  if (wasPinned) {
    // With the body gone the header is the section's first child and sits at
    // its natural (non-sticky) spot, which is above the pinned line. Scroll
    // by exactly that offset so it lands back where it was pinned.
    const newHead = qsOn(list, `.log-group-head[data-group-id="${CSS.escape(groupId)}"]`);
    if (!newHead) return;
    const contentTop =
      list.getBoundingClientRect().top +
      list.clientTop +
      parseFloat(getComputedStyle(list).paddingTop);
    list.scrollTop += newHead.getBoundingClientRect().top - contentTop;
  }
}
function hasFinishedResponseDetail() {
  const meta = state.meta.response;
  if (!meta || typeof meta !== "object") return false;
  return (
    (meta.status !== undefined && meta.status !== null && meta.status !== "") || Boolean(meta.error)
  );
}
function selectedLogNeedsRefresh() {
  return Boolean(state.selected) && !hasFinishedResponseDetail();
}
export function applySelectedLogDetail(data, options = {}) {
  state.raw.request = data.request;
  state.raw.response = data.response;
  state.meta.request = data.request_meta || null;
  state.meta.response = data.response_meta || null;
  state.requestPricing = data.pricing || null;
  if (options.resetView) {
    state.metaOpen.request = false;
    state.metaOpen.response = false;
    state.tree.request = true;
    state.tree.response = true;
    state.formatStrings.request = true;
    state.formatStrings.response = true;
    state.requestPricingOpen = false;
  }
  renderMetaPane("request");
  renderMetaPane("response");
  renderRequestPricing();
  updateResponseTiming();
  renderJsonPane("request", { preserveView: !options.resetView });
  renderJsonPane("response", { preserveView: !options.resetView });
}
// The detail request is most of the time between clicking a row and seeing its
// JSON: for a multi-megabyte body the response alone is ~50 ms, while the tree
// that gets painted is ~35 ms. The pointer sits on a row well before it is
// clicked, so a short hover starts that request early and the click reads the
// payload straight out of this cache.
const logDetailPrefetch = new Map();
const LOG_DETAIL_PREFETCH_LIMIT = 12;
const LOG_DETAIL_PREFETCH_DWELL_MS = 50;
// A multi-megabyte body is mostly image payloads, so a dozen of them are far
// more than the record count suggests; cap the cache by bytes as well.
const LOG_DETAIL_PREFETCH_BYTES = 24 * 1024 * 1024;
function trimLogDetailPrefetch() {
  let bytes = 0;
  for (const entry of logDetailPrefetch.values()) bytes += entry.bytes;
  // A Map keeps insertion order, so the oldest payload is dropped first.
  for (const [id, entry] of logDetailPrefetch) {
    if (logDetailPrefetch.size <= LOG_DETAIL_PREFETCH_LIMIT && bytes <= LOG_DETAIL_PREFETCH_BYTES) {
      break;
    }
    logDetailPrefetch.delete(id);
    bytes -= entry.bytes;
  }
}
async function fetchLogDetail(id) {
  const res = await fetch(`/api/logs/${encodeURIComponent(id)}`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : res.statusText);
  }
  // content-length says what the payload cost and is free to read.
  return { data: payload, bytes: Number(res.headers.get("content-length") || 0) };
}
function prefetchLogDetail(id) {
  if (!id || logDetailPrefetch.has(id)) return;
  // A still-running request keeps growing its body, so a payload fetched now
  // would be stale by the time the row is clicked; let the click read it fresh.
  const item = state.logs.find((log) => log.id === id);
  if (item && isPendingStatus(item.status)) return;
  /** @type {{data: import("../../admin-schemas.js").AdminLogRecordDetail | undefined, bytes: number, promise: Promise<import("../../admin-schemas.js").AdminLogRecordDetail | void> | null}} */
  const entry = { data: undefined, bytes: 0, promise: null };
  logDetailPrefetch.set(id, entry);
  entry.promise = fetchLogDetail(id)
    .then(({ data, bytes }) => {
      entry.data = data;
      entry.bytes = bytes;
      trimLogDetailPrefetch();
      return data;
    })
    .catch(() => {
      if (logDetailPrefetch.get(id) === entry) logDetailPrefetch.delete(id);
    });
}
function cachedLogDetail(id) {
  const entry = logDetailPrefetch.get(id);
  if (!entry) return null;
  if (entry.data !== undefined) return entry.data;
  // The hover request is still in flight: ride on it instead of starting a
  // second one for the same record.
  return entry.promise.then(() => (entry.data === undefined ? null : entry.data));
}
function rememberLogDetail(id, data, bytes) {
  if (!id || data === undefined || data === null) return;
  logDetailPrefetch.set(id, { data, bytes, promise: Promise.resolve(data) });
  trimLogDetailPrefetch();
}
// The highlight is the only thing a row click changes in the list, and a full
// renderLogs costs ~9 ms on a real page, so move the class instead.
function markSelectedLogRow(id) {
  for (const el of qsa("#logItems .log-item")) {
    el.classList.toggle("active", el.dataset.logId === id);
  }
}
async function selectLog(id) {
  closeTaskPricing();
  state.selected = id;
  markSelectedLogRow(id);
  state.selectedLogLoading = true;
  try {
    const cached = cachedLogDetail(id);
    let detail = cached !== null ? await cached : null;
    if (detail === null) {
      // Nothing was prefetched, or the hover request failed: read it now, and
      // keep it so the hover timer that fires right after the click does not
      // ask the server for the same megabytes again.
      const fetched = await fetchLogDetail(id);
      detail = fetched.data;
      rememberLogDetail(id, detail, fetched.bytes);
    }
    if (state.selected !== id) return;
    applySelectedLogDetail(detail, { resetView: true });
    loadSummary(id);
  } finally {
    if (state.selected === id) state.selectedLogLoading = false;
  }
}
function markLogSummarized(id) {
  let changed = false;
  for (const item of state.logs) {
    if (item.id === id && !item.has_summary) {
      item.has_summary = true;
      changed = true;
    }
  }
  if (changed) renderLogs();
}
async function loadSummary(id) {
  try {
    const data = await api(`/api/logs/${encodeURIComponent(id)}/summary`);
    if (state.selected !== id) return;
    renderSummary(data);
    if (data) markLogSummarized(id);
  } catch (error) {
    console.warn("task summary load failed", error);
  }
}
function renderSummary(data, options = {}) {
  if (!data) return;
  const list = (value) =>
    Array.isArray(value)
      ? value
          .filter(
            (item) => (typeof item === "string" && item.trim() !== "") || typeof item === "number",
          )
          .map((item) => String(item))
      : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const segmentHtml = segments
    .map((segment) => {
      const points = list(segment.key_points);
      const evidence = list(segment.evidence);
      return `<article class="summary-segment"><div class="summary-segment-head"><strong>${escapeHtml(String(segment.range || t("stage")))}</strong><span>${escapeHtml(String(segment.summary || ""))}</span></div>${points.length ? `<ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}${evidence.length ? `<div class="summary-evidence">${escapeHtml(t("evidence"))}${evidence.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</div>` : ""}</article>`;
    })
    .join("");
  const section = (title, values, className) =>
    values.length
      ? `<section class="summary-list ${className}"><h4>${title}</h4><ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`
      : "";
  $("summaryContent").innerHTML =
    `<div class="summary-title">${escapeHtml(String(data.title || t("summaryDialogTitle")))}</div><p class="summary-overview">${escapeHtml(String(data.overview || ""))}</p><div class="summary-segments">${segmentHtml}</div>${section(t("decisions"), list(data.decisions), "summary-decisions")}${section(t("issues"), list(data.issues), "summary-issues")}`;
  if (options.open && !requiredDialog("summaryPanel").open)
    requiredDialog("summaryPanel").showModal();
}
async function refreshSelectedLogDetail() {
  const id = state.selected;
  if (
    !id ||
    state.selectedLogLoading ||
    state.selectedLogRefreshLoading ||
    !selectedLogNeedsRefresh()
  )
    return;
  state.selectedLogRefreshLoading = true;
  try {
    const fetched = await fetchLogDetail(id);
    if (state.selected !== id) return;
    // Keep the prefetched payload in step with what this refresh just read, so
    // clicking the row again does not show a body that has since stopped growing.
    rememberLogDetail(id, fetched.data, fetched.bytes);
    applySelectedLogDetail(fetched.data, { resetView: false });
  } finally {
    state.selectedLogRefreshLoading = false;
  }
}
function runLogSearch() {
  state.logQuery = requiredTyped("#logSearch", HTMLInputElement).value.trim();
  requiredTyped("#autoRefreshLogs", HTMLInputElement).disabled = state.logQuery !== "";
  state.logGroups = [];
  state.logs = [];
  state.logOffset = 0;
  state.logsHasMore = false;
  state.logsTotal = 0;
  state.selectedLogGroups = {};
  loadLogs({ search: true }).catch((e) => toast(e.message));
}
// Hover intent: a row that is merely passed over does not get a detail request,
// a row the pointer rests on does, so sweeping a long list stays cheap.
let hoverPrefetchId = null;
let hoverPrefetchTimer = null;

/**
 * Attaches every listener the history list owns: the toolbar (refresh, search, export,
 * cleanup, select-all, auto refresh), the delegated list clicks and keyboard activation,
 * the hover/press detail prefetch and the summary dialog. Nothing runs at import time.
 * @returns {void}
 */
export function mountHistory() {
  requiredTyped("#summarizeRecord", HTMLButtonElement)?.addEventListener("click", async () => {
    const button = requiredTyped("#summarizeRecord", HTMLButtonElement);
    if (!state.selected) {
      toast("请先选择一条请求");
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "…";
    try {
      const existing = await api(`/api/logs/${encodeURIComponent(state.selected)}/summary`);
      if (existing) {
        if (requiredDialog("summaryPanel").open) {
          requiredDialog("summaryPanel").close();
          return;
        }
        renderSummary(existing, { open: true });
        markLogSummarized(state.selected);
        return;
      }
      const result = await api(`/api/logs/${encodeURIComponent(state.selected)}/summary`, {
        method: "POST",
      });
      renderSummary(result, { open: true });
      markLogSummarized(state.selected);
      toast(t("summaryGenerated"));
    } catch (e) {
      if (
        String(e.message || "")
          .toLowerCase()
          .includes("not configured")
      ) {
        toast(t("summaryModelRequired"));
        document.getElementById("summaryModelSettings")?.click();
      } else toast(e.message);
    } finally {
      button.disabled = false;
      button.textContent = "✨";
    }
  });
  requiredTyped("#refreshLogs", HTMLButtonElement).addEventListener("click", () =>
    loadLogs().catch((e) => toast(e.message)),
  );
  requiredTyped("#searchLogs", HTMLButtonElement).addEventListener("click", runLogSearch);
  requiredTyped("#logSearch", HTMLInputElement).addEventListener("keydown", (event) => {
    if (event.key === "Enter") runLogSearch();
  });
  requiredTyped("#exportLogs", HTMLButtonElement).addEventListener("click", () =>
    exportLogs().catch((e) => toast(e.message)),
  );
  requiredTyped("#cleanupLogs", HTMLButtonElement).addEventListener("click", () =>
    cleanupLogs().catch((e) => toast(e.message)),
  );
  requiredTyped("#cleanupSingleRequestLogs", HTMLButtonElement).addEventListener("click", () =>
    cleanupSingleRequestLogs().catch((e) => toast(e.message)),
  );
  requiredTyped("#summaryModelSettings", HTMLButtonElement).addEventListener("click", async () => {
    const current = await api("/api/settings/summary-model").catch(() => null);
    const base = current || {
      api_type: "openai_chat",
      disable_reasoning: true,
      target_url: "",
      api_key: "",
      model: "",
      target_headers: [],
      timeout_ms: 180000,
    };
    requiredTyped("#summaryApiType", HTMLSelectElement).value = base.api_type;
    requiredTyped("#summaryDisableReasoning", HTMLInputElement).checked =
      base.disable_reasoning !== false;
    requiredTyped("#summaryUrl", HTMLInputElement).value = base.target_url;
    requiredTyped("#summaryModel", HTMLInputElement).value = base.model;
    requiredTyped("#summaryKey", HTMLInputElement).value = base.api_key;
    requiredTyped("#summaryHeaders", HTMLInputElement).value = (base.target_headers || []).join(
      "\n",
    );
    requiredTyped("#summaryTimeout", HTMLInputElement).value = String(
      Math.max(1, Math.round(Number(base.timeout_ms || 180000) / 1000)),
    );
    $("summaryTestResult").hidden = true;
    $("summaryTestResult").textContent = "";
    requiredDialog("summaryModelDialog").showModal();
  });
  $("summaryModelForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const base = await api("/api/settings/summary-model").catch(() => ({}));
    await api("/api/settings/summary-model", {
      method: "PUT",
      body: JSON.stringify({
        ...base,
        disable_reasoning: requiredTyped("#summaryDisableReasoning", HTMLInputElement).checked,
        api_type: requiredTyped("#summaryApiType", HTMLSelectElement).value,
        target_url: requiredTyped("#summaryUrl", HTMLInputElement).value,
        model: requiredTyped("#summaryModel", HTMLInputElement).value,
        api_key: requiredTyped("#summaryKey", HTMLInputElement).value,
        target_headers: requiredTyped("#summaryHeaders", HTMLInputElement)
          .value.split("\n")
          .filter(Boolean),
        timeout_ms: Number(requiredTyped("#summaryTimeout", HTMLInputElement).value) * 1000,
      }),
    });
    requiredDialog("summaryModelDialog").close();
    toast(t("summaryConfigSaved"));
  });
  requiredTyped("#summaryCancel", HTMLButtonElement).addEventListener("click", () =>
    requiredDialog("summaryModelDialog").close(),
  );
  requiredTyped("#selectAllLogs", HTMLButtonElement).addEventListener("click", () =>
    toggleSelectAllLogs(),
  );
  requiredTyped("#autoRefreshLogs", HTMLInputElement).addEventListener("change", () =>
    scheduleLogRefresh(250),
  );
  $("logItems").addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches("[data-select-group]")) {
      const groupId = target.dataset.selectGroup;
      if (groupId === undefined) throw new Error("Missing data-select-group");
      state.selectedLogGroups[groupId] = target.checked;
      updateSelectAllLogsButton();
      return;
    }
    const groupToggle = closestFrom(event.target, "[data-group-toggle]");
    if (groupToggle) {
      // The caret button is the only entry point for expanding/collapsing the
      // second-level request list.
      toggleLogGroupBody(groupToggle.dataset.groupToggle).catch((e) => toast(e.message));
      return;
    }
    const group = closestFrom(event.target, "[data-group-id]");
    if (group) {
      // A header click (or Enter/Space on it) only opens the task detail panel;
      // it never touches the body expansion.
      showTaskPricing(group.dataset.groupId).catch((e) => toast(e.message));
      return;
    }
    const item = closestFrom(event.target, "[data-log-id]");
    if (item) selectLog(item.dataset.logId).catch((e) => toast(e.message));
    const recordMore = closestFrom(event.target, "[data-load-more-records]");
    if (recordMore) {
      loadMoreLogGroup(recordMore.dataset.loadMoreRecords).catch((e) => toast(e.message));
      return;
    }
    if (asElement(event.target)?.matches("[data-load-more]"))
      loadLogs({ append: true }).catch((e) => toast(e.message));
  });
  $("logItems").addEventListener("pointerover", (event) => {
    const item = closestFrom(event.target, "[data-log-id]");
    const id = item ? item.dataset.logId : null;
    if (id === hoverPrefetchId) return;
    hoverPrefetchId = id;
    if (hoverPrefetchTimer !== null) {
      clearTimeout(hoverPrefetchTimer);
      hoverPrefetchTimer = null;
    }
    if (id === null) return;
    hoverPrefetchTimer = setTimeout(() => {
      hoverPrefetchTimer = null;
      prefetchLogDetail(id);
    }, LOG_DETAIL_PREFETCH_DWELL_MS);
  });
  // Pressing the button already decides the click, and it is held for tens of
  // milliseconds before the release: start the request under the finger instead
  // of waiting for the click event that follows.
  $("logItems").addEventListener("pointerdown", (event) => {
    const item = closestFrom(event.target, "[data-log-id]");
    if (item) prefetchLogDetail(item.dataset.logId);
  });
  // Keyboard selection gets the same head start as the pointer.
  $("logItems").addEventListener("focusin", (event) => {
    const item = closestFrom(event.target, "[data-log-id]");
    if (item) prefetchLogDetail(item.dataset.logId);
  });
  $("logItems").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (closestFrom(event.target, "input, button, a, select, textarea")) return;
    const group = closestFrom(event.target, ".log-group-head[data-group-id]");
    if (!group) return;
    event.preventDefault();
    // The header only opens the task detail panel; the caret button toggles the
    // list and, being a real <button>, activates natively on Enter/Space and
    // reaches the delegated click handler above.
    showTaskPricing(group.dataset.groupId).catch((e) => toast(e.message));
  });
  requiredTyped("#summaryTest", HTMLButtonElement).addEventListener("click", async () => {
    const result = $("summaryTestResult");
    result.hidden = false;
    result.className = "target-check-result testing";
    result.textContent = t("testTesting");
    try {
      const r = await api("/api/settings/summary-model/test", {
        method: "POST",
        body: JSON.stringify({
          disable_reasoning: requiredTyped("#summaryDisableReasoning", HTMLInputElement).checked,
          api_type: requiredTyped("#summaryApiType", HTMLSelectElement).value,
          target_url: requiredTyped("#summaryUrl", HTMLInputElement).value,
          model: requiredTyped("#summaryModel", HTMLInputElement).value,
          api_key: requiredTyped("#summaryKey", HTMLInputElement).value,
          target_headers: requiredTyped("#summaryHeaders", HTMLInputElement)
            .value.split("\n")
            .filter(Boolean),
          timeout_ms: Number(requiredTyped("#summaryTimeout", HTMLInputElement).value) * 1000,
        }),
      });
      result.className = `target-check-result ${r.ok ? "success" : "failure"}`;
      result.textContent = r.ok ? t("testSuccess") : r.detail || t("testFailed");
    } catch (e) {
      result.className = "target-check-result failure";
      result.textContent = e.message || t("testFailedGeneric");
    }
  });
  requiredTyped("#summaryClose", HTMLButtonElement).addEventListener("click", () => {
    requiredDialog("summaryPanel").close();
  });
  requiredTyped("#summaryRegenerate", HTMLButtonElement).addEventListener("click", async () => {
    if (!state.selected) return;
    const button = requiredTyped("#summaryRegenerate", HTMLButtonElement);
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "生成中…";
    try {
      const result = await api(`/api/logs/${encodeURIComponent(state.selected)}/summary`, {
        method: "POST",
      });
      // Do not force-reopen a dialog the user closed while the request was in flight.
      renderSummary(result, { open: requiredDialog("summaryPanel").open });
      toast("智能摘要已重新生成");
    } catch (e) {
      toast(e.message || "重新生成失败");
    } finally {
      button.disabled = false;
      button.textContent = "重新生成";
    }
  });
  requiredTyped("#summaryCopy", HTMLButtonElement).addEventListener("click", () =>
    navigator.clipboard.writeText($("summaryContent").textContent || ""),
  );
}

/**
 * Releases what outlives the page: the auto-refresh timer and the hover-prefetch timer.
 * An in-flight detail request is left to finish on its own; its result is dropped because
 * the page it would render into is gone.
 * @returns {void}
 */
export function disposeHistory() {
  if (state.refreshTimer !== null) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (hoverPrefetchTimer !== null) {
    clearTimeout(hoverPrefetchTimer);
    hoverPrefetchTimer = null;
  }
}
