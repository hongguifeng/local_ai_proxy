// LLM Proxy admin UI -- proxy config page: listener pairs, targets, model mappings, connection test
// Parts are concatenated in numeric order into /static/app.js and served as one classic script.

// Redraw on language change. The sequence mirrors the order the switch used to
// call these in by hand; see registerLanguagePanel in 01-core.js.
registerLanguagePanel("pairs", 10, () => renderPairs());
registerLanguagePanel(
  "targetCheckModels",
  80,
  () => {
    renderTargetCheckModelsNotice();
    renderTargetCheckModelPop();
  },
  () => Boolean($("targetCheckDialog")?.open),
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
function patternToRegex(pattern) {
  return pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
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
      ${lbTakeoverNoteHtml(pair)}
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
      ${lbSectionHtml(p, i)}
    </article>`,
    )
    .join("");
  refreshLbCards();
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
    qsaOn(card, ".lb-card").forEach((lbCard) => {
      const group = (pair.load_balancers || [])[Number(lbCard.dataset.lbIndex)];
      if (!group) return;
      qsaOn(lbCard, "[data-lb-field]").forEach((input) => {
        group[input.dataset.lbField] = input.value;
      });
      group.enabled = qsOn(lbCard, "[data-lb-toggle]")?.checked ?? true;
      ["metrics_enabled", "failover_enabled"].forEach((flag) => {
        const input = qsOn(lbCard, `[data-lb-flag="${flag}"]`);
        group[flag] = input ? input.checked : true;
      });
      group.members = lbCollectMembers(lbCard, group.members);
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
  const handle = closestFrom(event.target, "[data-drag-target]");
  if (!handle || handle.disabled || event.button !== 0) return;
  const card = closestOn(handle, ".target-card");
  const row = closestOn(card, ".targets-row");
  if (!card || !row || qsaOn(row, ".target-card").length < 2) return;
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
