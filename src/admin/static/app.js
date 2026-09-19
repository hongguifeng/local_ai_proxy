const translations = {
  zh: {
    language: "语言",
    tabProxies: "监听转发",
    tabLogs: "历史日志",
    tabStatistics: "使用统计",
    usageStatistics: "使用统计",
    request: "请求",
    requestCount: "请求数量",
    totalTokens: "总 Token",
    response: "响应",
    firstTokenTime: "首 token",
    totalTime: "总计",
    prefillSpeed: "Prefill",
    decodeSpeed: "Decode",
    tokensPerSecond: "token/s",
    avgDecodeSpeed: "平均 decode 速度",
    avgDecodeSpeedTip:
      "该任务下所有已完成请求的平均 decode 速度（输出 token 总数 ÷ decode 总时长）",
    speed: "速度",
    proxyPairs: "地址对",
    add: "添加",
    saveConfig: "保存配置",
    filterPlaceholder: "搜索时间 / 请求 / 响应 / id",
    search: "搜索",
    refresh: "刷新",
    exportLogs: "导出",
    statsToday: "今天",
    statsPresetRange: "快速范围",
    statsFollowNow: "结束时间跟随当前时间",
    statsTimeRange: "时间范围",
    statsFrom: "开始时间",
    statsTo: "结束时间",
    statsDateSeparator: "至",
    statsDataFilters: "统计维度",
    statsMetricLabel: "指标",
    statsGranularityLabel: "时间粒度",
    statsBreakdownLabel: "趋势分组",
    statsTargetLabel: "转发地址",
    statsModelLabel: "模型",
    applyFilters: "应用筛选",
    resetFilters: "重置",
    statsOverviewTitle: "总体使用量",
    statsOverviewHint: "按当前时间范围汇总",
    cleanupLogs: "清理",
    cleanupSelectedLogs: "清理选中",
    cleanupSingleRequestLogs: "清理单请求",
    cleaningSingleRequestLogs: "清理中…",
    selectAllLogs: "全选",
    clearSelectedLogs: "取消全选",
    selectLogGroup: "选择任务",
    noSelectedLogs: "请先选择要清理的任务",
    noSingleRequestLogs: "没有仅含一个请求的任务",
    autoRefresh: "自动刷新",
    toggleWrap: "切换自动换行",
    expandJson: "向下展开一级",
    collapseJson: "折叠 JSON",
    formatStringContent: "格式化字符串内容",
    copyJson: "复制 JSON",
    showMetadata: "显示元信息",
    hideMetadata: "隐藏元信息",
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
    logRoot: "日志目录",
    redactLogs: "日志脱敏",
    upstreamHeaders: "上游 Headers，每行一个 Name: value",
    stripFields: "转发前移除的 request 字段，逗号分隔；留空关闭",
    injectFields: "转发前注入的 request 字段，JSON object；留空关闭",
    targets: "转发地址",
    addTarget: "添加转发地址",
    dragTarget: "拖动调整顺序（方向键也可移动）",
    targetName: "名称",
    checkTarget: "测试",
    checkDialogTitle: "测试转发地址",
    checkApiType: "API 类型",
    checkModel: "模型 ID",
    startCheck: "开始测试",
    checking: "测试中…",
    close: "关闭",
    checkOk: "成功：转发地址已正常响应",
    checkBadStatus: "收到响应，但状态码为 {status}（API Key 或模型 ID 可能无效）",
    checkFail: "失败：未收到响应",
    defaultTarget: "默认",
    targetEnabled: "启用",
    modelMappings: "模型映射，每行一个 监听模型 => 转发模型；监听模型支持 * 通配符",
    modelPrices: "模型价格",
    addModelPrice: "添加模型价格",
    pricePattern: "模型名称 / 通配符",
    priceMultiplier: "价格倍率",
    normalInputPrice: "普通输入",
    outputPrice: "输出",
    cacheReadPrice: "缓存读取",
    cacheWritePrice: "缓存写入",
    priceUnit: "单位：元 / M token（100 万 token）；历史费用和单价均按价格 × 倍率展示",
    priceRule: "规则",
    movePriceUp: "上移规则",
    movePriceDown: "下移规则",
    noModelPrices: "尚未配置模型价格，请求费用将显示为未计价",
    testPriceModel: "测试模型名",
    priceNoMatch: "未命中价格规则",
    cost: "费用",
    currencySymbol: "¥",
    calculating: "计算中…",
    unpriced: "未计价",
    taskPricing: "任务明细",
    viewTaskPricing: "查看任务明细",
    costEstimate: "费用估算",
    showCostDetails: "显示费用明细",
    hideCostDetails: "隐藏费用明细",
    billingModel: "计价模型",
    matchedRule: "命中规则",
    priceSource: "价格来源",
    pricingUsage: "用量来源",
    pricingReason: "未计价原因",
    target: "转发地址",
    timeRange: "时间范围",
    inputUncached: "普通输入",
    output: "输出",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
    tokensBilled: "已计价 token 数",
    pricePerMillion: "单价（元/M token）",
    amountCny: "金额（元）",
    tokenShare: "Token 占比",
    costShare: "占比",
    total: "合计",
    activeDuration: "请求总耗时",
    totalDuration: "任务总耗时",
    tokenTrend: "单请求 Token 数趋势",
    tokenTrendNote: "每个请求的 token 总量（请求 + 响应），按请求序号；尚无 token 数的请求不显示。",
    tokenTrendNoData: "暂无 token 数据",
    costTrend: "费用趋势",
    costTrendNote: "每个请求自身的费用（元），按请求序号；尚无费用的请求不显示。",
    costTrendNoData: "暂无费用数据",
    outputTokenTrend: "Token 输出趋势",
    outputTokenTrendNote:
      "累计输出 token，从任务开始到每个请求为止的输出 token 总数；尚无输出 token 数的请求按 0 计入。",
    outputTokenTrendNoData: "暂无输出 token 数据",
    priceGroups: "按模型 / 单价分组",
    priced: "已计价",
    retry: "重试",
    close: "关闭",
    pricingUnavailable: "无法加载任务明细",
    taskDeleted: "任务已删除",
    taskWholeScope: "整个任务费用，包含未匹配请求。",
    moreTargetOptions: "更多配置",
    lessTargetOptions: "收起配置",
    delete: "删除",
    history: "历史记录",
    task: "任务",
    pending: "等待中",
    noLogs: "暂无日志",
    noMatchedLogs: "该组下没有匹配的记录",
    summaryStar: "已生成智能总结",
    summaryModelSettings: "总结模型配置",
    summarize: "智能总结",
    summaryDialogTitle: "智能摘要",
    regenerate: "重新生成",
    copy: "复制",
    disableReasoning: "关闭模型思考",
    model: "模型",
    headers: "Headers",
    timeoutSeconds: "超时（秒）",
    testConnection: "连接测试",
    cancel: "取消",
    save: "保存",
    summaryGenerated: "智能总结已生成",
    summaryModelRequired: "请先配置总结模型",
    summaryConfigSaved: "总结模型配置已保存",
    testTesting: "测试中…",
    testSuccess: "连接成功",
    testFailed: "连接失败",
    testFailedGeneric: "连接测试失败",
    decisions: "决策",
    issues: "问题",
    evidence: "证据：",
    stage: "阶段",
    loadMore: "加载更多",
    requests: "个请求",
    messages: "条消息",
    tokens: "tokens",
    items: "项",
    lines: "行",
    copyFormattedText: "复制格式化文本",
    exportedLogs: "日志已导出",
    cleanedLogs: "日志已清理",
    loading: "加载中...",
  },
  en: {
    language: "Language",
    tabProxies: "Proxy",
    tabLogs: "History",
    tabStatistics: "Usage statistics",
    usageStatistics: "Usage statistics",
    request: "Request",
    requestCount: "Requests",
    totalTokens: "Total tokens",
    response: "Response",
    firstTokenTime: "First token",
    totalTime: "Total",
    prefillSpeed: "Prefill",
    decodeSpeed: "Decode",
    tokensPerSecond: "tok/s",
    avgDecodeSpeed: "Avg decode speed",
    avgDecodeSpeedTip:
      "Average decode speed across finished requests in the task (total output tokens ÷ total decode time)",
    speed: "Speed",
    proxyPairs: "Proxy pairs",
    add: "Add",
    saveConfig: "Save config",
    filterPlaceholder: "Search time / request / response / id",
    search: "Search",
    refresh: "Refresh",
    exportLogs: "Export",
    statsToday: "Today",
    statsPresetRange: "Quick range",
    statsFollowNow: "End time follows now",
    statsTimeRange: "Time range",
    statsFrom: "From",
    statsTo: "To",
    statsDateSeparator: "to",
    statsDataFilters: "Data dimensions",
    statsMetricLabel: "Metric",
    statsGranularityLabel: "Granularity",
    statsBreakdownLabel: "Trend grouping",
    statsTargetLabel: "Target",
    statsModelLabel: "Model",
    applyFilters: "Apply filters",
    resetFilters: "Reset",
    statsOverviewTitle: "Total usage",
    statsOverviewHint: "Summary for the selected period",
    cleanupLogs: "Clean",
    cleanupSelectedLogs: "Clean",
    cleanupSingleRequestLogs: "Clean single-request",
    cleaningSingleRequestLogs: "Cleaning…",
    selectAllLogs: "Select all",
    clearSelectedLogs: "Deselect all",
    selectLogGroup: "Select task",
    noSelectedLogs: "Select tasks to clean first",
    noSingleRequestLogs: "No single-request tasks",
    autoRefresh: "Auto refresh",
    toggleWrap: "Toggle line wrap",
    expandJson: "Expand one level",
    collapseJson: "Collapse JSON",
    formatStringContent: "Format string content",
    copyJson: "Copy JSON",
    showMetadata: "Show metadata",
    hideMetadata: "Hide metadata",
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
    logRoot: "Log directory",
    redactLogs: "Redact logs",
    upstreamHeaders: "Upstream headers, one Name: value per line",
    stripFields:
      "Request fields to remove before forwarding, comma-separated; leave blank to disable",
    injectFields: "Request fields to inject before forwarding, JSON object; leave blank to disable",
    targets: "Targets",
    addTarget: "Add target",
    dragTarget: "Drag to reorder (arrow keys also move)",
    targetName: "Name",
    checkTarget: "Test",
    checkDialogTitle: "Test target",
    checkApiType: "API type",
    checkModel: "Model ID",
    startCheck: "Start test",
    checking: "Testing…",
    close: "Close",
    checkOk: "Success: the target responded normally",
    checkBadStatus:
      "A response was received, but with status {status} (the API key or model ID may be invalid)",
    checkFail: "Failed: no response was received",
    defaultTarget: "Default",
    targetEnabled: "Enabled",
    modelPrices: "Model pricing",
    addModelPrice: "Add model price",
    pricePattern: "Model / wildcard",
    priceMultiplier: "Price multiplier",
    normalInputPrice: "Input",
    outputPrice: "Output",
    cacheReadPrice: "Cache read",
    cacheWritePrice: "Cache write",
    priceUnit: "Unit: $ / M tokens (1,000,000 tokens); history shows price × multiplier",
    priceRule: "Rule",
    movePriceUp: "Move rule up",
    movePriceDown: "Move rule down",
    noModelPrices: "No model prices configured; request cost will be unpriced",
    testPriceModel: "Test model",
    priceNoMatch: "No price rule matched",
    cost: "Cost",
    currencySymbol: "$",
    calculating: "Calculating…",
    unpriced: "Unpriced",
    taskPricing: "Task details",
    viewTaskPricing: "View task details",
    costEstimate: "Cost estimate",
    showCostDetails: "Show cost details",
    hideCostDetails: "Hide cost details",
    billingModel: "Billing model",
    matchedRule: "Matched rule",
    priceSource: "Price source",
    pricingUsage: "Usage source",
    pricingReason: "Unpriced reason",
    target: "Target",
    timeRange: "Time range",
    inputUncached: "Uncached input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    tokensBilled: "Billed tokens",
    pricePerMillion: "Price ($/M tokens)",
    amountCny: "Amount (USD)",
    tokenShare: "Token share",
    costShare: "Share",
    total: "Total",
    activeDuration: "Request time",
    totalDuration: "Task time",
    tokenTrend: "Per-request token count trend",
    tokenTrendNote:
      "Total tokens (request + response) per request, by request sequence; requests without token counts are not shown.",
    tokenTrendNoData: "No token data",
    costTrend: "Cost trend",
    costTrendNote:
      "This request's own cost, by request sequence; requests without a cost yet are not shown.",
    costTrendNoData: "No cost data",
    outputTokenTrend: "Token output trend",
    outputTokenTrendNote:
      "Cumulative output tokens from the task start through each request; requests without an output token count yet count as zero.",
    outputTokenTrendNoData: "No output token data",
    priceGroups: "Model / price groups",
    priced: "Priced",
    retry: "Retry",
    close: "Close",
    pricingUnavailable: "Could not load task details",
    taskDeleted: "Task was deleted",
    taskWholeScope: "Whole-task cost, including requests outside this list.",
    modelMappings:
      "Model mapping, one per line: listened model => upstream model; * is supported as a wildcard",
    moreTargetOptions: "More settings",
    lessTargetOptions: "Collapse settings",
    delete: "Delete",
    history: "History",
    task: "Task",
    pending: "pending",
    noLogs: "No logs",
    noMatchedLogs: "No matching records in this group",
    summaryStar: "Smart summary generated",
    summaryModelSettings: "Summary model settings",
    summarize: "Smart summary",
    summaryDialogTitle: "Smart summary",
    regenerate: "Regenerate",
    copy: "Copy",
    disableReasoning: "Disable model thinking",
    model: "Model",
    headers: "Headers",
    timeoutSeconds: "Timeout (seconds)",
    testConnection: "Test connection",
    cancel: "Cancel",
    save: "Save",
    summaryGenerated: "Smart summary generated",
    summaryModelRequired: "Configure a summary model first",
    summaryConfigSaved: "Summary model settings saved",
    testTesting: "Testing…",
    testSuccess: "Connection OK",
    testFailed: "Connection failed",
    testFailedGeneric: "Connection test failed",
    decisions: "Decisions",
    issues: "Issues",
    evidence: "Evidence: ",
    stage: "Stage",
    loadMore: "Load more",
    requests: "requests",
    messages: "messages",
    tokens: "tokens",
    items: "items",
    lines: "lines",
    copyFormattedText: "Copy formatted text",
    exportedLogs: "Logs exported",
    cleanedLogs: "Logs cleaned",
    loading: "Loading...",
  },
};
const savedLanguage = localStorage.getItem("llmProxyLanguage");
const initialLanguage =
  savedLanguage || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
const state = {
  language: translations[initialLanguage] ? initialLanguage : "en",
  pairs: [],
  logGroups: [],
  logs: [],
  selected: null,
  selectedLogGroups: {},
  raw: { request: null, response: null },
  meta: { request: null, response: null },
  metaOpen: { request: false, response: false },
  wrap: { request: false, response: false },
  formatStrings: { request: false, response: false },
  tree: { request: true, response: true },
  collapsedGroups: {},
  loadingLogGroups: {},
  loadingMoreLogGroups: {},
  logsLoading: false,
  selectedLogLoading: false,
  selectedLogRefreshLoading: false,
  requestPricing: null,
  requestPricingOpen: false,
  activeTaskPricing: null,
  activeTaskGroup: null,
  taskPricing: null,
  taskTokenSeries: null,
  taskCostSeries: null,
  taskOutputTokenSeries: null,
  taskPricingAbort: null,
  pricingGroupOpen: {},
  logsLoadedAt: 0,
  logLimit: 100,
  logOffset: 0,
  logsHasMore: false,
  logsTotal: 0,
  logQuery: "",
  lastLogQuery: "",
  splitterDragging: false,
  refreshTimer: null,
};
const $ = (id) => document.getElementById(id);
const t = (key) =>
  (translations[state.language] && translations[state.language][key]) ||
  translations.en[key] ||
  key;
const toast = (text) => {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2400);
};
const api = async (url, options = {}) => {
  const requestOptions = {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  };
  const res = await fetch(url, requestOptions);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error && typeof data.error.message === "string"
          ? data.error.message
          : res.statusText;
    throw new Error(message);
  }
  return data;
};
function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  $("languageSelect").value = state.language;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  updateExpandButton("request");
  updateExpandButton("response");
  updateMetaButton("request");
  updateMetaButton("response");
  updateResponseTiming();
  updateSelectAllLogsButton();
}
function setLanguage(language) {
  if (!translations[language]) return;
  if (document.querySelector(".proxy-card")) collectPairs();
  state.language = language;
  localStorage.setItem("llmProxyLanguage", language);
  applyLanguage();
  renderPairs();
  renderLogs();
  renderJsonPane("request", { preserveView: true });
  renderJsonPane("response", { preserveView: true });
  renderMetaPane("request");
  renderMetaPane("response");
  renderRequestPricing();
  renderTaskPricingPanel();
  // The statistics page is rendered on demand; re-render it if it was loaded so
  // its inline (non data-i18n) labels follow the new language without a refresh.
  if ($("statsOverview")?.innerHTML)
    loadStatisticsOptions()
      .then(() => loadStatistics())
      .catch((e) => toast(e.message));
}
function isPendingStatus(status) {
  return status === undefined || status === null || status === "pending";
}
function formatStatus(status) {
  return isPendingStatus(status) ? t("pending") : String(status);
}
function logStatusClass(status) {
  if (isPendingStatus(status)) return "pending";
  const code = Number(status);
  if (Number.isFinite(code) && code >= 200 && code < 400) return "success";
  if (Number.isFinite(code) && code >= 400) return "error";
  return "neutral";
}
function displayTimestampParts(value) {
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/.exec(text);
  if (!match) return { date: "", shortDate: "", time: text };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    shortDate: `${match[2]}-${match[3]}`,
    time: match[4],
  };
}
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
function formatCurrencyAmount(amount) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const text = String(amount);
  const [wholeRaw, fractionRaw = ""] = text.split(".");
  const whole = wholeRaw || "0";
  const next = (fractionRaw.slice(0, 5) + "00000").slice(0, 5);
  let rounded = BigInt(whole + next.slice(0, 4)) + BigInt(next[4] >= "5" ? 1 : 0);
  const scale = 10_000n;
  const integer = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(4, "0").replace(/0+$/, "");
  if (integer === 0n && fraction === "" && !/^0+(?:\.0+)?$/.test(text))
    return `< ${t("currencySymbol")}0.0001`;
  return `${t("currencySymbol")}${integer}${fraction ? `.${fraction}` : ""}`;
}
function formatRequestCost(cost) {
  if (!cost || cost.status === "unpriced") return "—";
  if (cost.status === "pending") return t("calculating");
  return formatCurrencyAmount(cost.amount);
}
function formatGroupCost(cost) {
  return cost ? formatCurrencyAmount(cost.known_amount) : "—";
}
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
  const decodeSpeed = formatGroupDecodeSpeed(item.decode_speed_tps);
  if (decodeSpeed !== "") {
    metrics.push(logMetricHtml("decode-speed", t("speed"), `${decodeSpeed}t/s`, t("speed")));
  }
  metrics.push(logMetricHtml("cost", t("cost"), formatRequestCost(item.cost), t("cost")));
  return (
    metrics.join("") ||
    `<span class="log-item-empty">${escapeHtml(formatStatus(item.status))}</span>`
  );
}
function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}
const suggestedStripRequestFields = __SUGGESTED_STRIP_REQUEST_FIELDS__;
const newTarget = () => ({
  id: `target-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name: "Target",
  enabled: true,
  target_url: "http://127.0.0.1:1235",
  target_api_key: "",
  target_headers: [],
  strip_request_fields: "",
  inject_request_fields: "",
  log_root: "logs",
  redact_logs: false,
  model_mappings: [],
  model_prices: [],
  expanded: false,
});
const newPair = () => {
  const target = newTarget();
  return {
    id: `proxy-${Date.now()}`,
    name: t("newProxy"),
    enabled: false,
    running: false,
    listen_host: "127.0.0.1",
    listen_port: 1234,
    access_log: false,
    targets: [target],
    default_target_id: target.id,
  };
};
function pairTargets(pair) {
  if (Array.isArray(pair.targets) && pair.targets.length) return pair.targets;
  const target = newTarget();
  pair.targets = [target];
  pair.default_target_id = pair.default_target_id || target.id;
  return pair.targets;
}
function mappingsText(mappings) {
  return (mappings || [])
    .map((item) =>
      item.upstream && item.upstream !== item.listen
        ? `${item.listen} => ${item.upstream}`
        : item.listen,
    )
    .join("\n");
}
function modelPriceRuleHtml(target, index) {
  const rule = (target.model_prices || [])[index] || {};
  const numberFields = [
    ["price_multiplier", "priceMultiplier"],
    ["input_per_million", "normalInputPrice"],
    ["output_per_million", "outputPrice"],
    ["cache_read_per_million", "cacheReadPrice"],
    ["cache_write_per_million", "cacheWritePrice"],
  ];
  const patternCell = `<label><span>${escapeHtml(t("pricePattern"))}</span><input data-price-field="model_pattern" value="${escapeHtml(rule.model_pattern ?? "")}" placeholder="gpt-*"></label>`;
  const gridCells = [
    patternCell,
    ...numberFields.map(
      ([field, label]) =>
        `<label><span>${escapeHtml(t(label))}</span><input data-price-field="${field}" inputmode="decimal" value="${escapeHtml(field === "price_multiplier" ? (rule[field] ?? "1") : (rule[field] ?? ""))}"></label>`,
    ),
  ];
  return `<section class="model-price-rule" data-price-index="${index}" aria-label="${escapeHtml(`${t("priceRule")} ${index + 1}`)}">
    <div class="price-rule-head"><strong>${escapeHtml(`${t("priceRule")} ${index + 1}`)}</strong><div class="price-actions"><button type="button" data-price-up title="${escapeHtml(t("movePriceUp"))}" aria-label="${escapeHtml(t("movePriceUp"))}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-price-down title="${escapeHtml(t("movePriceDown"))}" aria-label="${escapeHtml(t("movePriceDown"))}" ${index === (target.model_prices || []).length - 1 ? "disabled" : ""}>↓</button><button type="button" data-price-remove>${escapeHtml(t("delete"))}</button></div></div>
    <div class="price-field-grid">${gridCells.join("")}</div>
  </section>`;
}
function localPriceMatch(target) {
  const model = target.price_test_model || "";
  const rules = target.model_prices || [];
  if (!model) return "";
  const exact = rules.findIndex(
    (rule) => !rule.model_pattern?.includes("*") && rule.model_pattern === model,
  );
  const wildcard = rules.findIndex(
    (rule) => rule.model_pattern?.includes("*") && wildcardPriceMatch(rule.model_pattern, model),
  );
  const index = exact >= 0 ? exact : wildcard;
  return index < 0 ? t("priceNoMatch") : `#${index + 1}: ${rules[index].model_pattern}`;
}
function updateLocalPriceMatch(targetCard) {
  const target = {
    price_test_model: targetCard.querySelector("[data-price-test]")?.value || "",
    model_prices: [...targetCard.querySelectorAll("[data-price-index]")].map((rule) =>
      Object.fromEntries(
        [...rule.querySelectorAll("[data-price-field]")].map((input) => [
          input.dataset.priceField,
          input.value,
        ]),
      ),
    ),
  };
  const output = targetCard.querySelector(".price-test output");
  if (output) output.textContent = localPriceMatch(target);
}
function wildcardPriceMatch(pattern, model) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(model);
}
function renderTarget(target, pair, pairIndex, targetIndex) {
  const expanded = Boolean(target.expanded);
  const isDefault = pair.default_target_id === target.id;
  const canReorder = (pair.targets || []).length > 1;
  const statusClass = isDefault
    ? "is-default-target"
    : target.enabled !== false
      ? "is-enabled-target"
      : "is-disabled-target";
  return `
    <section class="target-card ${statusClass}" data-target-index="${targetIndex}">
      <div class="target-head">
        <div class="target-title">
          <button type="button" class="target-drag-handle" data-drag-target title="${escapeHtml(t("dragTarget"))}" aria-label="${escapeHtml(t("dragTarget"))}" ${canReorder ? "" : "disabled"}>⠿</button>
          <input data-target-field="name" value="${escapeHtml(target.name || "")}" placeholder="${escapeHtml(t("targetName"))}">
          <label class="default-target"><input type="radio" name="default-target-${pairIndex}" data-default-target ${isDefault ? "checked" : ""}> <span>${escapeHtml(t("defaultTarget"))}</span></label>
        </div>
        <button data-check-target title="${escapeHtml(t("checkTarget"))}">${escapeHtml(t("checkTarget"))}</button>
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
      <label><span>${escapeHtml(t("modelMappings"))}</span><textarea data-target-field="model_mappings" placeholder="*gpt-5.5* => gpt-5.5">${escapeHtml(mappingsText(target.model_mappings))}</textarea></label>
      <details class="model-prices" ${target.prices_expanded ? "open" : ""}>
        <summary>${escapeHtml(t("modelPrices"))} · ${(target.model_prices || []).length}</summary>
        <p class="price-help">${escapeHtml(t("priceUnit"))}</p>
        <div class="model-price-rules">${(target.model_prices || []).map((_, index) => modelPriceRuleHtml(target, index)).join("") || `<p class="price-empty">${escapeHtml(t("noModelPrices"))}</p>`}</div>
        <div class="price-tools"><button type="button" data-add-price>${escapeHtml(t("addModelPrice"))}</button><label class="price-test"><span>${escapeHtml(t("testPriceModel"))}</span><input data-price-test value="${escapeHtml(target.price_test_model || "")}"><output aria-live="polite">${escapeHtml(localPriceMatch(target))}</output></label></div>
      </details>
      <div class="target-controls">
        ${isDefault ? `<span class="target-enabled">${escapeHtml(t("defaultTarget"))}</span>` : `<label class="target-enabled"><input type="checkbox" data-target-enabled ${target.enabled !== false ? "checked" : ""}> <span>${escapeHtml(t("targetEnabled"))}</span></label>`}
        <button data-toggle-target-options>${escapeHtml(t(expanded ? "lessTargetOptions" : "moreTargetOptions"))}</button>
      </div>
      <div class="target-options" ${expanded ? "" : "hidden"}>
        <div class="fields">
          <label><span>${escapeHtml(t("logRoot"))}</span><input data-target-field="log_root" value="${escapeHtml(target.log_root || "logs")}"></label>
        </div>
        <label class="target-enabled"><input type="checkbox" data-redact-logs ${target.redact_logs ? "checked" : ""}> <span>${escapeHtml(t("redactLogs"))}</span></label>
        <label><span>${escapeHtml(t("upstreamHeaders"))}</span><textarea data-target-field="target_headers">${escapeHtml((target.target_headers || []).join("\n"))}</textarea></label>
        <label><span>${escapeHtml(t("stripFields"))}</span><textarea data-target-field="strip_request_fields" placeholder="${escapeHtml(suggestedStripRequestFields)}">${escapeHtml(target.strip_request_fields ?? "")}</textarea></label>
        <label><span>${escapeHtml(t("injectFields"))}</span><textarea data-target-field="inject_request_fields" placeholder='{"metadata":{"source":"proxy"}}'>${escapeHtml(target.inject_request_fields ?? "")}</textarea></label>
      </div>
    </section>`;
}
function renderPairs() {
  $("proxyGrid").innerHTML = state.pairs
    .map(
      (p, i) => `
    <article class="proxy-card" data-index="${i}">
      <div class="proxy-head">
        <div class="proxy-title"><span class="status ${p.running ? "running" : ""}"></span><input data-field="name" value="${escapeHtml(p.name || "")}"></div>
        <label><span>${escapeHtml(t("listenHost"))}</span><input data-field="listen_host" value="${escapeHtml(p.listen_host || "")}"></label>
        <label><span>${escapeHtml(t("port"))}</span><input type="number" data-field="listen_port" value="${p.listen_port || 0}"></label>
        <label class="switch" title="${escapeHtml(t("switch"))}"><input type="checkbox" data-toggle ${p.enabled ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <strong>${escapeHtml(t("targets"))}</strong>
      <div class="targets-row">
        ${pairTargets(p)
          .map((target, targetIndex) => renderTarget(target, p, i, targetIndex))
          .join("")}
      </div>
      <div class="row-actions"><button data-add-target>${escapeHtml(t("addTarget"))}</button><button data-remove>${escapeHtml(t("delete"))}</button></div>
    </article>`,
    )
    .join("");
}
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}
function collectPairs() {
  document.querySelectorAll(".proxy-card").forEach((card) => {
    const pair = state.pairs[Number(card.dataset.index)];
    card.querySelectorAll("[data-field]").forEach((input) => {
      const field = input.dataset.field;
      let value = input.value;
      if (field === "listen_port") value = Number(value);
      if (field === "target_headers")
        value = value
          .split(/\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      if (field === "strip_request_fields" && value === "") value = "";
      if (field === "inject_request_fields" && value === "") value = "";
      pair[field] = value;
    });
    card.querySelectorAll(".target-card").forEach((targetCard) => {
      const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
      targetCard.querySelectorAll("[data-target-field]").forEach((input) => {
        const field = input.dataset.targetField;
        let value = input.value;
        if (field === "target_headers")
          value = value
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (field === "model_mappings") {
          value = value
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const parts = line.split(/\s*=>\s*/);
              return { listen: parts[0].trim(), upstream: (parts[1] || parts[0]).trim() };
            })
            .filter((item) => item.listen);
        }
        if (field === "strip_request_fields" && value === "") value = "";
        if (field === "inject_request_fields" && value === "") value = "";
        target[field] = value;
      });
      target.model_prices = [...targetCard.querySelectorAll("[data-price-index]")].map((rule) => {
        const value = {};
        rule.querySelectorAll("[data-price-field]").forEach((input) => {
          value[input.dataset.priceField] = input.value;
        });
        return value;
      });
      target.price_test_model = targetCard.querySelector("[data-price-test]")?.value || "";
      target.prices_expanded = targetCard.querySelector(".model-prices")?.open || false;
      if (targetCard.querySelector("[data-default-target]")?.checked)
        pair.default_target_id = target.id;
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
// Target cards are reordered by dragging their grip handle (pointer events, not the
// native HTML5 drag API, so input fields keep working while cards move in the DOM).
let targetDrag = null;
function startTargetDrag(event) {
  const handle = event.target.closest?.("[data-drag-target]");
  if (!handle || handle.disabled || event.button !== 0) return;
  const card = handle.closest(".target-card");
  const row = card?.closest(".targets-row");
  if (!card || !row || row.querySelectorAll(".target-card").length < 2) return;
  event.preventDefault();
  handle.focus({ preventScroll: true });
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Capture is only a nicety; the window listeners below keep the drag alive.
  }
  collectPairs();
  targetDrag = {
    handle,
    card,
    row,
    scroller: row.closest(".proxy-view"),
    pairIndex: Number(row.closest(".proxy-card")?.dataset.index ?? -1),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    stacked: targetsRowIsStacked(row),
    started: false,
  };
}
function nearestTargetCard(row, dragged, x, y) {
  let nearest = null;
  let bestDistance = Infinity;
  row.querySelectorAll(".target-card").forEach((card) => {
    if (card === dragged) return;
    const rect = card.getBoundingClientRect();
    const distance = Math.hypot(
      Math.max(rect.left - x, 0, x - rect.right),
      Math.max(rect.top - y, 0, y - rect.bottom),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = card;
    }
  });
  return nearest;
}
// A row of cards can be a horizontal grid or a single-column stack (narrow screens);
// the drop side follows the axis the cards are actually arranged on.
function targetsRowIsStacked(row) {
  const rects = [...row.querySelectorAll(".target-card")].map((card) =>
    card.getBoundingClientRect(),
  );
  return !rects.some((rect, index) =>
    rects
      .slice(index + 1)
      .some((other) => rect.bottom > other.top + 1 && other.bottom > rect.top + 1),
  );
}
function autoScrollDuringTargetDrag(dragging, y) {
  const scroller = dragging.scroller;
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  const rect = scroller.getBoundingClientRect();
  const margin = 48;
  if (y < rect.top + margin) {
    scroller.scrollTop -= Math.ceil((rect.top + margin - y) / 3);
  } else if (y > rect.bottom - margin) {
    scroller.scrollTop += Math.ceil((y - (rect.bottom - margin)) / 3);
  }
}
function moveTargetCardToPointer(dragging, x, y) {
  const { card, row } = dragging;
  const nearest = nearestTargetCard(row, card, x, y);
  if (!nearest) return;
  const rect = nearest.getBoundingClientRect();
  const after = dragging.stacked
    ? y > rect.top + rect.height / 2
    : y > rect.bottom || (y >= rect.top && x > rect.left + rect.width / 2);
  if (after) {
    if (card.previousElementSibling === nearest) return;
    row.insertBefore(card, nearest.nextElementSibling);
  } else {
    if (card.nextElementSibling === nearest) return;
    row.insertBefore(card, nearest);
  }
}
function moveTargetDrag(event) {
  const dragging = targetDrag;
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  if (event.buttons === 0) {
    endTargetDrag(event);
    return;
  }
  if (!dragging.started) {
    if (Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 4) return;
    dragging.started = true;
    dragging.card.classList.add("is-dragging");
    document.body.classList.add("drag-target-active");
  }
  event.preventDefault();
  autoScrollDuringTargetDrag(dragging, event.clientY);
  moveTargetCardToPointer(dragging, event.clientX, event.clientY);
}
function commitTargetDrag(dragging) {
  const pair = state.pairs[dragging.pairIndex];
  if (!pair) return;
  const targets = pairTargets(pair);
  const ordered = [...dragging.row.querySelectorAll(".target-card")]
    .map((card) => targets[Number(card.dataset.targetIndex)])
    .filter(Boolean);
  if (ordered.length !== targets.length) return;
  pair.targets = ordered;
  renderPairs();
}
function endTargetDrag(event) {
  const dragging = targetDrag;
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  targetDrag = null;
  try {
    dragging.handle.releasePointerCapture(dragging.pointerId);
  } catch {
    // The pointer was already released.
  }
  dragging.card.classList.remove("is-dragging");
  document.body.classList.remove("drag-target-active");
  if (dragging.started) commitTargetDrag(dragging);
}
function cancelTargetDrag() {
  const dragging = targetDrag;
  if (!dragging) return;
  targetDrag = null;
  try {
    dragging.handle.releasePointerCapture(dragging.pointerId);
  } catch {
    // The pointer was already released.
  }
  dragging.card.classList.remove("is-dragging");
  document.body.classList.remove("drag-target-active");
  if (dragging.started) renderPairs();
}
// Keyboard equivalent of the drag: the arrow keys move the focused card one slot.
function moveTargetCardByKey(handle, offset) {
  const card = handle.closest(".target-card");
  const row = card?.closest(".targets-row");
  const pairCard = row?.closest(".proxy-card");
  const pairIndex = Number(pairCard?.dataset.index ?? -1);
  const pair = state.pairs[pairIndex];
  if (!pair) return;
  const index = Number(card.dataset.targetIndex);
  collectPairs();
  const targets = pairTargets(pair);
  const next = index + offset;
  if (next < 0 || next >= targets.length) return;
  [targets[index], targets[next]] = [targets[next], targets[index]];
  renderPairs();
  document
    .querySelector(
      `.proxy-card[data-index="${pairIndex}"] .target-card[data-target-index="${next}"] [data-drag-target]`,
    )
    ?.focus();
}
window.addEventListener("pointermove", moveTargetDrag);
window.addEventListener("pointerup", endTargetDrag);
window.addEventListener("pointercancel", endTargetDrag);
window.addEventListener("blur", () => cancelTargetDrag());
async function savePairs() {
  collectPairs();
  const data = await api("/api/pairs", {
    method: "PUT",
    body: JSON.stringify({ pairs: state.pairs }),
  });
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
function mergeLogGroupSummaries(currentGroups, nextGroups, query = "") {
  const currentById = new Map(currentGroups.map((group) => [group.id, group]));
  return nextGroups.map((group) => {
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
}
async function loadLogs(options = {}) {
  if (state.logsLoading) return;
  state.logsLoading = true;
  const showSearchProgress = Boolean(options.search);
  if (showSearchProgress) $("logListProgress").hidden = false;
  const q = encodeURIComponent(state.logQuery);
  try {
    const offset = options.append ? state.logOffset : 0;
    const limit =
      options.quiet && !options.append
        ? Math.max(state.logLimit, state.logOffset || state.logGroups.length)
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
      state.logGroups = mergeLogGroupSummaries(state.logGroups, nextGroups, state.logQuery);
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
    } else {
      scheduleLogRefresh();
    }
  }
}
async function refreshPendingLogItems() {
  const pendingItems = state.logGroups
    .filter((group) => group.logsLoaded && state.collapsedGroups[group.id])
    .flatMap((group) => group.logs || [])
    .filter((item) => isPendingStatus(item.status));
  const refreshedIds = new Set();
  let listChanged = false;
  await Promise.all(
    pendingItems.map(async (item) => {
      const data = await api(`/api/logs/${encodeURIComponent(item.id)}`);
      refreshedIds.add(item.id);
      if (state.selected === item.id) applySelectedLogDetail(data, { resetView: false });
      if (data.pending) return;
      const requestMeta = data.request_meta || {};
      const responseMeta = data.response_meta || {};
      item.message_count = requestMeta.message_count ?? item.message_count;
      item.status = responseMeta.status ?? item.status;
      item.request_token_count = responseMeta.request_token_count ?? item.request_token_count;
      item.response_token_count = responseMeta.response_token_count ?? item.response_token_count;
      item.cost = logRequestCost(data.pricing);
      listChanged = true;
    }),
  );
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
function renderLogs() {
  const groupsHtml =
    state.logGroups
      .map(
        (group) => `
    <section class="log-group">
      <div class="log-group-head" data-group-id="${escapeHtml(group.id || "")}" role="button" tabindex="0" aria-expanded="${state.collapsedGroups[group.id] ? "true" : "false"}" aria-label="${escapeHtml(t("task"))}">
        <div class="log-group-controls">
          <input class="log-group-select" type="checkbox" data-select-group="${escapeHtml(group.id || "")}" title="${escapeHtml(t("selectLogGroup"))}" ${state.selectedLogGroups[group.id] ? "checked" : ""}>
          <button type="button" class="log-group-detail-btn" data-group-detail="${escapeHtml(group.id || "")}" title="${escapeHtml(t("viewTaskPricing"))}" aria-label="${escapeHtml(t("viewTaskPricing"))}">ⓘ</button>
          <span class="log-group-caret" aria-hidden="true">${!state.collapsedGroups[group.id] ? "▸" : "▾"}</span>
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
            ${
              state.loadingLogGroups[group.id] || (!group.logsLoaded && !(group.logs || []).length)
                ? `<div class="log-item log-loading">${escapeHtml(t("loading"))}</div>`
                : (group.logs || []).length
                  ? (group.logs || [])
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
                      ? `<button class="load-more log-group-load-more" data-load-more-records="${escapeHtml(group.id || "")}" ${state.loadingMoreLogGroups[group.id] ? "disabled" : ""}>${escapeHtml(state.loadingMoreLogGroups[group.id] ? t("loading") : t("loadMore"))} (${group.logs.length}/${group.logsTotal})</button>`
                      : "")
                  : `<div class="log-item log-group-empty">${escapeHtml(t("noMatchedLogs"))}</div>`
            }
          </div>`
      }
    </section>`,
      )
      .join("") || `<div class="empty">${escapeHtml(t("noLogs"))}</div>`;
  updateSelectAllLogsButton();
  const moreHtml = state.logsHasMore
    ? `<button class="load-more" data-load-more>${escapeHtml(t("loadMore"))} (${state.logGroups.length}/${state.logsTotal})</button>`
    : "";
  $("logItems").innerHTML = groupsHtml + moreHtml;
}
// When a group is collapsed while its header is pinned to the top of the log
// list, removing the body would shift the whole list up; compensate by
// scrolling down by the removed height so the header keeps its position.
function collapseLogGroup(groupId) {
  // Note: state.collapsedGroups holds the EXPANDED state (flag set = body
  // visible); collapsing a group clears its flag.
  const list = $("logItems");
  const head = list.querySelector(`.log-group-head[data-group-id="${CSS.escape(groupId)}"]`);
  // Pinned: the header's border box sits at the scrollport content top
  // (list border + padding). At its natural (top of list) position the
  // section's 1 px border pushes it down one more pixel, and while
  // releasing from the pin it sits above the content top; only the pinned
  // state is worth compensating.
  const wasPinned = (() => {
    if (!head) return false;
    const contentTop =
      list.getBoundingClientRect().top +
      list.clientTop +
      parseFloat(getComputedStyle(list).paddingTop);
    const headTop = head.getBoundingClientRect().top;
    return headTop >= contentTop - 0.5 && headTop <= contentTop + 0.75;
  })();
  state.collapsedGroups[groupId] = false;
  renderLogs();
  if (wasPinned) {
    // With the body gone the header is the section's first child and sits at
    // its natural (non-sticky) spot, which is above the pinned line. Scroll
    // by exactly that offset so it lands back where it was pinned.
    const newHead = list.querySelector(`.log-group-head[data-group-id="${CSS.escape(groupId)}"]`);
    if (!newHead) return;
    const contentTop =
      list.getBoundingClientRect().top +
      list.clientTop +
      parseFloat(getComputedStyle(list).paddingTop);
    list.scrollTop += newHead.getBoundingClientRect().top - contentTop;
  }
}
function pricingDecimalFromNano(value) {
  if (value === null || value === undefined || value === "") return null;
  const nano = BigInt(String(value));
  const integer = nano / 1_000_000_000n;
  const fraction = (nano % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}
function pricingAmount(value) {
  return formatCurrencyAmount(pricingDecimalFromNano(value));
}
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
function formatIntegerValue(value) {
  if (value === null || value === undefined || value === "—") return "—";
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString(state.language === "en" ? "en-US" : "zh-CN")
    : String(value);
}
function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (state.language === "en")
    return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
  return n.toLocaleString("zh-CN");
}
function fullNumber(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString(state.language === "en" ? "en-US" : "zh-CN")
    : String(value);
}
function pricingStatusValue(pricing) {
  if (!pricing || pricing.pricing_status === "unpriced") return "—";
  if (pricing.pricing_status === "pending") return t("calculating");
  return pricingAmount(pricing.cost_nano_cny);
}
function logRequestCost(pricing) {
  if (!pricing) return undefined;
  return {
    currency: "CNY",
    status: pricing.pricing_status,
    reason: pricing.pricing_reason ?? null,
    amount:
      pricing.pricing_status === "priced" ? pricingDecimalFromNano(pricing.cost_nano_cny) : null,
  };
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
function renderRequestPricing() {
  const el = $("responsePricing");
  const pricing = state.requestPricing;
  const open = Boolean(pricing && state.requestPricingOpen);
  el.hidden = !open;
  updateRequestPricingButton();
  if (!open) {
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
// Human-readable total for the summary card: >= 1亿 / >= 1万 in Chinese,
// >= 1B / >= 1M in English, otherwise a plain comma-grouped number.
function formatTokenCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (state.language === "en") {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  } else {
    if (value >= 1e8) return `${(value / 1e8).toFixed(1).replace(/\.0$/, "")} 亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, "")} 万`;
  }
  return value.toLocaleString(state.language === "en" ? "en-US" : "zh-CN");
}
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
// Choose the y-axis step and maximum for the task-detail line charts: the
// highest data point should sit close to the top gridline.  Among the 1/2/5
// "nice" steps that leave 3 to 8 gridline intervals, pick the one with the
// smallest resulting axis maximum (ties prefer the larger step).  A plain
// "max / 4" round-up can jump to the next 1/2/5 tier (e.g. 8,400 -> 5,000)
// and then force the axis to 4 steps (20,000), leaving the top of the chart
// mostly empty.
function niceAxisScale(maxValue) {
  const max = Number(maxValue);
  if (!Number.isFinite(max) || max <= 0) return { step: 1, axisMax: 4 };
  let best = null;
  const top = Math.floor(Math.log10(max));
  for (let exponent = top - 2; exponent <= top + 1; exponent++) {
    for (const factor of [1, 2, 5]) {
      const step = factor * 10 ** exponent;
      const intervals = Math.ceil(max / step - 1e-9);
      if (intervals < 3 || intervals > 8) continue;
      const axisMax = step * intervals;
      if (!best || axisMax < best.axisMax || (axisMax === best.axisMax && step > best.step))
        best = { step, axisMax };
    }
  }
  return best ?? { step: 1, axisMax: Math.ceil(max) };
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
  return `<div class="token-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("tokenTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}</svg></div>`;
}
// Axis tick labels for yuan values: compact for large amounts, fixed four
// decimal places (trimmed) for everyday per-request costs, scientific for
// sub-0.0001-yuan amounts where fixed decimals would round to zero.
function costAxisLabel(value) {
  const n = Number(value);
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return compactNumber(n);
  if (Math.abs(n) < 1e-4) return n.toPrecision(1);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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
  const maxSequence = Math.max(...known.map((point) => Number(point.sequence)));
  const minSequence = Math.min(...known.map((point) => Number(point.sequence)));
  const maxCost = Math.max(...known.map(valueFor));
  const { step: niceStep, axisMax } = niceAxisScale(maxCost);
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
  return `<div class="cost-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("costTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}</svg></div>`;
}
// Raw SVG line chart for the task-detail token output trend: x = request
// sequence, y = cumulative output (response) tokens from the task start
// through each request. Requests whose output token count is still unknown
// keep the running total unchanged, so the line is flat between requests
// with known output tokens; the axis always shows the real sequence numbers.
function taskOutputTokenChartHtml(points) {
  const known = (points || []).filter((point) => Number(point?.output_tokens) >= 0);
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
  const maxTokens = Math.max(...known.map((point) => Number(point.output_tokens)));
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
        `${english ? "Request" : "请求"} #${Number(point.sequence)}: ${english ? "Cumulative " : "累计 "}${fullNumber(
          point.output_tokens,
        )} ${english ? " output tokens" : " 个输出 token"}`,
      );
      return `<circle class="token-chart-dot" cx="${x}" cy="${y}" r="3.5"><title>${title}</title></circle>`;
    })
    .join("");
  return `<div class="output-token-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("outputTokenTrend"))}">${gridLines.join("")}${xLabels}${area}${line}${dots}</svg></div>`;
}
const pricingGroupOpenStorageKey = "llmProxyPricingGroupOpen";
function loadPricingGroupOpenState() {
  let parsed = null;
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
loadPricingGroupOpenState();
// Shrink task-summary values one pixel at a time until they fit on one
// The model card value wraps at narrow widths; shrink it (to a 12px floor)
// before it wraps more than necessary, keeping the summary rows compact.
// Wrapping remains the last-resort fallback.
function fitTaskSummaryValues(root) {
  const model = root.querySelector(".task-stat-model > strong");
  if (!model) return;
  let fs = parseFloat(getComputedStyle(model).fontSize);
  while (fs > 12) {
    const lh = parseFloat(getComputedStyle(model).lineHeight) || fs * 1.35;
    if (model.scrollHeight <= lh * 1.5) break;
    fs -= 1;
    model.style.fontSize = `${fs}px`;
  }
}
// Stacked start/↓/end time range for the task-detail time bar: the “Time
// range” label shares the start-time row on the left (the user rejected the
// top-header variant), both the start- and end-date badges always render
// (even when the range is same-day) so the two time values stay in the same
// column, and a thin down-arrow row (no badge, time column only) keeps the
// vertical gap between the two times small.
function taskTimeRangeHtml(group) {
  const start = displayTimestampParts(group.started_at);
  const end = displayTimestampParts(group.last_activity_at);
  if (!start.time && !end.time && !(start.date && end.date)) {
    return `<span class="log-group-time-fallback">${escapeHtml(group.id || t("task"))}</span>`;
  }
  // The label sits on the start-time row (left side), not as a top header.
  // Both date badges always render, even for same-day ranges.
  const showStart = Boolean(start.time || start.date);
  const showEnd = Boolean(end.time || end.date);
  const badge = (parts, cls) =>
    parts.date ? `<span class="log-group-date ${cls}">${escapeHtml(parts.shortDate)}</span>` : "";
  const arrow =
    showStart && showEnd ? '<span class="log-time-arrow-down" aria-hidden="true">↓</span>' : "";
  const inner = [
    `<small class="task-time-range-label">${t("timeRange")}</small>`,
    showStart ? badge(start, "task-time-date-start") : "",
    showStart && start.time ? `<span class="task-time-start">${escapeHtml(start.time)}</span>` : "",
    arrow,
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
    decode_speed_tps: group.decode_speed_tps ?? null,
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
function renderTaskPricingPanel() {
  const panel = $("pricingPanel");
  const detail = $("detail");
  const pricing = state.taskPricing;
  const active = state.activeTaskPricing;
  detail.classList.toggle("pricing-open", Boolean(active));
  panel.hidden = !active;
  if (!active) {
    panel.innerHTML = "";
    return;
  }
  if (!pricing || pricing.id !== active || pricing.loading) {
    panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div><p>${escapeHtml(t("loading"))}</p>`;
    return;
  }
  if (pricing.error) {
    const deleted = pricing.error === "deleted";
    panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div><p>${escapeHtml(deleted ? t("taskDeleted") : t("pricingUnavailable"))}</p>${deleted ? "" : `<button type="button" data-retry-pricing>${escapeHtml(t("retry"))}</button>`}`;
    return;
  }
  const data = pricing.data;
  const openGroups = state.pricingGroupOpen[active] || {};
  const presentModels = new Set((data.groups || []).map((group) => group.billing_model || "—"));
  Object.keys(openGroups).forEach((model) => {
    if (!presentModels.has(model)) delete openGroups[model];
  });
  if (Object.keys(openGroups).length === 0) delete state.pricingGroupOpen[active];
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
  const group = state.activeTaskGroup;
  const decodeSpeed = group ? formatGroupDecodeSpeed(group.decode_speed_tps) : "";
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
      // above the two stacked time lines.
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
  const tokenSeries =
    state.taskTokenSeries && state.taskTokenSeries.id === active
      ? state.taskTokenSeries.points
      : null;
  const tokenChart = `<h3 class="section-token">${escapeHtml(t("tokenTrend"))}</h3>${tokenSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskTokenChartHtml(tokenSeries)}<p class="pricing-note">${escapeHtml(t("tokenTrendNote"))}</p>`;
  const costSeries =
    state.taskCostSeries && state.taskCostSeries.id === active ? state.taskCostSeries.points : null;
  const costChart = `<h3 class="section-cost">${escapeHtml(t("costTrend"))}</h3>${costSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskCostChartHtml(costSeries)}<p class="pricing-note">${escapeHtml(t("costTrendNote"))}</p>`;
  const outputTokenSeries =
    state.taskOutputTokenSeries && state.taskOutputTokenSeries.id === active
      ? state.taskOutputTokenSeries.points
      : null;
  const outputTokenChart = `<h3 class="section-output">${escapeHtml(t("outputTokenTrend"))}</h3>${outputTokenSeries === null ? `<p>${escapeHtml(t("loading"))}</p>` : taskOutputTokenChartHtml(outputTokenSeries)}<p class="pricing-note">${escapeHtml(t("outputTokenTrendNote"))}</p>`;
  panel.innerHTML = `<div class="pricing-panel-head"><strong>${escapeHtml(t("taskPricing"))}</strong><button type="button" data-close-pricing>${escapeHtml(t("close"))}</button></div>${summaryCard}${data.priced_request_count ? taskBreakdownTableHtml(data.breakdown, pricingDecimalFromNano(data.cost_nano_cny)) : `<p>${escapeHtml(reasons || t("unpriced"))}</p>`}<p class="pricing-note">${escapeHtml(t("taskWholeScope"))}</p>${tokenChart}${outputTokenChart}${costChart}<h3 class="section-groups">${escapeHtml(t("priceGroups"))}</h3>${groups || `<p>${escapeHtml(t("unpriced"))}</p>`}`;
  fitTaskSummaryValues(panel);
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
async function showTaskPricing(groupId) {
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
  state.taskTokenSeries = { id: groupId, points: null };
  state.taskCostSeries = { id: groupId, points: null };
  state.taskOutputTokenSeries = { id: groupId, points: null };
  renderTaskPricingPanel();
  const series = loadTaskTokenSeries(groupId, controller.signal);
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
  await Promise.all([series, costSeries, outputTokenSeries]);
}
function closeTaskPricing() {
  state.taskPricingAbort?.abort();
  state.taskPricingAbort = null;
  state.activeTaskPricing = null;
  state.activeTaskGroup = null;
  state.taskTokenSeries = null;
  state.taskCostSeries = null;
  state.taskOutputTokenSeries = null;
  renderTaskPricingPanel();
}
async function refreshTaskPricingPanel() {
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
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
const defaultJsonExpandedDepth = 2;
function jsonContentOffset(container, el) {
  let top = 0;
  let node = el;
  while (node && node !== container) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return top;
}
function jsonNodePathAttr(path) {
  return escapeHtml(JSON.stringify(path));
}
function collectJsonPaneViewState(el) {
  const nodeState = new Map();
  el.querySelectorAll("details[data-json-node-path]").forEach((detail) => {
    const body = detail.classList.contains("json-str-detail")
      ? detail.querySelector(".json-str-body")
      : null;
    nodeState.set(detail.dataset.jsonNodePath, {
      open: detail.open,
      scrollTop: body?.scrollTop || 0,
      scrollLeft: body?.scrollLeft || 0,
    });
  });
  return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, nodeState };
}
function restoreJsonPaneViewState(el, viewState) {
  if (!viewState) return;
  el.querySelectorAll("details[data-json-node-path]").forEach((detail) => {
    const saved = viewState.nodeState.get(detail.dataset.jsonNodePath);
    if (!saved) return;
    detail.open = saved.open;
    if (!detail.classList.contains("json-str-detail")) return;
    const body = detail.querySelector(".json-str-body");
    if (!body) return;
    body.scrollTop = saved.scrollTop;
    body.scrollLeft = saved.scrollLeft;
  });
  el.scrollTop = viewState.scrollTop;
  el.scrollLeft = viewState.scrollLeft;
}
function renderJsonValue(
  value,
  key = "",
  root = false,
  formatMode = false,
  depth = 0,
  path = [],
  lineWidth = 0,
) {
  const type = jsonType(value);
  const keyHtml =
    key === "" ? "" : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span>: `;
  if (type === "array" || type === "object") {
    const entries =
      type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    const start = type === "array" ? "[" : "{";
    const end = type === "array" ? "]" : "}";
    const summary = `${keyHtml}${start}<span class="json-muted">${entries.length ? ` ${entries.length} ${t("items")} ` : ""}</span>${end}`;
    const childrenHtml = `<div class="json-children">${entries
      .map(
        ([childKey, childValue]) =>
          `<div class="json-row">${renderJsonValue(
            childValue,
            String(childKey),
            false,
            formatMode,
            depth + 1,
            path.concat([childKey]),
            lineWidth,
          )}</div>`,
      )
      .join("")}</div>`;
    const openAttr = depth < defaultJsonExpandedDepth ? " open" : "";
    return `<details${openAttr} class="json-node${root ? " root" : ""}" data-json-depth="${depth}" style="--json-sticky-depth: ${depth}" data-json-node-path="${jsonNodePathAttr(path)}"><summary>${summary}</summary>${childrenHtml}<div class="json-muted">${end}</div></details>`;
  }
  if (type === "string") {
    const plain = `${keyHtml}<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    if (!formatMode) return plain;
    const displayValue = formatString(value);
    const hasNewline = displayValue.indexOf(String.fromCharCode(10)) !== -1;
    const shouldFormat = hasNewline || value.indexOf("\\") !== -1 || value.indexOf('"') !== -1;
    const tooWide =
      !hasNewline && lineWidth > 0 && !jsonTextFitsOnLine(displayValue, key, depth, lineWidth);
    if (hasNewline || tooWide) {
      const summaryRaw = displayValue.substring(0, 150);
      const summarySingleLine = escapeHtml(summaryRaw.replace(/\r\n/g, "↵").replace(/\n/g, "↵"));
      const summaryText = summarySingleLine + (displayValue.length > 150 ? "…" : "");
      const fullLines = displayValue.split(String.fromCharCode(10)).length;
      return `${keyHtml}<details class="json-str-detail" data-json-node-path="${jsonNodePathAttr(path)}"><summary>${summaryText} <span class="json-muted">(${fullLines} ${t("lines")})</span></summary><div class="json-str-full"><button class="json-str-copy" data-copy-string title="${escapeHtml(t("copyFormattedText"))}">📋</button><pre class="json-str-body">${escapeHtml(displayValue)}</pre></div></details>`;
    }
    if (!shouldFormat) return plain;
    return `${keyHtml}<span class="json-string format-mode">${escapeHtml(displayValue)}</span>`;
  }
  if (type === "number")
    return `${keyHtml}<span class="json-number">${escapeHtml(String(value))}</span>`;
  if (type === "boolean")
    return `${keyHtml}<span class="json-boolean">${escapeHtml(String(value))}</span>`;
  if (type === "undefined") return `${keyHtml}<span class="json-null">undefined</span>`;
  return `${keyHtml}<span class="json-null">null</span>`;
}
let jsonMeasureBox = null;
let jsonMeasureResults = new Map();
function ensureJsonMeasureBox() {
  if (!jsonMeasureBox) {
    jsonMeasureBox = document.createElement("div");
    jsonMeasureBox.style.cssText =
      "position:absolute;top:0;left:-9999px;visibility:hidden;white-space:pre;padding:0;margin:0;border:0;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;";
    document.body.appendChild(jsonMeasureBox);
  }
  return jsonMeasureBox;
}
function collectJsonMeasureProbes(value, key, depth, lineWidth, probes) {
  if (value === null || value === undefined) return;
  const type = jsonType(value);
  if (type === "array" || type === "object") {
    const entries =
      type === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
    for (const [childKey, childValue] of entries) {
      collectJsonMeasureProbes(childValue, String(childKey), depth + 1, lineWidth, probes);
    }
    return;
  }
  if (type !== "string") return;
  const displayValue = formatString(value);
  if (displayValue.indexOf(String.fromCharCode(10)) !== -1) return;
  const probe = (key === "" ? "" : JSON.stringify(key) + ": ") + displayValue;
  const available = lineWidth - 16 * depth - 8;
  if (available > 0 && probe.length * 12 > available && probe.length * 7.2 <= available) {
    probes.push(probe);
  }
}
function prepareJsonMeasurements(value, lineWidth) {
  jsonMeasureResults = new Map();
  if (lineWidth <= 0) return;
  const probes = [];
  collectJsonMeasureProbes(value, "", 0, lineWidth, probes);
  if (!probes.length) return;
  const box = ensureJsonMeasureBox();
  box.textContent = "";
  const measured = [];
  const seen = new Set();
  for (const probe of probes) {
    if (seen.has(probe)) continue;
    seen.add(probe);
    const el = document.createElement("div");
    el.textContent = probe;
    box.appendChild(el);
    measured.push([probe, el]);
  }
  // 一次性强制布局，批量拿到全部探测文本的宽度
  void box.offsetHeight;
  for (const [probe, el] of measured) jsonMeasureResults.set(probe, el.offsetWidth);
}
function measureJsonTextWidth(text) {
  const cached = jsonMeasureResults.get(text);
  if (cached !== undefined) return cached;
  // 回退：预扫描未覆盖时单独测量
  const box = ensureJsonMeasureBox();
  box.textContent = text;
  return box.offsetWidth;
}
function jsonTextFitsOnLine(displayValue, key, depth, lineWidth) {
  const probe = (key === "" ? "" : JSON.stringify(key) + ": ") + displayValue;
  const available = lineWidth - 16 * depth - 8;
  if (available <= 0) return false;
  if (probe.length * 12 <= available) return true;
  if (probe.length * 7.2 > available) return false;
  return measureJsonTextWidth(probe) <= available;
}
function formatString(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\\n/g, String.fromCharCode(10))
    .replace(/\\r/g, String.fromCharCode(13))
    .replace(/\\t/g, "    ")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function jsonText(value) {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "undefined" : text;
}
function renderJsonPane(key, options = {}) {
  const el = $(key + "Json");
  const viewState = options.preserveView ? collectJsonPaneViewState(el) : null;
  el.classList.toggle("wrap", state.wrap[key]);
  el.classList.toggle("nowrap", !state.wrap[key]);
  if (state.tree[key]) {
    const lineWidth = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
    if (state.formatStrings[key]) prepareJsonMeasurements(state.raw[key], lineWidth);
    el.innerHTML = renderJsonValue(
      state.raw[key],
      "",
      true,
      state.formatStrings[key],
      0,
      [],
      lineWidth,
    );
    restoreJsonPaneViewState(el, viewState);
  } else {
    el.textContent = jsonText(state.raw[key]);
  }
  updateExpandButton(key);
  updatePaneButtons(key);
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
function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || milliseconds === "") return "";
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return "";
  // Do not round sub-second timings to seconds: a real 95 ms TTFT used to
  // be rendered as 00:00, which looked like a missing/zero measurement.
  if (value < 1_000) return `${Math.round(value)} ms`;
  const totalSeconds = Math.round(value / 1_000);
  if (totalSeconds >= 3_600) {
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}
function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
function formatTokensPerSecond(value) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
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
  if (tokenMs !== undefined && durationMs !== undefined) {
    // Prefill is measured until the first generated text token; records without
    // that timing (e.g. non-streaming responses) do not show speed estimates.
    // Prompt-cache hits are served by the upstream without a real prefill, so
    // only the uncached input tokens count toward the prefill speed estimate.
    const inputTokens = positiveNumber(meta.request_token_count) ?? 0;
    const cachedTokens = Math.min(positiveNumber(meta.cached_token_count) ?? 0, inputTokens);
    const prefill = formatTokensPerSecond((inputTokens - cachedTokens) * (1000 / tokenMs));
    const decodeWindowMs = durationMs - tokenMs;
    const decode =
      decodeWindowMs > 0
        ? formatTokensPerSecond(
            (positiveNumber(meta.response_token_count) ?? 0) * (1000 / decodeWindowMs),
          )
        : "";
    if (prefill !== "") parts.push(`${t("prefillSpeed")} ${prefill} ${t("tokensPerSecond")}`);
    if (decode !== "") parts.push(`${t("decodeSpeed")} ${decode} ${t("tokensPerSecond")}`);
  }
  element.textContent = parts.join(" · ");
  element.hidden = parts.length === 0;
}
function updateMetaButton(key) {
  const button = document.querySelector(`[data-meta="${key}"]`);
  if (!button) return;
  const available = hasMetadata(state.meta[key]);
  button.disabled = !available;
  button.classList.toggle("active", available && state.metaOpen[key]);
  button.title = available && state.metaOpen[key] ? t("hideMetadata") : t("showMetadata");
}
function updateRequestPricingButton() {
  const button = document.querySelector('[data-pricing="response"]');
  if (!button) return;
  const available = Boolean(state.requestPricing);
  button.disabled = !available;
  button.classList.toggle("active", available && state.requestPricingOpen);
  button.title =
    available && state.requestPricingOpen ? t("hideCostDetails") : t("showCostDetails");
  button.setAttribute("aria-expanded", String(available && state.requestPricingOpen));
}
function updatePaneButtons(key) {
  document.querySelector(`[data-wrap="${key}"]`).classList.toggle("active", state.wrap[key]);
  document
    .querySelector(`[data-format="${key}"]`)
    .classList.toggle("active", state.formatStrings[key]);
  const expandBtn = document.querySelector(`[data-expand="${key}"]`);
  if (expandBtn) {
    const details = Array.from($(key + "Json").querySelectorAll("details:not(.json-str-detail)"));
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    expandBtn.classList.toggle("active", !allOpen);
  }
}
function updateExpandButton(key) {
  const button = document.querySelector(`[data-expand="${key}"]`);
  if (!button) return;
  const details = Array.from($(key + "Json").querySelectorAll("details:not(.json-str-detail)"));
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
$("summarizeRecord")?.addEventListener("click", async () => {
  const button = $("summarizeRecord");
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
      if ($("summaryPanel").open) {
        $("summaryPanel").close();
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
async function selectLog(id) {
  closeTaskPricing();
  state.selected = id;
  renderLogs();
  state.selectedLogLoading = true;
  try {
    const data = await api(`/api/logs/${encodeURIComponent(id)}`);
    if (state.selected !== id) return;
    applySelectedLogDetail(data, { resetView: true });
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
  } catch {}
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
    const data = await api(`/api/logs/${encodeURIComponent(id)}`);
    if (state.selected !== id) return;
    applySelectedLogDetail(data, { resetView: false });
  } finally {
    state.selectedLogRefreshLoading = false;
  }
}
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .view").forEach((el) => el.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "logs") loadLogs().catch((e) => toast(e.message));
    if (tab.dataset.tab === "statistics")
      loadStatisticsOptions()
        .then(() => loadStatistics())
        .catch((e) => toast(e.message));
  }),
);

let statisticsRequestId = 0;
async function loadStatistics() {
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
    (Object.values(result.unpriced || {}).reduce((a, b) => a + Number(b), 0)
      ? `<div class="stats-unpriced"><span class="stats-alert-icon">!</span><span>${english ? "Unpriced records are excluded from cost totals" : "有未计价记录，费用合计不包含这些记录"}${
          english ? " (" : "（"
        }${Object.values(result.unpriced || {})
          .reduce((a, b) => a + Number(b), 0)
          .toLocaleString(english ? "en-US" : "zh-CN")}${english ? ")" : "）"}</span></div>`
      : "") +
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
  const maxRequests = Math.max(
    1,
    ...trend.points.map((point) =>
      displayGroupsFor(point).reduce((sum, group) => sum + valueOf(group), 0),
    ),
  );
  const niceCeil = (value) => {
    const exp = 10 ** Math.floor(Math.log10(Math.max(1e-9, value)));
    const f = value / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
  };
  const niceMax = niceCeil(maxRequests);
  const formatTick = (v) => compactNumber(v);
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
  const tickFractions = [0, 0.25, 0.5, 0.75, 1];
  const trendGrid = tickFractions
    .map(
      (f) =>
        `<i class="trend-gridline${f === 0 ? " base" : ""}" style="bottom:${22 + 200 * f}px"></i>`,
    )
    .join("");
  const trendYaxis = `<div class="trend-yaxis" aria-hidden="true">${tickFractions
    .map((f) => `<span style="bottom:${15 + 200 * f}px">${formatTick(niceMax * f)}</span>`)
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
    metricState.trend = event.target.value;
    loadStatistics().catch(showStatisticsError);
  });
  $("statsMetricTarget")?.addEventListener("change", (event) => {
    metricState.target = event.target.value;
    loadStatistics().catch(showStatisticsError);
  });
  $("statsMetricModel")?.addEventListener("change", (event) => {
    metricState.model = event.target.value;
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
async function loadStatisticsOptions() {
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
$("refreshStatistics")?.addEventListener("click", () =>
  loadStatistics().catch(showStatisticsError),
);
function statsLocalInput(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
document.querySelectorAll("[data-stats-range]").forEach((button) =>
  button.addEventListener("click", () => {
    const days = Number(button.dataset.statsRange || 7);
    const to = new Date();
    const from =
      days === 0
        ? new Date(to.getFullYear(), to.getMonth(), to.getDate())
        : new Date(to.getTime() - days * 86400000);
    $("statsFrom").value = statsLocalInput(from);
    $("statsTo").value = statsLocalInput(to);
    document
      .querySelectorAll("[data-stats-range]")
      .forEach((item) => item.classList.toggle("active", item === button));
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
$("statsMetric")?.addEventListener("change", () => loadStatistics().catch((e) => toast(e.message)));
$("statsTarget")?.addEventListener("change", () =>
  loadStatisticsOptions()
    .then(() => loadStatistics())
    .catch(showStatisticsError),
);
$("statsModel")?.addEventListener("change", () => loadStatistics().catch((e) => toast(e.message)));
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
  document
    .querySelectorAll("[data-stats-range]")
    .forEach((item) => item.classList.toggle("active", item.dataset.statsRange === "7"));
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
loadStatisticsOptions().catch(() => {});
$("languageSelect").addEventListener("change", (event) => setLanguage(event.target.value));
$("addProxy").addEventListener("click", () => {
  state.pairs.push(newPair());
  renderPairs();
});
$("saveProxies").addEventListener("click", () => savePairs().catch((e) => toast(e.message)));
$("proxyGrid").addEventListener("click", (event) => {
  const card = event.target.closest(".proxy-card");
  if (!card) return;
  const pair = state.pairs[Number(card.dataset.index)];
  if (
    event.target.matches(
      "[data-add-price], [data-price-remove], [data-price-up], [data-price-down]",
    )
  ) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    const rules = target.model_prices || (target.model_prices = []);
    const index = Number(event.target.closest("[data-price-index]")?.dataset.priceIndex);
    if (event.target.matches("[data-add-price]")) {
      rules.push({
        model_pattern: "",
        price_multiplier: "1",
        input_per_million: "",
        output_per_million: "",
        cache_read_per_million: "",
        cache_write_per_million: "",
      });
    } else if (event.target.matches("[data-price-remove]")) {
      rules.splice(index, 1);
    } else if (event.target.matches("[data-price-up]") && index > 0) {
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
    } else if (event.target.matches("[data-price-down]") && index < rules.length - 1) {
      [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
    }
    target.prices_expanded = true;
    renderPairs();
    return;
  }
  if (event.target.matches("[data-add-target]")) {
    collectPairs();
    const target = newTarget();
    pairTargets(pair).push(target);
    pair.default_target_id = pair.default_target_id || target.id;
    renderPairs();
    return;
  }
  if (event.target.matches("[data-toggle-target-options]")) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    target.expanded = !target.expanded;
    renderPairs();
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
      () => toast(t("copyFailed")),
    );
    return;
  }
  if (event.target.matches("[data-check-target]")) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    openTargetCheckDialog(target);
    return;
  }
  if (event.target.matches("[data-remove-target]")) {
    collectPairs();
    const targetCard = event.target.closest(".target-card");
    const targets = pairTargets(pair);
    if (targets.length <= 1) return;
    const removed = targets.splice(Number(targetCard.dataset.targetIndex), 1)[0];
    if (pair.default_target_id === removed.id) pair.default_target_id = targets[0].id;
    renderPairs();
    return;
  }
  if (event.target.matches("[data-remove]")) {
    state.pairs.splice(Number(card.dataset.index), 1);
    renderPairs();
  }
});
const targetCheckStart = $("targetCheckStart");
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
  $("targetCheckDialog").showModal();
}
$("targetCheckClose").addEventListener("click", () => $("targetCheckDialog").close());
$("targetCheckForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (targetCheckStart.disabled) return;
  const result = $("targetCheckResult");
  targetCheckStart.disabled = true;
  targetCheckStart.textContent = t("checking");
  result.hidden = false;
  result.className = "target-check-result testing";
  result.textContent = t("checking");
  try {
    const data = await api("/api/target-check", {
      method: "POST",
      body: JSON.stringify({
        targetUrl: $("targetCheckUrl").value,
        model: $("targetCheckModel").value,
        apiType: $("targetCheckApiType").value,
        apiKey: $("targetCheckApiKey").value,
      }),
    });
    const duration = `${Math.round(data.durationMs)} ms`;
    if (data.ok) {
      if ((data.status ?? 0) < 400) {
        result.className = "target-check-result success";
        result.textContent = `${t("checkOk")} · HTTP ${data.status} · ${duration}`;
      } else {
        const detail =
          typeof data.detail === "string" && data.detail !== "" ? `\n${data.detail}` : "";
        result.className = "target-check-result warning";
        result.textContent = `${t("checkBadStatus").replace("{status}", String(data.status))} · ${duration}${detail}`;
      }
    } else {
      result.className = "target-check-result failure";
      result.textContent = `${t("checkFail")} · ${data.error || "unknown error"} · ${duration}`;
    }
  } catch (error) {
    result.className = "target-check-result failure";
    result.textContent = `${t("checkFail")} · ${error.message || error}`;
  } finally {
    targetCheckStart.disabled = false;
    targetCheckStart.textContent = t("startCheck");
  }
});
$("proxyGrid").addEventListener("change", async (event) => {
  if (event.target.matches("[data-default-target]")) {
    collectPairs();
    renderPairs();
    return;
  }
  if (event.target.matches("[data-target-enabled]")) {
    const targetCard = event.target.closest(".target-card");
    targetCard?.classList.toggle("is-enabled-target", event.target.checked);
    targetCard?.classList.toggle("is-disabled-target", !event.target.checked);
    return;
  }
  if (!event.target.matches("[data-toggle]")) return;
  collectPairs();
  await savePairs();
  const pair = state.pairs[Number(event.target.closest(".proxy-card").dataset.index)];
  const data = await api(`/api/pairs/${encodeURIComponent(pair.id)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled: event.target.checked }),
  });
  Object.assign(pair, data.pair);
  renderPairs();
});
$("proxyGrid").addEventListener("pointerdown", (event) => startTargetDrag(event));
$("proxyGrid").addEventListener("keydown", (event) => {
  if (targetDrag?.started && event.key === "Escape") {
    event.preventDefault();
    cancelTargetDrag();
    return;
  }
  const handle = event.target.closest?.("[data-drag-target]");
  if (!handle || handle.disabled) return;
  const offset = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  moveTargetCardByKey(handle, offset);
});
$("proxyGrid").addEventListener("input", (event) => {
  if (!event.target.matches("[data-price-field], [data-price-test]")) return;
  const targetCard = event.target.closest(".target-card");
  if (targetCard) updateLocalPriceMatch(targetCard);
});
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
$("refreshLogs").addEventListener("click", () => loadLogs().catch((e) => toast(e.message)));
$("searchLogs").addEventListener("click", runLogSearch);
$("logSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runLogSearch();
});
$("exportLogs").addEventListener("click", () => exportLogs().catch((e) => toast(e.message)));
$("cleanupLogs").addEventListener("click", () => cleanupLogs().catch((e) => toast(e.message)));
$("cleanupSingleRequestLogs").addEventListener("click", () =>
  cleanupSingleRequestLogs().catch((e) => toast(e.message)),
);
$("summaryModelSettings").addEventListener("click", async () => {
  const current = await api("/api/settings/summary-model").catch(() => null);
  const base = current || {
    api_type: "openai_chat",
    target_url: "",
    api_key: "",
    model: "",
    target_headers: [],
    timeout_ms: 180000,
  };
  $("summaryApiType").value = base.api_type;
  $("summaryDisableReasoning").checked = base.disable_reasoning !== false;
  $("summaryUrl").value = base.target_url;
  $("summaryModel").value = base.model;
  $("summaryKey").value = base.api_key;
  $("summaryHeaders").value = (base.target_headers || []).join("\n");
  $("summaryTimeout").value = Math.max(1, Math.round(Number(base.timeout_ms || 180000) / 1000));
  $("summaryTestResult").hidden = true;
  $("summaryTestResult").textContent = "";
  $("summaryModelDialog").showModal();
});
$("summaryModelForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const base = await api("/api/settings/summary-model").catch(() => ({}));
  await api("/api/settings/summary-model", {
    method: "PUT",
    body: JSON.stringify({
      ...base,
      disable_reasoning: $("summaryDisableReasoning").checked,
      api_type: $("summaryApiType").value,
      target_url: $("summaryUrl").value,
      model: $("summaryModel").value,
      api_key: $("summaryKey").value,
      target_headers: $("summaryHeaders").value.split("\n").filter(Boolean),
      timeout_ms: Number($("summaryTimeout").value) * 1000,
    }),
  });
  $("summaryModelDialog").close();
  toast(t("summaryConfigSaved"));
});
$("summaryCancel").addEventListener("click", () => $("summaryModelDialog").close());
$("selectAllLogs").addEventListener("click", () => toggleSelectAllLogs());
$("autoRefreshLogs").addEventListener("change", () => scheduleLogRefresh(250));
$("logItems").addEventListener("click", (event) => {
  if (event.target.matches("[data-select-group]")) {
    state.selectedLogGroups[event.target.dataset.selectGroup] = event.target.checked;
    updateSelectAllLogsButton();
    return;
  }
  const groupDetail = event.target.closest("[data-group-detail]");
  if (groupDetail) {
    event.stopPropagation();
    showTaskPricing(groupDetail.dataset.groupDetail).catch((e) => toast(e.message));
    return;
  }
  const group = event.target.closest("[data-group-id]");
  if (group) {
    const groupId = group.dataset.groupId;
    if (state.collapsedGroups[groupId]) collapseLogGroup(groupId);
    else {
      state.collapsedGroups[groupId] = true;
      renderLogs();
    }
    return;
  }
  const item = event.target.closest("[data-log-id]");
  if (item) selectLog(item.dataset.logId).catch((e) => toast(e.message));
  const recordMore = event.target.closest("[data-load-more-records]");
  if (recordMore) {
    loadMoreLogGroup(recordMore.dataset.loadMoreRecords).catch((e) => toast(e.message));
    return;
  }
  if (event.target.matches("[data-load-more]"))
    loadLogs({ append: true }).catch((e) => toast(e.message));
});
$("logItems").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target.closest("input, button, a, select, textarea")) return;
  const group = event.target.closest(".log-group-head[data-group-id]");
  if (!group) return;
  event.preventDefault();
  const groupId = group.dataset.groupId;
  if (state.collapsedGroups[groupId]) collapseLogGroup(groupId);
  else {
    state.collapsedGroups[groupId] = true;
    renderLogs();
  }
});
$("pricingPanel").addEventListener("click", (event) => {
  const summary = event.target.closest("summary");
  if (summary && state.activeTaskPricing) {
    const details = summary.parentElement;
    if (details && details.hasAttribute("data-price-group-model")) {
      const openGroups =
        state.pricingGroupOpen[state.activeTaskPricing] ||
        (state.pricingGroupOpen[state.activeTaskPricing] = {});
      const model = details.dataset.priceGroupModel;
      if (details.open) delete openGroups[model];
      else openGroups[model] = true;
      savePricingGroupOpenState();
      return;
    }
  }
  if (event.target.closest("[data-close-pricing]")) {
    closeTaskPricing();
    return;
  }
  if (event.target.closest("[data-retry-pricing]") && state.activeTaskPricing) {
    showTaskPricing(state.activeTaskPricing).catch((e) => toast(e.message));
  }
});
$("logItems").addEventListener("click", (event) => {
  const group = event.target.closest("[data-group-id]");
  if (
    !group ||
    event.target.matches("[data-select-group]") ||
    event.target.closest("[data-group-detail]")
  )
    return;
  const groupId = group.dataset.groupId;
  if (state.collapsedGroups[groupId]) loadLogGroup(groupId).catch((e) => toast(e.message));
});
document.querySelectorAll("[data-wrap]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.wrap;
    state.wrap[key] = !state.wrap[key];
    renderJsonPane(key, { preserveView: true });
  }),
);
document.querySelectorAll("[data-meta]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.meta;
    if (!key || !hasMetadata(state.meta[key])) return;
    state.metaOpen[key] = !state.metaOpen[key];
    renderMetaPane(key);
  }),
);
document.querySelectorAll("[data-pricing]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!state.requestPricing) return;
    state.requestPricingOpen = !state.requestPricingOpen;
    renderRequestPricing();
  }),
);
document.querySelectorAll("[data-expand]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.expand;
    state.tree[key] = true;
    if ($(key + "Json").querySelectorAll("details").length === 0) renderJsonPane(key);
    const details = Array.from($(key + "Json").querySelectorAll("details:not(.json-str-detail)"));
    const allOpen = details.length > 0 && details.every((detail) => detail.open);
    if (allOpen) {
      details.forEach((detail) => {
        const parentDetail = detail.parentElement ? detail.parentElement.closest("details") : null;
        detail.open =
          detail.classList.contains("root") || Boolean(parentDetail?.classList.contains("root"));
      });
    } else {
      const nextLevel = details.filter((detail) => {
        if (detail.open) return false;
        let parentDetail = detail.parentElement ? detail.parentElement.closest("details") : null;
        while (parentDetail) {
          if (!parentDetail.open) return false;
          parentDetail = parentDetail.parentElement
            ? parentDetail.parentElement.closest("details")
            : null;
        }
        return true;
      });
      nextLevel.forEach((detail) => {
        detail.open = true;
      });
    }
    updateExpandButton(key);
    updatePaneButtons(key);
  }),
);
["request", "response"].forEach((key) => {
  $(key + "Json").addEventListener(
    "toggle",
    () => {
      updateExpandButton(key);
      updatePaneButtons(key);
    },
    true,
  );
  $(key + "Json").addEventListener("click", (event) => {
    const summary = event.target.closest("summary");
    const detail =
      summary && summary.parentElement.matches("details.json-node") ? summary.parentElement : null;
    if (detail) {
      const container = $(key + "Json");
      const naturalTop = jsonContentOffset(container, detail);
      const visualTop =
        summary.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      const stuckBy = visualTop - naturalTop;
      if (stuckBy > 0.5) {
        event.preventDefault();
        container.scrollTo({
          top: Math.max(0, container.scrollTop - stuckBy),
          behavior: "smooth",
        });
      }
    }
    const button = event.target.closest("[data-copy-string]");
    if (!button) return;
    const body = button.closest(".json-str-full")?.querySelector(".json-str-body");
    if (!body) return;
    navigator.clipboard.writeText(body.textContent || "").then(
      () => toast(t("copiedText")),
      () => toast(t("copyFailed")),
    );
  });
});
document.querySelectorAll("[data-format]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.format;
    state.formatStrings[key] = !state.formatStrings[key];
    renderJsonPane(key, { preserveView: true });
  }),
);
document.querySelectorAll("[data-copy]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.copy;
    if (key && state.raw[key] !== null) {
      navigator.clipboard.writeText(JSON.stringify(state.raw[key], null, 2)).then(
        () => toast(t("copiedJson")),
        () => toast(t("copyFailed")),
      );
    }
  }),
);
(() => {
  const detail = $("detail"),
    splitter = $("splitter");
  let dragging = false,
    previewFrame = 0,
    baseRect = null,
    baseTop = 0,
    baseY = 0,
    targetY = 0;
  const clampedTop = () =>
    Math.max(120, Math.min(baseRect.height - 120, baseTop + (targetY - baseY)));
  const previewTop = () => {
    previewFrame = 0;
    if (!dragging || !baseRect) return;
    splitter.style.setProperty("--splitter-preview-y", `${clampedTop() - baseTop}px`);
  };
  const clearPreview = () => {
    if (previewFrame) cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    splitter.classList.remove("dragging");
    splitter.style.removeProperty("--splitter-preview-y");
  };
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    state.splitterDragging = true;
    splitter.setPointerCapture(e.pointerId);
    baseRect = detail.getBoundingClientRect();
    baseTop = splitter.offsetTop;
    baseY = e.clientY;
    targetY = e.clientY;
    splitter.classList.add("dragging");
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    targetY = e.clientY;
    if (!previewFrame) previewFrame = requestAnimationFrame(previewTop);
  });
  const stopDragging = (commit) => {
    if (!dragging) return;
    dragging = false;
    state.splitterDragging = false;
    if (commit && baseRect) {
      const top = clampedTop();
      detail.style.setProperty("--request-fr", `${top}px`);
      detail.style.setProperty("--response-fr", `${baseRect.height - top - 8}px`);
    }
    clearPreview();
    baseRect = null;
  };
  splitter.addEventListener("pointerup", () => stopDragging(true));
  splitter.addEventListener("pointercancel", () => stopDragging(false));
  splitter.addEventListener("lostpointercapture", () => stopDragging(false));
})();
(() => {
  const logsView = $("logs"),
    logSplitter = $("logSplitter"),
    logList = document.querySelector(".log-list");
  let dragging = false,
    previewFrame = 0,
    baseRect = null,
    baseWidth = 0,
    baseX = 0,
    targetX = 0;
  const clampedWidth = () =>
    Math.max(200, Math.min(baseRect.width * 0.8, baseWidth + (targetX - baseX)));
  const previewWidth = () => {
    previewFrame = 0;
    if (!dragging || !baseRect) return;
    logSplitter.style.setProperty("--splitter-preview-x", `${clampedWidth() - baseWidth}px`);
  };
  const clearPreview = () => {
    if (previewFrame) cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    logSplitter.classList.remove("dragging");
    logSplitter.style.removeProperty("--splitter-preview-x");
  };
  logSplitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    state.splitterDragging = true;
    logSplitter.setPointerCapture(e.pointerId);
    baseRect = logsView.getBoundingClientRect();
    baseWidth = logList.getBoundingClientRect().width;
    baseX = e.clientX;
    targetX = e.clientX;
    logSplitter.classList.add("dragging");
  });
  logSplitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    targetX = e.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(previewWidth);
  });
  const stopDragging = (commit) => {
    if (!dragging) return;
    dragging = false;
    state.splitterDragging = false;
    if (commit && baseRect) logsView.style.setProperty("--sidebar-w", `${clampedWidth()}px`);
    clearPreview();
    baseRect = null;
  };
  logSplitter.addEventListener("pointerup", () => stopDragging(true));
  logSplitter.addEventListener("pointercancel", () => stopDragging(false));
  logSplitter.addEventListener("lostpointercapture", () => stopDragging(false));
})();
applyLanguage();
loadPairs().catch((e) => toast(e.message));
$("summaryTest").addEventListener("click", async () => {
  const result = $("summaryTestResult");
  result.hidden = false;
  result.className = "target-check-result testing";
  result.textContent = t("testTesting");
  try {
    const r = await api("/api/settings/summary-model/test", {
      method: "POST",
      body: JSON.stringify({
        disable_reasoning: $("summaryDisableReasoning").checked,
        api_type: $("summaryApiType").value,
        target_url: $("summaryUrl").value,
        model: $("summaryModel").value,
        api_key: $("summaryKey").value,
        target_headers: $("summaryHeaders").value.split("\n").filter(Boolean),
        timeout_ms: Number($("summaryTimeout").value) * 1000,
      }),
    });
    result.className = `target-check-result ${r.ok ? "success" : "failure"}`;
    result.textContent = r.ok ? t("testSuccess") : r.detail || t("testFailed");
  } catch (e) {
    result.className = "target-check-result failure";
    result.textContent = e.message || t("testFailedGeneric");
  }
});
$("summaryClose").addEventListener("click", () => {
  $("summaryPanel").close();
});
$("summaryRegenerate").addEventListener("click", async () => {
  if (!state.selected) return;
  const button = $("summaryRegenerate");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const result = await api(`/api/logs/${encodeURIComponent(state.selected)}/summary`, {
      method: "POST",
    });
    // Do not force-reopen a dialog the user closed while the request was in flight.
    renderSummary(result, { open: $("summaryPanel").open });
    toast("智能摘要已重新生成");
  } catch (e) {
    toast(e.message || "重新生成失败");
  } finally {
    button.disabled = false;
    button.textContent = "重新生成";
  }
});
$("summaryCopy").addEventListener("click", () =>
  navigator.clipboard.writeText($("summaryContent").textContent || ""),
);
