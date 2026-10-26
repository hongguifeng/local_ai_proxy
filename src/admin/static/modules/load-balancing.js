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
   * @param {Map<string, string>} nodeNames names for the destination options of a move, read
   *   from the pair's own targets so an option never has to guess what a node is called
   */
  function lbStatusRowHtml(targetId, target, context, nodeNames) {
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
    <div class="lb-binding-panel" id="${panelId}" data-lb-binding-pair="${escapeHtml(context.pairId)}" data-lb-binding-group="${escapeHtml(context.groupId)}" data-lb-binding-node="${id}"${panel.open ? "" : " hidden"}>${lbBindingPanelHtml(panel, name, nodeNames)}</div>
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
    const nodeNames = new Map(
      (targets || []).map((target) => [target.id, target.name || target.id]),
    );
    return targetIds
      .map((targetId, nodeIndex) =>
        lbStatusRowHtml(
          targetId,
          (targets || []).find((item) => item.id === targetId),
          { ...context, nodeIndex },
          nodeNames,
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
    /**
     * [TRI-09] Why a binding is not offered for a move, in the migration gate's own code names.
     * The button's enabled state comes from `movable.ok` and nothing else, so a page never
     * re-derives the gate from target URLs, model names or cooldowns.
     */
    moveReason: {
      response_state_dependency: "lbMoveReasonResponseState",
      state_unknown: "lbMoveReasonStateUnknown",
      no_eligible_destination: "lbMoveReasonNoEligible",
    },
    /** Why one candidate is not eligible, in the same gate's names. */
    destinationReason: {
      target_unknown: "lbMoveReasonTargetUnknown",
      target_disabled: "lbMoveReasonTargetDisabled",
      target_cooldown: "lbMoveReasonTargetCooldown",
      target_asleep: "lbMoveReasonTargetAsleep",
      same_physical_key: "lbMoveReasonSamePhysicalKey",
      model_mismatch: "lbMoveReasonModelMismatch",
    },
    /**
     * What an intent looks like now, as the list reports it. `applied` says the route changed
     * and nothing more; `observed` says a later request was seen using the destination, which is
     * not a claim that the upstream answered well.
     */
    operationState: {
      requested: "lbMoveStateRequested",
      rejected: "lbMoveStateRejected",
      pending_boundary: "lbMoveStatePending",
      applied: "lbMoveStateApplied",
      observed: "lbMoveStateObserved",
      cancelled: "lbMoveStateCancelled",
      expired: "lbMoveStateExpired",
      expired_after_apply: "lbMoveStateExpiredAfterApply",
    },
    operationStateClass: {
      requested: "is-requested",
      rejected: "is-rejected",
      pending_boundary: "is-pending",
      applied: "is-applied",
      observed: "is-observed",
      cancelled: "is-cancelled",
      expired: "is-expired",
      expired_after_apply: "is-expired-after-apply",
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
      // The versions a submit has to carry back. They come from the envelope the rows came in,
      // so a page never derives a group revision or an incarnation it was not given.
      runtimeEpoch: null,
      groupRevision: null,
      // The group's migration records as the list reports them, newest first and independent of
      // the node filter: a binding that moved is gone from this page, its record is not.
      operations: [],
      // What the user has chosen and what the server answered, per binding, so a refresh can
      // rebuild the markup without wiping a selection, a confirmation or a conflict notice.
      moves: new Map(),
      // The cancels on their way, each held by the attempt that started it, so one button
      // cannot be clicked into two DELETEs and an obsolete callback cannot unlock a cancel a
      // newer generation is making for the same operation.
      cancelling: new Map(),
      cancelNoticeKey: null,
      cancelNoticeDetail: "",
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
  function lbBindingRowHtml(panel, item, now, nodeLabel, nodeNames) {
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
    return `<div class="lb-binding" data-lb-binding-id="${item.bindingId}" data-lb-binding-incarnation="${item.incarnation}" data-lb-binding-node="${escapeHtml(item.targetId)}">
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
    ${lbBindingMoveHtml(panel, item, moveDraftFor(panel, item), nodeNames)}
  </div>`;
  }

  /**
   * What the panel says right now: the reason there is nothing to show, the rows the last
   * read produced, or the note that those rows are stale. Rebuilding a card - a rename, a
   * language switch - redraws these rows from the same panel state, so the list never has to
   * be read twice for one opening.
   */
  function lbBindingPanelHtml(panel, nodeLabel, nodeNames) {
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
      // The operation list goes out even with no rows: a move that was applied took its binding
      // off this node's page, and the record of that move is the one thing the user still has to
      // be able to read here. Dropping it with the rows would leave the move looking unfinished.
      return `${staleNote}<p class="lb-binding-empty" data-lb-binding-empty>${escapeHtml(
        t("lbBindingsNone"),
      )}</p>${lbBindingUnresolvedHtml(panel)}${lbBindingOperationsHtml(panel)}`;
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
      panel.items
        .map((item) => lbBindingRowHtml(panel, item, panel.now, nodeLabel, nodeNames))
        .join(""),
      lbBindingUnresolvedHtml(panel),
      lbBindingOperationsHtml(panel),
      pager,
    ].join("");
  }

  /**
   * Which control inside a panel the user was working in, if any. The panel is rebuilt from the
   * status poll, so the identity of a control has to be recorded in a way a rebuilt panel can
   * find again: the binding it belongs to and which affordance of that binding it is.
   */
  function capturePanelFocus(element) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !element.contains(active)) return null;
    const row = closestOn(active, ".lb-binding");
    if (row === null) return null;
    const bindingId = row.dataset.lbBindingId;
    if (bindingId === undefined) return null;
    if (active.dataset.lbBindingMoveTarget !== undefined) return [bindingId, "target"];
    if (active.dataset.lbBindingMoveConfirm !== undefined) return [bindingId, "confirm"];
    if (active.dataset.lbBindingMove !== undefined) return [bindingId, "submit"];
    if (active.dataset.lbBindingMoveRetry !== undefined) return [bindingId, "retry"];
    if (active.dataset.lbBindingMoveCancel !== undefined) {
      return [bindingId, `cancel:${active.dataset.lbBindingMoveCancel}`];
    }
    return null;
  }

  /** Put the focus back where the user left it, on the control the rebuild made again. */
  function restorePanelFocus(element, focus) {
    if (focus === null) return;
    const row = element.querySelector(`.lb-binding[data-lb-binding-id="${focus[0]}"]`);
    if (row === null) return;
    const target =
      focus[1] === "target"
        ? qsOn(row, "[data-lb-binding-move-target]")
        : focus[1] === "confirm"
          ? qsOn(row, "[data-lb-binding-move-confirm]")
          : focus[1] === "submit"
            ? qsOn(row, "[data-lb-binding-move]")
            : focus[1] === "retry"
              ? qsOn(row, "[data-lb-binding-move-retry]")
              : qsOn(row, `[data-lb-binding-move-cancel="${focus[1].slice(6)}"]`);
    if (target !== null) target.focus();
  }

  /**
   * Repaint one panel from the state it holds. A row that is gone from the document needs
   * nothing: the next build of the card reads the same state. The panel is rebuilt from scratch,
   * so the two things a rebuild would otherwise lose are put back on purpose: the choice the
   * user made lives in the panel and is rendered again, and the control the user was working in
   * is found again and re-focused. A poll therefore cannot wipe a destination, a confirmation or
   * a conflict notice, and it cannot move the caret out from under the user.
   */
  function renderBindingPanel(context) {
    const panel = bindingPanels.get(
      bindingPanelKey(context.pairId, context.groupId, context.targetId),
    );
    if (panel === undefined) return;
    const element = lbBindingPanelElement(context);
    if (element === null) return;
    const focus = capturePanelFocus(element);
    element.innerHTML = lbBindingPanelHtml(
      panel,
      lbNodeLabelOfPanel(element, context),
      lbNodeNamesForCard(closestOn(element, ".lb-card")),
    );
    restorePanelFocus(element, focus);
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
   *  because one binding listed twice reads as two bindings. Either way the panel ends with at
   *  most `lbBindingReadRowCap` rows: the read asks for no more than the room left, and a page
   *  that still answers with more than that is cut to the cap rather than shown past it. */
  function storeBindingPage(panel, data, append) {
    const incoming = bindingVersionKey(data.runtimeEpoch, data.groupRevision);
    // Read before the envelope is copied over: this is the epoch the rows on screen came from,
    // and once it is overwritten the comparison would always be between two equal values.
    const leftRuntime = panel.runtimeEpoch !== null && panel.runtimeEpoch !== data.runtimeEpoch;
    // Also read before the envelope is copied over: once the version is overwritten, the
    // comparison would only ever be between two equal values.
    const changedGeneration = panel.version !== "" && panel.version !== incoming;
    panel.total = data.totalBindings;
    panel.hasMore = data.hasMore;
    panel.now = data.now;
    panel.nextOffset = data.nextOffset;
    panel.loaded = true;
    panel.runtimeEpoch = data.runtimeEpoch;
    panel.groupRevision = data.groupRevision;
    // Newest first: the newest submit is the one a reader has to be shown, and a binding can
    // carry several records whose ids never line up into a sequence.
    panel.operations = data.migrationOperations;
    panel.errorKey = null;
    panel.errorMessage = "";
    panel.errorDetail = "";
    if (append) {
      const held = new Set(panel.items.map(bindingAddress));
      const fresh = data.items.filter((item) => !held.has(bindingAddress(item)));
      panel.items = panel.items.concat(fresh).slice(0, lbBindingReadRowCap);
    } else {
      // The page names another runtime now, so an instruction built under the old one addressed
      // a runtime that is gone: it is retired before any row of the new list is shown. A group
      // revision that moved under the same runtime does not retire it, because the frozen
      // instruction can still be replayed and the server answers it definitively.
      if (changedGeneration) {
        // Whichever part of the generation moved, this page stopped being the page that asked.
        // A write still on its way is detached here so its answer cannot rewrite a newer page.
        detachPendingMoveWrites(panel);
      }
      if (leftRuntime) {
        retireMoveDrafts(panel);
      }
      panel.items = data.items.slice(0, lbBindingReadRowCap);
      panel.version = incoming;
    }
    // Pruning judges the drafts against the rows this answer put on the page, so it runs after
    // they are stored: run it first it would judge them against the list being replaced.
    pruneMoveDrafts(panel);
  }

  /** Forget the rows that came from another runtime epoch or another group revision, so the
   *  panel holds one consistent list again. A fresh read then starts at offset 0: the tail of
   *  the old generation is not the first page of the new one. An instruction addressed to a
   *  runtime that is gone is retired with the rows; one addressed to this same runtime under an
   *  older group revision is kept, because replaying it is still how its outcome gets settled. */
  function discardBindingGeneration(panel, data) {
    // The rows on screen are being dropped, so the page that asked for these writes is going
    // away with them: detach before anything of the old generation is cleared.
    detachPendingMoveWrites(panel);
    if (panel.runtimeEpoch !== null && panel.runtimeEpoch !== data.runtimeEpoch) {
      retireMoveDrafts(panel);
    }
    panel.items = [];
    panel.version = "";
    panel.loaded = false;
    panel.total = 0;
    panel.hasMore = false;
    panel.nextOffset = 0;
    panel.operations = [];
    panel.runtimeEpoch = null;
    panel.groupRevision = null;
  }

  // ------------------------------------------------------------ [TRI-09] the move a row can make

  /**
   * What the user has chosen for one binding, and what the server said about it. It lives on the
   * panel rather than in the DOM because the panel is rebuilt from the status poll: a choice that
   * only existed in a `<select>` would be wiped by the next refresh, and a conflict notice that
   * only existed as text would be wiped with it.
   */
  function moveDraftFor(panel, item) {
    const address = bindingAddress(item);
    const known = panel.moves.get(address);
    if (known !== undefined) return known;
    const created = {
      bindingId: item.bindingId,
      destinationTargetId: null,
      confirmed: false,
      submitting: false,
      // A result the browser cannot tell apart from one that never arrived. Only then may the
      // same key be sent again; a definite answer is never repeated with a new key.
      uncertain: false,
      noticeKey: null,
      noticeDetail: "",
      // The frozen instruction, so a retry repeats what was decided rather than whatever the
      // route and the poll look like now.
      key: null,
      payload: null,
      // The runtime epoch this draft's instruction was addressed to. It outlives the answer: a
      // later page that names a different epoch is what turns this submission's state into
      // "cannot be confirmed", because the runtime it was sent to is gone and nothing read from
      // this one can ever answer for it.
      builtEpoch: null,
      // The page moved to another runtime epoch after an instruction was built here, so what
      // that instruction reached is no longer something this list can answer. It stays as a
      // fact about the user's own submission, never as an instruction that may be sent again.
      generationRetired: false,
      // The write this draft has on its way, or null. A callback only answers into the attempt
      // that still owns the draft, so a superseded or stranded one writes nothing.
      attempt: null,
      operationId: null,
    };
    panel.moves.set(address, created);
    return created;
  }

  /**
   * The instruction a row is carrying and the user may not overwrite right now: a write on its
   * way, or a write whose outcome the browser could not tell. Either stays frozen until an
   * answer settles it, and the only thing that may send the second one again is its own retry,
   * with the same key and the same payload.
   */
  function moveDraftIsFrozen(draft) {
    return draft.submitting || (draft.uncertain && draft.payload !== null);
  }

  /** Whether the user still has something to learn from a draft: a write on its way, or a write
   *  whose outcome the browser could not tell. Dropping one of those would drop the only retry
   *  the user has, or the answer a callback is still on its way to give. */
  function moveDraftIsAwaited(draft) {
    return draft.submitting || draft.uncertain;
  }

  /**
   * Drop the instruction a draft carries: the payload, its key, the destination and the
   * confirmation. What stays is only what the user still has to be told, because a frozen
   * instruction must never be sent again under versions the page now shows.
   */
  function retireMoveIntent(draft) {
    draft.payload = null;
    draft.key = null;
    draft.builtEpoch = null;
    draft.destinationTargetId = null;
    draft.confirmed = false;
  }

  /**
   * The page moved to another runtime epoch. Every instruction the drafts carry was addressed to
   * a runtime this page no longer shows: it can never be answered for or replayed here, and a
   * binding number plus incarnation that a later runtime reuses is not the same binding. So the
   * instruction, the destination and the confirmation go with it, and what stays is the one
   * sentence the user still needs - that submission's state cannot be confirmed. Keeping the old
   * choice would offer a destination this generation never named. A write that was still on its
   * way is detached at the same moment: its callback finds nothing to write into, and the row is
   * left free to be decided over again on the runtime this page now shows.
   */
  function retireMoveDrafts(panel) {
    panel.moves.forEach((draft) => {
      // A write still on its way was addressed to the runtime this page has left. Detach it
      // here, so the callback that eventually answers finds an attempt that is no longer the
      // draft's and writes nothing, and so the row is not left frozen on an answer that can
      // never settle. A row frozen that way would block every new decision on this runtime.
      const unconfirmed = draft.attempt !== null || draft.builtEpoch !== null || draft.uncertain;
      draft.attempt = null;
      draft.submitting = false;
      retireMoveIntent(draft);
      if (unconfirmed) {
        // What the user still has to be told: that submission's state cannot be confirmed, and
        // nothing is left here that could be sent again. The row itself is open to a decision.
        draft.generationRetired = true;
        draft.uncertain = true;
      }
    });
  }

  /**
   * Stop the writes this page is waiting for, at the moment the page stops being the page that
   * asked for them: the surface was disposed, or its rows were replaced by another generation.
   * A write goes out without the surface's signal, so nobody can call it back once it is on the
   * wire - what changes here is only whose answer it may still become. The attempt is detached
   * and the draft's own flags are cleared at this point, so a callback that arrives later finds
   * an attempt that is no longer the draft's and writes nothing at all: no receipt, no retry,
   * no second send, and no read started in its name.
   *
   * What the user is told is the local answer at the moment of the detach - this page stopped
   * waiting, so the outcome of that submission is unknown - never something a late callback
   * happens to carry. The instruction stays frozen exactly as it went out, key and payload
   * both, so the row's own retry can still settle it while the runtime it was addressed to is
   * the one this page shows. A cancel's claim is dropped the same way: the operations the live
   * read carries are the current fact, so an answer nobody waits for must not leave the cancel
   * button locked for good.
   */
  function detachPendingMoveWrites(panel) {
    panel.moves.forEach((draft) => {
      if (draft.attempt === null && !draft.submitting) return;
      draft.attempt = null;
      draft.submitting = false;
      // Nothing to settle by retry once the generation it was built under is gone: that
      // sentence is `retireMoveDrafts`'s, and it already left no instruction behind.
      if (draft.generationRetired || draft.payload === null) return;
      draft.uncertain = true;
      draft.noticeKey = "lbMoveUncertainNotice";
      draft.noticeDetail = "";
    });
    panel.cancelling.clear();
  }

  /** Every panel the surface is leaving: disposal does not pick one node's list to abandon. */
  function detachAllPendingMoveWrites() {
    bindingPanels.forEach((panel) => detachPendingMoveWrites(panel));
  }

  /**
   * Forget the drafts whose binding is no longer listed here, once the rows this answer put on
   * the page are stored. An intent the user is still waiting on is kept: its outcome is either
   * unknown or still being written, and dropping it would drop the only retry it has. What is
   * kept without a row to show it on is named by the panel's own line below the rows.
   */
  function pruneMoveDrafts(panel) {
    const living = new Set(panel.items.map(bindingAddress));
    [...panel.moves].forEach(([address, draft]) => {
      if (living.has(address) || moveDraftIsAwaited(draft)) return;
      panel.moves.delete(address);
    });
  }

  /** The node names a candidate option can show, read from the card the panel sits in. */
  function lbNodeNamesForCard(card) {
    const names = new Map();
    if (card === null) return names;
    qsaOn(card, ".lb-node-state").forEach((row) => {
      const targetId = row.dataset.lbStatusTarget;
      const name = qsOn(row, ".lb-node-name");
      if (targetId === undefined || name === null) return;
      names.set(targetId, name.textContent || targetId);
    });
    return names;
  }

  /**
   * One binding's move affordance: the destination the server would accept, the warning the
   * server asked to be confirmed, and the answer the last submit gave. Everything here is the
   * server's decision shown in the server's words - the page compares nothing.
   */
  function lbBindingMoveHtml(panel, item, draft, nodeNames) {
    if (!item.movable.ok) {
      const reasons = item.movable.reasons.map((reason) =>
        lbBindingWord(reason, lbBindingVocabulary.moveReason),
      );
      return `<div class="lb-binding-tools">
      <button type="button" class="lb-binding-move" data-lb-binding-move disabled title="${escapeHtml(t("lbMoveNextRequestHint"))}">${escapeHtml(t("lbMoveBinding"))}</button>
      <span class="lb-binding-move-reasons" data-lb-binding-move-reasons>${escapeHtml(reasons.join(" · "))}</span>
    </div>`;
    }
    const chosen = draft.destinationTargetId;
    // While a write is on its way, or its outcome stayed unknown, the row is frozen: the
    // destination and the confirmation cannot be edited into a different instruction, and the
    // only control that does anything is the retry of the very same one.
    const frozen = moveDraftIsFrozen(draft);
    const options = item.movable.destinations.map((destination) => {
      const name = nodeNames.get(destination.targetId) ?? destination.targetId;
      const label = destination.eligible
        ? name
        : `${name} (${lbBindingWord(destination.reason ?? "", lbBindingVocabulary.destinationReason)})`;
      const warning =
        destination.eligible && destination.metricsUnknown ? ` ${t("lbMoveMetricsUnknown")}` : "";
      return `<option value="${escapeHtml(destination.targetId)}"${
        destination.eligible ? "" : " disabled"
      }${chosen === destination.targetId ? " selected" : ""}>${escapeHtml(`${label}${warning}`)}</option>`;
    });
    const selected = item.movable.destinations.find(
      (destination) => destination.targetId === chosen,
    );
    const needsConfirmation = selected !== undefined && selected.metricsUnknown;
    const canSubmit =
      !frozen &&
      chosen !== null &&
      selected !== undefined &&
      selected.eligible &&
      (!needsConfirmation || draft.confirmed);
    // The runtime this instruction was addressed to is gone, so what it reached is no longer
    // something the list can answer. It is named as unknown rather than kept under the word it
    // was answered with, and no retry is offered for an address that does not exist.
    const generationChanged = draft.generationRetired;
    const noticeKey = generationChanged ? "lbMoveGenerationChanged" : draft.noticeKey;
    const notice =
      noticeKey === null && draft.noticeDetail === ""
        ? ""
        : `<p class="lb-binding-move-notice" data-lb-binding-move-notice>${
            noticeKey === null ? "" : escapeHtml(t(noticeKey))
          }${
            draft.noticeDetail === ""
              ? ""
              : ` <span class="lb-binding-move-notice-detail" data-lb-binding-move-notice-detail>${escapeHtml(draft.noticeDetail)}</span>`
          }</p>`;
    const retry =
      draft.uncertain && !generationChanged && draft.payload !== null
        ? `<button type="button" class="lb-binding-move-retry" data-lb-binding-move-retry${
            draft.submitting ? " disabled" : ""
          }>${escapeHtml(t("lbMoveRetry"))}</button>`
        : "";
    return `<div class="lb-binding-tools lb-binding-move-tools">
    <label class="lb-binding-move-pick">
      <span class="lb-binding-move-pick-label">${escapeHtml(t("lbMoveChooseTarget"))}</span>
      <select class="lb-binding-move-target" data-lb-binding-move-target aria-label="${escapeHtml(t("lbMoveChooseTarget"))}"${
        frozen ? " disabled" : ""
      }>
        <option value="">${escapeHtml(t("lbMoveChooseTarget"))}</option>
        ${options.join("")}
      </select>
    </label>
    ${
      needsConfirmation
        ? `<label class="lb-binding-move-confirm"><input type="checkbox" class="lb-binding-move-confirm-input" data-lb-binding-move-confirm${draft.confirmed ? " checked" : ""}${frozen ? " disabled" : ""}><span>${escapeHtml(t("lbMoveConfirmUnknown"))}</span></label>`
        : ""
    }
    <button type="button" class="lb-binding-move" data-lb-binding-move${canSubmit ? "" : " disabled"} title="${escapeHtml(t("lbMoveNextRequestHint"))}">${escapeHtml(t("lbMoveBinding"))}</button>
    ${retry}
    ${notice}
  </div>`;
  }

  /**
   * A submission whose outcome the browser could not tell is retryable only from the row that
   * carries it. When that row is not on this page - the binding moved away, or the generation
   * the submission was addressed to is gone - the panel says so below the rows instead of
   * leaving the user with no trace of the write they made.
   */
  function lbBindingUnresolvedHtml(panel) {
    const shown = new Set(panel.items.map(bindingAddress));
    const stranded = [...panel.moves].filter(
      ([address, draft]) => draft.uncertain && !shown.has(address),
    );
    return stranded
      .map(
        ([, draft]) =>
          `<p class="lb-binding-unresolved" data-lb-binding-unresolved="${draft.bindingId}">${escapeHtml(
            `#${draft.bindingId} ${t("lbMoveUnresolvedOffPage")}`,
          )}</p>`,
      )
      .join("");
  }

  /**
   * The operation block of a panel. It sits below the rows because a binding that has been
   * applied leaves the node page it was listed on: the record of the move still has to be
   * readable there, or a pending move would look like it never finished.
   */
  function lbBindingOperationsHtml(panel) {
    if (panel.operations.length === 0) return "";
    return `<ul class="lb-binding-operations" data-lb-binding-operations>
    <li class="lb-binding-operations-title">${escapeHtml(t("lbMoveOperations"))}</li>
    ${panel.operations
      .map(
        (operation) =>
          `<li class="lb-binding-operation ${
            lbBindingVocabulary.operationStateClass[operation.state] ?? ""
          }" data-lb-binding-operation="${escapeHtml(operation.operationId)}">
        <span class="lb-binding-operation-route">${escapeHtml(
          `#${operation.bindingId} ${operation.sourceTargetId} \u2192 ${operation.destinationTargetId}`,
        )}</span>
        <span class="lb-binding-operation-state">${escapeHtml(
          lbBindingWord(operation.state, lbBindingVocabulary.operationState),
        )}</span>
        ${
          operation.cancellable
            ? `<button type="button" class="lb-binding-operation-cancel" data-lb-binding-move-cancel="${escapeHtml(operation.operationId)}"${panel.cancelling.has(operation.operationId) ? " disabled" : ""}>${escapeHtml(t("lbMoveCancel"))}</button>`
            : ""
        }
        ${
          operation.endReason === null
            ? ""
            : `<span class="lb-binding-operation-reason" data-lb-binding-operation-reason>${escapeHtml(operation.endReason)}</span>`
        }
      </li>`,
      )
      .join("")}
  </ul>${
    panel.cancelNoticeKey === null && panel.cancelNoticeDetail === ""
      ? ""
      : `<p class="lb-binding-cancel-notice" data-lb-binding-cancel-notice>${
          panel.cancelNoticeKey === null ? "" : escapeHtml(t(panel.cancelNoticeKey))
        }${
          panel.cancelNoticeDetail === ""
            ? ""
            : ` <span class="lb-binding-cancel-notice-detail" data-lb-binding-cancel-notice-detail>${escapeHtml(panel.cancelNoticeDetail)}</span>`
        }</p>`
  }`;
  }

  /**
   * One read of one node's list. Offset 0 replaces the rows and asks for as many as the user
   * already paged through, so a refresh never drops rows that are on screen; a larger offset
   * appends the next page at the server's own progress. An append asks for no more than the
   * room left under the row cap, and a panel already at the cap starts no read at all - the
   * page would only push the list past the stated limit. The server's `nextOffset` stays the
   * paging progress, so dropping a repeated row shortens the list without rewinding it.
   * A late answer is dropped: a newer read owns the panel, and its numbers are the ones the
   * user should see. A page that reports a different runtime epoch or group revision than the
   * rows already shown belongs to another generation, so those rows are dropped and the new
   * one is read from offset 0 - one restart per answer, never a loop. A cancelled read is not
   * a failed read: the panel keeps whatever it already showed, and a callback whose surface is
   * gone touches nothing.
   */
  async function readBindingPage(context, panel, offset) {
    if (lifecycle === null) return;
    const append = offset > 0;
    if (append && panel.items.length >= lbBindingReadRowCap) return;
    const limit = append
      ? Math.min(lbBindingPageRows, lbBindingReadRowCap - panel.items.length)
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
        discardBindingGeneration(panel, data);
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
   * The instruction one confirmed intent sends: built from what the list answered, never from a
   * later poll. `runtimeEpoch` and `groupRevision` come from the envelope and `incarnation` and
   * `routingRevision` from the row, because the server does not derive them - a client that
   * cannot carry them has not looked at the route it says it is changing.
   *
   * The idempotency key is made here, once, and travels with the frozen payload: a retry after a
   * result the browser could not tell apart repeats this same instruction instead of stamping a
   * newer revision onto an older key.
   */
  function buildMovePayload(context, panel, item, destinationTargetId) {
    if (panel.runtimeEpoch === null || panel.groupRevision === null) return null;
    return {
      pairId: context.pairId,
      groupId: context.groupId,
      runtimeEpoch: panel.runtimeEpoch,
      bindingId: item.bindingId,
      incarnation: item.incarnation,
      groupRevision: panel.groupRevision,
      expectedRoutingRevision: item.routingRevision,
      expectedSourceTargetId: item.targetId,
      destinationTargetId,
      idempotencyKey: crypto.randomUUID(),
    };
  }

  /** The row a control belongs to, and the item that row was rendered from. */
  function bindingRowContext(panel, element) {
    const row = closestOn(element, ".lb-binding");
    if (row === null) return null;
    const bindingId = Number(row.dataset.lbBindingId);
    const incarnation = Number(row.dataset.lbBindingIncarnation);
    const item =
      panel.items.find(
        (candidate) => candidate.bindingId === bindingId && candidate.incarnation === incarnation,
      ) ?? null;
    return item === null ? null : { row, item };
  }

  /**
   * A write is not a read: closing the panel must not be reported to the user as though the
   * server had called the intent off. So a write is sent without the surface's signal and its
   * answer is guarded instead.
   */
  /**
   * Everything one write's callback needs to decide whether its answer still belongs on the
   * page it was sent from, captured at the moment the write starts: the surface that was alive,
   * the generation the page showed, the panel and binding address the draft lives under, the
   * draft itself, and the instruction that goes out. A later edit, refresh, disposal or runtime
   * cannot change any of it, so the callback never reads a draft or a version that somebody
   * else moved on from.
   */
  function captureMoveAttempt(context, panel, item, draft, payload) {
    return {
      context,
      panel,
      panelKey: bindingPanelKey(context.pairId, context.groupId, context.targetId),
      lifecycle,
      version: panel.version,
      address: bindingAddress(item),
      item,
      draft,
      payload,
    };
  }

  /**
   * Whether an attempt still owns the page it was sent from: the same live surface, the same
   * panel object, the same generation, the same draft under the same binding address, and no
   * newer attempt that took its place. Anything else means the answer describes a page, a
   * version or an intent that is gone, so it never writes a receipt into a newer state and
   * starts no read and no second write.
   */
  function moveAttemptStillOwnsPage(attempt) {
    if (attempt.lifecycle !== lifecycle) return false;
    if (bindingPanels.get(attempt.panelKey) !== attempt.panel) return false;
    if (attempt.panel.version !== attempt.version) return false;
    if (attempt.panel.moves.get(attempt.address) !== attempt.draft) return false;
    return attempt.draft.attempt === attempt;
  }

  /**
   * What a cancel's callback has to check before it says anything: the surface it started from
   * and the generation the operations list belonged to. A page that moved to another runtime or
   * group version no longer answers about that operation, and a disposal is never reported as a
   * cancellation the server made.
   */
  function captureCancelAttempt(context, panel, operationId) {
    return {
      context,
      panel,
      panelKey: bindingPanelKey(context.pairId, context.groupId, context.targetId),
      lifecycle,
      version: panel.version,
      operationId,
    };
  }

  function cancelAttemptStillOwnsPage(attempt) {
    if (attempt.lifecycle !== lifecycle) return false;
    if (bindingPanels.get(attempt.panelKey) !== attempt.panel) return false;
    return attempt.panel.version === attempt.version;
  }

  /** @typedef {Error & { code?: string }} MoveWriteError */

  /**
   * A write's outcome, as the browser can tell it: the server answered, or nothing came back and
   * the outcome is unknown. `code` is present only when the answer carried the API's error shape,
   * which is what tells a refusal the page can name apart from a request that never arrived.
   * A write is sent without the surface's signal on purpose: closing a panel is not a cancel, and
   * a request that never arrived must not be reported as a refusal or as a cancellation.
   * @typedef {{ kind: "answered", answer: import("../../ui-contracts.js").ApiResult<"/api/load-balancer/task-moves"> }} MoveAnswered
   * @typedef {{ kind: "failed", error: MoveWriteError }} MoveFailed
   */

  /** @returns {Promise<MoveAnswered | MoveFailed>} */
  async function postMoveWrite(payload) {
    try {
      return {
        kind: "answered",
        answer: await request("/api/load-balancer/task-moves", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      };
    } catch (error) {
      return {
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /** @returns {Promise<MoveAnswered | MoveFailed>} */
  async function deleteMoveWrite(operationId) {
    try {
      return {
        kind: "answered",
        answer: await request(`/api/load-balancer/task-moves/${encodeURIComponent(operationId)}`, {
          method: "DELETE",
        }),
      };
    } catch (error) {
      return {
        kind: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Send the frozen instruction. The answer is the submit's receipt - what the server decided at
   * the moment it answered - and never the operation's current state, which the list below
   * shows. `applied` says the route changed and nothing about the upstream; `pending_boundary`
   * says nothing changed yet and the intent waits for the request boundary.
   *
   * A submit always stamps a fresh key: an outcome that stayed unknown is repeated only by the
   * retry button, with the instruction it was built under.
   */
  async function submitBindingMove(context, panel, item, draft) {
    const destination = draft.destinationTargetId;
    // A frozen row starts no new write: one already on its way must not become two, and an
    // outcome that stayed unknown is repeated only by its own retry - never by a submit that
    // stamps a newer key and newer versions onto the same intent.
    if (destination === null || moveDraftIsFrozen(draft)) return;
    const payload = buildMovePayload(context, panel, item, destination);
    if (payload === null) {
      draft.noticeKey = "lbMoveNoEnvelope";
      renderBindingPanel(context);
      return;
    }
    draft.payload = payload;
    draft.key = payload.idempotencyKey;
    draft.builtEpoch = panel.runtimeEpoch;
    draft.generationRetired = false;
    draft.submitting = true;
    draft.uncertain = false;
    draft.noticeKey = null;
    draft.noticeDetail = "";
    const attempt = captureMoveAttempt(context, panel, item, draft, payload);
    draft.attempt = attempt;
    renderBindingPanel(context);
    const outcome = await postMoveWrite(payload);
    // An answer whose page stopped waiting writes nothing at all: the detach that ended that
    // wait - a disposal, or the rows being replaced by another generation - already left the
    // row with the only honest statement and the instruction its own retry can settle. So this
    // callback may not show a receipt on a page that did not ask, clear a newer intent's flags,
    // start a read or send a second write.
    if (!moveAttemptStillOwnsPage(attempt)) return;
    if (draft.attempt === attempt) draft.attempt = null;
    if (outcome.kind === "failed") {
      applyMoveError(panel, context, item, draft, outcome.error);
    } else {
      applyMoveAnswer(draft, outcome.answer);
    }
    if (panel.readLifecycle === lifecycle) renderBindingPanel(context);
  }

  /**
   * What a receipt means on the page. `applied` says the in-memory route changed and nothing
   * else; `pending_boundary` says nothing changed yet and the intent waits for the request
   * boundary; `already_there` says no write was needed. None of them says the upstream answered,
   * and none of them is the operation's current state - that is the record list below the rows.
   */
  function applyMoveAnswer(draft, answer) {
    draft.submitting = false;
    draft.uncertain = false;
    draft.operationId = answer.operationId;
    draft.noticeKey =
      answer.state === "applied"
        ? "lbMoveAppliedNotice"
        : answer.state === "pending_boundary"
          ? "lbMovePendingNotice"
          : answer.state === "already_there"
            ? "lbMoveAlreadyThereNotice"
            : null;
    draft.noticeDetail = "";
    // The instruction was answered, so it is spent: a later submit is a new instruction with a
    // new key, never this key stamped with whatever a later poll happens to read.
    draft.payload = null;
    draft.key = null;
  }

  /**
   * A write that came back as an answer, as opposed to one whose outcome the browser cannot
   * tell. A refusal that carried the server's code is definite: the page keeps the choice the
   * user made, says what the server said, and waits for the user to submit again by hand. It
   * never picks a newer revision and sends it on its own, and it never reuses the spent key.
   */
  function applyMoveError(panel, context, item, draft, error) {
    const code = typeof error.code === "string" ? error.code : "";
    draft.submitting = false;
    if (code === "") {
      // Nothing came back at all, so whether the route moved is unknown. The same instruction
      // may be sent again under the same key; a new key would risk moving it twice.
      draft.uncertain = true;
      draft.noticeKey = "lbMoveUncertainNotice";
      draft.noticeDetail = String(error.message || error);
      return;
    }
    draft.uncertain = false;
    draft.payload = null;
    draft.key = null;
    draft.noticeKey =
      code === "binding_stale"
        ? "lbMoveConflictNotice"
        : code === "operation_expired"
          ? "lbMoveExpiredNotice"
          : null;
    draft.noticeDetail = String(error.message || error);
    if (draft.noticeKey === null && draft.noticeDetail === "") {
      draft.noticeKey = "lbMoveRejectedNotice";
    }
    // The row the user was looking at is stale by the server's own answer, so the next status
    // read replaces it and the user submits against what the list says now.
    void readBindingPage(context, panel, 0);
  }

  /**
   * Repeat the instruction whose result the browser could not tell apart, key and payload both.
   * The send uses the instruction the attempt captured, not whatever the draft holds after a
   * later edit, and the answer is only applied if the page still owns that attempt.
   */
  async function retryBindingMove(context, panel, item, draft) {
    const payload = draft.payload;
    if (payload === null || !draft.uncertain || draft.submitting) return;
    // The generation this instruction was addressed to is gone: a frozen payload must never be
    // sent again under a newer runtime epoch or group revision.
    if (draft.generationRetired) return;
    draft.submitting = true;
    const attempt = captureMoveAttempt(context, panel, item, draft, payload);
    draft.attempt = attempt;
    renderBindingPanel(context);
    const outcome = await postMoveWrite(attempt.payload);
    // Guarded exactly like the submit: an answer that no longer owns the page this retry was
    // sent from writes nothing, starts nothing and unfreezes nothing.
    if (!moveAttemptStillOwnsPage(attempt)) return;
    if (draft.attempt === attempt) draft.attempt = null;
    if (outcome.kind === "failed") {
      applyMoveError(panel, context, item, draft, outcome.error);
    } else {
      applyMoveAnswer(draft, outcome.answer);
    }
    if (panel.readLifecycle === lifecycle) renderBindingPanel(context);
  }

  /**
   * Call off an intent that has not been applied. Only a record the server said is cancellable
   * carries this button, and a route that already moved answers `operation_already_applied`
   * rather than pretending the write never happened - the sentence then points at a move back.
   */
  async function cancelBindingMove(context, panel, operationId) {
    if (panel.cancelling.has(operationId)) return;
    const attempt = captureCancelAttempt(context, panel, operationId);
    panel.cancelling.set(operationId, attempt);
    renderBindingPanel(context);
    const outcome = await deleteMoveWrite(attempt.operationId);
    // A claim is released only by the attempt that holds it. An obsolete callback must not
    // unlock a cancel a newer generation is making for the same operation.
    if (panel.cancelling.get(operationId) === attempt) panel.cancelling.delete(operationId);
    if (!cancelAttemptStillOwnsPage(attempt)) return;
    if (outcome.kind === "failed") {
      // A refusal that carried the API's code is the server's own sentence, which is not the
      // console's to translate. One that carried no code leaves the browser unable to tell how
      // this cancel ended: nothing here proves the request did or did not arrive, so the
      // operation's state stays unknown and is never reported as a cancellation.
      panel.cancelNoticeKey =
        typeof outcome.error.code === "string" ? null : "lbMoveCancelUnknownOutcome";
      panel.cancelNoticeDetail = String(outcome.error.message || outcome.error);
      renderBindingPanel(context);
      return;
    }
    panel.cancelNoticeKey = outcome.answer.state === "cancelled" ? "lbMoveCancelledNotice" : null;
    panel.cancelNoticeDetail = "";
    renderBindingPanel(context);
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
    const moveRow = closestFrom(event.target, ".lb-binding");
    const movePanelElement = moveRow === null ? null : closestOn(moveRow, ".lb-binding-panel");
    const moveContext =
      movePanelElement === null ? null : bindingContextFromElement(movePanelElement);
    if (moveContext !== null) {
      const panel = bindingPanelFor(moveContext.pairId, moveContext.groupId, moveContext.targetId);
      const row = bindingRowContext(panel, asElement(event.target));
      if (row !== null) {
        const draft = moveDraftFor(panel, row.item);
        if (asElement(event.target)?.matches("[data-lb-binding-move]")) {
          // One intent is in flight at a time, so a double click cannot become two writes, and a
          // dispatch that reaches this button while an outcome is unknown sends nothing: the
          // only way to repeat that instruction is its own retry, key and payload included.
          if (!moveDraftIsFrozen(draft) && !controlIsDisabled(event.target)) {
            void submitBindingMove(moveContext, panel, row.item, draft);
          }
          return true;
        }
        if (asElement(event.target)?.matches("[data-lb-binding-move-retry]")) {
          // A retry repeats one instruction, so it is guarded the same way: no second send while
          // one is on its way, and none at all once the generation it was built under is gone.
          if (
            !draft.submitting &&
            draft.uncertain &&
            draft.payload !== null &&
            !draft.generationRetired &&
            !controlIsDisabled(event.target)
          ) {
            void retryBindingMove(moveContext, panel, row.item, draft);
          }
          return true;
        }
      }
    }
    const cancelButton = closestFrom(event.target, "[data-lb-binding-move-cancel]");
    if (cancelButton !== null) {
      const cancelPanelElement = closestOn(cancelButton, ".lb-binding-panel");
      const cancelContext =
        cancelPanelElement === null ? null : bindingContextFromElement(cancelPanelElement);
      const operationId = asElement(cancelButton)?.dataset.lbBindingMoveCancel;
      if (cancelContext !== null && operationId !== undefined) {
        void cancelBindingMove(
          cancelContext,
          bindingPanelFor(cancelContext.pairId, cancelContext.groupId, cancelContext.targetId),
          operationId,
        );
        return true;
      }
    }
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

    listen(document, "change", (event) => {
      const control = asElement(event.target);
      if (control === null) return;
      const panelElement = closestOn(control, ".lb-binding-panel");
      if (panelElement === null) return;
      const context = bindingContextFromElement(panelElement);
      if (context === null) return;
      const panel = bindingPanelFor(context.pairId, context.groupId, context.targetId);
      const row = bindingRowContext(panel, control);
      if (row === null) return;
      const draft = moveDraftFor(panel, row.item);
      // A frozen row takes no edits: the destination and the confirmation of an instruction that
      // is still on its way, or whose outcome stayed unknown, cannot be rewritten into a new one.
      // The panel is rebuilt instead, so what the control shows is the frozen choice again.
      if (moveDraftIsFrozen(draft)) {
        renderBindingPanel(context);
        return;
      }
      if (control.dataset.lbBindingMoveTarget !== undefined) {
        const chosen = control instanceof HTMLSelectElement ? control.value : "";
        draft.destinationTargetId = chosen === "" ? null : chosen;
        // A different destination is a different instruction: its key is made again, and a
        // warning that was confirmed for the old one is not carried over to the new.
        draft.confirmed = false;
        draft.key = null;
        draft.payload = null;
        draft.uncertain = false;
        draft.noticeKey = null;
        draft.noticeDetail = "";
      } else if (control.dataset.lbBindingMoveConfirm !== undefined) {
        draft.confirmed = control instanceof HTMLInputElement && control.checked;
      } else {
        return;
      }
      renderBindingPanel(context);
    });
    listen(document, "visibilitychange", updatePolling);
    updatePolling();
  }

  /** Whether the browser already sees this control as unclickable. */
  function controlIsDisabled(candidate) {
    return asElement(candidate) instanceof HTMLButtonElement && candidate.disabled;
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
    // A write keeps travelling after disposal because it was sent without the surface's signal.
    // What disposal ends is the right to answer into the page, so the attempts still on their
    // way are detached here: the row is left with the honest local state - this surface stopped
    // waiting, so the outcome of that submission is unknown - plus the frozen instruction its
    // own retry can still settle. A callback that arrives later, into a lifecycle built after
    // this one, finds an attempt that is no longer the draft's and writes nothing.
    detachAllPendingMoveWrites();
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
