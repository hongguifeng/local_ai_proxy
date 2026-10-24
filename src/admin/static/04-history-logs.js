// LLM Proxy admin UI -- history logs: task groups, records, search, detail panes, pending sweep
// Parts are concatenated in numeric order into /static/app.js and served as one classic script.

function logGroupTimeHtml(group) {
  const start = displayTimestampParts(group.started_at);
  const activity = displayTimestampParts(group.last_activity_at);
  const fallback = group.started_at || group.last_activity_at || group.id || t("task");
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
function formatGroupDecodeSpeed(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}
function logGroupFactsHtml(group) {
  const decodeSpeed = formatGroupDecodeSpeed(group.decode_speed_tps);
  const decodeSpeedTip = `${t("avgDecodeSpeed")}: ${t("avgDecodeSpeedTip")}`;
  const cost = formatGroupCost(group.cost);
  const costHtml =
    cost === "—"
      ? `<span class="log-group-cost log-fact-empty">—</span>`
      : `<span class="log-group-cost">${escapeHtml(cost)}</span>`;
  return `<span class="log-group-facts">
    <span class="log-group-fact-line">${group.model ? `<span class="log-model" title="${escapeHtml(group.model)}">${escapeHtml(group.model)}</span>` : ""}<span class="log-request-count"><strong>${escapeHtml(group.request_count ?? 0)}</strong> ${escapeHtml(t("requests"))}</span>${decodeSpeed ? `<span class="log-group-decode-speed" title="${escapeHtml(decodeSpeedTip)}">${escapeHtml(decodeSpeed)}t/s</span>` : ""}${costHtml}</span>
    <span class="log-group-fact-line log-target" title="${escapeHtml(group.target || "")}">${escapeHtml(group.target || "—")}</span>
  </span>`;
}
function formatGroupCost(cost) {
  return cost ? formatCurrencyAmount(cost.known_amount) : "—";
}
function newLoadBalancerGroup() {
  return {
    id: `lb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    enabled: true,
    model_pattern: "",
    members: [],
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
  };
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
  const button = $("cleanupSingleRequestLogs");
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
  clearTimeout(state.refreshTimer);
  if (!$("autoRefreshLogs").checked) return;
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
  $("selectAllLogs").textContent = t(
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
async function loadLogs(options = {}) {
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
    item.message_count = record.message_count ?? item.message_count;
    item.status = record.status ?? item.status;
    item.request_token_count = record.request_token_count ?? item.request_token_count;
    item.response_token_count = record.response_token_count ?? item.response_token_count;
    item.decode_speed_tps = record.decode_speed_tps ?? item.decode_speed_tps;
    item.end_to_end_speed_tps = record.end_to_end_speed_tps ?? item.end_to_end_speed_tps;
    item.cost = record.cost ?? item.cost;
    listChanged = true;
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
  const logs = group.logs || [];
  return state.loadingLogGroups[group.id] || (!group.logsLoaded && !logs.length)
    ? `<div class="log-item log-loading">${escapeHtml(t("loading"))}</div>`
    : logs.length
      ? logs
          .map(
            (item) => `
        <button class="log-item ${state.selected === item.id ? "active" : ""}" data-log-id="${escapeHtml(item.id)}">
          <span class="log-sequence">${escapeHtml(item.sequence ? `#${item.sequence}` : "-")}</span>
          <span class="log-item-content">
            <span class="log-item-metrics">${logItemMetricsHtml(item)}</span>
            <span class="log-item-subline">
              <span class="log-timestamp">${escapeHtml(item.timestamp || "")}</span>${item.has_summary ? `<span class="log-summary-star" title="${escapeHtml(t("summaryStar"))}" aria-label="${escapeHtml(t("summaryStar"))}">★</span>` : ""}${(() => {
                const statusClass = logStatusClass(item.status);
                const statusLabel = formatStatus(item.status);
                if (statusClass === "success") return "";
                return `<span class="log-status ${statusClass}" title="${escapeHtml(statusLabel)}" aria-label="${escapeHtml(statusLabel)}"><span class="log-status-dot" aria-hidden="true"></span>${escapeHtml(statusLabel)}</span>`;
              })()}
            </span>
          </span>
        </button>`,
          )
          .join("") +
        (group.logsHasMore
          ? `<button class="load-more log-group-load-more" data-load-more-records="${escapeHtml(group.id || "")}" ${state.loadingMoreLogGroups[group.id] ? "disabled" : ""}>${escapeHtml(state.loadingMoreLogGroups[group.id] ? t("loading") : t("loadMore"))} (${logs.length}/${group.logsTotal})</button>`
          : "")
      : `<div class="log-item log-group-empty">${escapeHtml(t("noMatchedLogs"))}</div>`;
}
function logGroupSectionHtml(group) {
  return `
    <section class="log-group">
      <div class="log-group-head" data-group-id="${escapeHtml(group.id || "")}" role="button" tabindex="0" aria-label="${escapeHtml(t("viewTaskPricing"))}">
        <div class="log-group-controls">
          <input class="log-group-select" type="checkbox" data-select-group="${escapeHtml(group.id || "")}" title="${escapeHtml(t("selectLogGroup"))}" ${state.selectedLogGroups[group.id] ? "checked" : ""}>
          <button type="button" class="log-group-caret" data-group-toggle="${escapeHtml(group.id || "")}" title="${escapeHtml(t("toggleTaskRecords"))}" aria-label="${escapeHtml(t("toggleTaskRecords"))}" aria-expanded="${state.collapsedGroups[group.id] ? "true" : "false"}">${!state.collapsedGroups[group.id] ? "▸" : "▾"}</button>
        </div>
        <div class="log-group-summary">
          ${logGroupTimeHtml(group)}
          ${logGroupFactsHtml(group)}
        </div>
      </div>
      ${
        !state.collapsedGroups[group.id]
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
function logItemRenderSignature(item) {
  return [
    item.id,
    item.sequence,
    item.timestamp,
    item.status,
    item.message_count,
    item.request_token_count,
    item.response_token_count,
    item.decode_speed_tps,
    item.end_to_end_speed_tps,
    item.cost?.known_amount,
    item.cost?.status,
    item.cost?.reason,
    item.has_summary ? "star" : "",
    state.selected === item.id ? "selected" : "",
  ].join("|");
}
function logGroupRenderSignature(group) {
  return [
    // Labels come from the active language, so a language switch must rebuild.
    state.language,
    logGroupSummarySignature(group),
    group.decode_speed_tps,
    state.selectedLogGroups[group.id] ? "checked" : "",
    state.collapsedGroups[group.id] ? "expanded" : "collapsed",
    state.loadingLogGroups[group.id] ? "loading" : "",
    state.loadingMoreLogGroups[group.id] ? "loading-more" : "",
    group.logsLoaded ? "loaded" : "unloaded",
    group.logsHasMore ? "more" : "",
    group.logsTotal,
    (group.logs || []).map(logItemRenderSignature).join(","),
  ].join("#");
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
  const groups = state.logGroups;
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
      list.appendChild(template.content.firstElementChild);
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
function hasMetadata(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}
function renderMetaPane(key) {
  const el = $(key + "Meta");
  const available = hasMetadata(state.meta[key]);
  const open = available && state.metaOpen[key];
  el.hidden = !open;
  el.innerHTML = open ? renderJsonValue(state.meta[key], "", true, true, 0) : "";
  updateMetaButton(key);
}
function updateResponseTiming() {
  const element = $("responseTiming");
  const meta = state.meta.response || {};
  const firstToken = formatDuration(meta.first_token_ms);
  const total = formatDuration(meta.duration_ms);
  const parts = [
    ...(firstToken === "" ? [] : [`${t("firstTokenTime")} ${firstToken}`]),
    ...(total === "" ? [] : [`${t("totalTime")} ${total}`]),
  ];
  const tokenMs = positiveNumber(meta.first_token_ms);
  const durationMs = positiveNumber(meta.duration_ms);
  const measured = tokenMs !== undefined;
  // New records provide an explicit generated-content window. Zero means
  // buffered/non-streaming output: use end-to-end speed, never invent decode.
  // Legacy records retain their historical timing convention.
  const windowMs =
    meta.decode_window_ms !== undefined && meta.decode_window_ms !== null
      ? positiveNumber(meta.decode_window_ms)
      : measured
        ? durationMs - tokenMs
        : undefined;
  if (durationMs !== undefined) {
    const inputTokens = positiveNumber(meta.request_token_count) ?? 0;
    const cachedTokens = Math.min(positiveNumber(meta.cached_token_count) ?? 0, inputTokens);
    const prefill =
      measured && (meta.decode_window_ms == null || windowMs !== undefined)
        ? formatTokensPerSecond((inputTokens - cachedTokens) * (1000 / tokenMs))
        : "";
    const decode =
      windowMs !== undefined && windowMs >= 1
        ? formatTokensPerSecond(
            (positiveNumber(meta.response_token_count) ?? 0) * (1000 / windowMs),
          )
        : "";
    if (prefill !== "") parts.push(`${t("prefillSpeed")} ${prefill} ${t("tokensPerSecond")}`);
    if (decode === "") {
      const speed = formatTokensPerSecond(
        ((positiveNumber(meta.response_token_count) ?? 0) * 1000) / durationMs,
      );
      if (speed !== "") parts.push(`${t("endToEndSpeed")} ${speed} ${t("tokensPerSecond")}`);
    }
    if (decode !== "") parts.push(`${t("decodeSpeed")} ${decode} ${t("tokensPerSecond")}`);
  }
  element.textContent = parts.join(" · ");
  element.hidden = parts.length === 0;
}
function updateMetaButton(key) {
  const button = qs(`[data-meta="${key}"]`);
  if (!button) return;
  const available = hasMetadata(state.meta[key]);
  button.disabled = !available;
  button.classList.toggle("active", available && state.metaOpen[key]);
  button.title = available && state.metaOpen[key] ? t("hideMetadata") : t("showMetadata");
}
function updatePaneButtons(key) {
  qs(`[data-wrap="${key}"]`).classList.toggle("active", state.wrap[key]);
  qs(`[data-format="${key}"]`).classList.toggle("active", state.formatStrings[key]);
  const expandBtn = qs(`[data-expand="${key}"]`);
  if (expandBtn) {
    const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    expandBtn.classList.toggle("active", !allOpen);
  }
}
function updateExpandButton(key) {
  const button = qs(`[data-expand="${key}"]`);
  if (!button) return;
  const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
  const allOpen = details.length > 0 && details.every((detail) => detail.open);
  button.title = allOpen ? t("collapseJson") : t("expandJson");
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
function applySelectedLogDetail(data, options = {}) {
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
  if (options.open && !$("summaryPanel").open) $("summaryPanel").showModal();
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
function openTargetCheckDialog(target) {
  $("targetCheckUrl").value = target.target_url || "";
  $("targetCheckApiType").value = "chat";
  $("targetCheckApiKey").value = target.target_api_key || "";
  const mappings = target.model_mappings || [];
  $("targetCheckModel").value = mappings[mappings.length - 1]?.upstream || "";
  const result = $("targetCheckResult");
  result.hidden = true;
  result.textContent = "";
  result.className = "target-check-result";
  // A fetched list belongs to this dialog only, so every open starts from the defaults.
  applyTargetCheckModelOptions(defaultTargetCheckModels);
  closeTargetCheckModelPop();
  state.targetCheckModelsNotice = null;
  renderTargetCheckModelsNotice();
  targetCheckModelsButton.disabled = false;
  targetCheckModelsButton.textContent = t("fetchModels");
  $("targetCheckDialog").showModal();
}
function runLogSearch() {
  state.logQuery = $("logSearch").value.trim();
  $("autoRefreshLogs").disabled = state.logQuery !== "";
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
