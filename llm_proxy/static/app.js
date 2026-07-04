const translations = {
  zh: {
    language: "语言",
    tabProxies: "监听转发",
    tabLogs: "历史日志",
    request: "请求",
    response: "响应",
    proxyPairs: "地址对",
    add: "添加",
    saveConfig: "保存配置",
    filterPlaceholder: "筛选 path / id / target",
    refresh: "刷新",
    exportLogs: "导出",
    cleanupLogs: "清理",
    cleanupSelectedLogs: "清理选中",
    selectLogGroup: "选择任务",
    noSelectedLogs: "请先选择要清理的任务",
    autoRefresh: "自动刷新",
    toggleWrap: "切换自动换行",
    expandJson: "展开 JSON",
    collapseJson: "折叠 JSON",
    formatStringContent: "格式化字符串内容",
    copyJson: "复制 JSON",
    copiedJson: "已复制 JSON",
    copiedText: "已复制格式化文本",
    copiedApiKey: "已复制 API Key",
    copyFailed: "复制失败",
    savedConfig: "配置已保存",
    newProxy: "新代理",
    switch: "开关",
    listenHost: "监听地址",
    port: "端口",
    targetUrl: "转发地址",
    targetApiKey: "API Key",
    showApiKey: "显示 API Key",
    hideApiKey: "隐藏 API Key",
    copyApiKey: "复制 API Key",
    timeoutSeconds: "超时秒数",
    readableLogDir: "日志目录",
    redactLogs: "日志脱敏",
    upstreamHeaders: "上游 Headers，每行一个 Name: value",
    stripFields: "转发前移除的 request 字段，逗号分隔；留空关闭",
    injectFields: "转发前注入的 request 字段，JSON object；留空关闭",
    targets: "转发地址",
    addTarget: "添加转发地址",
    targetName: "名称",
    defaultTarget: "默认",
    targetEnabled: "启用",
    modelMappings: "模型映射，每行一个 监听模型 => 转发模型；省略 => 时保持同名",
    moreTargetOptions: "更多配置",
    lessTargetOptions: "收起配置",
    delete: "删除",
    history: "历史记录",
    task: "任务",
    pending: "等待中",
    noLogs: "暂无日志",
    loadMore: "加载更多",
    requests: "个请求",
    messages: "条消息",
    tokens: "tokens",
    items: "项",
    lines: "行",
    copyFormattedText: "复制格式化文本",
    exportedLogs: "日志已导出",
    cleanedLogs: "日志已清理",
    loading: "加载中..."
  },
  en: {
    language: "Language",
    tabProxies: "Proxy",
    tabLogs: "History",
    request: "Request",
    response: "Response",
    proxyPairs: "Proxy pairs",
    add: "Add",
    saveConfig: "Save config",
    filterPlaceholder: "Filter path / id / target",
    refresh: "Refresh",
    exportLogs: "Export",
    cleanupLogs: "Clean",
    cleanupSelectedLogs: "Clean selected",
    selectLogGroup: "Select task",
    noSelectedLogs: "Select tasks to clean first",
    autoRefresh: "Auto refresh",
    toggleWrap: "Toggle line wrap",
    expandJson: "Expand JSON",
    collapseJson: "Collapse JSON",
    formatStringContent: "Format string content",
    copyJson: "Copy JSON",
    copiedJson: "Copied JSON",
    copiedText: "Copied formatted text",
    copiedApiKey: "Copied API Key",
    copyFailed: "Copy failed",
    savedConfig: "Config saved",
    newProxy: "New proxy",
    switch: "Enable or disable",
    listenHost: "Listen host",
    port: "Port",
    targetUrl: "Target URL",
    targetApiKey: "API Key",
    showApiKey: "Show API Key",
    hideApiKey: "Hide API Key",
    copyApiKey: "Copy API Key",
    timeoutSeconds: "Timeout seconds",
    readableLogDir: "Log directory",
    redactLogs: "Redact logs",
    upstreamHeaders: "Upstream headers, one Name: value per line",
    stripFields: "Request fields to remove before forwarding, comma-separated; leave blank to disable",
    injectFields: "Request fields to inject before forwarding, JSON object; leave blank to disable",
    targets: "Targets",
    addTarget: "Add target",
    targetName: "Name",
    defaultTarget: "Default",
    targetEnabled: "Enabled",
    modelMappings: "Model mapping, one per line: listened model => upstream model; omit => to keep the same name",
    moreTargetOptions: "More settings",
    lessTargetOptions: "Collapse settings",
    delete: "Delete",
    history: "History",
    task: "Task",
    pending: "pending",
    noLogs: "No logs",
    loadMore: "Load more",
    requests: "requests",
    messages: "messages",
    tokens: "tokens",
    items: "items",
    lines: "lines",
    copyFormattedText: "Copy formatted text",
    exportedLogs: "Logs exported",
    cleanedLogs: "Logs cleaned",
    loading: "Loading..."
  }
};
const savedLanguage = localStorage.getItem("llmProxyLanguage");
const initialLanguage = savedLanguage || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
const state = { language: translations[initialLanguage] ? initialLanguage : "en", pairs: [], logGroups: [], logs: [], selected: null, selectedLogGroups: {}, raw: { request: null, response: null }, wrap: { request: false, response: false }, formatStrings: { request: false, response: false }, tree: { request: true, response: true }, collapsedGroups: {}, loadingLogGroups: {}, logsLoading: false, logsLoadedAt: 0, logLimit: 100, logOffset: 0, logsHasMore: false, logsTotal: 0, searchTimer: null, refreshTimer: null };
const $ = (id) => document.getElementById(id);
const t = (key) => (translations[state.language] && translations[state.language][key]) || translations.en[key] || key;
const toast = (text) => { const el = $("toast"); el.textContent = text; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2400); };
const api = async (url, options = {}) => {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  $("languageSelect").value = state.language;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  updateExpandButton("request");
  updateExpandButton("response");
}
function setLanguage(language) {
  if (!translations[language]) return;
  if (document.querySelector(".proxy-card")) collectPairs();
  state.language = language;
  localStorage.setItem("llmProxyLanguage", language);
  applyLanguage();
  renderPairs();
  renderLogs();
  renderJsonPane("request");
  renderJsonPane("response");
}
function formatLogMeta(meta) {
  const text = String(meta || "");
  return text.replace(/(\d+)\s+requests/g, (_, count) => `${count} ${t("requests")}`);
}
function formatStatus(status) {
  return status === undefined || status === null || status === "pending" ? t("pending") : String(status);
}
function logItemTitle(item) {
  const parts = [];
  const messageCount = Number(item.message_count);
  const tokenCount = Number(item.token_count);
  if (Number.isFinite(messageCount)) parts.push(`${messageCount} ${t("messages")}`);
  if (Number.isFinite(tokenCount)) parts.push(`${tokenCount} ${t("tokens")}`);
  if (!parts.length) parts.push(formatStatus(item.status));
  return `${item.sequence ? `[${item.sequence}] ` : ""}${parts.join(" | ")}`;
}
const suggestedStripRequestFields = __SUGGESTED_STRIP_REQUEST_FIELDS__;
const newTarget = () => ({ id: `target-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: "Target", enabled: true, target_url: "http://127.0.0.1:1235", target_api_key: "", target_headers: [], strip_request_fields: "", inject_request_fields: "", timeout: 600, readable_log_dir: "logs", redact_logs: false, model_mappings: [], expanded: false });
const newPair = () => { const target = newTarget(); return { id: `proxy-${Date.now()}`, name: t("newProxy"), enabled: false, running: false, listen_host: "127.0.0.1", listen_port: 1234, access_log: false, targets: [target], default_target_id: target.id }; };
function pairTargets(pair) {
  if (Array.isArray(pair.targets) && pair.targets.length) return pair.targets;
  const target = newTarget();
  pair.targets = [target];
  pair.default_target_id = pair.default_target_id || target.id;
  return pair.targets;
}
function mappingsText(mappings) {
  return (mappings || []).map((item) => item.upstream && item.upstream !== item.listen ? `${item.listen} => ${item.upstream}` : item.listen).join("\n");
}
function renderTarget(target, pair, pairIndex, targetIndex) {
  const expanded = Boolean(target.expanded);
  const isDefault = pair.default_target_id === target.id;
  return `
    <section class="target-card" data-target-index="${targetIndex}">
      <div class="target-head">
        <div class="target-title">
          <input data-target-field="name" value="${escapeHtml(target.name || "")}" placeholder="${escapeHtml(t("targetName"))}">
          <label class="default-target"><input type="radio" name="default-target-${pairIndex}" data-default-target ${isDefault ? "checked" : ""}> <span>${escapeHtml(t("defaultTarget"))}</span></label>
        </div>
        <button data-remove-target>${escapeHtml(t("delete"))}</button>
      </div>
      <label><span>${escapeHtml(t("targetUrl"))}</span><input data-target-field="target_url" value="${escapeHtml(target.target_url || "")}" placeholder="https://api.example.com/v1"></label>
      <label>
        <span>${escapeHtml(t("targetApiKey"))}</span>
        <div class="secret-field">
          <input data-target-field="target_api_key" type="password" value="${escapeHtml(target.target_api_key || "")}" placeholder="sk-...">
          <button type="button" data-toggle-api-key title="${escapeHtml(t("showApiKey"))}">👁</button>
          <button type="button" data-copy-api-key title="${escapeHtml(t("copyApiKey"))}">📋</button>
        </div>
      </label>
      <label><span>${escapeHtml(t("modelMappings"))}</span><textarea data-target-field="model_mappings" placeholder="A-gpt-5.5 => gpt-5.5">${escapeHtml(mappingsText(target.model_mappings))}</textarea></label>
      <div class="target-controls">
        ${isDefault ? `<span class="target-enabled">${escapeHtml(t("defaultTarget"))}</span>` : `<label class="target-enabled"><input type="checkbox" data-target-enabled ${target.enabled !== false ? "checked" : ""}> <span>${escapeHtml(t("targetEnabled"))}</span></label>`}
        <button data-toggle-target-options>${escapeHtml(t(expanded ? "lessTargetOptions" : "moreTargetOptions"))}</button>
      </div>
      <div class="target-options" ${expanded ? "" : "hidden"}>
        <div class="fields">
          <label><span>${escapeHtml(t("timeoutSeconds"))}</span><input type="number" data-target-field="timeout" value="${target.timeout || 600}"></label>
          <label><span>${escapeHtml(t("readableLogDir"))}</span><input data-target-field="readable_log_dir" value="${escapeHtml(target.readable_log_dir || "logs")}"></label>
        </div>
        <label class="target-enabled"><input type="checkbox" data-redact-logs ${target.redact_logs ? "checked" : ""}> <span>${escapeHtml(t("redactLogs"))}</span></label>
        <label><span>${escapeHtml(t("upstreamHeaders"))}</span><textarea data-target-field="target_headers">${escapeHtml((target.target_headers || []).join("\n"))}</textarea></label>
        <label><span>${escapeHtml(t("stripFields"))}</span><textarea data-target-field="strip_request_fields" placeholder="${escapeHtml(suggestedStripRequestFields)}">${escapeHtml(target.strip_request_fields ?? "")}</textarea></label>
        <label><span>${escapeHtml(t("injectFields"))}</span><textarea data-target-field="inject_request_fields" placeholder='{"metadata":{"source":"proxy"}}'>${escapeHtml(target.inject_request_fields ?? "")}</textarea></label>
      </div>
    </section>`;
}
function renderPairs() {
  $("proxyGrid").innerHTML = state.pairs.map((p, i) => `
    <article class="proxy-card" data-index="${i}">
      <div class="proxy-head">
        <div class="proxy-title"><span class="status ${p.running ? "running" : ""}"></span><input data-field="name" value="${escapeHtml(p.name || "")}"></div>
        <label><span>${escapeHtml(t("listenHost"))}</span><input data-field="listen_host" value="${escapeHtml(p.listen_host || "")}"></label>
        <label><span>${escapeHtml(t("port"))}</span><input type="number" data-field="listen_port" value="${p.listen_port || 0}"></label>
        <label class="switch" title="${escapeHtml(t("switch"))}"><input type="checkbox" data-toggle ${p.enabled ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <strong>${escapeHtml(t("targets"))}</strong>
      <div class="targets-row">
        ${pairTargets(p).map((target, targetIndex) => renderTarget(target, p, i, targetIndex)).join("")}
      </div>
      <div class="row-actions"><button data-add-target>${escapeHtml(t("addTarget"))}</button><button data-remove>${escapeHtml(t("delete"))}</button></div>
    </article>`).join("");
}
function rerenderPairAtScroll(card, scrollLeft) {
  const index = card.dataset.index;
  renderPairs();
  const nextRow = document.querySelector(`.proxy-card[data-index="${index}"] .targets-row`);
  if (nextRow) nextRow.scrollLeft = scrollLeft;
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function collectPairs() {
  document.querySelectorAll(".proxy-card").forEach((card) => {
    const pair = state.pairs[Number(card.dataset.index)];
    card.querySelectorAll("[data-field]").forEach((input) => {
      const field = input.dataset.field;
      let value = input.value;
      if (field === "listen_port") value = Number(value);
      if (field === "timeout") value = Number(value);
      if (field === "target_headers") value = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
      if (field === "strip_request_fields" && value === "") value = "";
      if (field === "inject_request_fields" && value === "") value = "";
      pair[field] = value;
    });
    card.querySelectorAll(".target-card").forEach((targetCard) => {
      const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
      targetCard.querySelectorAll("[data-target-field]").forEach((input) => {
        const field = input.dataset.targetField;
        let value = input.value;
        if (field === "timeout") value = Number(value);
        if (field === "target_headers") value = value.split(/\n/).map((line) => line.trim()).filter(Boolean);
        if (field === "model_mappings") {
          value = value.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const parts = line.split(/\s*=>\s*/);
            return { listen: parts[0].trim(), upstream: (parts[1] || parts[0]).trim() };
          }).filter((item) => item.listen);
        }
        if (field === "strip_request_fields" && value === "") value = "";
        if (field === "inject_request_fields" && value === "") value = "";
        target[field] = value;
      });
      if (targetCard.querySelector("[data-default-target]")?.checked) pair.default_target_id = target.id;
      const enabledInput = targetCard.querySelector("[data-target-enabled]");
      target.enabled = enabledInput ? enabledInput.checked : true;
      const redactInput = targetCard.querySelector("[data-redact-logs]");
      target.redact_logs = redactInput ? redactInput.checked : false;
    });
    pairTargets(pair).forEach((target) => {
      if (target.id === pair.default_target_id) target.enabled = true;
    });
  });
}
async function loadPairs() {
  const data = await api("/api/pairs");
  state.pairs = data.pairs;
  renderPairs();
}
async function savePairs() {
  collectPairs();
  const data = await api("/api/pairs", { method: "PUT", body: JSON.stringify({ pairs: state.pairs }) });
  state.pairs = data.pairs;
  renderPairs();
  toast(t("savedConfig"));
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
  const groupIds = Object.keys(state.selectedLogGroups).filter((groupId) => state.selectedLogGroups[groupId]);
  if (!groupIds.length) {
    toast(t("noSelectedLogs"));
    return;
  }
  const data = await api("/api/logs/cleanup", { method: "POST", body: JSON.stringify({ group_ids: groupIds }) });
  state.logOffset = 0;
  state.logGroups = [];
  state.logs = [];
  state.selectedLogGroups = {};
  await loadLogs();
  toast(`${t("cleanedLogs")}: ${data.deleted_count || 0}`);
}
function scheduleLogRefresh(delay = 3000) {
  clearTimeout(state.refreshTimer);
  if (!$("autoRefreshLogs").checked) return;
  state.refreshTimer = setTimeout(() => {
    if (document.hidden || !$("logs").classList.contains("active")) {
      scheduleLogRefresh(delay);
      return;
    }
    loadLogs({ quiet: true }).catch((e) => toast(e.message));
  }, delay);
}
function logGroupsSignature(groups) {
  return (groups || []).map((group) => logGroupSummarySignature(group)).join("\n");
}
function logGroupSummarySignature(group) {
  return [
    group.id,
    group.dir,
    group.title,
    group.meta
  ].join("|");
}
function sameLogGroups(nextGroups) {
  return logGroupsSignature(state.logGroups) === logGroupsSignature(nextGroups);
}
function mergeLogGroupSummaries(currentGroups, nextGroups) {
  const currentById = new Map(currentGroups.map((group) => [group.id, group]));
  return nextGroups.map((group) => {
    const existing = currentById.get(group.id);
    if (!existing) return group;
    const summaryChanged = logGroupSummarySignature(existing) !== logGroupSummarySignature(group);
    return {
      ...group,
      logs: summaryChanged ? [] : existing.logs,
      logsLoaded: summaryChanged ? false : existing.logsLoaded
    };
  });
}
async function loadLogs(options = {}) {
  if (state.logsLoading) return;
  state.logsLoading = true;
  const q = encodeURIComponent($("logSearch").value.trim());
  try {
    const offset = options.append ? state.logOffset : 0;
    const limit = options.quiet && !options.append ? Math.max(state.logLimit, state.logOffset || state.logGroups.length) : state.logLimit;
    const data = await api(`/api/logs?q=${q}&limit=${limit}&offset=${offset}`);
    const nextGroups = data.groups || [{ id: "logs", title: t("history"), logs: data.logs || [] }];
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
    } else if (!sameLogGroups(nextGroups)) {
      state.logGroups = mergeLogGroupSummaries(state.logGroups, nextGroups);
      state.logs = state.logGroups.flatMap((group) => group.logs || []);
      renderLogs();
      rendered = true;
      state.logGroups
        .filter((group) => state.collapsedGroups[group.id] && !group.logsLoaded)
        .forEach((group) => loadLogGroup(group.id).catch((e) => toast(e.message)));
    }
    if (!rendered) renderLogs();
    state.logsLoadedAt = Date.now();
  } finally {
    state.logsLoading = false;
    scheduleLogRefresh();
  }
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
  if (!group || group.logsLoaded || state.loadingLogGroups[groupId]) return;
  state.loadingLogGroups[groupId] = true;
  renderLogs();
  try {
    const q = encodeURIComponent($("logSearch").value.trim());
    const data = await api(`/api/log-groups/${encodeURIComponent(groupId)}/logs?q=${q}`);
    group.logs = data.logs || [];
    group.logsLoaded = true;
    state.logs = state.logGroups.flatMap((item) => item.logs || []);
  } finally {
    delete state.loadingLogGroups[groupId];
    renderLogs();
  }
}
function renderLogs() {
  const groupsHtml = state.logGroups.map((group) => `
    <section class="log-group">
      <button class="log-group-head" data-group-id="${escapeHtml(group.id || "")}">
        <input class="log-group-select" type="checkbox" data-select-group="${escapeHtml(group.id || "")}" title="${escapeHtml(t("selectLogGroup"))}" ${state.selectedLogGroups[group.id] ? "checked" : ""}>
        <span class="log-group-caret">${!state.collapsedGroups[group.id] ? "▸" : "▾"}</span>
        <span class="log-group-title">${escapeHtml(group.title || group.id || t("task"))}</span>
        <span class="log-meta">${escapeHtml(formatLogMeta(group.meta || ""))}</span>
      </button>
      ${!state.collapsedGroups[group.id] ? "" : state.loadingLogGroups[group.id] ? `<div class="log-item log-loading">${escapeHtml(t("loading"))}</div>` : (group.logs || []).map((item) => `
        <button class="log-item ${state.selected === item.id ? "active" : ""}" data-log-id="${escapeHtml(item.id)}">
          <span class="log-title">${escapeHtml(logItemTitle(item))}</span>
          <span class="log-meta">${escapeHtml(item.timestamp || "")} | ${escapeHtml(formatStatus(item.status))}</span>
        </button>`).join("")}
    </section>`).join("") || `<div class="empty">${escapeHtml(t("noLogs"))}</div>`;
  const moreHtml = state.logsHasMore ? `<button class="load-more" data-load-more>${escapeHtml(t("loadMore"))} (${state.logGroups.length}/${state.logsTotal})</button>` : "";
  $("logItems").innerHTML = groupsHtml + moreHtml;
}
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function renderJsonValue(value, key = "", root = false, formatMode = false) {
  const type = jsonType(value);
  const keyHtml = key === "" ? "" : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span>: `;
  if (type === "array" || type === "object") {
    const entries = type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    const start = type === "array" ? "[" : "{";
    const end = type === "array" ? "]" : "}";
    const summary = `${keyHtml}${start}<span class="json-muted">${entries.length ? ` ${entries.length} ${t("items")} ` : ""}</span>${end}`;
    const childrenHtml = `<div class="json-children">${entries.map(([childKey, childValue]) => `<div class="json-row">${renderJsonValue(childValue, String(childKey), false, formatMode)}</div>`).join("")}</div>`;
    return `<details open${root ? ' class="root"' : ''}><summary>${summary}</summary>${childrenHtml}<div class="json-muted">${end}</div></details>`;
  }
  if (type === "string") {
    if (!formatMode) return `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    const shouldFormat = typeof value === 'string' && (value.indexOf(String.fromCharCode(10)) !== -1 || value.indexOf("\\") !== -1 || value.length > 200);
    if (!shouldFormat) return `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    const displayValue = formatString(value);
    if (displayValue.indexOf(String.fromCharCode(10)) !== -1 || displayValue.length > 200) {
      const summaryRaw = displayValue.substring(0, 150);
      const summarySingleLine = escapeHtml(summaryRaw.replace(/\r\n/g, '↵').replace(/\n/g, '↵'));
      const summaryText = summarySingleLine + (displayValue.length > 150 ? "…" : "");
      const fullLines = displayValue.split(String.fromCharCode(10)).length;
      return `${keyHtml}<details class="json-str-detail"><summary>${summaryText} <span class="json-muted">(${fullLines} ${t("lines")})</span></summary><div class="json-str-full"><button class="json-str-copy" data-copy-string title="${escapeHtml(t("copyFormattedText"))}">📋</button><pre class="json-str-body">${escapeHtml(displayValue)}</pre></div></details>`;
    }
    return `${keyHtml}<span class="json-string format-mode">${escapeHtml(displayValue)}</span>`;
  }
  if (type === "number") return `${keyHtml}<span class="json-number">${escapeHtml(String(value))}</span>`;
  if (type === "boolean") return `${keyHtml}<span class="json-boolean">${escapeHtml(String(value))}</span>`;
  if (type === "undefined") return `${keyHtml}<span class="json-null">undefined</span>`;
  return `${keyHtml}<span class="json-null">null</span>`;
}
function formatString(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\\n/g, String.fromCharCode(10))
              .replace(/\\r/g, String.fromCharCode(13))
              .replace(/\\t/g, '    ')
              .replace(/\\b/g, '\b')
              .replace(/\\f/g, '\f')
              .replace(/\\"/g, '"')
              .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function jsonText(value) {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "undefined" : text;
}
function renderJsonPane(key) {
  const el = $(key + "Json");
  el.classList.toggle("wrap", state.wrap[key]);
  el.classList.toggle("nowrap", !state.wrap[key]);
  if (state.tree[key]) {
    el.innerHTML = renderJsonValue(state.raw[key], "", true, state.formatStrings[key]);
  } else {
    el.textContent = jsonText(state.raw[key]);
  }
  updateExpandButton(key);
  updatePaneButtons(key);
}
function updatePaneButtons(key) {
  document.querySelector(`[data-wrap="${key}"]`).classList.toggle("active", state.wrap[key]);
  document.querySelector(`[data-format="${key}"]`).classList.toggle("active", state.formatStrings[key]);
  const expandBtn = document.querySelector(`[data-expand="${key}"]`);
  if (expandBtn) {
    const details = Array.from($(key + "Json").querySelectorAll("details"));
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    expandBtn.classList.toggle("active", !allOpen);
  }
}
function updateExpandButton(key) {
  const button = document.querySelector(`[data-expand="${key}"]`);
  if (!button) return;
  const details = Array.from($(key + "Json").querySelectorAll("details"));
  const allOpen = details.length > 0 && details.every((detail) => detail.open);
  button.title = allOpen ? t("collapseJson") : t("expandJson");
}
async function selectLog(id) {
  state.selected = id;
  renderLogs();
  const data = await api(`/api/logs/${encodeURIComponent(id)}`);
  state.raw.request = data.request;
  state.raw.response = data.response;
  state.tree.request = true;
  state.tree.response = true;
  state.formatStrings.request = true;
  state.formatStrings.response = true;
  renderJsonPane("request");
  renderJsonPane("response");
}
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab, .view").forEach((el) => el.classList.remove("active"));
  tab.classList.add("active"); $(tab.dataset.tab).classList.add("active");
  if (tab.dataset.tab === "logs") loadLogs().catch((e) => toast(e.message));
}));
$("languageSelect").addEventListener("change", (event) => setLanguage(event.target.value));
$("addProxy").addEventListener("click", () => { state.pairs.push(newPair()); renderPairs(); });
$("saveProxies").addEventListener("click", () => savePairs().catch((e) => toast(e.message)));
$("proxyGrid").addEventListener("click", (event) => {
  const card = event.target.closest(".proxy-card");
  if (!card) return;
  const pair = state.pairs[Number(card.dataset.index)];
  const targetRow = card.querySelector(".targets-row");
  const targetScrollLeft = targetRow ? targetRow.scrollLeft : 0;
  if (event.target.matches("[data-add-target]")) {
    collectPairs();
    const target = newTarget();
    pairTargets(pair).push(target);
    pair.default_target_id = pair.default_target_id || target.id;
    rerenderPairAtScroll(card, targetScrollLeft);
    return;
  }
  if (event.target.matches("[data-toggle-target-options]")) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    target.expanded = !target.expanded;
    rerenderPairAtScroll(card, targetScrollLeft);
    return;
  }
  if (event.target.matches("[data-toggle-api-key]")) {
    const field = event.target.closest(".secret-field");
    const input = field?.querySelector("[data-target-field='target_api_key']");
    if (!input) return;
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    event.target.classList.toggle("active", !visible);
    event.target.title = t(visible ? "showApiKey" : "hideApiKey");
    return;
  }
  if (event.target.matches("[data-copy-api-key]")) {
    const field = event.target.closest(".secret-field");
    const input = field?.querySelector("[data-target-field='target_api_key']");
    if (!input) return;
    navigator.clipboard.writeText(input.value || "").then(
      () => toast(t("copiedApiKey")),
      () => toast(t("copyFailed"))
    );
    return;
  }
  if (event.target.matches("[data-remove-target]")) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const targets = pairTargets(pair);
    if (targets.length <= 1) return;
    const removed = targets.splice(Number(targetCard.dataset.targetIndex), 1)[0];
    if (pair.default_target_id === removed.id) pair.default_target_id = targets[0].id;
    rerenderPairAtScroll(card, targetScrollLeft);
    return;
  }
  if (event.target.matches("[data-remove]")) { state.pairs.splice(Number(card.dataset.index), 1); renderPairs(); }
});
$("proxyGrid").addEventListener("change", async (event) => {
  if (!event.target.matches("[data-toggle]")) return;
  collectPairs();
  await savePairs();
  const pair = state.pairs[Number(event.target.closest(".proxy-card").dataset.index)];
  const data = await api(`/api/pairs/${encodeURIComponent(pair.id)}/enabled`, { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) });
  Object.assign(pair, data.pair);
  renderPairs();
});
$("refreshLogs").addEventListener("click", () => loadLogs().catch((e) => toast(e.message)));
$("exportLogs").addEventListener("click", () => exportLogs().catch((e) => toast(e.message)));
$("cleanupLogs").addEventListener("click", () => cleanupLogs().catch((e) => toast(e.message)));
$("autoRefreshLogs").addEventListener("change", () => scheduleLogRefresh(250));
$("logSearch").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadLogs().catch((e) => toast(e.message)), 180);
});
$("logItems").addEventListener("click", (event) => {
  if (event.target.matches("[data-select-group]")) {
    state.selectedLogGroups[event.target.dataset.selectGroup] = event.target.checked;
    return;
  }
  const group = event.target.closest("[data-group-id]");
  if (group) {
    const groupId = group.dataset.groupId;
    state.collapsedGroups[groupId] = !state.collapsedGroups[groupId];
    renderLogs();
    return;
  }
  const item = event.target.closest("[data-log-id]");
  if (item) selectLog(item.dataset.logId).catch((e) => toast(e.message));
  if (event.target.matches("[data-load-more]")) loadLogs({ append: true }).catch((e) => toast(e.message));
});
$("logItems").addEventListener("click", (event) => {
  const group = event.target.closest("[data-group-id]");
  if (!group || event.target.matches("[data-select-group]")) return;
  const groupId = group.dataset.groupId;
  if (state.collapsedGroups[groupId]) loadLogGroup(groupId).catch((e) => toast(e.message));
});
document.querySelectorAll("[data-wrap]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.wrap;
  state.wrap[key] = !state.wrap[key];
  renderJsonPane(key);
}));
document.querySelectorAll("[data-expand]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.expand;
  state.tree[key] = true;
  if ($(key + "Json").querySelectorAll("details").length === 0) renderJsonPane(key);
  const details = Array.from($(key + "Json").querySelectorAll("details"));
  const shouldOpen = !details.length || details.some((detail) => !detail.open);
  details.forEach((detail) => {
    const parentDetail = detail.parentElement ? detail.parentElement.closest("details") : null;
    detail.open = shouldOpen || detail.classList.contains("root") || parentDetail?.classList.contains("root");
  });
  updateExpandButton(key);
  updatePaneButtons(key);
}));
["request", "response"].forEach((key) => {
  $(key + "Json").addEventListener("toggle", () => { updateExpandButton(key); updatePaneButtons(key); }, true);
  $(key + "Json").addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-string]");
    if (!button) return;
    const body = button.closest(".json-str-full")?.querySelector(".json-str-body");
    if (!body) return;
    navigator.clipboard.writeText(body.textContent || "").then(
      () => toast(t("copiedText")),
      () => toast(t("copyFailed"))
    );
  });
});
document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.format;
  state.formatStrings[key] = !state.formatStrings[key];
  renderJsonPane(key);
}));
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.copy;
  if (key && state.raw[key] !== null) {
    navigator.clipboard.writeText(JSON.stringify(state.raw[key], null, 2)).then(
      () => toast(t("copiedJson")),
      () => toast(t("copyFailed"))
    );
  }
}));
(() => {
  const detail = $("detail"), splitter = $("splitter");
  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => { dragging = true; splitter.setPointerCapture(e.pointerId); });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = detail.getBoundingClientRect();
    const top = Math.max(120, Math.min(rect.height - 120, e.clientY - rect.top));
    detail.style.setProperty("--request-fr", `${top}px`);
    detail.style.setProperty("--response-fr", `${rect.height - top - 8}px`);
  });
  splitter.addEventListener("pointerup", () => { dragging = false; });
})();
(() => {
  const logsView = $("logs"), logSplitter = $("logSplitter");
  let dragging = false;
  logSplitter.addEventListener("pointerdown", (e) => { dragging = true; logSplitter.setPointerCapture(e.pointerId); });
  logSplitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = logsView.getBoundingClientRect();
    const minW = 200, maxW = rect.width * 0.8;
    const w = Math.max(minW, Math.min(maxW, e.clientX - rect.left));
    logsView.style.setProperty("--sidebar-w", `${w}px`);
  });
  logSplitter.addEventListener("pointerup", () => { dragging = false; });
})();
applyLanguage();
loadPairs().catch((e) => toast(e.message));
