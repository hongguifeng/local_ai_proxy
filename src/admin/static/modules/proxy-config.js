import { escapeHtml } from "./text.js";

import { requestWithCancellation } from "./request.js";

/** Owns the editable proxy configuration and connection-test dialog. The classic
 * adapter supplies shared UI services; no feature reads the classic script scope. */
export function createProxyConfig({
  $,
  qs,
  qsa,
  qsaOn,
  qsOn,
  asElement,
  closestFrom,
  closestOn,
  t,
  toast,
  api: request,
  registerLanguagePanel,
  suggestedStripRequestFields,
  openTargetMetricsDialog,
  loadBalancing,
}) {
  const state = {
    pairs: [],
    targetCheckModelsNotice: null,
    targetCheckModelOptions: [],
    targetCheckModelFilter: null,
    targetCheckModelActive: -1,
  };
  let lifecycle = null;
  let unregisterPanels = [];
  let languageDraft = null;
  let saveControl = null;
  const api = (url, options = {}) =>
    requestWithCancellation(request, url, options, lifecycle?.signal);
  const listen = (target, type, listener, options = {}) =>
    target.addEventListener(
      type,
      (event) => {
        const result = listener(event);
        result?.catch?.((error) => {
          if (error.name !== "AbortError") toast(configIssueText(error));
        });
      },
      {
        ...(typeof options === "boolean" ? { capture: options } : options),
        signal: lifecycle.signal,
      },
    );
  function configIssueText(error) {
    const issues = error && error.issues;
    if (!Array.isArray(issues) || issues.length === 0) {
      return error instanceof Error ? error.message : String(error);
    }
    return issues
      .slice(0, 3)
      .map((issue) => [issue.path, issue.message].filter(Boolean).join(": "))
      .join(" · ");
  }
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
      load_balancers: [],
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
        </div>
        <div class="target-head-flags">
          <label class="default-target"><input type="radio" name="default-target-${pairIndex}" data-default-target ${isDefault ? "checked" : ""}> <span>${escapeHtml(t("defaultTarget"))}</span></label>
          <label class="switch" title="${escapeHtml(t("targetEnabled"))}"><input type="checkbox" data-target-enabled aria-label="${escapeHtml(t("targetEnabled"))}" ${isDefault || target.enabled !== false ? "checked" : ""} ${isDefault ? "disabled" : ""}><span class="slider"></span></label>
        </div>
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
      ${loadBalancing.takeoverNoteHtml(pair)}
      <details class="model-prices" ${target.prices_expanded ? "open" : ""}>
        <summary>${escapeHtml(t("modelPrices"))} · ${(target.model_prices || []).length}</summary>
        <p class="price-help">${escapeHtml(t("priceUnit"))}</p>
        <div class="model-price-rules">${(target.model_prices || []).map((_, index) => modelPriceRuleHtml(target, index)).join("") || `<p class="price-empty">${escapeHtml(t("noModelPrices"))}</p>`}</div>
        <div class="price-tools"><button type="button" data-add-price>${escapeHtml(t("addModelPrice"))}</button><label class="price-test"><span>${escapeHtml(t("testPriceModel"))}</span><input data-price-test value="${escapeHtml(target.price_test_model || "")}"><output aria-live="polite">${escapeHtml(localPriceMatch(target))}</output></label></div>
        <div class="price-catalog">
          <label class="price-catalog-rate"><span>${escapeHtml(t("catalogPriceRate"))}</span><input data-catalog-rate inputmode="decimal" value="${escapeHtml(target.catalog_rate || "1")}"></label>
          <button type="button" data-fetch-catalog-prices title="${escapeHtml(t("fetchCatalogPrices"))}">${escapeHtml(t("fetchCatalogPrices"))}</button>
        </div>
        <p class="price-help">${escapeHtml(t("catalogSourceNote"))}</p>
      </details>
      <div class="target-controls">
        <div class="target-actions">
          <button data-check-target title="${escapeHtml(t("checkTarget"))}">${escapeHtml(t("checkTarget"))}</button>
          <button data-metrics-target title="${escapeHtml(t("targetMetricsTitle"))}">${escapeHtml(t("targetMetrics"))}</button>
          <button data-remove-target>${escapeHtml(t("delete"))}</button>
        </div>
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
        <button type="button" data-remove>${escapeHtml(t("delete"))}</button>
        <label class="switch" title="${escapeHtml(t("switch"))}"><input type="checkbox" data-toggle ${p.enabled ? "checked" : ""}><span class="slider"></span></label>
      </div>
      <div class="targets-head">
        <strong>${escapeHtml(t("targets"))}</strong>
        <button type="button" data-add-target>${escapeHtml(t("addTarget"))}</button>
      </div>
      <div class="targets-row">
        ${pairTargets(p)
          .map((target, targetIndex) => renderTarget(target, p, i, targetIndex))
          .join("")}
      </div>
      ${loadBalancing.sectionHtml(p, i)}
    </article>`,
      )
      .join("");
    loadBalancing.refreshCards();
  }
  function collectPairs() {
    qsa(".proxy-card").forEach((card) => {
      const pair = state.pairs[Number(card.dataset.index)];
      qsaOn(card, "[data-field]").forEach((input) => {
        const field = input.dataset.field;
        /** @type {string | number | string[]} */
        let value = input.value;
        if (field === "listen_port") value = Number(value);
        if (field === "target_headers")
          value = String(value)
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (field === "strip_request_fields" && value === "") value = "";
        if (field === "inject_request_fields" && value === "") value = "";
        pair[field] = value;
      });
      qsaOn(card, ".target-card").forEach((targetCard) => {
        const target = pairTargets(pair)[Number(targetCard.dataset.targetIndex)];
        qsaOn(targetCard, "[data-target-field]").forEach((input) => {
          const field = input.dataset.targetField;
          /** @type {string | string[] | { listen: string; upstream: string }[]} */
          let value = input.value;
          if (field === "target_headers")
            value = String(value)
              .split(/\n/)
              .map((line) => line.trim())
              .filter(Boolean);
          if (field === "model_mappings") {
            value = String(value)
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
        target.model_prices = qsaOn(targetCard, "[data-price-index]").map((rule) => {
          const value = {};
          qsaOn(rule, "[data-price-field]").forEach((input) => {
            value[input.dataset.priceField] = input.value;
          });
          return value;
        });
        target.price_test_model = qsOn(targetCard, "[data-price-test]")?.value || "";
        target.catalog_rate = qsOn(targetCard, "[data-catalog-rate]")?.value || "1";
        target.prices_expanded = qsOn(targetCard, ".model-prices")?.open || false;
        if (qsOn(targetCard, "[data-default-target]")?.checked) pair.default_target_id = target.id;
        const enabledInput = qsOn(targetCard, "[data-target-enabled]");
        target.enabled = enabledInput ? enabledInput.checked : true;
        const redactInput = qsOn(targetCard, "[data-redact-logs]");
        target.redact_logs = redactInput ? redactInput.checked : false;
      });
      pair.load_balancers = loadBalancing.collectGroups(card, pair.load_balancers || []);
      pairTargets(pair).forEach((target) => {
        if (target.id === pair.default_target_id) target.enabled = true;
      });
    });
  }
  async function loadPairs() {
    const data = await api("/api/pairs");
    if (qs(".proxy-card")) {
      // Status refreshes never replace the editable configuration.
      for (const pair of state.pairs) {
        const current = data.pairs.find((item) => item.id === pair.id);
        if (current) {
          pair.running = current.running;
          pair.actual_listen_port = current.actual_listen_port;
        }
      }
      qsa(".proxy-card").forEach((card) =>
        qsOn(card, ".status")?.classList.toggle(
          "running",
          Boolean(state.pairs[Number(card.dataset.index)]?.running),
        ),
      );
    } else {
      state.pairs = data.pairs;
      renderPairs();
    }
  }
  // Target cards are reordered by dragging their grip handle (pointer events, not the
  // native HTML5 drag API, so input fields keep working while cards move in the DOM).
  let targetDrag = null;
  function captureTargetPointer(handle, pointerId, capture) {
    try {
      if (capture) handle.setPointerCapture(pointerId);
      else handle.releasePointerCapture(pointerId);
    } catch {
      return; // Capture is optional; window listeners still finish the drag.
    }
  }
  function startTargetDrag(event) {
    const handle = closestFrom(event.target, "[data-drag-target]");
    if (!handle || handle.disabled || event.button !== 0) return;
    const card = closestOn(handle, ".target-card");
    const row = closestOn(card, ".targets-row");
    if (!card || !row || qsaOn(row, ".target-card").length < 2) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    captureTargetPointer(handle, event.pointerId, true);
    collectPairs();
    targetDrag = {
      handle,
      card,
      row,
      scroller: closestOn(row, ".proxy-view"),
      pairIndex: Number(closestOn(row, ".proxy-card")?.dataset.index ?? -1),
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
    qsaOn(row, ".target-card").forEach((card) => {
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
    const rects = qsaOn(row, ".target-card").map((card) => card.getBoundingClientRect());
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
    const ordered = qsaOn(dragging.row, ".target-card")
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
    captureTargetPointer(dragging.handle, dragging.pointerId, false);
    dragging.card.classList.remove("is-dragging");
    document.body.classList.remove("drag-target-active");
    if (dragging.started) commitTargetDrag(dragging);
  }
  function cancelTargetDrag() {
    const dragging = targetDrag;
    if (!dragging) return;
    targetDrag = null;
    captureTargetPointer(dragging.handle, dragging.pointerId, false);
    dragging.card.classList.remove("is-dragging");
    document.body.classList.remove("drag-target-active");
    if (dragging.started) renderPairs();
  }
  // Keyboard equivalent of the drag: the arrow keys move the focused card one slot.
  function moveTargetCardByKey(handle, offset) {
    const card = closestOn(handle, ".target-card");
    const row = closestOn(card, ".targets-row");
    const pairCard = closestOn(row, ".proxy-card");
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
    qs(
      `.proxy-card[data-index="${pairIndex}"] .target-card[data-target-index="${next}"] [data-drag-target]`,
    )?.focus();
  }
  async function savePairs(previousControl = null) {
    collectPairs();
    const submittedForm = formSignature();
    const data = await api("/api/pairs", {
      method: "PUT",
      body: JSON.stringify({ pairs: state.pairs }),
    });
    collectPairs();
    if (formSignature() === submittedForm) {
      state.pairs = data.pairs;
      const activeControl =
        captureActiveControl() ||
        (document.activeElement === $("saveProxies") ? previousControl : null);
      renderPairs();
      restoreActiveControl(activeControl);
    }
    toast(t("savedConfig"));
  }
  const targetCheckStart = $("targetCheckStart");
  const targetCheckModelsButton = $("targetCheckModels");
  // The suggestions the dialog offers before (and after a failed) model list pull.
  const defaultTargetCheckModels = [
    "gpt-4o-mini",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "claude-haiku-4-5",
    "qwen3.8-27b",
    "qwen-plus",
    "deepseek-chat",
  ];
  const targetCheckModelInput = $("targetCheckModel");
  const targetCheckModelCaret = $("targetCheckModelCaret");
  const targetCheckModelPop = $("targetCheckModelPop");
  const targetCheckModelPicker = targetCheckModelPop.closest(".target-check-model-picker");

  /** Offers a new set of ids; an open list is rebuilt so the change is visible. */
  function applyTargetCheckModelOptions(models) {
    state.targetCheckModelOptions = [...models];
    state.targetCheckModelFilter = null;
    if (!targetCheckModelPop.hidden) renderTargetCheckModelPop();
  }

  /** Clicking the caret lists everything; typing narrows the list to what contains the text. */
  function visibleTargetCheckModels() {
    const filter = state.targetCheckModelFilter;
    if (filter === null || filter === "") return state.targetCheckModelOptions;
    const needle = filter.toLowerCase();
    return state.targetCheckModelOptions.filter((model) => model.toLowerCase().includes(needle));
  }

  function renderTargetCheckModelPop() {
    const models = visibleTargetCheckModels();
    targetCheckModelPop.textContent = "";
    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "target-check-model-empty";
      empty.tabIndex = -1;
      empty.textContent = t("noModelMatch").replace("{value}", state.targetCheckModelFilter || "");
      targetCheckModelPop.append(empty);
      setTargetCheckModelActive(-1);
      return;
    }
    models.forEach((model, index) => {
      const row = document.createElement("div");
      row.className = "target-check-model-option";
      row.id = `target-check-model-option-${index}`;
      row.setAttribute("role", "option");
      row.dataset.modelOption = model;
      // A row that cannot take focus blurs the text field when it is clicked, which
      // closes the list before the click is dispatched and loses the pick.
      row.tabIndex = -1;
      if (model === targetCheckModelInput.value) {
        row.classList.add("is-current");
        row.setAttribute("aria-selected", "true");
      }
      // Bare text in a flex box cannot truncate; it needs its own child.
      const name = document.createElement("span");
      name.textContent = model;
      name.title = model;
      row.append(name);
      targetCheckModelPop.append(row);
    });
    const current = models.indexOf(targetCheckModelInput.value);
    setTargetCheckModelActive(current === -1 ? 0 : current);
  }

  /** The keyboard cursor: a highlighted row plus aria-activedescendant on the text. */
  function setTargetCheckModelActive(index) {
    const rows = qsaOn(targetCheckModelPop, ".target-check-model-option");
    const clamped = Math.max(-1, Math.min(index, rows.length - 1));
    state.targetCheckModelActive = clamped;
    rows.forEach((row, position) => {
      row.classList.toggle("is-active", position === clamped);
    });
    if (clamped < 0) {
      targetCheckModelInput.removeAttribute("aria-activedescendant");
      return;
    }
    targetCheckModelInput.setAttribute("aria-activedescendant", rows[clamped].id);
    rows[clamped].scrollIntoView({ block: "nearest" });
  }

  function activeTargetCheckModel() {
    const row = qsOn(targetCheckModelPop, ".target-check-model-option.is-active");
    return row ? row.dataset.modelOption : null;
  }

  /* The list floats over the dialog, so it never grows the form; like the member
   picker it flips up when the field sits too close to the bottom. */
  function positionTargetCheckModelPop() {
    const dialog = targetCheckModelPop.closest("dialog");
    if (dialog === null) return;
    const dialogRect = dialog.getBoundingClientRect();
    const caretRect = targetCheckModelCaret.getBoundingClientRect();
    const roomBelow = Math.floor(dialogRect.bottom - caretRect.bottom) - 8;
    const roomAbove = Math.floor(caretRect.top - dialogRect.top) - 8;
    const above = roomBelow < 160 && roomAbove > roomBelow;
    targetCheckModelPop.classList.toggle("is-above", above);
    targetCheckModelPop.style.maxHeight = `${Math.min(240, Math.max(120, above ? roomAbove : roomBelow))}px`;
  }

  function openTargetCheckModelPop(showAll) {
    if (showAll) state.targetCheckModelFilter = null;
    renderTargetCheckModelPop();
    positionTargetCheckModelPop();
    targetCheckModelPop.hidden = false;
    targetCheckModelCaret.setAttribute("aria-expanded", "true");
  }

  function closeTargetCheckModelPop() {
    targetCheckModelPop.hidden = true;
    targetCheckModelPop.style.maxHeight = "";
    targetCheckModelPop.classList.remove("is-above");
    targetCheckModelCaret.setAttribute("aria-expanded", "false");
    setTargetCheckModelActive(-1);
  }

  function chooseTargetCheckModel(model) {
    targetCheckModelInput.value = model;
    closeTargetCheckModelPop();
    targetCheckModelInput.focus();
  }

  // The notice keeps the facts, not the words, so a language switch re-writes it.
  function renderTargetCheckModelsNotice() {
    const notice = $("targetCheckModelsNotice");
    const fact = state.targetCheckModelsNotice;
    if (fact === null) {
      notice.hidden = true;
      notice.className = "target-check-models-notice";
      notice.textContent = "";
      return;
    }
    const success = fact.kind === "success";
    notice.className = `target-check-models-notice ${success ? "success" : "failure"}`;
    notice.textContent = success
      ? t("fetchModelsOk")
          .replace("{count}", String(fact.count))
          .replace("{duration}", `${Math.round(fact.durationMs)} ms`) +
        (fact.truncated ? t("fetchModelsNotListed") : "")
      : t("fetchModelsFail").replace("{error}", fact.error);
    notice.hidden = false;
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

  function captureActiveControl(element = document.activeElement) {
    const controls = qsa("#proxyGrid input, #proxyGrid textarea, #proxyGrid select");
    const index = controls.indexOf(element);
    if (index < 0) return null;
    const input = controls[index];
    return {
      index,
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
    };
  }
  function restoreActiveControl(active) {
    if (!active) return;
    const input = qsa("#proxyGrid input, #proxyGrid textarea, #proxyGrid select")[active.index];
    if (!input) return;
    input.focus({ preventScroll: true });
    if (active.start !== null && active.start !== undefined)
      input.setSelectionRange(active.start, active.end, active.direction);
  }
  function formSignature() {
    return JSON.stringify(
      qsa("#proxyGrid input, #proxyGrid textarea, #proxyGrid select").map((input) => [
        input.value,
        input.checked,
      ]),
    );
  }
  function captureLanguageDraft() {
    collectPairs();
    languageDraft = qsa("#proxyGrid input, #proxyGrid textarea, #proxyGrid select").map(
      (input) => ({
        value: input.value,
        checked: input.checked,
        type: input.type,
        focused: input === document.activeElement,
        start: input.selectionStart,
        end: input.selectionEnd,
      }),
    );
  }
  function renderLanguageDraft() {
    renderPairs();
    qsa("#proxyGrid input, #proxyGrid textarea, #proxyGrid select").forEach((input, index) => {
      const draft = languageDraft?.[index];
      if (!draft) return;
      input.value = draft.value;
      if (input.tagName === "INPUT") {
        input.checked = draft.checked;
        input.type = draft.type;
      }
      if (draft.focused) {
        input.focus({ preventScroll: true });
        if (draft.start !== null && draft.start !== undefined)
          input.setSelectionRange(draft.start, draft.end);
      }
    });
    languageDraft = null;
    loadBalancing.refreshCards();
  }
  function init() {
    if (lifecycle) return;
    lifecycle = new AbortController();
    unregisterPanels = [
      registerLanguagePanel("pairs", 10, renderLanguageDraft, undefined, captureLanguageDraft),
      registerLanguagePanel(
        "targetCheckModels",
        80,
        () => {
          renderTargetCheckModelsNotice();
          renderTargetCheckModelPop();
        },
        () => Boolean($("targetCheckDialog")?.open),
      ),
    ];
    loadBalancing.init({
      getPairs: () => structuredClone(state.pairs),
      addGroup: (pairIndex, group) => {
        collectPairs();
        const pair = state.pairs[pairIndex];
        (pair.load_balancers || (pair.load_balancers = [])).push(group);
        renderPairs();
      },
      removeGroup: (pairIndex, groupIndex) => {
        collectPairs();
        state.pairs[pairIndex].load_balancers.splice(groupIndex, 1);
        renderPairs();
      },
    });
    listen(window, "pointermove", moveTargetDrag);
    listen(window, "pointerup", endTargetDrag);
    listen(window, "pointercancel", endTargetDrag);
    listen(window, "blur", () => cancelTargetDrag());
    listen($("addProxy"), "click", () => {
      collectPairs();
      state.pairs.push(newPair());
      renderPairs();
    });
    listen($("saveProxies"), "pointerdown", () => {
      saveControl = captureActiveControl();
    });
    listen($("proxyGrid"), "focusout", (event) => {
      if (event.relatedTarget === $("saveProxies"))
        saveControl = captureActiveControl(event.target);
    });
    listen($("saveProxies"), "click", () => {
      const previousControl = saveControl;
      saveControl = null;
      return savePairs(previousControl).catch((e) => toast(configIssueText(e)));
    });
    listen($("proxyGrid"), "click", (event) => {
      const card = closestFrom(event.target, ".proxy-card");
      if (!card) return;
      const pair = state.pairs[Number(card.dataset.index)];
      if (loadBalancing.handleClick(event, Number(card.dataset.index))) return;
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
        } else if (
          asElement(event.target).matches("[data-price-down]") &&
          index < rules.length - 1
        ) {
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
        pair.load_balancers = loadBalancing.withoutMember(pair.load_balancers || [], removed.id);
        renderPairs();
        return;
      }
      if (asElement(event.target).matches("[data-remove]")) {
        collectPairs();
        state.pairs.splice(Number(card.dataset.index), 1);
        renderPairs();
      }
    });
    listen(targetCheckModelCaret, "click", () => {
      if (targetCheckModelPop.hidden) openTargetCheckModelPop(true);
      else closeTargetCheckModelPop();
      targetCheckModelInput.focus();
    });

    listen(targetCheckModelInput, "input", () => {
      state.targetCheckModelFilter = targetCheckModelInput.value;
      if (targetCheckModelPop.hidden) openTargetCheckModelPop(false);
      else renderTargetCheckModelPop();
    });

    listen(targetCheckModelInput, "keydown", (event) => {
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

    listen(targetCheckModelPop, "click", (event) => {
      const row = closestFrom(event.target, ".target-check-model-option");
      if (!row) return;
      // The rows live inside the field's <label>, so the click must not also activate the input.
      event.preventDefault();
      chooseTargetCheckModel(row.dataset.modelOption);
    });

    listen(targetCheckModelPicker, "focusout", (event) => {
      const related = /** @type {Node | null} */ (/** @type {FocusEvent} */ (event).relatedTarget);
      if (!targetCheckModelPicker.contains(related)) closeTargetCheckModelPop();
    });

    // The list floats over the dialog, so a click anywhere outside it closes it.
    listen(document, "pointerdown", (event) => {
      if (!closestFrom(event.target, "[data-model-picker]")) closeTargetCheckModelPop();
    });
    listen(document, "keydown", (event) => {
      if (event.key === "Escape") closeTargetCheckModelPop();
    });

    listen($("targetCheckModels"), "click", async () => {
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
    listen($("targetCheckClose"), "click", () => $("targetCheckDialog").close());
    listen($("targetCheckForm"), "submit", async (event) => {
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
    listen($("proxyGrid"), "change", async (event) => {
      if (asElement(event.target).matches("[data-lb-node], [data-lb-toggle], [data-lb-flag]")) {
        loadBalancing.refreshCards();
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
        loadBalancing.refreshCards();
        return;
      }
      if (!asElement(event.target).matches("[data-toggle]")) return;
      const pairId = state.pairs[Number(closestFrom(event.target, ".proxy-card").dataset.index)].id;
      const enabled = asElement(event.target).checked;
      await savePairs();
      const data = await api(`/api/pairs/${encodeURIComponent(pairId)}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      const pair = state.pairs.find((item) => item.id === pairId);
      if (!pair) return;
      pair.enabled = data.pair.enabled;
      pair.running = data.pair.running;
      pair.actual_listen_port = data.pair.actual_listen_port;
      qsa(".proxy-card").forEach((card) => {
        if (state.pairs[Number(card.dataset.index)]?.id === pairId) {
          qsOn(card, ".status")?.classList.toggle("running", Boolean(pair.running));
          qsOn(card, "[data-toggle]").checked = pair.enabled;
        }
      });
    });
    listen($("proxyGrid"), "pointerdown", (event) => startTargetDrag(event));
    listen($("proxyGrid"), "keydown", (event) => {
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
    listen($("proxyGrid"), "input", (event) => {
      if (asElement(event.target).matches("[data-lb-field]")) {
        loadBalancing.refreshCards();
        return;
      }
      if (!asElement(event.target).matches("[data-price-field], [data-price-test]")) return;
      const targetCard = closestFrom(event.target, ".target-card");
      if (targetCard) updateLocalPriceMatch(targetCard);
    });
  }
  function dispose() {
    if (!lifecycle) return;
    captureLanguageDraft();
    cancelTargetDrag();
    closeTargetCheckModelPop();
    lifecycle.abort();
    lifecycle = null;
    saveControl = null;
    for (const unregister of unregisterPanels) unregister();
    unregisterPanels = [];
    loadBalancing.dispose();
  }
  return { init, dispose, load: loadPairs, save: savePairs };
}
