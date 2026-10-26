import { controlsOn, optionalTyped } from "./dom.js";
import { displayLocaleTag } from "./display-locale.js";
import { compactNumber, formatTokenCount, fullNumber } from "./numbers.js";
import { escapeHtml } from "./text.js";
import { displayTimestampParts } from "./time.js";
import { requestWithCancellation } from "./request.js";

/** Owns LB presentation, member form collection, open cards and polling. Pair
 * configuration belongs to proxy-config: reads are snapshots, edits are operations.
 * @param {import("../../ui-contracts.js").LoadBalancingServices} services
 */
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
  /** @type {AbortController | null} */
  let lifecycle = null;
  let statusRequest = null;
  /** @template {import("../../ui-contracts.js").ApiPath} Path @param {Path} url @param {RequestInit} [options] */
  const api = (url, options = {}) =>
    requestWithCancellation(request, url, options, lifecycle?.signal);
  const listen = (target, type, listener, options = {}) =>
    target.addEventListener(type, listener, {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: activeLifecycle().signal,
    });
  function activeLifecycle() {
    if (lifecycle === null) throw new Error("UI surface is not initialized");
    return lifecycle;
  }
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
  /**
   * One node's row: its own metrics, then the affordance that reveals the bindings this
   * node is holding. The numbers on the metric line come from the status poll and are
   * never rewritten by the list below them - a panel that shows three bindings does not
   * make an engine that never sampled look measured, and it does not make a node with no
   * bindings in the status answer look like it has none.
   * @param {string} targetId
   * @param {{ name?: string } | undefined} target
   * @param {{ pairIndex: number, groupIndex: number, nodeIndex: number, pairId: string, groupId: string }} context
   */
  function lbStatusRowHtml(targetId, target, context) {
    const id = escapeHtml(targetId);
    const name = (target && target.name) || targetId;
    const fact = (key, label, value) =>
      `<span class="lb-node-fact" data-lb-fact="${key}" title="${escapeHtml(`${label}: ${value}`)}">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
    const panel = bindingPanelFor(context.pairId, context.groupId, targetId);
    const panelId = `lb-binding-panel-${context.pairIndex}-${context.groupIndex}-${context.nodeIndex}`;
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
    <div class="lb-node-tools">
      <button type="button" class="lb-node-bindings-toggle" data-lb-bindings-toggle aria-expanded="${panel.open ? "true" : "false"}" aria-controls="${panelId}"><span class="lb-node-bindings-label">${escapeHtml(t("lbNodeBindings"))}</span><span class="lb-picker-caret" aria-hidden="true"></span></button>
    </div>
    <div class="lb-binding-panel" id="${panelId}" data-lb-binding-pair="${escapeHtml(context.pairId)}" data-lb-binding-group="${escapeHtml(context.groupId)}" data-lb-binding-node="${id}"${panel.open ? "" : " hidden"}>${lbBindingPanelHtml(panel, name)}</div>
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

  function lbNodeStatesHtml(targetIds, targets, context) {
    return targetIds
      .map((targetId, nodeIndex) =>
        lbStatusRowHtml(
          targetId,
          (targets || []).find((item) => item.id === targetId),
          { ...context, nodeIndex },
        ),
      )
      .join("");
  }

  // ------------------------------------------------------------ [TRI-06] the binding list

  /**
   * What one node's panel holds. A closed panel is never asked for; an open one follows the
   * status poll this file already runs, so the list adds no timer and no listener of its own.
   * The panel is keyed by the (pair, group, node) triple its element carries: a binding number
   * alone is not an address, and the same number in another group is another binding.
   */
  const bindingPanels = new Map();
  const lbNodeBindingsOpenStorageKey = "llmProxyLbNodeBindings";
  /** Rows one read asks for. The server caps a page at 200 whatever this says. */
  const lbBindingPageRows = 20;
  const lbBindingReadRowCap = 200;

  /**
   * The words for every closed-set value the list answers with, spelled in the wire's own
   * vocabulary so one table can say what each state means. The button's enabled state is never
   * in this table: it comes from the server's `movable.ok` and nothing else.
   */
  const lbBindingVocabulary = {
    activity: {
      in_flight: "lbActivityInFlight",
      idle: "lbActivityIdle",
      unknown: "lbActivityUnknown",
    },
    activityClass: { in_flight: "is-in-flight", idle: "is-idle", unknown: "is-unknown" },
    costSource: {
      normalized_usage: "lbCostNormalizedUsage",
      request_bytes: "lbCostRequestBytes",
      none: "lbCostNone",
    },
    confidence: {
      high: "lbConfidenceHigh",
      candidate: "lbConfidenceCandidate",
      none: "lbConfidenceNone",
    },
    associationLevel: { high: "lbConfidenceHigh", candidate: "lbConfidenceCandidate" },
    historyTargetNode: {
      same: "lbHistoryTargetSame",
      different: "lbHistoryTargetDifferent",
      unknown: "lbHistoryTargetUnknown",
    },
    coverage: {
      available: "lbCoverageAvailable",
      no_log_configured: "lbCoverageNoLogConfigured",
      no_traffic_database: "lbCoverageNoTrafficDatabase",
      failed: "lbCoverageFailed",
    },
    coverageClass: {
      available: "is-available",
      no_log_configured: "is-no-log",
      no_traffic_database: "is-no-database",
      failed: "is-failed",
    },
    moveReason: {
      migration_unavailable: "lbMoveReasonMigrationUnavailable",
      in_flight: "lbMoveReasonInFlight",
    },
    associationReason: {
      exact_key_links: "lbReasonExactKeyLinks",
      several_linked_tasks: "lbReasonSeveralLinkedTasks",
      key_without_link: "lbReasonKeyWithoutLink",
      key_without_task: "lbReasonKeyWithoutTask",
      link_boundary_mismatch: "lbReasonLinkBoundaryMismatch",
      key_limit_exceeded: "lbReasonKeyLimitExceeded",
      boundary_candidates: "lbReasonBoundaryCandidates",
      candidate_scan_truncated: "lbReasonCandidateScanTruncated",
      task_list_truncated: "lbReasonTaskListTruncated",
      no_log_configured: "lbCoverageNoLogConfigured",
      no_traffic_database: "lbCoverageNoTrafficDatabase",
      history_query_failed: "lbCoverageFailed",
      log_write_may_be_pending: "lbCoverageWritePending",
    },
    notFound: {
      pair_not_found: "lbBindingNotFoundPair",
      group_not_found: "lbBindingNotFoundGroup",
    },
  };

  /** A closed-set value plus its word; a value the table does not know stays the wire name
   *  rather than being printed as a translation key. */
  function lbBindingWord(value, table) {
    const key = table[value];
    return key === undefined ? String(value) : t(key);
  }

  function bindingPanelKey(pairId, groupId, targetId) {
    // JSON rather than a joined string: an id is configured text that may contain any
    // separator, and two different triples must not collapse into one key.
    return JSON.stringify([pairId, groupId, targetId]);
  }

  function readLbNodeBindingsOpen() {
    let parsed;
    try {
      parsed = JSON.parse(localStorage.getItem(lbNodeBindingsOpenStorageKey) || "{}");
    } catch {
      parsed = {};
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  function writeLbNodeBindingsOpen(map) {
    localStorage.setItem(lbNodeBindingsOpenStorageKey, JSON.stringify(map));
  }

  /** The panel for one node, created on first use. Whether it is open lives in the browser,
   *  like the group card's own open flag, because a configuration round trip keeps nothing. */
  function bindingPanelFor(pairId, groupId, targetId) {
    const key = bindingPanelKey(pairId, groupId, targetId);
    const known = bindingPanels.get(key);
    if (known !== undefined) return known;
    const created = {
      targetId,
      open: readLbNodeBindingsOpen()[key] === true,
      loaded: false,
      loading: false,
      loadingMore: false,
      errorKey: null,
      errorMessage: "",
      errorDetail: "",
      items: [],
      total: 0,
      hasMore: false,
      now: 0,
      serial: 0,
      pendingSerial: null,
      // Paging progress is the server's own `nextOffset`, never the length of the rows held
      // here: dropping a duplicate row shortens the list without advancing the page.
      nextOffset: 0,
      // The generation the rows on screen came from, or "" before any page was accepted.
      version: "",
      // The read still on its way and the surface that started it, so a close, a removal or
      // a disposal can stop it and an old callback cannot reach a newer panel.
      readOwner: null,
      readLifecycle: null,
    };
    bindingPanels.set(key, created);
    return created;
  }

  /** The three ids a panel element carries; the markup writes them escaped and the browser
   *  reads them back unescaped, so they are the pair of values worth comparing. */
  function bindingContextFromElement(element) {
    const pairId = element.dataset.lbBindingPair;
    const groupId = element.dataset.lbBindingGroup;
    const targetId = element.dataset.lbBindingNode;
    if (pairId === undefined || groupId === undefined || targetId === undefined) return null;
    return { pairId, groupId, targetId };
  }

  function lbBindingPanelElement(context) {
    return (
      qsa(".lb-binding-panel").find(
        (element) =>
          element.dataset.lbBindingPair === context.pairId &&
          element.dataset.lbBindingGroup === context.groupId &&
          element.dataset.lbBindingNode === context.targetId,
      ) ?? null
    );
  }

  /** The node's name is already on its row, so repainting a panel asks no one for the
   *  pair configuration; an empty name falls back to the id the row also carries. */
  function lbNodeLabelOfPanel(element, context) {
    const row = closestOn(element, ".lb-node-state");
    const name = row === null ? null : qsOn(row, ".lb-node-name");
    const text = name === null ? "" : name.textContent || "";
    return text === "" ? context.targetId : text;
  }

  /**
   * Age of one epoch-millisecond mark, counted against the `now` the same answer carried.
   * The server's clock and the row's own clock therefore come from one response, and a null
   * stays the dash that means "this never happened", not a zero.
   */
  function lbBindingAge(now, value) {
    if (value === null) return "-";
    const seconds = Math.max(0, Math.round((now - value) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /** The same instant as a wall-clock line, for the tooltip a clipped age hides. */
  function lbBindingClock(value) {
    if (value === null) return "";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(displayLocaleTag()) : "";
  }

  /** The cost signal names where its numbers came from; a source with no number behind it
   *  is shown as missing, because "normalized usage" without a token count says nothing. */
  function lbBindingCostValue(context) {
    if (context.source === "normalized_usage" && context.inputTokens !== null) {
      return `${lbBindingWord(context.source, lbBindingVocabulary.costSource)} ${formatTokenCount(context.inputTokens)}`;
    }
    if (context.source === "request_bytes" && context.requestBytes !== null) {
      return `${lbBindingWord(context.source, lbBindingVocabulary.costSource)} ${compactNumber(context.requestBytes)}`;
    }
    return "-";
  }

  function lbBindingCostTitle(context) {
    const parts = [
      `${t("lbStateCost")}: ${lbBindingWord(context.source, lbBindingVocabulary.costSource)}`,
    ];
    if (context.inputTokens !== null)
      parts.push(`${t("lbCostInputTokens")}: ${fullNumber(context.inputTokens)}`);
    if (context.cacheReadTokens !== null)
      parts.push(`${t("lbCostCacheReadTokens")}: ${fullNumber(context.cacheReadTokens)}`);
    if (context.requestBytes !== null)
      parts.push(`${t("lbCostRequestBytes")}: ${fullNumber(context.requestBytes)}`);
    if (context.observedAt !== null)
      parts.push(`${t("lbCostObservedAt")}: ${lbBindingClock(context.observedAt)}`);
    return parts.join(" · ");
  }

  /** One history task: its id, how firm the link is, how many requests it holds, when the
   *  log last saw it, and whether that was on this node. */
  function lbBindingTaskHtml(task) {
    const seen = displayTimestampParts(task.lastSeenAt);
    const seenText = `${seen.shortDate} ${seen.time}`.trim() || task.lastSeenAt;
    const detail = [
      `${t("lbStateRequests")}: ${task.requestCount}`,
      `${t("lbStateLastRequest")}: ${task.lastSeenAt}`,
      `${t("lbStateLastResponse")}: ${task.lastResponseAt === null ? "-" : task.lastResponseAt}`,
    ].join(" · ");
    return `<li class="lb-binding-task" data-lb-task-id="${escapeHtml(task.taskId)}">
      <span class="lb-binding-task-id" title="${escapeHtml(task.taskId)}">${escapeHtml(task.taskId)}</span>
      <span class="lb-binding-task-level is-${escapeHtml(task.level)}">${escapeHtml(lbBindingWord(task.level, lbBindingVocabulary.associationLevel))}</span>
      <span class="lb-binding-task-count" title="${escapeHtml(detail)}">${escapeHtml(String(task.requestCount))}</span>
      <span class="lb-binding-task-time" title="${escapeHtml(detail)}">${escapeHtml(seenText)}</span>
      <span class="lb-binding-task-node is-${escapeHtml(task.historyTargetNode)}">${escapeHtml(lbBindingWord(task.historyTargetNode, lbBindingVocabulary.historyTargetNode))}</span>
      ${task.pendingRequestOnly ? `<span class="lb-binding-task-pending">${escapeHtml(t("lbTaskPendingOnly"))}</span>` : ""}
    </li>`;
  }

  /** A failed history read says what broke, and that is not the same sentence as "there is
   *  nothing stored": only `failed` carries a cause. */
  function lbBindingCoverageHtml(coverage) {
    const stateClass = lbBindingVocabulary.coverageClass[coverage.state] ?? "";
    const stateWord = lbBindingWord(coverage.state, lbBindingVocabulary.coverage);
    const failure = coverage.failure;
    const detail =
      failure === null
        ? ""
        : [failure.phase, failure.errorName, failure.code, failure.message]
            .filter((part) => part !== null && part !== "")
            .join(" · ");
    const flags = [
      coverage.historyTruncated
        ? `<span class="lb-binding-coverage-flag is-truncated">${escapeHtml(t("lbCoverageTruncated"))}</span>`
        : "",
      coverage.logWriteMayBePending
        ? `<span class="lb-binding-coverage-flag is-pending">${escapeHtml(t("lbCoverageWritePending"))}</span>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    return `<span class="lb-binding-coverage-state ${stateClass}">${escapeHtml(stateWord)}</span>${
      detail === ""
        ? ""
        : `<span class="lb-binding-coverage-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>`
    }${flags}`;
  }

  /**
   * One binding row. Its own address, its live activity, what the history makes of it, and
   * what the server says about moving it. Several linked tasks still make one row with one
   * move affordance, because the thing that could move is the binding, not each task.
   */
  function lbBindingRowHtml(item, now, nodeLabel) {
    const fact = (name, label, value, detail) => {
      const text = `${label}: ${value}`;
      const title = detail === "" ? text : `${text} · ${detail}`;
      return `<span class="lb-binding-fact" data-lb-binding-fact="${name}" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
    };
    const association = item.associations;
    const tasks = association.tasks;
    const model = item.model === null ? "-" : item.model;
    const activityClass = lbBindingVocabulary.activityClass[item.activity] ?? "";
    const confidenceClass =
      association.confidence === "none" ? "is-none" : `is-${escapeHtml(association.confidence)}`;
    const moveReasons = item.movable.reasons.map((reason) =>
      lbBindingWord(reason, lbBindingVocabulary.moveReason),
    );
    const moveTitle = [t("lbMoveNextRequestHint")].concat(moveReasons).join(" · ");
    const taskList = tasks.length
      ? `<ul class="lb-binding-task-list">${tasks.map((task) => lbBindingTaskHtml(task)).join("")}</ul>`
      : "";
    const reasonChips = association.reasons.length
      ? `<p class="lb-binding-reasons" data-lb-binding-reasons>${association.reasons
          .map(
            (reason) =>
              `<span class="lb-binding-reason">${escapeHtml(lbBindingWord(reason, lbBindingVocabulary.associationReason))}</span>`,
          )
          .join("")}</p>`
      : "";
    return `<div class="lb-binding" data-lb-binding-id="${item.bindingId}" data-lb-binding-node="${escapeHtml(item.targetId)}">
    <div class="lb-binding-head">
      <span class="lb-binding-key" data-lb-binding-key title="${escapeHtml(String(item.bindingId))}">#${item.bindingId}</span>
      <span class="lb-binding-model" data-lb-binding-model title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      <span class="lb-binding-endpoint" data-lb-binding-endpoint title="${escapeHtml(`${item.endpointKind} ${item.endpoint}`)}">${escapeHtml(`${item.endpointKind} ${item.endpoint}`)}</span>
    </div>
    <div class="lb-binding-facts">
      ${fact("target", t("lbStateBindingTarget"), nodeLabel, `targetId: ${item.targetId}`)}
      ${fact("revision", t("lbStateRevision"), String(item.routingRevision), "")}
      ${fact("incarnation", t("lbStateIncarnation"), String(item.incarnation), "")}
    </div>
    <div class="lb-binding-facts">
      ${fact("requests", t("lbStateRequests"), fullNumber(item.requestCount), "")}
      ${fact("lastRequest", t("lbStateLastRequest"), lbBindingAge(now, item.lastRequestStartedAt), lbBindingClock(item.lastRequestStartedAt))}
      ${fact("lastResponse", t("lbStateLastResponse"), lbBindingAge(now, item.lastResponseEndedAt), lbBindingClock(item.lastResponseEndedAt))}
    </div>
    <div class="lb-binding-facts">
      ${fact("inFlight", t("lbStateInFlight"), String(item.inFlight), "")}
      <span class="lb-binding-fact lb-binding-activity ${activityClass}" data-lb-binding-fact="activity" title="${escapeHtml(t("lbActivityNote"))}">${escapeHtml(lbBindingWord(item.activity, lbBindingVocabulary.activity))}</span>
      ${fact("cost", t("lbStateCost"), lbBindingCostValue(item.context), lbBindingCostTitle(item.context))}
    </div>
    <div class="lb-binding-association">
      <p class="lb-binding-task-line" data-lb-binding-tasks>${escapeHtml(`${t("lbBindingTasks")}: ${tasks.length}`)} <span class="lb-binding-confidence ${confidenceClass}" data-lb-binding-confidence>${escapeHtml(lbBindingWord(association.confidence, lbBindingVocabulary.confidence))}</span>${
        association.ambiguous
          ? ` <span class="lb-binding-ambiguous" data-lb-binding-ambiguous>${escapeHtml(t("lbAmbiguous"))}</span>`
          : ""
      }</p>
      ${taskList}
      <p class="lb-binding-coverage" data-lb-binding-coverage>${lbBindingCoverageHtml(association.coverage)}</p>
      ${reasonChips}
    </div>
    <div class="lb-binding-tools">
      <button type="button" class="lb-binding-move" data-lb-binding-move${item.movable.ok ? "" : " disabled"} title="${escapeHtml(moveTitle)}">${escapeHtml(t("lbMoveBinding"))}</button>
      <span class="lb-binding-move-reasons" data-lb-binding-move-reasons>${escapeHtml(moveReasons.join(" · "))}</span>
    </div>
  </div>`;
  }

  /**
   * What the panel says right now: the reason there is nothing to show, the rows the last
   * read produced, or the note that those rows are stale. Rebuilding a card - a rename, a
   * language switch - redraws these rows from the same panel state, so the list never has to
   * be read twice for one opening.
   */
  function lbBindingPanelHtml(panel, nodeLabel) {
    if (bindingErrorText(panel) !== "" && panel.items.length === 0) {
      return `<p class="lb-binding-error" data-lb-binding-error>${escapeHtml(bindingErrorText(panel))}${
        panel.errorDetail === ""
          ? ""
          : ` <span class="lb-binding-error-detail" data-lb-binding-error-detail>${escapeHtml(panel.errorDetail)}</span>`
      }</p>`;
    }
    if (!panel.loaded) {
      return `<p class="lb-binding-loading" data-lb-binding-loading>${escapeHtml(t("lbBindingsLoading"))}</p>`;
    }
    const staleNote =
      bindingErrorText(panel) === ""
        ? ""
        : `<p class="lb-binding-stale" data-lb-binding-stale>${escapeHtml(t("lbBindingsRefreshFailed"))}${
            panel.errorDetail === ""
              ? ""
              : ` <span class="lb-binding-error-detail" data-lb-binding-error-detail>${escapeHtml(panel.errorDetail)}</span>`
          }</p>`;
    if (panel.items.length === 0) {
      return `${staleNote}<p class="lb-binding-empty" data-lb-binding-empty>${escapeHtml(t("lbBindingsNone"))}</p>`;
    }
    const linkedTasks = panel.items.reduce(
      (total, item) => total + item.associations.tasks.length,
      0,
    );
    const summary = `<p class="lb-binding-summary" data-lb-binding-summary>${escapeHtml(`${t("lbBindingsOnNode")}: ${panel.items.length} / ${panel.total}`)} · ${escapeHtml(`${t("lbLinkedTasksShown")}: ${linkedTasks}`)}</p>`;
    const pager = !panel.hasMore
      ? ""
      : panel.items.length >= lbBindingReadRowCap
        ? `<p class="lb-binding-limit" data-lb-binding-limit>${escapeHtml(t("lbBindingsAtLimit"))}</p>`
        : `<button type="button" class="lb-binding-more" data-lb-binding-more${panel.loadingMore ? " disabled" : ""}>${escapeHtml(`${t("lbBindingsLoadMore")} (${panel.items.length}/${panel.total})`)}</button>`;
    return [
      staleNote,
      summary,
      panel.items.map((item) => lbBindingRowHtml(item, panel.now, nodeLabel)).join(""),
      pager,
    ].join("");
  }

  /** Repaint one panel from the state it holds. A row that is gone from the document needs
   *  nothing: the next build of the card reads the same state. */
  function renderBindingPanel(context) {
    const panel = bindingPanels.get(
      bindingPanelKey(context.pairId, context.groupId, context.targetId),
    );
    if (panel === undefined) return;
    const element = lbBindingPanelElement(context);
    if (element === null) return;
    element.innerHTML = lbBindingPanelHtml(panel, lbNodeLabelOfPanel(element, context));
  }

  /**
   * The generation a page of bindings belongs to: which runtime holds the binding table and
   * which version of the group's routing signature it was read under. Two pages carrying
   * different versions are two different lists, so their rows must not be shown as one.
   * JSON is used because both values are legally nullable, which leaves "" free to mean
   * "no page has been accepted yet".
   */
  function bindingVersionKey(runtimeEpoch, groupRevision) {
    return JSON.stringify([runtimeEpoch, groupRevision]);
  }

  /** The binding's own address: its number plus the incarnation that says whether a reused
   *  number is the same binding. Ordering can shift while the user pages, so this is what
   *  keeps one binding from being listed twice in one panel. */
  function bindingAddress(item) {
    return JSON.stringify([item.bindingId, item.incarnation]);
  }

  /** Whether a read still owns its panel: no newer serial took over, and the surface that
   *  started it is still the live one. A callback from either situation is obsolete. */
  function bindingReadIsCurrent(panel, serial) {
    return panel.pendingSerial === serial && panel.readLifecycle === lifecycle;
  }

  /**
   * Stop a read that is still on its way: the panel is closed, hidden, gone, or the whole
   * surface was disposed, so nobody is waiting for that answer. The flags are cleared here
   * because the callback of a cancelled read is not allowed to clear them later - it may
   * belong to a lifecycle that no longer exists.
   */
  function cancelBindingRead(panel) {
    panel.readOwner?.abort();
    panel.readOwner = null;
    panel.pendingSerial = null;
    panel.loading = false;
    panel.loadingMore = false;
  }

  function cancelAllBindingReads() {
    bindingPanels.forEach((panel) => cancelBindingRead(panel));
  }

  /** Put an accepted page into the panel. Offset 0 replaces the rows, so a refresh shows what
   *  the server answers now; a larger offset adds the next page without dropping the rows the
   *  user paged to. A row that came back under an address the panel already holds is dropped,
   *  because one binding listed twice reads as two bindings. */
  function storeBindingPage(panel, data, append) {
    panel.total = data.totalBindings;
    panel.hasMore = data.hasMore;
    panel.now = data.now;
    panel.nextOffset = data.nextOffset;
    panel.loaded = true;
    panel.errorKey = null;
    panel.errorMessage = "";
    panel.errorDetail = "";
    if (append) {
      const held = new Set(panel.items.map(bindingAddress));
      panel.items = panel.items.concat(
        data.items.filter((item) => !held.has(bindingAddress(item))),
      );
      return;
    }
    panel.items = data.items.slice();
    panel.version = bindingVersionKey(data.runtimeEpoch, data.groupRevision);
  }

  /** Forget the rows that came from another runtime epoch or another group revision, so the
   *  panel holds one consistent list again. A fresh read then starts at offset 0: the tail of
   *  the old generation is not the first page of the new one. */
  function discardBindingGeneration(panel) {
    panel.items = [];
    panel.version = "";
    panel.loaded = false;
    panel.total = 0;
    panel.hasMore = false;
    panel.nextOffset = 0;
  }

  /**
   * One read of one node's list. Offset 0 replaces the rows and asks for as many as the user
   * already paged through, so a refresh never drops rows that are on screen; a larger offset
   * appends the next page at the server's own progress. A late answer is dropped: a newer read
   * owns the panel, and its numbers are the ones the user should see. A page that reports a
   * different runtime epoch or group revision than the rows already shown belongs to another
   * generation, so those rows are dropped and the new one is read from offset 0 - one restart
   * per answer, never a loop. A cancelled read is not a failed read: the panel keeps whatever
   * it already showed, and a callback whose surface is gone touches nothing.
   */
  async function readBindingPage(context, panel, offset) {
    if (lifecycle === null) return;
    const append = offset > 0;
    const limit = append
      ? lbBindingPageRows
      : Math.min(lbBindingReadRowCap, Math.max(lbBindingPageRows, panel.items.length));
    const serial = panel.serial + 1;
    panel.serial = serial;
    panel.pendingSerial = serial;
    panel.loading = true;
    panel.loadingMore = append;
    panel.readLifecycle = lifecycle;
    const pending = new AbortController();
    panel.readOwner = pending;
    const query = new URLSearchParams({
      pairId: context.pairId,
      groupId: context.groupId,
      targetId: context.targetId,
      limit: String(limit),
      offset: String(offset),
    });
    try {
      const data = await api(`/api/load-balancer/tasks?${query.toString()}`, {
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      if (!bindingReadIsCurrent(panel, serial)) return;
      // An answer that names another pair, group or node is not this panel's page, and
      // showing it here would put one node's bindings under another node's name.
      if (
        data.pairId !== context.pairId ||
        data.groupId !== context.groupId ||
        data.targetFilter !== context.targetId
      )
        return;
      if (append && bindingVersionKey(data.runtimeEpoch, data.groupRevision) !== panel.version) {
        discardBindingGeneration(panel);
        void readBindingPage(context, panel, 0);
        return;
      }
      storeBindingPage(panel, data, append);
    } catch (error) {
      // A cancelled read is a tab switch or a disposal, not a failed one: the panel keeps
      // whatever it already showed and waits for the next tick.
      if (pending.signal.aborted) return;
      if (!bindingReadIsCurrent(panel, serial)) return;
      applyBindingError(panel, error);
    } finally {
      if (bindingReadIsCurrent(panel, serial)) {
        panel.pendingSerial = null;
        panel.loading = false;
        panel.loadingMore = false;
      }
      if (panel.readOwner === pending) panel.readOwner = null;
      // A read whose surface is gone must not repaint a panel a newer lifecycle built.
      if (panel.readLifecycle === lifecycle) renderBindingPanel(context);
    }
  }

  /** What the panel says when a read did not answer: a translation key for the two named 404
   *  causes, so the sentence is drawn in the language the page speaks now and not the one it
   *  spoke when the read failed, and the server's own line for everything else, which arrives
   *  in English whatever the page speaks. */
  function bindingErrorText(panel) {
    if (panel.errorKey !== null) return t(panel.errorKey);
    return panel.errorMessage;
  }

  /** The two named 404 causes are kept as the code the server sent; everything else keeps the
   *  answer's message and code, which are not the console's words to translate. */
  function applyBindingError(panel, error) {
    const code = typeof error.code === "string" ? error.code : "";
    const key = lbBindingVocabulary.notFound[code];
    if (key === undefined) {
      panel.errorKey = null;
      panel.errorMessage = String(error.message || error);
      panel.errorDetail = code;
      return;
    }
    panel.errorKey = key;
    panel.errorMessage = "";
    panel.errorDetail = "";
  }

  /** Open panels follow the status poll; a closed panel, and a panel inside a folded node
   *  state section, are never asked for. One read per panel at a time. */
  function refreshOpenBindingPanels() {
    if (lifecycle === null) return;
    qsa(".lb-binding-panel").forEach((element) => {
      if (element.hidden) return;
      const details = element.closest("details");
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      const context = bindingContextFromElement(element);
      if (context === null) return;
      const panel = bindingPanels.get(
        bindingPanelKey(context.pairId, context.groupId, context.targetId),
      );
      if (panel === undefined || !panel.open || panel.pendingSerial !== null) return;
      void readBindingPage(context, panel, 0);
    });
  }

  function toggleLbNodeBindings(button) {
    const row = closestOn(button, ".lb-node-state");
    const panelElement = row === null ? null : qsOn(row, ".lb-binding-panel");
    if (panelElement === null) return;
    const context = bindingContextFromElement(panelElement);
    if (context === null) return;
    const key = bindingPanelKey(context.pairId, context.groupId, context.targetId);
    const panel = bindingPanelFor(context.pairId, context.groupId, context.targetId);
    const willOpen = panelElement.hidden;
    panelElement.hidden = !willOpen;
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
    panel.open = willOpen;
    const stored = readLbNodeBindingsOpen();
    stored[key] = willOpen;
    writeLbNodeBindingsOpen(stored);
    // Closing is a cancellation, not a failure: the answer would land in a list the user
    // just put away, so the read on its way is stopped and its rows stay as they were.
    if (willOpen) void readBindingPage(context, panel, 0);
    else cancelBindingRead(panel);
  }

  function loadMoreBindings(moreButton) {
    const panelElement = closestOn(moreButton, ".lb-binding-panel");
    if (panelElement === null) return;
    const context = bindingContextFromElement(panelElement);
    if (context === null) return;
    const panel = bindingPanelFor(context.pairId, context.groupId, context.targetId);
    if (!panel.hasMore || panel.pendingSerial !== null) return;
    // The server's progress, not the rows held here: dropping a row that came back under an
    // address already shown would otherwise ask for the same page again.
    void readBindingPage(context, panel, panel.nextOffset);
  }

  /**
   * Forget a panel whose node left the card: the row is gone, so its rows and its stored
   * open flag could only come back as a list for a node this group no longer has.
   */
  function pruneBindingPanels() {
    const living = new Set();
    qsa(".lb-card").forEach((card) => {
      qsaOn(card, ".lb-binding-panel").forEach((element) => {
        const context = bindingContextFromElement(element);
        if (context === null) return;
        living.add(bindingPanelKey(context.pairId, context.groupId, context.targetId));
      });
    });
    const stored = readLbNodeBindingsOpen();
    let changed = false;
    bindingPanels.forEach((panel, key) => {
      if (living.has(key)) return;
      cancelBindingRead(panel);
      bindingPanels.delete(key);
      delete stored[key];
      changed = true;
    });
    if (changed) writeLbNodeBindingsOpen(stored);
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
    const checkedIds = controlsOn(lbCard, "[data-lb-node]")
      .filter((input) => input instanceof HTMLInputElement && input.checked)
      .map((input) => input.dataset.lbNode);
    const typed = new Map(
      controlsOn(lbCard, "[data-lb-member-model]").map((input) => [
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
    const nodeContext = { pairIndex, groupIndex, pairId: pair.id, groupId: group.id };
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
      <div class="lb-node-states" data-lb-rendered="${escapeHtml(lbNodeRenderSignature(nodeIds, pair.targets))}">${lbNodeStatesHtml(nodeIds, pair.targets, nodeContext)}</div>
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
        draft.model_pattern =
          optionalTyped("[data-lb-field='model_pattern']", HTMLInputElement, lbCard)?.value || "";
        draft.members = lbCollectMembers(lbCard, draft.members);
        const toggle = optionalTyped("[data-lb-toggle]", HTMLInputElement, lbCard);
        if (toggle !== null) draft.enabled = toggle.checked;
      });
      // Enabled flags live only in the DOM until a save collects them, so a member
      // that was just switched off has to be read from its checkbox.
      const shadowTargets = (pair.targets || []).map((item) => ({ ...item }));
      qsaOn(proxyCard, ".target-card").forEach((targetCard) => {
        const index = Number(targetCard.dataset.targetIndex);
        const box = optionalTyped("[data-target-enabled]", HTMLInputElement, targetCard);
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
          states.innerHTML = lbNodeStatesHtml(lbMemberIds(draft), shadowTargets, {
            pairIndex: Number(lbCard.dataset.lbPair),
            groupIndex: Number(lbCard.dataset.lbIndex),
            pairId: pair.id,
            groupId: draft.id,
          });
          const summary = qsOn(lbCard, ".lb-status > summary");
          if (summary !== null) {
            summary.textContent = `${t("lbNodeState")} · ${lbMemberIds(draft).length}`;
          }
        }
      });
    });
    pruneBindingPanels();
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
    if (asElement(event.target)?.matches("[data-add-lb-group]")) {
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
    const bindingsToggle = closestFrom(event.target, "[data-lb-bindings-toggle]");
    if (bindingsToggle) {
      toggleLbNodeBindings(bindingsToggle);
      return true;
    }
    const moreButton = closestFrom(event.target, "[data-lb-binding-more]");
    if (moreButton) {
      loadMoreBindings(moreButton);
      return true;
    }
    // The move button carries no submit path in this step: the server answers every binding
    // `movable.ok: false`, so the button is rendered disabled and nothing is posted. The
    // destination picker and the submit call arrive with the migration API (TRI-09).
    if (lbCard && asElement(event.target)?.matches("[data-remove-lb]")) {
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
      controlsOn(lbCard, "[data-lb-field]").forEach((input) => {
        const field = input.dataset.lbField;
        if (field === undefined) throw new Error("Missing data-lb-field");
        group[field] = input.value;
      });
      group.enabled = optionalTyped("[data-lb-toggle]", HTMLInputElement, lbCard)?.checked ?? true;
      ["metrics_enabled", "failover_enabled"].forEach((flag) => {
        const input = optionalTyped(`[data-lb-flag="${flag}"]`, HTMLInputElement, lbCard);
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
        // A null number is one the engine never answered, so it is shown as unknown. Only a
        // zero the engine really reported is printed as a zero; nothing here invents idle.
        else if (metrics.running === null || metrics.waiting === null)
          stateWords.push(t("lbStatePartial"));
        setLbBadge(row, node.enabled, metrics, node.stale, stateWords);
        setLbFact(row, "inFlight", t("lbStateInFlight"), String(node.inFlight));
        setLbFact(
          row,
          "waiting",
          t("lbStateWaiting"),
          metrics === null || metrics.waiting === null ? "-" : String(metrics.waiting),
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
    // The same tick that refills the node numbers also refills the binding panels the user
    // opened, so the list follows one timer instead of keeping a poll of its own.
    refreshOpenBindingPanels();
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
      cancelAllBindingReads();
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
        const details = event.target;
        if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("lb-status"))
          return;
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
    // The list reads have an owner of their own, so disposal stops them the same way the
    // status read is stopped; a cancelled read is never shown as a query failure.
    cancelAllBindingReads();
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
