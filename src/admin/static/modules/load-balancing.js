import { escapeHtml } from "./text.js";
import { requestWithCancellation } from "./request.js";

/** Owns LB presentation, member form collection, open cards and polling. Pair
 * configuration belongs to proxy-config: reads are snapshots, edits are operations. */
export function createLoadBalancing({
  $,
  qs,
  qsa,
  qsaOn,
  qsOn,
  asElement,
  closestFrom,
  closestOn,
  t,
  api: request,
}) {
  let operations;
  let lifecycle = null;
  let statusRequest = null;
  const api = (url, options = {}) =>
    requestWithCancellation(request, url, options, lifecycle?.signal);
  const listen = (target, type, listener, options = {}) =>
    target.addEventListener(type, listener, {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: lifecycle.signal,
    });
  function patternToRegex(pattern) {
    return pattern
      .split("*")
      .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join(".*");
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
  const lbGroupOpenStorageKey = "llmProxyLbGroupOpen";
  // Whether a group card reveals its node state lives in the browser, never in the
  // configuration: a config round trip strips anything zod does not know.
  function lbGroupOpenKey(pair, group) {
    return `${pair.id || "pair"}|${group.id || "group"}`;
  }
  function readLbGroupOpen() {
    let parsed;
    try {
      parsed = JSON.parse(localStorage.getItem(lbGroupOpenStorageKey) || "{}");
    } catch {
      parsed = {};
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  function writeLbGroupOpen(map) {
    localStorage.setItem(lbGroupOpenStorageKey, JSON.stringify(map));
  }
  function isLbGroupOpen(pair, group) {
    return readLbGroupOpen()[lbGroupOpenKey(pair, group)] === true;
  }
  function markLbGroupOpen(pair, group, open) {
    const map = readLbGroupOpen();
    map[lbGroupOpenKey(pair, group)] = open;
    writeLbGroupOpen(map);
  }
  function lbPatternsMayOverlap(left, right) {
    if (!left.includes("*") || !right.includes("*")) return left === right;
    const core = (pattern) => pattern.replace(/\*/g, "");
    const leftCore = core(left);
    const rightCore = core(right);
    if (leftCore === rightCore) return true;
    return (
      new RegExp(`^${patternToRegex(right)}$`).test(leftCore) ||
      new RegExp(`^${patternToRegex(left)}$`).test(rightCore)
    );
  }
  /** The soft warnings the backend also reports, shown while the form is being edited. */
  function lbGroupWarnings(pair) {
    const groups = pair.load_balancers || [];
    const known = new Set((pair.targets || []).map((target) => target.id));
    const warnings = [];
    groups.forEach((group, groupIndex) => {
      const memberIds = lbMemberIds(group);
      if (memberIds.length === 1) warnings.push({ groupIndex, text: t("lbWarnSingleNode") });
      if (group.model_pattern) {
        const overlaps = groups.some(
          (other, otherIndex) =>
            otherIndex !== groupIndex &&
            other.enabled !== false &&
            other.model_pattern &&
            lbPatternsMayOverlap(group.model_pattern, other.model_pattern),
        );
        if (overlaps) warnings.push({ groupIndex, text: t("lbWarnOverlapping") });
      }
      if (memberIds.some((id) => !known.has(id))) {
        warnings.push({ groupIndex, text: t("lbNodeMissingMember") });
      }
      if (
        memberIds.some((id) =>
          (pair.targets || []).some((target) => target.id === id && target.enabled === false),
        )
      ) {
        warnings.push({ groupIndex, text: t("lbWarnDisabledMember") });
      }
    });
    return warnings;
  }
  /** A note inside a target card: a group that owns this node skips its mapping. */
  function lbTakeoverNoteHtml(pair) {
    const groups = (pair.load_balancers || []).filter((group) => group.enabled !== false);
    if (!groups.length) return "";
    return `<p class="lb-takeover-note">${escapeHtml(t("lbTakeover"))}</p>`;
  }
  function lbStatusRowHtml(targetId, target) {
    const id = escapeHtml(targetId);
    const name = (target && target.name) || targetId;
    const fact = (key, label, value) =>
      `<span class="lb-node-fact" data-lb-fact="${key}" title="${escapeHtml(`${label}: ${value}`)}">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
    return `<div class="lb-node-state" data-lb-status-target="${id}">
    <div class="lb-node-head">
      <span class="lb-node-name" title="${id}">${escapeHtml(name)}</span>
      <span class="lb-node-flag" data-lb-fact="enabled">${escapeHtml(t("lbStateOn"))}</span>
    </div>
    <div class="lb-node-metrics">
      ${fact("inFlight", t("lbStateInFlight"), "0")}
      ${fact("waiting", t("lbStateWaiting"), "-")}
      ${fact("kv", t("lbStateKv"), "-")}
    </div>
    <div class="lb-node-metrics">
      ${fact("bindings", t("lbStateBindings"), "0")}
      ${fact("cooldown", t("lbStateCooldown"), "0")}
      ${fact("source", t("lbStateSource"), "-")}
    </div>
  </div>`;
  }

  /** Names are part of the row markup, so a rename has to force a rebuild too. */
  function lbNodeRenderSignature(targetIds, targets) {
    return targetIds
      .map((targetId) => {
        const target = (targets || []).find((item) => item.id === targetId);
        return `${targetId}:${(target && target.name) || ""}`;
      })
      .join("|");
  }

  function lbNodeStatesHtml(targetIds, targets) {
    return targetIds
      .map((targetId) =>
        lbStatusRowHtml(
          targetId,
          (targets || []).find((item) => item.id === targetId),
        ),
      )
      .join("");
  }
  /** One checkbox row in the member picker dropdown: checkbox, name, disabled mark. */
  function lbMemberOptionHtml(target, checked) {
    const id = escapeHtml(target.id);
    const name = target.name || target.id;
    const off =
      target.enabled === false ? `<em class="lb-off">${escapeHtml(t("lbStateOff"))}</em>` : "";
    return `<label class="lb-member"><input type="checkbox" data-lb-node="${id}" ${checked ? "checked" : ""}><span class="lb-member-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>${off}</label>`;
  }
  /** Member ids in the order they were configured. */
  function lbMemberIds(group) {
    return (group.members || []).map((member) => member.target_id);
  }

  /** One row per ticked member: node name on the left, its model id on the right. */
  function lbMemberRowsHtml(members, targets) {
    const byId = new Map(targets.map((target) => [target.id, target]));
    const rows = members
      .map((member) => {
        const target = byId.get(member.target_id);
        const name = (target && target.name) || member.target_id;
        const id = escapeHtml(member.target_id);
        const off =
          target !== undefined && target.enabled === false
            ? `<em class="lb-off">${escapeHtml(t("lbStateOff"))}</em>`
            : "";
        return `<div class="lb-member-row">
        <span class="lb-member-row-name" title="${id}"><span class="lb-member-row-label">${escapeHtml(name)}</span>${off}</span>
        <input type="text" class="lb-member-row-model" data-lb-member-model="${id}" value="${escapeHtml(member.model_id || "")}" placeholder="${escapeHtml(t("lbMemberModelPlaceholder"))}" aria-label="${escapeHtml(`${t("lbMemberModel")}: ${name}`)}">
      </div>`;
      })
      .join("");
    return rows || `<p class="lb-empty">${escapeHtml(t("lbMembersNone"))}</p>`;
  }

  /** Which members are switched off: a disabled member gains a mark on its row. */
  function lbDisabledTargetIds(targets) {
    return targets.filter((target) => target.enabled === false).map((target) => target.id);
  }

  /** Only the id, the name and the enabled flag decide whether the rows have to be
   rebuilt, so typing in a model box never rebuilds them. */
  function lbMemberRowsSignature(members, targets, disabledIds) {
    const disabled = new Set(disabledIds || []);
    return members
      .map((member) => {
        const target = (targets || []).find((item) => item.id === member.target_id);
        return `${member.target_id}:${(target && target.name) || ""}:${disabled.has(member.target_id) ? "off" : "on"}`;
      })
      .join("|");
  }

  /** Checked nodes plus whatever is typed in their model boxes, in configured order. */
  function lbCollectMembers(lbCard, previous) {
    const checkedIds = qsaOn(lbCard, "[data-lb-node]")
      .filter((input) => input.checked)
      .map((input) => input.dataset.lbNode);
    const typed = new Map(
      qsaOn(lbCard, "[data-lb-member-model]").map((input) => [
        input.dataset.lbMemberModel,
        input.value.trim(),
      ]),
    );
    const members = [];
    const used = new Set();
    (previous || []).forEach((member) => {
      if (!checkedIds.includes(member.target_id) || used.has(member.target_id)) {
        return;
      }
      used.add(member.target_id);
      members.push({
        target_id: member.target_id,
        model_id: typed.has(member.target_id) ? typed.get(member.target_id) : member.model_id || "",
      });
    });
    checkedIds.forEach((targetId) => {
      if (used.has(targetId)) {
        return;
      }
      used.add(targetId);
      members.push({ target_id: targetId, model_id: typed.get(targetId) || "" });
    });
    return members;
  }

  function lbGroupCard(group, pair, pairIndex, groupIndex) {
    const open = isLbGroupOpen(pair, group);
    const memberList = group.members || [];
    const members = new Set(lbMemberIds(group));
    const targets = pair.targets || [];
    const memberRows = targets
      .map((target) => lbMemberOptionHtml(target, members.has(target.id)))
      .join("");
    const nodeIds = lbMemberIds(group);
    const rowsKey = lbMemberRowsSignature(memberList, targets, lbDisabledTargetIds(targets));
    const popId = `lb-picker-pop-${pairIndex}-${groupIndex}`;
    return `<section class="lb-card" data-lb-pair="${pairIndex}" data-lb-index="${groupIndex}">
    <div class="lb-head">
      <input data-lb-field="name" value="${escapeHtml(group.name || "")}" placeholder="${escapeHtml(t("lbGroupName"))}" aria-label="${escapeHtml(t("lbGroupName"))}">
      <button type="button" data-remove-lb>${escapeHtml(t("delete"))}</button>
      <label class="switch" title="${escapeHtml(t("switch"))}"><input type="checkbox" data-lb-toggle ${group.enabled !== false ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <label><span>${escapeHtml(t("lbModelPattern"))}</span><input data-lb-field="model_pattern" value="${escapeHtml(group.model_pattern || "")}" placeholder="Qwen3.8-Flash-Next"></label>
    <label><span>${escapeHtml(t("lbStrategy"))}</span><select data-lb-field="strategy">
      <option value="least_load"${group.strategy === "least_load" ? " selected" : ""}>${escapeHtml(t("lbStrategyLeast"))}</option>
      <option value="round_robin"${group.strategy === "round_robin" ? " selected" : ""}>${escapeHtml(t("lbStrategyRoundRobin"))}</option>
    </select></label>
    <div class="lb-flags">
      <label class="lb-flag"><input type="checkbox" data-lb-flag="metrics_enabled" ${group.metrics_enabled !== false ? "checked" : ""}> <span>${escapeHtml(t("lbMetricsEnabled"))}</span></label>
      <label class="lb-flag"><input type="checkbox" data-lb-flag="failover_enabled" ${group.failover_enabled !== false ? "checked" : ""}> <span>${escapeHtml(t("lbFailoverEnabled"))}</span></label>
    </div>
    <div class="lb-members-field">
      <strong>${escapeHtml(t("lbMembers"))}</strong>
      <div class="lb-picker" data-lb-picker>
        <button type="button" class="lb-picker-toggle" data-lb-picker-toggle aria-expanded="false" aria-controls="${popId}"><span>${escapeHtml(t("lbChooseNodes"))}</span><span class="lb-picker-caret" aria-hidden="true"></span></button>
        <div class="lb-picker-pop" id="${popId}" data-lb-picker-pop hidden>${memberRows}</div>
      </div>
    </div>
    <div class="lb-member-rows" data-lb-member-rows="${escapeHtml(rowsKey)}">${lbMemberRowsHtml(memberList, targets)}</div>
    <p class="lb-member-hint">${escapeHtml(t("lbMemberModelHint"))}</p>
    <div class="lb-tools">
      <p class="lb-warning" data-lb-warning hidden></p>
    </div>
    <details class="lb-status" ${open ? "open" : ""}>
      <summary>${escapeHtml(t("lbNodeState"))} · ${nodeIds.length}</summary>
      <div class="lb-node-states" data-lb-rendered="${escapeHtml(lbNodeRenderSignature(nodeIds, pair.targets))}">${lbNodeStatesHtml(nodeIds, pair.targets)}</div>
    </details>
  </section>`;
  }
  function lbSectionHtml(pair, pairIndex) {
    const groups = pair.load_balancers || [];
    return `<div class="lb-section">
    <div class="lb-section-head">
      <strong>${escapeHtml(t("loadBalancing"))}</strong>
      <button type="button" data-add-lb-group>${escapeHtml(t("addLbGroup"))}</button>
    </div>
    <div class="lb-groups">${groups
      .map((group, groupIndex) => lbGroupCard(group, pair, pairIndex, groupIndex))
      .join("")}</div>
  </div>`;
  }
  const loadBalancerStatusIntervalMs = 2000;
  let loadBalancerStatusTimer;

  function loadBalancerStatusVisible() {
    return !document.hidden && $("proxies").classList.contains("active");
  }

  /** Only numbers and state words are replaced, so typing and focus survive a refresh. */
  function setLbFact(row, name, label, value) {
    const element = qsOn(row, `[data-lb-fact="${name}"]`);
    if (element === null) return;
    const text = `${label}: ${value}`;
    element.textContent = text;
    // The fixed columns can clip a long value, so the whole text stays on hover.
    element.title = text;
  }

  /** The state badge on the name line shows only the words, never a repeated label. */
  function setLbBadge(row, enabled, metrics, stale, words) {
    const badge = qsOn(row, '[data-lb-fact="enabled"]');
    if (badge === null) return;
    badge.textContent = words.filter(Boolean).join(" · ");
    badge.classList.toggle("is-off", enabled === false);
    badge.classList.toggle("is-nosample", metrics === null);
    badge.classList.toggle("is-stale", stale === true && metrics !== null);
  }

  /** Opens one member picker and points it at the side of the card with more room, so
   *  the floating list is never clipped by the scrollable page. */
  function toggleLbPicker(picker) {
    const pop = picker?.querySelector("[data-lb-picker-pop]");
    const toggle = picker?.querySelector("[data-lb-picker-toggle]");
    if (!pop || !toggle) return;
    const willOpen = pop.hidden;
    if (willOpen) {
      closeLbPickers(picker);
      const view = pop.closest(".proxy-view");
      const toggleRect = toggle.getBoundingClientRect();
      if (view) {
        const viewRect = view.getBoundingClientRect();
        const roomBelow = Math.floor(viewRect.bottom - toggleRect.bottom) - 8;
        const roomAbove = Math.floor(toggleRect.top - viewRect.top) - 8;
        // Downwards is the normal dropdown direction; only a card that sits too
        // close to the bottom of the scrollable page flips the list up. The height
        // is capped to the chosen side so the page never clips the list.
        const above = roomBelow < 160 && roomAbove > roomBelow;
        pop.classList.toggle("is-above", above);
        pop.style.maxHeight = `${Math.min(240, Math.max(120, above ? roomAbove : roomBelow))}px`;
      }
      pop.hidden = false;
    } else {
      pop.hidden = true;
      pop.style.maxHeight = "";
      pop.classList.remove("is-above");
    }
    toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function closeLbPickers(except) {
    qsa("[data-lb-picker]").forEach((picker) => {
      if (picker === except) return;
      const pop = qsOn(picker, "[data-lb-picker-pop]");
      const toggle = qsOn(picker, "[data-lb-picker-toggle]");
      if (!pop || !toggle) return;
      pop.hidden = true;
      pop.style.maxHeight = "";
      pop.classList.remove("is-above");
      toggle.setAttribute("aria-expanded", "false");
    });
  }

  /** Warnings and the match preview follow the live form values, without a re-render. */
  function refreshLbCards() {
    qsa(".proxy-card").forEach((proxyCard) => {
      const pair = operations.getPairs()[Number(proxyCard.dataset.index)];
      if (!pair) return;
      const cards = qsaOn(proxyCard, ".lb-card");
      // Nothing is written back to state here: the drafts are only used to judge
      // the form the user is editing right now.
      const drafts = (pair.load_balancers || []).map((item) => ({ ...item }));
      cards.forEach((lbCard) => {
        const draft = drafts[Number(lbCard.dataset.lbIndex)];
        if (draft === undefined) return;
        draft.model_pattern = qsOn(lbCard, "[data-lb-field='model_pattern']")?.value || "";
        draft.members = lbCollectMembers(lbCard, draft.members);
        const toggle = qsOn(lbCard, "[data-lb-toggle]");
        if (toggle !== null) draft.enabled = toggle.checked;
      });
      // Enabled flags live only in the DOM until a save collects them, so a member
      // that was just switched off has to be read from its checkbox.
      const shadowTargets = (pair.targets || []).map((item) => ({ ...item }));
      qsaOn(proxyCard, ".target-card").forEach((targetCard) => {
        const index = Number(targetCard.dataset.targetIndex);
        const box = qsOn(targetCard, "[data-target-enabled]");
        const target = shadowTargets[index];
        if (target !== undefined && box !== null) {
          target.enabled = box.checked;
        }
      });
      const shadow = { ...pair, targets: shadowTargets, load_balancers: drafts };
      const warnings = lbGroupWarnings(shadow);
      cards.forEach((lbCard) => {
        const groupIndex = Number(lbCard.dataset.lbIndex);
        const draft = drafts[groupIndex] || {};
        const line = qsOn(lbCard, "[data-lb-warning]");
        if (line !== null) {
          const mine = warnings.filter((item) => item.groupIndex === groupIndex);
          line.textContent = mine.map((item) => item.text).join(" ");
          line.hidden = mine.length === 0;
        }
        // Each ticked node owns one row with its model box; typing in a box never
        // rebuilds them, only a tick or a rename does.
        const rows = qsOn(lbCard, ".lb-member-rows");
        const rowsKey = lbMemberRowsSignature(
          draft.members || [],
          shadowTargets,
          lbDisabledTargetIds(shadowTargets),
        );
        if (rows !== null && rows.dataset.lbMemberRows !== rowsKey) {
          rows.dataset.lbMemberRows = rowsKey;
          rows.innerHTML = lbMemberRowsHtml(draft.members || [], shadowTargets);
        }
        // The node rows follow the ticked members; the next poll refills their numbers.
        const states = qsOn(lbCard, ".lb-node-states");
        const checked = lbNodeRenderSignature(lbMemberIds(draft), shadowTargets);
        if (states !== null && states.dataset.lbRendered !== checked) {
          states.dataset.lbRendered = checked;
          states.innerHTML = lbNodeStatesHtml(lbMemberIds(draft), shadowTargets);
          const summary = qsOn(lbCard, ".lb-status > summary");
          if (summary !== null) {
            summary.textContent = `${t("lbNodeState")} · ${lbMemberIds(draft).length}`;
          }
        }
      });
    });
  }

  function withoutMember(groups, targetId) {
    return groups.map((group) => ({
      ...group,
      members: (group.members || []).filter((member) => member.target_id !== targetId),
    }));
  }

  function forgetLbGroupOpen(pair, group) {
    const map = readLbGroupOpen();
    delete map[lbGroupOpenKey(pair, group)];
    writeLbGroupOpen(map);
  }

  /** Returns true when the click belonged to a load balancing control. */
  function handleLoadBalancerClick(event, pairIndex) {
    const pair = operations.getPairs()[pairIndex];
    const lbCard = closestFrom(event.target, ".lb-card");
    if (asElement(event.target).matches("[data-add-lb-group]")) {
      operations.addGroup(pairIndex, newLoadBalancerGroup());
      const created = qs(
        `.proxy-card[data-index="${pairIndex}"] .lb-card:last-of-type [data-lb-field='name']`,
      );
      if (created) created.focus();
      return true;
    }
    const pickerToggle = closestFrom(event.target, "[data-lb-picker-toggle]");
    if (pickerToggle) {
      toggleLbPicker(pickerToggle.closest("[data-lb-picker]"));
      return true;
    }
    if (lbCard && asElement(event.target).matches("[data-remove-lb]")) {
      const group = (pair.load_balancers || [])[Number(lbCard.dataset.lbIndex)];
      if (group) forgetLbGroupOpen(pair, group);
      operations.removeGroup(pairIndex, Number(lbCard.dataset.lbIndex));
      return true;
    }
    return false;
  }
  function collectGroups(card, previous) {
    const groups = previous.map((group) => ({ ...group }));
    qsaOn(card, ".lb-card").forEach((lbCard) => {
      const group = groups[Number(lbCard.dataset.lbIndex)];
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
    return groups;
  }
  function applyLoadBalancerStatus(data) {
    const pairStates = (data && data.pairs) || [];
    qsa(".lb-card").forEach((lbCard) => {
      const pair = operations.getPairs()[Number(lbCard.dataset.lbPair)];
      const group = ((pair && pair.load_balancers) || [])[Number(lbCard.dataset.lbIndex)];
      const pairState = pairStates.find((item) => item.id === (pair && pair.id));
      const groupState = ((pairState && pairState.groups) || []).find(
        (item) => item.id === (group && group.id),
      );
      if (!groupState) return;
      qsaOn(lbCard, ".lb-node-state").forEach((row) => {
        const node = (groupState.nodes || []).find(
          (item) => item.targetId === row.dataset.lbStatusTarget,
        );
        if (!node) return;
        const metrics = node.metrics;
        const stateWords = [node.enabled ? t("lbStateOn") : t("lbStateOff")];
        if (metrics === null) stateWords.push(t("lbStateNoSample"));
        else if (node.stale) stateWords.push(t("lbStateStale"));
        setLbBadge(row, node.enabled, metrics, node.stale, stateWords);
        setLbFact(row, "inFlight", t("lbStateInFlight"), String(node.inFlight));
        setLbFact(
          row,
          "waiting",
          t("lbStateWaiting"),
          metrics === null ? "-" : String(metrics.waiting),
        );
        setLbFact(
          row,
          "kv",
          t("lbStateKv"),
          metrics === null || metrics.kvUsage === undefined
            ? "-"
            : `${Math.round(metrics.kvUsage * 100)}%`,
        );
        setLbFact(row, "bindings", t("lbStateBindings"), String(node.bindings));
        setLbFact(
          row,
          "cooldown",
          t("lbStateCooldown"),
          node.cooldownRemainingMs > 0 ? `${Math.ceil(node.cooldownRemainingMs / 1000)}s` : "0",
        );
        setLbFact(row, "source", t("lbStateSource"), metrics === null ? "-" : metrics.source);
      });
    });
  }

  async function refreshLoadBalancerStatus() {
    if (!lifecycle || !loadBalancerStatusVisible() || statusRequest) return;
    const pending = new AbortController();
    statusRequest = pending;
    try {
      const data = await api("/api/load-balancer/status", { signal: pending.signal });
      if (!pending.signal.aborted && loadBalancerStatusVisible()) applyLoadBalancerStatus(data);
    } catch {
      return; // A failed read keeps the numbers that are already on screen.
    } finally {
      if (statusRequest === pending) statusRequest = null;
    }
  }
  function updatePolling() {
    clearInterval(loadBalancerStatusTimer);
    loadBalancerStatusTimer = null;
    if (!lifecycle || !loadBalancerStatusVisible()) {
      statusRequest?.abort();
      statusRequest = null;
      closeLbPickers(null);
      return;
    }
    void refreshLoadBalancerStatus();
    loadBalancerStatusTimer = setInterval(() => {
      void refreshLoadBalancerStatus();
    }, loadBalancerStatusIntervalMs);
  }
  function init(nextOperations) {
    if (lifecycle) return;
    operations = nextOperations;
    lifecycle = new AbortController();
    // The member list floats over the card, so a click anywhere outside it closes it.
    listen(document, "pointerdown", (event) => {
      if (!closestFrom(event.target, "[data-lb-picker]")) closeLbPickers(null);
    });
    listen(document, "keydown", (event) => {
      if (event.key === "Escape") closeLbPickers(null);
    });
    // A group card reveals its node state; that choice is browser state, not configuration.
    // The toggle event does not bubble, so it is caught on the way down.
    listen(
      $("proxyGrid"),
      "toggle",
      (event) => {
        const details = asElement(event.target);
        if (!details.classList || !details.classList.contains("lb-status")) return;
        const lbCard = closestOn(details, ".lb-card");
        if (!lbCard) return;
        const pair = operations.getPairs()[Number(lbCard.dataset.lbPair)];
        const group = ((pair && pair.load_balancers) || [])[Number(lbCard.dataset.lbIndex)];
        if (!pair || !group) return;
        markLbGroupOpen(pair, group, details.open);
      },
      true,
    );

    listen(document, "visibilitychange", updatePolling);
    updatePolling();
  }
  function dispose() {
    if (!lifecycle) return;
    lifecycle.abort();
    lifecycle = null;
    clearInterval(loadBalancerStatusTimer);
    loadBalancerStatusTimer = null;
    statusRequest?.abort();
    statusRequest = null;
    closeLbPickers(null);
  }
  return {
    init,
    dispose,
    updatePolling,
    collectGroups,
    withoutMember,
    handleClick: handleLoadBalancerClick,
    sectionHtml: lbSectionHtml,
    takeoverNoteHtml: lbTakeoverNoteHtml,
    refreshCards: refreshLbCards,
  };
}
