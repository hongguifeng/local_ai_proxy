// LLM Proxy admin UI -- shared bootstrap: i18n dictionary, language, state, DOM/format helpers, API client
// Parts are concatenated in numeric order into /static/app.js and served as one classic script.

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
    endToEndSpeed: "端到端",
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
    fetchModels: "拉取模型列表",
    fetchingModels: "拉取中…",
    fetchModelsOk: "已拉取 {count} 个模型 · {duration}",
    fetchModelsNotListed: "（部分模型未列出）",
    fetchModelsFail: "拉取失败：{error}",
    toggleModelList: "显示或隐藏模型列表",
    noModelMatch: "没有包含“{value}”的模型",
    startCheck: "开始测试",
    checking: "测试中…",
    checkOk: "成功：转发地址已正常响应",
    checkBadStatus: "收到响应，但状态码为 {status}（API Key 或模型 ID 可能无效）",
    checkFail: "失败：未收到响应",
    targetMetrics: "指标",
    targetMetricsTitle: "读取并展示上游 /metrics 指标",
    metricsDialogTitle: "上游指标",
    metricsRefresh: "刷新",
    metricsAutoRefresh: "自动刷新",
    metricsRefreshOff: "关闭",
    metricsRefreshEvery5s: "每 5 秒",
    metricsRefreshEvery10s: "每 10 秒",
    metricsRefreshEvery30s: "每 30 秒",
    metricsRefreshEvery60s: "每 60 秒",
    metricsFilterPlaceholder: "按名称筛选指标",
    metricsLoading: "读取中…",
    metricsFail: "失败：{error}",
    metricsTruncated: "指标文本过大，仅展示前 1 MB",
    metricsRaw: "原始文本",
    metricsFamilies: "{n} 个指标族",
    metricsViewSwitch: "在看板与全部指标列表之间切换",
    metricsViewDashboard: "看板",
    metricsViewList: "全部指标",
    metricsNotVllm: "未检测到 vllm: 指标，已自动切换到全部指标列表。",
    metricsSectionStatus: "引擎状态",
    metricsSectionStatusNote: "模型、运行时长与引擎睡眠状态；指标自进程启动起累计。",
    metricsSectionLoad: "实时负载",
    metricsSectionLoadNote:
      "当前正在执行与排队的请求、KV 显存占用；占用接近满时新请求会排队或被抢占。",
    metricsSectionCache: "缓存与投机解码",
    metricsSectionCacheNote: "自启动以来的前缀缓存命中、投机接受率与缓存配置。",
    metricsSectionLatency: "延迟分布",
    metricsSectionLatencyNote:
      "由 histogram 桶估算的百分位（分桶插值，为近似值）；均值 = sum / count。",
    metricsSectionTokens: "Token 吞吐",
    metricsSectionTokensNote: "自启动以来的输入/输出 token 统计与请求结束原因。",
    metricsSectionProcess: "进程资源",
    metricsSectionProcessNote: "Python 进程自身占用的内存与 CPU，不含显存。",
    metricsModelName: "模型",
    metricsUptime: "运行时长",
    metricsUptimeTip: "自进程启动（process_start_time_seconds）以来的时间。",
    metricsEngineAwake: "运行中 (awake)",
    metricsEngineSleeping: "权重已换出 (weights_offloaded)",
    metricsEngineDiscarded: "缓存已丢弃 (discard_all)",
    metricsEngineSleepTip:
      "vLLM sleep 模式：awake = 正常服务；weights_offloaded = 权重换出到内存以释放显存；discard_all = 全部缓存丢弃。",
    metricsRequestsRunning: "运行中请求",
    metricsRequestsWaiting: "排队请求",
    metricsWaitingReasons: "排队原因",
    metricsLoadTip: "num_requests_running / waiting 为瞬时 gauge；等待中的请求尚未开始推理。",
    metricsKvUsage: "KV 缓存占用",
    metricsKvUsageTip:
      "kv_cache_usage_perc：GPU 上 KV 缓存 block 的使用比例；长期接近 100% 说明并发已超出显存容量。",
    metricsPreemptions: "抢占次数",
    metricsPreemptionsTip:
      "num_preemptions_total：因显存不足被中断并重新调度的请求次数（每次抢占都会重算 prefill）。",
    metricsPrefixHit: "前缀缓存命中率",
    metricsPrefixHitTip:
      "prefix_cache_hits_total / prefix_cache_queries_total（token 计）；命中率越高，重复前缀的 prefill 开销越低。",
    metricsExternalPrefixHit: "跨实例前缀命中",
    metricsExternalPrefixHitTip:
      "从外部 KV 传输（connector）命中的前缀比例，仅多实例部署时有意义。",
    metricsMmCacheHit: "多模态缓存命中",
    metricsMmCacheHitTip: "图像/音频等多模态输入的缓存命中率（mm_cache_hits / mm_cache_queries）。",
    metricsSpecAccept: "投机解码接受率",
    metricsSpecAcceptTip:
      "spec_decode_num_accepted_tokens_total / num_draft_tokens_total；接受率越高投机解码加速越明显，未启用时此卡隐藏。",
    metricsCacheConfig: "缓存配置",
    metricsCacheConfigTip:
      "引擎启动时的 cache_config 快照；kv_cache_size_tokens 为全部 GPU block 可容纳的 token 上限。",
    metricsCacheBlocks: "GPU block 数",
    metricsCacheSizeTokens: "KV 容量（token）",
    metricsCacheBlockSize: "block 大小（token）",
    metricsPrefixCaching: "前缀缓存",
    metricsGpuMemoryUtil: "显存利用率上限",
    metricsOn: "开启",
    metricsOff: "关闭",
    metricsTtft: "首 token 延迟 (TTFT)",
    metricsTtftTip:
      "从请求到达到吐出第一个 token 的时间；p50 为典型值，长输入或排队会推高 p95/p99。",
    metricsItl: "token 间隔延迟 (ITL)",
    metricsItlTip: "相邻两个输出 token 的平均间隔（解码阶段）；约 1/ITL 即单请求解码速度。",
    metricsQueueTime: "排队等待",
    metricsQueueTimeTip: "请求在队列中等待调度的时间；持续增大说明算力不足。",
    metricsPrefillTime: "prefill 耗时",
    metricsPrefillTimeTip: "提示词前向计算阶段的耗时；长上下文请求占主导。",
    metricsDecodeTime: "decode 耗时",
    metricsDecodeTimeTip: "逐 token 生成阶段的耗时（不含排队与 prefill）。",
    metricsE2e: "端到端耗时",
    metricsE2eTip: "从请求到达到生成结束的全部时间（排队 + prefill + decode）。",
    metricsAvg: "均值",
    metricsP50: "p50",
    metricsP95: "p95",
    metricsP99: "p99",
    metricsObservations: "样本数",
    metricsPercentilesApprox: "百分位为分桶插值近似",
    metricsDecodeSpeed: "解码速度（估算）",
    metricsDecodeSpeedTip:
      "generation_tokens_total / request_decode_time_seconds_sum：自启动以来的平均输出速度（token/秒），忽略排队与 prefill。",
    metricsRequestsCompleted: "已完成请求",
    metricsRequestsCompletedTip:
      "request_success_total 按结束原因分类的自启动累计值；abort/error 非零时值得关注。",
    metricsReasonStop: "正常结束 stop",
    metricsReasonLength: "触顶 length",
    metricsReasonAbort: "中断 abort",
    metricsReasonError: "错误 error",
    metricsReasonRepetition: "重复 repetition",
    metricsPromptTokensTotal: "输入 token 累计",
    metricsPromptTokensTotalTip: "prompt_tokens_total：自启动以来转发的提示词 token 总量。",
    metricsGenerationTokensTotal: "输出 token 累计",
    metricsGenerationTokensTotalTip: "generation_tokens_total：自启动以来生成的 token 总量。",
    metricsAvgPromptLength: "平均输入长度",
    metricsAvgPromptLengthTip: "request_prompt_tokens 直方图均值：单请求平均提示词 token 数。",
    metricsAvgGenerationLength: "平均输出长度",
    metricsAvgGenerationLengthTip:
      "request_generation_tokens 直方图均值：单请求平均生成 token 数。",
    metricsPromptSources: "输入 token 来源",
    metricsPromptSourcesTip:
      "prompt_tokens_by_source_total：local_cache_hit 为命中缓存直接复用，local_compute 为实际重算；cached 占比越高 prefill 越省。",
    metricsSourceLocalCompute: "实际计算",
    metricsSourceLocalCacheHit: "本地缓存命中",
    metricsSourceExternalKvTransfer: "外部 KV 传输",
    metricsPromptCached: "缓存复用输入",
    metricsPromptCachedTip: "prompt_tokens_cached_total：命中前缀缓存而免去计算的输入 token 总量。",
    metricsMemoryRss: "常驻内存",
    metricsMemoryRssTip: "process_resident_memory_bytes：进程当前占用的物理内存（不含显存）。",
    metricsVirtualMemory: "虚拟内存",
    metricsVirtualMemoryTip: "process_virtual_memory_bytes：进程申请的虚拟地址空间总量。",
    metricsCpuTime: "CPU 时间",
    metricsCpuTimeTip: "process_cpu_seconds_total：累计占用的用户 + 系统 CPU 时间。",
    metricsOpenFds: "打开的文件描述符",
    metricsOpenFdsTip: "process_open_fds / process_max_fds：接近上限时可能无法再接受连接。",
    metricsUptimeUnknown: "未知",
    metricsNoData: "无数据",
    defaultTarget: "默认",
    targetEnabled: "启用",
    modelMappings: "模型映射，每行一个 监听模型 => 转发模型；监听模型支持 * 通配符",
    loadBalancing: "负载均衡组",
    addLbGroup: "添加负载均衡组",
    lbGroupName: "组名",
    lbModelPattern: "请求模型 pattern",
    lbStrategy: "选择策略",
    lbStrategyLeast: "最少负载",
    lbStrategyRoundRobin: "轮转",
    lbMetricsEnabled: "采样上游指标",
    lbFailoverEnabled: "连接失败时切换一次",
    lbMembers: "参与节点",
    lbMembersNone: "未选择节点",
    lbChooseNodes: "选择节点",
    lbMemberModel: "映射模型",
    lbMemberModelPlaceholder: "留空不映射",
    lbMemberModelHint: "留空表示不映射：请求模型原样发给这个节点。",
    lbNodeMissingMember: "组里引用了本 pair 没有的节点",
    lbNodeState: "节点状态",
    lbStateInFlight: "进行中",
    lbStateWaiting: "排队",
    lbStateKv: "KV",
    lbStateBindings: "绑定",
    lbStateCooldown: "冷却",
    lbStateSource: "指标来源",
    lbStateStale: "指标过期",
    lbStateNoSample: "没有采样",
    lbStateAsleep: "引擎睡眠",
    lbStateOn: "启用",
    lbStateOff: "禁用",
    lbWarnSingleNode: "这个组只有一个节点，起不到均衡作用",
    lbWarnDisabledMember: "组里有禁用的节点，它不会参与选择",
    lbWarnOverlapping: "pattern 与其他组重叠，按配置顺序匹配",
    lbTakeover: "这个节点的模型映射不会作用于命中负载均衡组的请求",
    lbNoGroups: "还没有负载均衡组",
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
    catalogPriceRate: "models.dev 美元价格 × 汇率（1 = 美元原价）",
    fetchCatalogPrices: "拉取模型并填价",
    catalogSourceNote:
      "价格来自 models.dev 第三方目录，可能过期（例如 DeepSeek 只列空闲时段价）；保存前请对照厂商官方价目表核对。",
    catalogImportDone:
      "已添加 {added} 条价格；{existing} 条已有规则未改动；{unmatched} 条未找到价格",
    catalogManyModels: "上游共列出 {n} 个模型，全部添加为价格规则？",
    testPriceModel: "测试模型名",
    priceNoMatch: "未命中价格规则",
    cost: "费用",
    currencySymbol: "¥",
    calculating: "计算中…",
    unpriced: "未计价",
    taskPricing: "任务明细",
    viewTaskPricing: "查看任务明细",
    toggleTaskRecords: "展开/折叠请求列表",
    costEstimate: "费用估算",
    showCostDetails: "显示费用明细",
    hideCostDetails: "隐藏费用明细",
    billingModel: "计价模型",
    matchedRule: "命中规则",
    priceSource: "价格来源",
    pricingUsage: "用量来源",
    pricingReason: "未计价原因",
    target: "转发地址",
    startTime: "起始时间",
    endTime: "结束时间",
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
    outputTokenTrendNote: "每个请求自身的输出 token，按请求序号；尚无输出 token 数的请求不显示。",
    outputTokenTrendNoData: "暂无输出 token 数据",
    trendAvgPrefix: "平均",
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
    taskBrief: "任务简介",
    taskBriefGenerate: "生成简介",
    taskBriefGenerating: "生成中…",
    taskBriefNone: "尚未生成简介：点击右侧按钮，让总结模型用一小段话概括这个任务。",
    taskBriefFailed: "简介生成失败",
    taskBriefGenerated: "任务简介已生成",
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
    endToEndSpeed: "End-to-end",
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
    fetchModels: "Fetch models",
    fetchingModels: "Fetching…",
    fetchModelsOk: "Fetched {count} model(s) · {duration}",
    fetchModelsNotListed: " (some models are not listed)",
    fetchModelsFail: "Fetch failed: {error}",
    toggleModelList: "Show or hide the model list",
    noModelMatch: "No model contains “{value}”",
    startCheck: "Start test",
    checking: "Testing…",
    checkOk: "Success: the target responded normally",
    checkBadStatus:
      "A response was received, but with status {status} (the API key or model ID may be invalid)",
    checkFail: "Failed: no response was received",
    targetMetrics: "Metrics",
    targetMetricsTitle: "Read and display the upstream /metrics exposition",
    metricsDialogTitle: "Upstream metrics",
    metricsRefresh: "Refresh",
    metricsAutoRefresh: "Auto refresh",
    metricsRefreshOff: "Off",
    metricsRefreshEvery5s: "Every 5 s",
    metricsRefreshEvery10s: "Every 10 s",
    metricsRefreshEvery30s: "Every 30 s",
    metricsRefreshEvery60s: "Every 60 s",
    metricsFilterPlaceholder: "Filter metric names",
    metricsLoading: "Loading…",
    metricsFail: "Failed: {error}",
    metricsTruncated: "Metrics text is too large; the first 1 MB is shown",
    metricsRaw: "Raw text",
    metricsFamilies: "{n} metric families",
    metricsViewSwitch: "Switch between the dashboard and the full metric list",
    metricsViewDashboard: "Dashboard",
    metricsViewList: "All metrics",
    metricsNotVllm: "No vllm: metrics detected; switched to the full metric list.",
    metricsSectionStatus: "Engine status",
    metricsSectionStatusNote:
      "Model, uptime and engine sleep state; all metrics accumulate since process start.",
    metricsSectionLoad: "Live load",
    metricsSectionLoadNote:
      "Requests running and waiting right now plus KV cache pressure; near full means new requests queue or get preempted.",
    metricsSectionCache: "Cache & spec decoding",
    metricsSectionCacheNote:
      "Prefix cache hit ratios, speculative acceptance and cache configuration since start.",
    metricsSectionLatency: "Latency distribution",
    metricsSectionLatencyNote:
      "Percentiles estimated from histogram buckets (linear interpolation, approximate); mean = sum / count.",
    metricsSectionTokens: "Token throughput",
    metricsSectionTokensNote:
      "Prompt/generation token totals since start and request finish reasons.",
    metricsSectionProcess: "Process resources",
    metricsSectionProcessNote: "Memory and CPU used by the Python process itself, not GPU memory.",
    metricsModelName: "Model",
    metricsUptime: "Uptime",
    metricsUptimeTip: "Time since the process started (process_start_time_seconds).",
    metricsEngineAwake: "Awake (serving)",
    metricsEngineSleeping: "Weights offloaded",
    metricsEngineDiscarded: "Caches discarded",
    metricsEngineSleepTip:
      "vLLM sleep modes: awake = serving; weights_offloaded = weights moved to host RAM to free GPU memory; discard_all = all caches dropped.",
    metricsRequestsRunning: "Running requests",
    metricsRequestsWaiting: "Waiting requests",
    metricsWaitingReasons: "Waiting reasons",
    metricsLoadTip:
      "num_requests_running / waiting are instant gauges; waiting requests have not started inference.",
    metricsKvUsage: "KV cache usage",
    metricsKvUsageTip:
      "kv_cache_usage_perc: fraction of GPU KV cache blocks in use; sustained values near 100% mean concurrency exceeds capacity.",
    metricsPreemptions: "Preemptions",
    metricsPreemptionsTip:
      "num_preemptions_total: requests interrupted and rescheduled because the KV cache ran out; each preemption recomputes the prefill.",
    metricsPrefixHit: "Prefix cache hit ratio",
    metricsPrefixHitTip:
      "prefix_cache_hits_total / prefix_cache_queries_total (token based); a higher ratio means repeated prefixes skip prefill.",
    metricsExternalPrefixHit: "Cross-instance prefix hit",
    metricsExternalPrefixHitTip:
      "Prefix hits served through an external KV connector; only meaningful in multi-instance deployments.",
    metricsMmCacheHit: "Multimodal cache hit",
    metricsMmCacheHitTip:
      "mm_cache_hits / mm_cache_queries: cache hit ratio for image/audio inputs.",
    metricsSpecAccept: "Speculative acceptance",
    metricsSpecAcceptTip:
      "spec_decode_num_accepted_tokens_total / num_draft_tokens_total; higher acceptance means more speedup. Hidden when speculative decoding is off.",
    metricsCacheConfig: "Cache configuration",
    metricsCacheConfigTip:
      "cache_config snapshot taken at engine start; kv_cache_size_tokens is the token capacity of all GPU blocks.",
    metricsCacheBlocks: "GPU blocks",
    metricsCacheSizeTokens: "KV capacity (tokens)",
    metricsCacheBlockSize: "Block size (tokens)",
    metricsPrefixCaching: "Prefix caching",
    metricsGpuMemoryUtil: "GPU memory limit",
    metricsOn: "On",
    metricsOff: "Off",
    metricsTtft: "Time to first token (TTFT)",
    metricsTtftTip:
      "Time until the first token is emitted; p50 is typical, long prompts or queueing push p95/p99 up.",
    metricsItl: "Inter-token latency (ITL)",
    metricsItlTip:
      "Average gap between output tokens during decode; ~1/ITL is the per-request decode speed.",
    metricsQueueTime: "Queue time",
    metricsQueueTimeTip:
      "Time requests wait in the queue before being scheduled; growth means insufficient capacity.",
    metricsPrefillTime: "Prefill time",
    metricsPrefillTimeTip: "Duration of the prefill pass; long-context requests dominate.",
    metricsDecodeTime: "Decode time",
    metricsDecodeTimeTip: "Token-by-token generation duration (excluding queue and prefill).",
    metricsE2e: "End-to-end latency",
    metricsE2eTip: "Full request duration from arrival to completion (queue + prefill + decode).",
    metricsAvg: "Mean",
    metricsP50: "p50",
    metricsP95: "p95",
    metricsP99: "p99",
    metricsObservations: "Observations",
    metricsPercentilesApprox: "percentiles are bucket-interpolated",
    metricsDecodeSpeed: "Decode speed (est.)",
    metricsDecodeSpeedTip:
      "generation_tokens_total / request_decode_time_seconds_sum: average output speed since start (tokens/s), ignoring queue and prefill.",
    metricsRequestsCompleted: "Completed requests",
    metricsRequestsCompletedTip:
      "request_success_total split by finish reason since start; non-zero abort/error values deserve attention.",
    metricsReasonStop: "stop",
    metricsReasonLength: "length",
    metricsReasonAbort: "abort",
    metricsReasonError: "error",
    metricsReasonRepetition: "repetition",
    metricsPromptTokensTotal: "Prompt tokens (total)",
    metricsPromptTokensTotalTip: "prompt_tokens_total: prompt tokens forwarded since start.",
    metricsGenerationTokensTotal: "Generation tokens (total)",
    metricsGenerationTokensTotalTip: "generation_tokens_total: tokens generated since start.",
    metricsAvgPromptLength: "Avg prompt length",
    metricsAvgPromptLengthTip:
      "Mean of the request_prompt_tokens histogram: average prompt tokens per request.",
    metricsAvgGenerationLength: "Avg generation length",
    metricsAvgGenerationLengthTip:
      "Mean of the request_generation_tokens histogram: average generated tokens per request.",
    metricsPromptSources: "Prompt token sources",
    metricsPromptSourcesTip:
      "prompt_tokens_by_source_total: local_cache_hit reuses cached prefixes, local_compute recomputes them; a higher cached share saves prefill.",
    metricsSourceLocalCompute: "Recomputed",
    metricsSourceLocalCacheHit: "Local cache hit",
    metricsSourceExternalKvTransfer: "External KV transfer",
    metricsPromptCached: "Cached prompt tokens",
    metricsPromptCachedTip:
      "prompt_tokens_cached_total: input tokens that skipped computation thanks to the prefix cache.",
    metricsMemoryRss: "Resident memory",
    metricsMemoryRssTip:
      "process_resident_memory_bytes: physical memory used by the process (host RAM, not GPU).",
    metricsVirtualMemory: "Virtual memory",
    metricsVirtualMemoryTip: "process_virtual_memory_bytes: virtual address space requested.",
    metricsCpuTime: "CPU time",
    metricsCpuTimeTip: "process_cpu_seconds_total: cumulative user + system CPU time.",
    metricsOpenFds: "Open file descriptors",
    metricsOpenFdsTip:
      "process_open_fds / process_max_fds: near the limit new connections may be refused.",
    metricsUptimeUnknown: "unknown",
    metricsNoData: "no data",
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
    catalogPriceRate: "models.dev USD price × rate (1 = raw USD)",
    fetchCatalogPrices: "Fetch models & fill prices",
    catalogSourceNote:
      "Prices come from the models.dev catalog, a third-party source that can be stale (e.g. DeepSeek is listed at its off-peak rate); verify against the vendor's official price list before saving.",
    catalogImportDone:
      "Added {added} price rule(s); {existing} existing rule(s) untouched; {unmatched} had no price",
    catalogManyModels: "The upstream lists {n} models. Add them all as price rules?",
    testPriceModel: "Test model",
    priceNoMatch: "No price rule matched",
    cost: "Cost",
    currencySymbol: "$",
    calculating: "Calculating…",
    unpriced: "Unpriced",
    taskPricing: "Task details",
    viewTaskPricing: "View task details",
    toggleTaskRecords: "Expand or collapse the request list",
    costEstimate: "Cost estimate",
    showCostDetails: "Show cost details",
    hideCostDetails: "Hide cost details",
    billingModel: "Billing model",
    matchedRule: "Matched rule",
    priceSource: "Price source",
    pricingUsage: "Usage source",
    pricingReason: "Unpriced reason",
    target: "Target",
    startTime: "Start time",
    endTime: "End time",
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
      "This request's own output tokens, by request sequence; requests without an output token count yet are not shown.",
    outputTokenTrendNoData: "No output token data",
    trendAvgPrefix: "avg",
    priceGroups: "Model / price groups",
    priced: "Priced",
    retry: "Retry",
    close: "Close",
    pricingUnavailable: "Could not load task details",
    taskDeleted: "Task was deleted",
    taskWholeScope: "Whole-task cost, including requests outside this list.",
    modelMappings:
      "Model mapping, one per line: listened model => upstream model; * is supported as a wildcard",
    loadBalancing: "Load balancing groups",
    addLbGroup: "Add load balancing group",
    lbGroupName: "Group name",
    lbModelPattern: "Requested model pattern",
    lbStrategy: "Selection strategy",
    lbStrategyLeast: "Least load",
    lbStrategyRoundRobin: "Round robin",
    lbMetricsEnabled: "Sample upstream metrics",
    lbFailoverEnabled: "Switch once on a connection failure",
    lbMembers: "Member nodes",
    lbMembersNone: "No nodes selected",
    lbChooseNodes: "Choose nodes",
    lbMemberModel: "Mapped model",
    lbMemberModelPlaceholder: "no mapping",
    lbMemberModelHint: "An empty model id forwards the requested model to that node.",
    lbNodeMissingMember: "The group names a node this pair does not have",
    lbNodeState: "Node state",
    lbStateInFlight: "In flight",
    lbStateWaiting: "Waiting",
    lbStateKv: "KV",
    lbStateBindings: "Bindings",
    lbStateCooldown: "Cooldown",
    lbStateSource: "Metrics source",
    lbStateStale: "Metrics stale",
    lbStateNoSample: "No sample",
    lbStateAsleep: "Engine asleep",
    lbStateOn: "on",
    lbStateOff: "off",
    lbWarnSingleNode: "This group has one node, so it cannot balance anything",
    lbWarnDisabledMember: "A member node is disabled and will not be selected",
    lbWarnOverlapping: "This pattern overlaps another group; groups match in configured order",
    lbTakeover:
      "This node's model mapping does not apply to requests that hit a load balancing group",
    lbNoGroups: "No load balancing groups yet",
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
    taskBrief: "Task brief",
    taskBriefGenerate: "Generate brief",
    taskBriefGenerating: "Generating…",
    taskBriefNone:
      "No brief yet: use the button to let the summary model describe this task in a few sentences.",
    taskBriefFailed: "Task brief failed",
    taskBriefGenerated: "Task brief generated",
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
  targetCheckModelsNotice: null,
  targetCheckModelOptions: [],
  targetCheckModelFilter: null,
  targetCheckModelActive: -1,
  logs: [],
  selected: null,
  selectedLogGroups: {},
  raw: { request: null, response: null },
  jsonPaneHtml: {},
  meta: { request: null, response: null },
  metaOpen: { request: false, response: false },
  wrap: { request: false, response: false },
  formatStrings: { request: false, response: false },
  tree: { request: true, response: true },
  collapsedGroups: {},
  loadingLogGroups: {},
  loadingMoreLogGroups: {},
  logsLoading: false,
  logsQueued: null,
  logSections: new Map(),
  logTailHtml: "",
  pendingSweepCursor: 0,
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
  taskPricingRendered: "",
  taskBrief: null,
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
/**
 * The admin UI treats every element it grabs by id as "whichever control this
 * actually is", so the accessor returns an intersection carrying the form, dialog
 * and details members the code uses.
 *
 * Each member must be its own Partial<>: writing Partial<A & B & ...> makes TS
 * reduce the intersection to `never` because `type` has conflicting types across
 * the HTML element interfaces, and every use then reports "Property ... does not
 * exist on type 'never'".
 * @typedef {HTMLElement & Partial<HTMLInputElement> & Partial<HTMLTextAreaElement> & Partial<HTMLDialogElement> & Partial<HTMLDetailsElement>} UiElement
 */
/**
 * @param {string} id
 * @returns {UiElement}
 */
const $ = (id) => /** @type {UiElement} */ (document.getElementById(id));
/**
 * @param {string} selector
 * @returns {UiElement}
 */
const qs = (selector) => /** @type {UiElement} */ (document.querySelector(selector));
/**
 * @param {string} selector
 * @returns {UiElement[]}
 */
const qsa = (selector) =>
  /** @type {UiElement[]} */ (Array.from(document.querySelectorAll(selector)));
/**
 * @param {Element} root
 * @param {string} selector
 * @returns {UiElement[]}
 */
const qsaOn = (root, selector) =>
  /** @type {UiElement[]} */ (Array.from(root.querySelectorAll(selector)));
/**
 * @param {Element} root
 * @param {string} selector
 * @returns {UiElement}
 */
const qsOn = (root, selector) => /** @type {UiElement} */ (root.querySelector(selector));
/**
 * Event handlers get `EventTarget`, which has none of the DOM members this UI
 * uses. This is a type-level cast: it returns the very same object.
 * @param {EventTarget | null} target
 * @returns {UiElement}
 */
const asElement = (target) => /** @type {UiElement} */ (target);
/**
 * closest() is typed to return Element, but every node this UI finds is used as
 * a control afterwards, so the lookup helper carries the useful type.
 * @param {EventTarget | null} target
 * @param {string} selector
 * @returns {UiElement}
 */
const closestFrom = (target, selector) =>
  /** @type {UiElement} */ (asElement(target)?.closest?.(selector) ?? null);
/**
 * Same reason as closestFrom, for a lookup that starts from a known element.
 * The optional chain is kept so a null root or a node without closest() still
 * yields null instead of throwing, exactly like the call sites it replaced.
 * @param {Element | null | undefined} root
 * @param {string} selector
 * @returns {UiElement}
 */
const closestOn = (root, selector) => /** @type {UiElement} */ (root?.closest?.(selector) ?? null);
/**
 * parentElement is typed as Element, which again hides the members this UI needs.
 * @param {Element | null | undefined} el
 * @returns {UiElement}
 */
const parentOf = (el) => /** @type {UiElement} */ (el?.parentElement ?? null);
/**
 * A failed API call carries the field paths of a rejected configuration.
 * @typedef {Error & { issues?: unknown }} ApiError
 */
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
    const error = /** @type {ApiError} */ (new Error(message));
    // Field paths from a rejected configuration let the UI point at the offending input.
    if (data.error && Array.isArray(data.error.issues)) error.issues = data.error.issues;
    throw error;
  }
  return data;
};
function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  $("languageSelect").value = state.language;
  qsa("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  qsa("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  qsa("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  updateExpandButton("request");
  updateExpandButton("response");
  updateMetaButton("request");
  updateMetaButton("response");
  updateResponseTiming();
  updateSelectAllLogsButton();
}
/**
 * A surface that has to be redrawn when the UI language changes. Panels register
 * themselves in their own file, so adding a panel cannot silently leave it out of
 * the language switch the way a hand-written call list did.
 * @typedef {{ id: string, sequence: number, render: () => void, when?: () => boolean }} LanguagePanel
 */
/** @type {LanguagePanel[]} */
const languagePanels = [];
/**
 * @param {string} id
 * @param {number} sequence Lower runs first; these mirror the order the switch
 *   used to call the panels in by hand, so moving one means changing one number.
 * @param {() => void} render
 * @param {() => boolean} [when] Skip the panel when its surface is not on screen.
 */
function registerLanguagePanel(id, sequence, render, when) {
  if (languagePanels.some((panel) => panel.id === id)) return;
  languagePanels.push({ id, sequence, render, ...(when === undefined ? {} : { when }) });
}
function rerenderLanguagePanels() {
  const ordered = languagePanels.slice().sort((left, right) => left.sequence - right.sequence);
  for (const panel of ordered) {
    if (panel.when !== undefined && !panel.when()) continue;
    panel.render();
  }
}
function setLanguage(language) {
  if (!translations[language]) return;
  if (qs(".proxy-card")) collectPairs();
  state.language = language;
  localStorage.setItem("llmProxyLanguage", language);
  applyLanguage();
  rerenderLanguagePanels();
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
function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}
// Replaced by static-assets.ts before the browser ever sees this identifier.
// @ts-expect-error -- the name only exists in the authored source.
const suggestedStripRequestFields = __SUGGESTED_STRIP_REQUEST_FIELDS__;
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
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
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
function schedulePaneButtonsUpdate(key) {
  jsonPaneButtonsUpdateKeys.add(key);
  if (jsonPaneButtonsUpdateQueued) return;
  jsonPaneButtonsUpdateQueued = true;
  setTimeout(() => {
    jsonPaneButtonsUpdateQueued = false;
    for (const pendingKey of jsonPaneButtonsUpdateKeys) {
      updateExpandButton(pendingKey);
      updatePaneButtons(pendingKey);
    }
    jsonPaneButtonsUpdateKeys.clear();
  });
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
