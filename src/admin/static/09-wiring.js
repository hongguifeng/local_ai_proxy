// LLM Proxy admin UI -- every top-level executed statement: DOM wiring, listeners, startup order
// Parts are concatenated in numeric order into /static/app.js and served as one classic script.

window.addEventListener("pointermove", moveTargetDrag);
window.addEventListener("pointerup", endTargetDrag);
window.addEventListener("pointercancel", endTargetDrag);
window.addEventListener("blur", () => cancelTargetDrag());
loadPricingGroupOpenState();
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
qsa(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    qsa(".tab, .view").forEach((el) => el.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "logs") loadLogs().catch((e) => toast(e.message));
    if (tab.dataset.tab === "statistics")
      loadStatisticsOptions()
        .then(() => loadStatistics())
        .catch((e) => toast(e.message));
  }),
);

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
loadStatisticsOptions().catch(() => {});
$("languageSelect").addEventListener("change", (event) =>
  setLanguage(asElement(event.target).value),
);
$("addProxy").addEventListener("click", () => {
  state.pairs.push(newPair());
  renderPairs();
});
$("saveProxies").addEventListener("click", () =>
  savePairs().catch((e) => toast(configIssueText(e))),
);
$("proxyGrid").addEventListener("click", (event) => {
  const card = closestFrom(event.target, ".proxy-card");
  if (!card) return;
  const pair = state.pairs[Number(card.dataset.index)];
  if (handleLoadBalancerClick(event, pair, card)) return;
  if (
    asElement(event.target).matches(
      "[data-add-price], [data-price-remove], [data-price-up], [data-price-down]",
    )
  ) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    const rules = target.model_prices || (target.model_prices = []);
    const index = Number(closestFrom(event.target, "[data-price-index]")?.dataset.priceIndex);
    if (asElement(event.target).matches("[data-add-price]")) {
      rules.push({
        model_pattern: "",
        price_multiplier: "1",
        input_per_million: "",
        output_per_million: "",
        cache_read_per_million: "",
        cache_write_per_million: "",
      });
    } else if (asElement(event.target).matches("[data-price-remove]")) {
      rules.splice(index, 1);
    } else if (asElement(event.target).matches("[data-price-up]") && index > 0) {
      [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
    } else if (asElement(event.target).matches("[data-price-down]") && index < rules.length - 1) {
      [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]];
    }
    target.prices_expanded = true;
    renderPairs();
    return;
  }
  if (asElement(event.target).matches("[data-fetch-catalog-prices]")) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    target.catalog_rate = qsOn(targetCard, "[data-catalog-rate]")?.value || "1";
    const button = asElement(event.target);
    button.disabled = true;
    api("/api/model-prices/import", {
      method: "POST",
      body: JSON.stringify({
        targetUrl: target.target_url || "",
        targetApiKey: target.target_api_key || "",
        priceRate: target.catalog_rate,
      }),
    })
      .then((data) => {
        if (
          data.models.length > 50 &&
          !window.confirm(t("catalogManyModels").replace("{n}", String(data.models.length)))
        ) {
          return;
        }
        collectPairs();
        const current = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
        const rules = current.model_prices || (current.model_prices = []);
        const patterns = new Set(rules.map((rule) => rule.model_pattern ?? ""));
        let added = 0;
        for (const rule of data.rules) {
          if (patterns.has(rule.model_pattern)) continue;
          rules.push({ ...rule, price_multiplier: "1" });
          patterns.add(rule.model_pattern);
          added += 1;
        }
        current.prices_expanded = true;
        renderPairs();
        toast(
          t("catalogImportDone")
            .replace("{added}", String(added))
            .replace("{existing}", String(data.rules.length - added))
            .replace("{unmatched}", String(data.unmatched.length)),
        );
      })
      .catch((error) => {
        toast(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        button.disabled = false;
      });
    return;
  }
  if (asElement(event.target).matches("[data-add-target]")) {
    collectPairs();
    const target = newTarget();
    pairTargets(pair).push(target);
    pair.default_target_id = pair.default_target_id || target.id;
    renderPairs();
    return;
  }
  if (asElement(event.target).matches("[data-toggle-target-options]")) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    target.expanded = !target.expanded;
    renderPairs();
    return;
  }
  if (asElement(event.target).matches("[data-toggle-api-key]")) {
    const field = closestFrom(event.target, ".secret-field");
    const input = field ? qsOn(field, "[data-target-field='target_api_key']") : null;
    if (!input) return;
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    asElement(event.target).classList.toggle("active", !visible);
    asElement(event.target).title = t(visible ? "showApiKey" : "hideApiKey");
    return;
  }
  if (asElement(event.target).matches("[data-copy-api-key]")) {
    const field = closestFrom(event.target, ".secret-field");
    const input = field ? qsOn(field, "[data-target-field='target_api_key']") : null;
    if (!input) return;
    navigator.clipboard.writeText(input.value || "").then(
      () => toast(t("copiedApiKey")),
      () => toast(t("copyFailed")),
    );
    return;
  }
  if (asElement(event.target).matches("[data-check-target]")) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    openTargetCheckDialog(target);
    return;
  }
  if (asElement(event.target).matches("[data-metrics-target]")) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
    openTargetMetricsDialog(target);
    return;
  }
  if (asElement(event.target).matches("[data-remove-target]")) {
    collectPairs();
    const targetCard = closestFrom(event.target, ".target-card");
    const targets = pairTargets(pair);
    if (targets.length <= 1) return;
    const removed = targets.splice(Number(targetCard.dataset.targetIndex), 1)[0];
    if (pair.default_target_id === removed.id) pair.default_target_id = targets[0].id;
    purgeLoadBalancerMember(pair, removed.id);
    renderPairs();
    return;
  }
  if (asElement(event.target).matches("[data-remove]")) {
    state.pairs.splice(Number(card.dataset.index), 1);
    renderPairs();
  }
});
targetCheckModelCaret.addEventListener("click", () => {
  if (targetCheckModelPop.hidden) openTargetCheckModelPop(true);
  else closeTargetCheckModelPop();
  targetCheckModelInput.focus();
});

targetCheckModelInput.addEventListener("input", () => {
  state.targetCheckModelFilter = targetCheckModelInput.value;
  if (targetCheckModelPop.hidden) openTargetCheckModelPop(false);
  else renderTargetCheckModelPop();
});

targetCheckModelInput.addEventListener("keydown", (event) => {
  const open = !targetCheckModelPop.hidden;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (open) setTargetCheckModelActive(state.targetCheckModelActive + 1);
    else openTargetCheckModelPop(true);
    return;
  }
  if (event.key === "ArrowUp") {
    if (!open) return;
    event.preventDefault();
    setTargetCheckModelActive(state.targetCheckModelActive - 1);
    return;
  }
  if (event.key === "Escape") {
    // Escape would otherwise close the whole dialog.
    if (!open) return;
    event.preventDefault();
    event.stopPropagation();
    closeTargetCheckModelPop();
    return;
  }
  if (event.key === "Enter" && open) {
    const chosen = activeTargetCheckModel();
    if (chosen === null) return;
    event.preventDefault();
    chooseTargetCheckModel(chosen);
  }
});

targetCheckModelPop.addEventListener("click", (event) => {
  const row = closestFrom(event.target, ".target-check-model-option");
  if (!row) return;
  // The rows live inside the field's <label>, so the click must not also activate the input.
  event.preventDefault();
  chooseTargetCheckModel(row.dataset.modelOption);
});

targetCheckModelPicker.addEventListener("focusout", (event) => {
  const related = /** @type {Node | null} */ (/** @type {FocusEvent} */ (event).relatedTarget);
  if (!targetCheckModelPicker.contains(related)) closeTargetCheckModelPop();
});

// The list floats over the dialog, so a click anywhere outside it closes it.
document.addEventListener("pointerdown", (event) => {
  if (!closestFrom(event.target, "[data-model-picker]")) closeTargetCheckModelPop();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTargetCheckModelPop();
});

$("targetCheckModels").addEventListener("click", async () => {
  if (targetCheckModelsButton.disabled) return;
  targetCheckModelsButton.disabled = true;
  targetCheckModelsButton.textContent = t("fetchingModels");
  state.targetCheckModelsNotice = null;
  renderTargetCheckModelsNotice();
  try {
    const data = await api("/api/target-models", {
      method: "POST",
      body: JSON.stringify({
        targetUrl: $("targetCheckUrl").value,
        apiKey: $("targetCheckApiKey").value,
      }),
    });
    const models = Array.isArray(data.models) ? data.models : [];
    if (data.ok && models.length > 0) {
      applyTargetCheckModelOptions(models);
      const model = $("targetCheckModel");
      if (!models.includes(model.value)) {
        model.value = models[0];
      }
      state.targetCheckModelsNotice = {
        kind: "success",
        count: models.length,
        durationMs: Number(data.durationMs) || 0,
        truncated: data.truncated === true,
      };
      renderTargetCheckModelsNotice();
      return;
    }
    // The address serves no model list, so the hand-written suggestions stay usable.
    applyTargetCheckModelOptions(defaultTargetCheckModels);
    state.targetCheckModelsNotice = {
      kind: "failure",
      error: data.error || "the model list contained no model ids",
    };
    renderTargetCheckModelsNotice();
    toast($("targetCheckModelsNotice").textContent);
  } catch (error) {
    applyTargetCheckModelOptions(defaultTargetCheckModels);
    state.targetCheckModelsNotice = {
      kind: "failure",
      error: error.message || error,
    };
    renderTargetCheckModelsNotice();
    toast($("targetCheckModelsNotice").textContent);
  } finally {
    targetCheckModelsButton.disabled = false;
    targetCheckModelsButton.textContent = t("fetchModels");
  }
});
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
$("metricsClose").addEventListener("click", () => $("metricsDialog").close());
$("metricsDialog").addEventListener("close", stopMetricsAutoRefresh);
$("metricsRefresh").addEventListener("click", () => loadTargetMetrics());
$("metricsRefreshInterval")?.addEventListener("change", (event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  startMetricsAutoRefresh(Number(select.value) || 0);
  syncMetricsRefreshCountdown();
});
$("metricsViewDashboard").addEventListener("click", () => {
  metricsState.view = "dashboard";
  renderMetricsDialog();
});
$("metricsViewList").addEventListener("click", () => {
  metricsState.view = "list";
  renderMetricsDialog();
});
$("metricsFilter").addEventListener("input", (event) => {
  metricsState.filter = asElement(event.target).value;
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
$("proxyGrid").addEventListener("change", async (event) => {
  if (asElement(event.target).matches("[data-lb-node], [data-lb-toggle], [data-lb-flag]")) {
    refreshLbCards();
    return;
  }
  if (asElement(event.target).matches("[data-default-target]")) {
    collectPairs();
    renderPairs();
    return;
  }
  if (asElement(event.target).matches("[data-target-enabled]")) {
    const targetCard = closestFrom(event.target, ".target-card");
    targetCard?.classList.toggle("is-enabled-target", asElement(event.target).checked);
    targetCard?.classList.toggle("is-disabled-target", !asElement(event.target).checked);
    // Whether a member is disabled is part of a group's warnings.
    refreshLbCards();
    return;
  }
  if (!asElement(event.target).matches("[data-toggle]")) return;
  collectPairs();
  await savePairs();
  const pair = state.pairs[Number(closestFrom(event.target, ".proxy-card").dataset.index)];
  const data = await api(`/api/pairs/${encodeURIComponent(pair.id)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled: asElement(event.target).checked }),
  });
  Object.assign(pair, data.pair);
  renderPairs();
});
$("proxyGrid").addEventListener("pointerdown", (event) => startTargetDrag(event));
// The member list floats over the card, so a click anywhere outside it closes it.
document.addEventListener("pointerdown", (event) => {
  if (!closestFrom(event.target, "[data-lb-picker]")) closeLbPickers(null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLbPickers(null);
});
$("proxyGrid").addEventListener("keydown", (event) => {
  if (targetDrag?.started && event.key === "Escape") {
    event.preventDefault();
    cancelTargetDrag();
    return;
  }
  const handle = closestFrom(event.target, "[data-drag-target]");
  if (!handle || handle.disabled) return;
  const offset = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  moveTargetCardByKey(handle, offset);
});
$("proxyGrid").addEventListener("input", (event) => {
  if (asElement(event.target).matches("[data-lb-field]")) {
    refreshLbCards();
    return;
  }
  if (!asElement(event.target).matches("[data-price-field], [data-price-test]")) return;
  const targetCard = closestFrom(event.target, ".target-card");
  if (targetCard) updateLocalPriceMatch(targetCard);
});
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
  $("summaryTimeout").value = String(
    Math.max(1, Math.round(Number(base.timeout_ms || 180000) / 1000)),
  );
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
  if (asElement(event.target).matches("[data-select-group]")) {
    state.selectedLogGroups[asElement(event.target).dataset.selectGroup] = asElement(
      event.target,
    ).checked;
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
  if (asElement(event.target).matches("[data-load-more]"))
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
$("pricingPanel").addEventListener("click", (event) => {
  if (closestFrom(event.target, "[data-generate-brief]")) {
    regenerateTaskBrief().catch((e) => toast(e.message));
    return;
  }
  const summary = closestFrom(event.target, "summary");
  if (summary && state.activeTaskPricing) {
    const details = parentOf(summary);
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
  if (closestFrom(event.target, "[data-close-pricing]")) {
    closeTaskPricing();
    return;
  }
  if (closestFrom(event.target, "[data-retry-pricing]") && state.activeTaskPricing) {
    showTaskPricing(state.activeTaskPricing).catch((e) => toast(e.message));
  }
});
qsa("[data-wrap]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.wrap;
    state.wrap[key] = !state.wrap[key];
    renderJsonPane(key, { preserveView: true });
  }),
);
qsa("[data-meta]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.meta;
    if (!key || !hasMetadata(state.meta[key])) return;
    state.metaOpen[key] = !state.metaOpen[key];
    renderMetaPane(key);
  }),
);
qsa("[data-pricing]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!state.requestPricing) return;
    state.requestPricingOpen = !state.requestPricingOpen;
    renderRequestPricing();
  }),
);
qsa("[data-expand]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.expand;
    state.tree[key] = true;
    if (qsaOn($(key + "Json"), "details").length === 0) renderJsonPane(key);
    const details = qsaOn($(key + "Json"), "details:not(.json-str-detail)");
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
      // Refresh the width cache before touching the tree, then queue instead
      // of opening here: the click returns immediately and the queue opens
      // each node right after its children are filled, so the level streams
      // in without blocking the main thread.
      jsonLineWidthCache[key] =
        $(key + "Json").clientWidth > 24 ? $(key + "Json").clientWidth - 24 : 0;
      nextLevel.forEach((detail) => {
        // Non-lazy trees already have their children in the DOM, so opening
        // directly is the correct (and cheap) path; only lazy nodes go
        // through the queue, which fills them before opening.
        if (detail.dataset.jsonLazy === "1") enqueueJsonMaterialize($(key + "Json"), detail);
        else detail.open = true;
      });
      schedulePaneButtonsUpdate(key);
    }
  }),
);
["request", "response"].forEach((key) => {
  // Keep the cached line width current so lazy fills never read clientWidth
  // after a mutation (that read forces a synchronous re-layout of the pane).
  new ResizeObserver(() => {
    const el = $(key + "Json");
    jsonLineWidthCache[key] = el.clientWidth > 24 ? el.clientWidth - 24 : 0;
  }).observe($(key + "Json"));
  $(key + "Json").addEventListener(
    "toggle",
    (event) => {
      const detail = asElement(event.target);
      if (detail instanceof HTMLElement && detail.open && detail.dataset.jsonLazy === "1") {
        enqueueJsonMaterialize($(key + "Json"), detail);
      }
      schedulePaneButtonsUpdate(key);
    },
    true,
  );
  $(key + "Json").addEventListener("click", (event) => {
    const summary = closestFrom(event.target, "summary");
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
    const button = closestFrom(event.target, "[data-copy-string]");
    if (!button) return;
    const body = button.closest(".json-str-full")?.querySelector(".json-str-body");
    if (!body) return;
    navigator.clipboard.writeText(body.textContent || "").then(
      () => toast(t("copiedText")),
      () => toast(t("copyFailed")),
    );
  });
});
qsa("[data-format]").forEach((button) =>
  button.addEventListener("click", () => {
    const key = button.dataset.format;
    state.formatStrings[key] = !state.formatStrings[key];
    renderJsonPane(key, { preserveView: true });
  }),
);
qsa("[data-copy]").forEach((button) =>
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
    logList = qs(".log-list");
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
// A group card reveals its node state; that choice is browser state, not configuration.
// The toggle event does not bubble, so it is caught on the way down.
$("proxyGrid").addEventListener(
  "toggle",
  (event) => {
    const details = asElement(event.target);
    if (!details.classList || !details.classList.contains("lb-status")) return;
    const lbCard = closestOn(details, ".lb-card");
    if (!lbCard) return;
    const pair = state.pairs[Number(lbCard.dataset.lbPair)];
    const group = ((pair && pair.load_balancers) || [])[Number(lbCard.dataset.lbIndex)];
    if (!pair || !group) return;
    markLbGroupOpen(pair, group, details.open);
  },
  true,
);
loadPairs().catch((e) => toast(e.message));
scheduleLoadBalancerStatus();
void refreshLoadBalancerStatus();
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
