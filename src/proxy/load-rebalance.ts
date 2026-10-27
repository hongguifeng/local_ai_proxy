import type { LoadBalancerRebalanceMode } from "../config/index.js";

import { createRequestId } from "../shared/index.js";

import type { BindingActivity, BindingCostSource } from "./binding-activity.js";
import type { EngineLoadView } from "./load-evidence.js";
import type { LoadBalancerMoveGates } from "./load-balancer.js";
import type { BindingRef } from "./load-migration-contract.js";

/**
 * The pure half of automatic rebalancing (TRI-10): what an imbalance is, which binding may
 * be moved where, and what becomes of a suggestion. Nothing here reaches the network or the
 * database. Every input is a value the request path and the monitor already measured, and
 * the advisor writes only its own in-memory state - it never calls `moveBinding()`, never
 * touches a target and never opens a connection. The monitor hands it a snapshot each tick;
 * stopping the monitor drops the advisor's state with it.
 *
 * The safe-degradation contract this module exists to enforce:
 *
 * - `off` computes nothing (the monitor never even calls `tick` for it).
 * - `advise` computes suggestions and changes no binding.
 * - `auto`, until TRI-11's real-engine calibration exists, behaves exactly like `advise` and
 *   reports `disabledReason: "not_calibrated"`. It never moves a binding on its own.
 *
 * Suggestions carry ids, targets, revisions and numbers - never a request body, an exact
 * key, a session id, a user message hash or an upstream key.
 */

/** The three modes a group's configuration may name. */
export type RebalanceMode = LoadBalancerRebalanceMode;

/** The only suggestion states TRI-10 can produce. `applied`/`observed` belong to TRI-12. */
export type RebalanceSuggestionState = "suggested" | "unused" | "rejected" | "expired";

/** Why a suggestion was refused by advisor policy before it was ever created. */
export type RebalanceRejectionReason =
  | "binding_cooldown"
  | "episode_live"
  | "group_budget"
  | "anti_flap"
  | "destination_commitment"
  | "store_full";

/** Why a suggestion that existed stopped being valid. */
export type RebalanceExpiryReason =
  | "runtime_changed"
  | "group_changed"
  | "binding_gone"
  | "route_changed"
  | "state_risk"
  | "target_unavailable"
  | "target_busy"
  | "source_metrics_lost"
  | "destination_metrics_lost";

/** Why a suggestion aged out without anything acting on it. */
export type RebalanceUnusedReason = "no_action_permitted" | "no_next_request";

/** Every reason a terminal suggestion can name, in one closed union. */
export type RebalanceSuggestionReason =
  RebalanceRejectionReason | RebalanceExpiryReason | RebalanceUnusedReason;

/**
 * Whether the automatic mode is calibrated. This is the only switch that lets `auto` mean
 * more than `advise`, and TRI-10 must leave it false: the sole authority to change it is a
 * real-engine three-arm control experiment (no-migration baseline, manual safe-boundary
 * move, automatic policy) recorded under `docs/reports/` and accepted in the plan's TRI-11
 * completion record. Code review, unit tests or synthetic fixtures cannot change it. When
 * TRI-12 lands execution, this flag becomes the gate that record sets - nothing else.
 */
export const AUTO_REBALANCE_CALIBRATED = false;

/** What the status API says when a group asks for `auto` without calibration. */
export const AUTO_NOT_CALIBRATED = "not_calibrated" as const;

/**
 * The named parameters the advisor runs on. They are calibration targets, not product
 * constants: every value below is an uncalibrated observation default used only while the
 * mode is `advise` (or `auto` degraded to advise). They deliberately do NOT derive from the
 * existing 5 s sampling interval, the 15 s fresh window or the 0.9 KV tier threshold; the
 * one exception this module allows itself is the retention window, which mirrors the
 * migration store's existing "how long a record is worth keeping" value (15 minutes,
 * `MIGRATION_RETENTION_MS`) because that is a retention pattern, not a load threshold.
 * TRI-11 must replace these numbers with measured ones before `AUTO_REBALANCE_CALIBRATED`
 * may become true; until then the status API reports `calibrated: false` beside every
 * suggestion, and none of these may be treated as auto execution thresholds.
 */
export interface RebalancePolicy {
  /** Only a queue the engine itself reported counts; "high concurrency" stays uncalibrated. */
  readonly sourceBusyWaitingMin: number;
  /** How many distinct sample sequences the same source/target combination must hold before it counts. */
  readonly stabilitySamplesMin: number;
  /** How long ago a binding's last request start may be for it to still look active. */
  readonly candidateActivityWindowMs: number;
  /** How long a binding must wait after one suggestion before it may be suggested again. */
  readonly bindingSuggestionCooldownMs: number;
  /** How long an A→B suggestion blocks an automatic B→A suggestion for the same binding. */
  readonly antiFlapBlockedMs: number;
  /** How many suggestions a group may create inside one budget window. */
  readonly groupSuggestionBudget: number;
  /** The budget window. */
  readonly budgetWindowMs: number;
  /** How many live suggestions may point at one destination target at the same time. */
  readonly destinationCommitmentCap: number;
  /** How long a terminal suggestion stays readable before it is dropped. */
  readonly suggestionRetentionMs: number;
  /** Hard cap on stored suggestions per group. */
  readonly maxSuggestionsPerGroup: number;
}

/**
 * The advisor's observation defaults. Uncalibrated: these numbers describe what "advise"
 * looks for while nobody has measured what an automatic move is actually worth. They are
 * handed to every evaluation because TRI-10's acceptance is that a user can see what an
 * automatic policy *would* choose - and the only honest way to show that before calibration
 * is to label the parameters and let the status API report `calibrated: false` beside them.
 * None of these may be treated as auto execution thresholds.
 */
export const ADVISE_OBSERVATION_POLICY: RebalancePolicy = {
  antiFlapBlockedMs: 1_800_000,
  bindingSuggestionCooldownMs: 600_000,
  budgetWindowMs: 600_000,
  candidateActivityWindowMs: 900_000,
  destinationCommitmentCap: 2,
  groupSuggestionBudget: 4,
  maxSuggestionsPerGroup: 128,
  sourceBusyWaitingMin: 1,
  stabilitySamplesMin: 2,
  suggestionRetentionMs: 15 * 60_000,
};

/** What an evaluation needs about one binding, as data, not as a live object. */
export interface RebalanceBindingCandidate {
  readonly ref: BindingRef;
  readonly targetId: string;
  readonly activity: BindingActivity;
  /** The write gate's own answer for this binding, computed by the balancer, not by this module. */
  readonly gates: LoadBalancerMoveGates;
}

/** One evaluation's whole input. Every field is already-measured, in-memory data. */
export interface RebalanceTickInput {
  readonly groupId: string;
  readonly groupRevision: number | undefined;
  readonly now: number;
  readonly policy: RebalancePolicy;
  readonly runtimeEpoch: string;
  readonly memberOrder: readonly string[];
  /** Group members only: two spellings of one engine are one node here. */
  readonly engineViews: readonly EngineLoadView[];
  readonly targetInFlight: ReadonlyMap<string, number>;
  readonly candidates: readonly RebalanceBindingCandidate[];
}

/** One suggestion, with the reasons that explain it. */
export interface RebalanceSuggestion {
  readonly suggestionId: string;
  readonly groupId: string;
  readonly bindingId: number;
  readonly incarnation: number;
  readonly routingRevision: number;
  readonly runtimeEpoch: string;
  readonly groupRevision: number | undefined;
  readonly sourceTargetId: string;
  readonly destinationTargetId: string;
  readonly createdAt: number;
  /** How many distinct sample sequences held the imbalance when this was created. */
  readonly stableSamples: number;
  readonly costSource: BindingCostSource;
  readonly inputTokens: number | undefined;
  readonly requestBytes: number | undefined;
  /** True when the cost number is a body size standing in for tokens, never a token claim. */
  readonly costEstimated: boolean;
  state: RebalanceSuggestionState;
  stateReason: RebalanceSuggestionReason | undefined;
  /** Set when the binding started a new request after this suggestion was made. */
  sawNewRequest: boolean;
  terminalAt: number | undefined;
}

/** What the status API reads for one suggestion. Sanitised: ids, targets, numbers, reasons. */
export interface RebalanceSuggestionView {
  readonly bindingId: number;
  readonly costEstimated: boolean;
  readonly costSource: BindingCostSource;
  readonly createdAt: number;
  readonly destinationTargetId: string;
  readonly incarnation: number;
  readonly inputTokens: number | null;
  readonly requestBytes: number | null;
  readonly routingRevision: number;
  readonly sourceTargetId: string;
  readonly stableSamples: number;
  readonly state: RebalanceSuggestionState;
  readonly stateReason: RebalanceSuggestionReason | null;
  readonly suggestionId: string;
}

export interface RebalanceGroupView {
  readonly calibrated: boolean;
  readonly disabledReason: typeof AUTO_NOT_CALIBRATED | null;
  readonly groupId: string;
  readonly mode: RebalanceMode;
  readonly suggestions: readonly RebalanceSuggestionView[];
}

/** What one tick did, so the monitor can log what appeared or went away. */
export interface RebalanceTickResult {
  readonly created: readonly RebalanceSuggestion[];
  readonly expired: readonly RebalanceSuggestion[];
  readonly rejected: readonly RebalanceSuggestion[];
}

const STABILITY_KEY_SEPARATOR = "\u0000>";

function stabilityKey(sourceKey: string, destinationKey: string): string {
  return `${sourceKey}${STABILITY_KEY_SEPARATOR}${destinationKey}`;
}

function costOf(activity: BindingActivity): number {
  const usage = activity.lastUsage;
  if (usage?.inputTokens !== undefined) {
    return usage.inputTokens;
  }
  return activity.lastRequestBytes ?? Number.MAX_SAFE_INTEGER;
}

/** A cost number is "estimated" whenever tokens never proved it. */
function costEstimated(activity: BindingActivity): boolean {
  return activity.lastUsage?.inputTokens === undefined;
}

function toView(suggestion: RebalanceSuggestion): RebalanceSuggestionView {
  return {
    bindingId: suggestion.bindingId,
    costEstimated: suggestion.costEstimated,
    costSource: suggestion.costSource,
    createdAt: suggestion.createdAt,
    destinationTargetId: suggestion.destinationTargetId,
    incarnation: suggestion.incarnation,
    inputTokens: suggestion.inputTokens ?? null,
    requestBytes: suggestion.requestBytes ?? null,
    routingRevision: suggestion.routingRevision,
    sourceTargetId: suggestion.sourceTargetId,
    stableSamples: suggestion.stableSamples,
    state: suggestion.state,
    stateReason: suggestion.stateReason ?? null,
    suggestionId: suggestion.suggestionId,
  };
}

/**
 * The advisor keeps one state map per group it has been asked about. It is a pure in-memory
 * object: no timers of its own (the monitor's tick drives it), no balancer reference (the
 * gates arrive as data), no logger use beyond what the monitor already owns.
 */
export class RebalanceAdvisor {
  readonly #stability = new Map<string, Map<string, { countedSequence: number; stable: number }>>();
  readonly #suggestions = new Map<string, Map<string, RebalanceSuggestion>>();
  readonly #lastSuggestedAt = new Map<string, Map<number, number>>();
  /** Direction memory per group: binding incarnation -> "srcKey>dstKey" -> moment. */
  readonly #directions = new Map<string, Map<number, Map<string, number>>>();
  readonly #budgetMoments = new Map<string, number[]>();

  /** Forget everything. The monitor calls this when a pair stops. */
  clear(): void {
    this.#stability.clear();
    this.#suggestions.clear();
    this.#lastSuggestedAt.clear();
    this.#directions.clear();
    this.#budgetMoments.clear();
  }

  /** A group turned `off`, left the configuration or lost its runtime: drop its state. */
  dropGroup(groupId: string): void {
    this.#stability.delete(groupId);
    this.#suggestions.delete(groupId);
    this.#lastSuggestedAt.delete(groupId);
    this.#directions.delete(groupId);
    this.#budgetMoments.delete(groupId);
  }

  viewFor(groupId: string, mode: RebalanceMode): RebalanceGroupView {
    const stored = this.#suggestions.get(groupId);
    // Newest first, the same reading order the migration records use.
    const views = stored === undefined ? [] : [...stored.values()].map(toView).reverse();
    return {
      calibrated: AUTO_REBALANCE_CALIBRATED,
      disabledReason: mode === "auto" ? AUTO_NOT_CALIBRATED : null,
      groupId,
      mode,
      suggestions: views,
    };
  }

  /**
   * One tick for one group. The mode decides what happens before this call: `off` never
   * reaches it (the monitor skips those groups), `advise` and uncalibrated `auto` evaluate
   * identically here and neither writes a routing change - this object has no way to write
   * one. Everything it touches is its own state plus the input snapshot.
   */
  tick(input: RebalanceTickInput): RebalanceTickResult {
    const { groupId, now, policy } = input;
    const created: RebalanceSuggestion[] = [];
    const expired: RebalanceSuggestion[] = [];
    const rejected: RebalanceSuggestion[] = [];

    this.#pruneTerminal(groupId, policy, now);
    this.#advanceLifecycle(input, expired);

    if (input.engineViews.length < 2) {
      // Design 7.2 rule 1: one physical engine has nowhere to move to.
      this.#stability.delete(groupId);
      return { created, expired, rejected };
    }

    const busySources = new Map<string, EngineLoadView>();
    const idleDestinations = new Map<string, EngineLoadView>();
    for (const view of input.engineViews) {
      const assessment = view.assessment;
      if (!assessment.usableForLoadJudgement) {
        continue;
      }
      if (assessment.waiting !== undefined && assessment.waiting >= policy.sourceBusyWaitingMin) {
        busySources.set(view.canonicalKey, view);
      }
      const idleNumbers =
        assessment.running === 0 &&
        assessment.waiting === 0 &&
        view.targets.every((target) => (input.targetInFlight.get(target.targetId) ?? 0) === 0);
      if (idleNumbers) {
        idleDestinations.set(view.canonicalKey, view);
      }
    }

    // Rule 5: only a new read of the source engine can advance stability, and only while
    // the same source/target combination still holds. Re-reading the same sample sequence
    // adds no evidence, so a stuck engine cannot fake a stable imbalance.
    const stability = this.#stability.get(groupId) ?? new Map<string, StabilityState>();
    this.#stability.set(groupId, stability);
    const heldCombinations = new Map<string, StabilityObservation>();
    for (const [sourceKey, source] of busySources) {
      for (const [destinationKey, destination] of idleDestinations) {
        if (destinationKey === sourceKey) {
          continue;
        }
        heldCombinations.set(stabilityKey(sourceKey, destinationKey), {
          source,
          destination,
        });
      }
    }
    for (const key of [...stability.keys()]) {
      if (!heldCombinations.has(key)) {
        stability.delete(key);
      }
    }
    for (const [key, pair] of heldCombinations) {
      const sequence = pair.source.assessment.sampleSequence;
      const state = stability.get(key) ?? { countedSequence: -1, stable: 0 };
      if (sequence !== undefined && sequence > state.countedSequence) {
        state.countedSequence = sequence;
        state.stable += 1;
        stability.set(key, state);
      }
    }

    const budgetMoments = (this.#budgetMoments.get(groupId) ?? []).filter(
      (moment) => now - moment < policy.budgetWindowMs,
    );
    this.#budgetMoments.set(groupId, budgetMoments);

    for (const [key, state] of stability) {
      if (state.stable < policy.stabilitySamplesMin) {
        continue;
      }
      const pair = heldCombinations.get(key);
      if (pair === undefined) {
        continue;
      }
      const eligible = input.candidates.filter(
        (candidate) =>
          pair.source.targetIds.includes(candidate.targetId) &&
          this.#passesSafetyGates(candidate, pair.destination, input),
      );
      const ranked = this.#rank(eligible, input.memberOrder, now);
      for (const candidate of ranked) {
        const destinationTargetId = this.#pickDestination(candidate, pair.destination, input);
        const refusal = this.#policyRefusal(candidate, destinationTargetId, input, now);
        if (refusal !== undefined) {
          const outcome = this.#recordRejection(
            groupId,
            candidate,
            destinationTargetId ?? destinationTargetOf(pair.destination, candidate),
            refusal,
            input,
            now,
            rejected,
            state.stable,
          );
          if (outcome.status === "no_room") {
            break;
          }
          continue;
        }
        if (destinationTargetId === undefined) {
          continue;
        }
        const suggestion = this.#createSuggestion(
          groupId,
          candidate,
          destinationTargetId,
          input,
          now,
          state.stable,
        );
        if (suggestion === undefined) {
          this.#recordRejection(
            groupId,
            candidate,
            destinationTargetId,
            "store_full",
            input,
            now,
            rejected,
            state.stable,
          );
          break;
        }
        budgetMoments.push(now);
        created.push(suggestion);
        // One suggestion per stable combination per tick: an episode should not stack
        // several moves onto the same imbalance at once.
        break;
      }
      if (created.length > 0) {
        // A group gets at most one new suggestion per tick. The budget is measured across
        // sampling ticks; a burst across this tick's combinations would defeat it.
        break;
      }
    }

    return { created, expired, rejected };
  }

  // ------------------------------------------------------------------ candidate safety

  /**
   * The safety list of design 7.3, judged only from data already measured: zero in flight,
   * real recent activity, a cost signal with a real source, no manual protection, and the
   * write gate's own answer for state risk, model compatibility, cooldown, sleep, disable
   * and physical-key sameness. The gate codes are the balancer's decision - this module
   * reads it and never re-derives it.
   */
  #passesSafetyGates(
    candidate: RebalanceBindingCandidate,
    destination: EngineLoadView,
    input: RebalanceTickInput,
  ): boolean {
    const activity = candidate.activity;
    if (activity.inFlight !== 0 || activity.manualProtection !== undefined) {
      return false;
    }
    const started = activity.lastRequestStartedAt;
    if (started === undefined || input.now - started > input.policy.candidateActivityWindowMs) {
      return false;
    }
    // Cost must have a real source. `none` means the ledger has no evidence at all, and
    // without TRI-11 nobody knows how much "context unknown" is safe to move.
    const usage = activity.lastUsage;
    if (usage === undefined || usage.costSource === "none") {
      return false;
    }
    if (candidate.gates.blocking.length > 0) {
      return false;
    }
    const eligibleDestination = candidate.gates.destinations.find(
      (entry) =>
        destination.targetIds.includes(entry.targetId) &&
        entry.eligible &&
        entry.code === undefined,
    );
    if (eligibleDestination === undefined) {
      return false;
    }
    return (input.targetInFlight.get(eligibleDestination.targetId) ?? 0) === 0;
  }

  /**
   * Design 7.3's order: reliable cost signal ascending (a body size standing in for tokens
   * is labelled `costEstimated`, never claimed as tokens), then recent multi-turn activity,
   * then the binding that has waited longest since its last request, then configuration
   * order, then the binding number for determinism.
   */
  #rank(
    eligible: readonly RebalanceBindingCandidate[],
    memberOrder: readonly string[],
    now: number,
  ): RebalanceBindingCandidate[] {
    const orderOf = (targetId: string): number => {
      const index = memberOrder.indexOf(targetId);
      return index === -1 ? memberOrder.length : index;
    };
    return [...eligible].sort((left, right) => {
      const leftCost = costOf(left.activity);
      const rightCost = costOf(right.activity);
      if (leftCost !== rightCost) {
        return leftCost - rightCost;
      }
      const turns =
        right.activity.recentRequestStarts.length - left.activity.recentRequestStarts.length;
      if (turns !== 0) {
        return turns;
      }
      // "A while since it last started a request": the quieter candidate goes first, so a
      // move waits on a likely next request instead of cutting in front of one arriving now.
      const leftWait = now - (left.activity.lastRequestStartedAt ?? now);
      const rightWait = now - (right.activity.lastRequestStartedAt ?? now);
      if (leftWait !== rightWait) {
        return rightWait - leftWait;
      }
      const byTarget = orderOf(left.targetId) - orderOf(right.targetId);
      if (byTarget !== 0) {
        return byTarget;
      }
      return left.ref.bindingId - right.ref.bindingId;
    });
  }

  // ------------------------------------------------------------------ lifecycle

  #advanceLifecycle(input: RebalanceTickInput, expired: RebalanceSuggestion[]): void {
    const stored = this.#suggestions.get(input.groupId);
    if (stored === undefined) {
      return;
    }
    const byBinding = new Map<number, RebalanceBindingCandidate>();
    for (const candidate of input.candidates) {
      byBinding.set(candidate.ref.bindingId, candidate);
    }
    for (const suggestion of stored.values()) {
      if (suggestion.state !== "suggested") {
        continue;
      }
      const reason = this.#expiryReason(suggestion, input, byBinding);
      if (reason !== undefined) {
        this.#terminal(suggestion, "expired", reason, input.now);
        expired.push(suggestion);
        continue;
      }
      const candidate = byBinding.get(suggestion.bindingId);
      const started = candidate?.activity.lastRequestStartedAt;
      if (started !== undefined && started > suggestion.createdAt) {
        suggestion.sawNewRequest = true;
      }
    }
  }

  #expiryReason(
    suggestion: RebalanceSuggestion,
    input: RebalanceTickInput,
    byBinding: ReadonlyMap<number, RebalanceBindingCandidate>,
  ): RebalanceExpiryReason | undefined {
    if (suggestion.runtimeEpoch !== input.runtimeEpoch) {
      return "runtime_changed";
    }
    if (suggestion.groupRevision !== input.groupRevision) {
      return "group_changed";
    }
    const candidate = byBinding.get(suggestion.bindingId);
    if (candidate === undefined) {
      return "binding_gone";
    }
    if (
      candidate.ref.incarnation !== suggestion.incarnation ||
      candidate.ref.routingRevision !== suggestion.routingRevision ||
      candidate.targetId !== suggestion.sourceTargetId
    ) {
      // The binding under this suggestion is not the one the suggestion was made about, or
      // something else already moved it. Either way the premise is gone.
      return "route_changed";
    }
    if (candidate.gates.blocking.length > 0) {
      return "state_risk";
    }
    const sourceView = this.#viewForTarget(input.engineViews, suggestion.sourceTargetId);
    if (!sourceView?.assessment.usableForLoadJudgement) {
      return "source_metrics_lost";
    }
    const destinationView = this.#viewForTarget(input.engineViews, suggestion.destinationTargetId);
    if (!destinationView?.assessment.usableForLoadJudgement) {
      // Which side lost its evidence matters: a source that stopped answering says the
      // imbalance may have gone away, while a quiet destination that stopped answering only
      // says nobody knows it is still quiet. Naming both "source" would misreport the second.
      return "destination_metrics_lost";
    }
    const destinationGate = candidate.gates.destinations.find(
      (entry) => entry.targetId === suggestion.destinationTargetId,
    );
    if (!destinationGate?.eligible) {
      return "target_unavailable";
    }
    const stillIdle =
      destinationView.assessment.running === 0 &&
      destinationView.assessment.waiting === 0 &&
      (input.targetInFlight.get(suggestion.destinationTargetId) ?? 0) === 0;
    return stillIdle ? undefined : "target_busy";
  }

  #viewForTarget(views: readonly EngineLoadView[], targetId: string): EngineLoadView | undefined {
    return views.find((view) => view.targetIds.includes(targetId));
  }

  /**
   * Terminal is terminal: once a suggestion reads unused, rejected or expired, no later tick
   * rewrites it - the same one-way discipline the migration state machine keeps.
   */
  #terminal(
    suggestion: RebalanceSuggestion,
    state: RebalanceSuggestionState,
    reason: RebalanceSuggestionReason,
    now: number,
  ): void {
    if (suggestion.terminalAt !== undefined) {
      return;
    }
    suggestion.state = state;
    suggestion.stateReason = reason;
    suggestion.terminalAt = now;
  }

  #pruneTerminal(groupId: string, policy: RebalancePolicy, now: number): void {
    const stored = this.#suggestions.get(groupId);
    if (stored === undefined) {
      return;
    }
    for (const [id, suggestion] of [...stored]) {
      if (
        suggestion.terminalAt !== undefined &&
        now - suggestion.terminalAt >= policy.suggestionRetentionMs
      ) {
        stored.delete(id);
      }
    }
    // A live suggestion that simply aged out was never acted on: under advise (and under
    // auto degraded to advise) that is the honest answer, with the sub-reason telling
    // whether the binding even had another request while it waited.
    for (const suggestion of stored.values()) {
      if (
        suggestion.state === "suggested" &&
        now - suggestion.createdAt >= policy.suggestionRetentionMs
      ) {
        this.#terminal(
          suggestion,
          "unused",
          suggestion.sawNewRequest ? "no_action_permitted" : "no_next_request",
          now,
        );
      }
    }
  }

  // ------------------------------------------------------------------ policy refusals

  #policyRefusal(
    candidate: RebalanceBindingCandidate,
    destinationTargetId: string | undefined,
    input: RebalanceTickInput,
    now: number,
  ): RebalanceRejectionReason | undefined {
    const policy = input.policy;
    const groupId = input.groupId;
    const stored = this.#suggestions.get(groupId);
    if (this.#liveBindingKeys(groupId).has(candidate.ref.incarnation)) {
      return "episode_live";
    }
    const lastAt = this.#lastSuggestedAt.get(groupId)?.get(candidate.ref.incarnation);
    if (lastAt !== undefined && now - lastAt < policy.bindingSuggestionCooldownMs) {
      return "binding_cooldown";
    }
    if ((this.#budgetMoments.get(groupId) ?? []).length >= policy.groupSuggestionBudget) {
      return "group_budget";
    }
    if (destinationTargetId !== undefined) {
      const liveToDestination = [...(stored?.values() ?? [])].filter(
        (suggestion) =>
          suggestion.state === "suggested" &&
          suggestion.destinationTargetId === destinationTargetId,
      ).length;
      if (liveToDestination >= policy.destinationCommitmentCap) {
        return "destination_commitment";
      }
    }
    const sourceKey = this.#canonicalKeyOf(input.engineViews, candidate.targetId);
    if (destinationTargetId !== undefined && sourceKey !== undefined) {
      const destinationKey = this.#canonicalKeyOf(input.engineViews, destinationTargetId);
      const directions = this.#directions.get(groupId)?.get(candidate.ref.incarnation);
      if (directions !== undefined && destinationKey !== undefined) {
        // Design 7.5: after an A→B suggestion, an automatic B→A for the same binding is
        // blocked until the anti-flap window passed. The recorded direction is the
        // reverse of what this tick would create.
        const moment = directions.get(stabilityKey(destinationKey, sourceKey));
        if (moment !== undefined && now - moment < policy.antiFlapBlockedMs) {
          return "anti_flap";
        }
      }
    }
    if (
      stored !== undefined &&
      stored.size >= policy.maxSuggestionsPerGroup &&
      this.#oldestTerminal(stored) === undefined
    ) {
      // Only a store of nothing but live suggestions is truly full: a terminal record
      // would simply be dropped to make room.
      return "store_full";
    }
    return undefined;
  }

  #recordRejection(
    groupId: string,
    candidate: RebalanceBindingCandidate,
    destinationTargetId: string,
    reason: RebalanceRejectionReason,
    input: RebalanceTickInput,
    now: number,
    sink: RebalanceSuggestion[],
    stableSamples: number,
  ): { status: "recorded" | "deduped" | "no_room"; record: RebalanceSuggestion | undefined } {
    const stored = this.#suggestions.get(groupId) ?? new Map<string, RebalanceSuggestion>();
    this.#suggestions.set(groupId, stored);
    if (stored.size >= input.policy.maxSuggestionsPerGroup) {
      // No room to remember even this refusal: drop the oldest terminal record first. When
      // everything stored is still live, the refusal is not remembered at all.
      const oldestTerminal = this.#oldestTerminal(stored);
      if (oldestTerminal === undefined) {
        return { record: undefined, status: "no_room" };
      }
      stored.delete(oldestTerminal.suggestionId);
    }
    const already = [...stored.values()].some(
      (existing) =>
        existing.state === "rejected" &&
        existing.bindingId === candidate.ref.bindingId &&
        existing.incarnation === candidate.ref.incarnation &&
        existing.destinationTargetId === destinationTargetId &&
        existing.stateReason === reason &&
        existing.terminalAt !== undefined &&
        now - existing.terminalAt < input.policy.suggestionRetentionMs,
    );
    if (already) {
      return { record: undefined, status: "deduped" };
    }
    const record: RebalanceSuggestion = {
      bindingId: candidate.ref.bindingId,
      costEstimated: costEstimated(candidate.activity),
      costSource: candidate.activity.lastUsage?.costSource ?? "none",
      createdAt: now,
      destinationTargetId,
      groupId,
      incarnation: candidate.ref.incarnation,
      inputTokens: candidate.activity.lastUsage?.inputTokens,
      requestBytes: candidate.activity.lastRequestBytes,
      groupRevision: input.groupRevision,
      routingRevision: candidate.ref.routingRevision,
      runtimeEpoch: input.runtimeEpoch,
      sawNewRequest: false,
      sourceTargetId: candidate.targetId,
      stableSamples,
      state: "rejected",
      stateReason: reason,
      suggestionId: createRequestId(),
      terminalAt: now,
    };
    stored.set(record.suggestionId, record);
    sink.push(record);
    return { record, status: "recorded" };
  }

  #oldestTerminal(store: Map<string, RebalanceSuggestion>): RebalanceSuggestion | undefined {
    let oldest: RebalanceSuggestion | undefined;
    for (const suggestion of store.values()) {
      if (suggestion.terminalAt === undefined) {
        continue;
      }
      if (oldest === undefined || suggestion.terminalAt < (oldest.terminalAt ?? 0)) {
        oldest = suggestion;
      }
    }
    return oldest;
  }

  #createSuggestion(
    groupId: string,
    candidate: RebalanceBindingCandidate,
    destinationTargetId: string,
    input: RebalanceTickInput,
    now: number,
    stableSamples: number,
  ): RebalanceSuggestion | undefined {
    const stored = this.#suggestions.get(groupId) ?? new Map<string, RebalanceSuggestion>();
    this.#suggestions.set(groupId, stored);
    if (stored.size >= input.policy.maxSuggestionsPerGroup) {
      // Same discipline as the migration store: make room by dropping the oldest terminal
      // record, and only refuse new work when everything stored is still live.
      const oldestTerminal = this.#oldestTerminal(stored);
      if (oldestTerminal === undefined) {
        return undefined;
      }
      stored.delete(oldestTerminal.suggestionId);
    }
    const suggestion: RebalanceSuggestion = {
      bindingId: candidate.ref.bindingId,
      costEstimated: costEstimated(candidate.activity),
      costSource: candidate.activity.lastUsage?.costSource ?? "none",
      createdAt: now,
      destinationTargetId,
      groupId,
      incarnation: candidate.ref.incarnation,
      inputTokens: candidate.activity.lastUsage?.inputTokens,
      requestBytes: candidate.activity.lastRequestBytes,
      groupRevision: input.groupRevision,
      routingRevision: candidate.ref.routingRevision,
      runtimeEpoch: input.runtimeEpoch,
      sawNewRequest: false,
      sourceTargetId: candidate.targetId,
      stableSamples,
      state: "suggested",
      stateReason: undefined,
      suggestionId: createRequestId(),
      terminalAt: undefined,
    };
    stored.set(suggestion.suggestionId, suggestion);
    const suggestedAt = this.#lastSuggestedAt.get(groupId) ?? new Map<number, number>();
    suggestedAt.set(candidate.ref.incarnation, now);
    this.#lastSuggestedAt.set(groupId, suggestedAt);
    const directions = this.#directions.get(groupId) ?? new Map<number, Map<string, number>>();
    const byIncarnation = directions.get(candidate.ref.incarnation) ?? new Map<string, number>();
    const sourceKey = this.#canonicalKeyOf(input.engineViews, candidate.targetId) ?? "";
    const destinationKey = this.#canonicalKeyOf(input.engineViews, destinationTargetId) ?? "";
    byIncarnation.set(stabilityKey(sourceKey, destinationKey), now);
    directions.set(candidate.ref.incarnation, byIncarnation);
    this.#directions.set(groupId, directions);
    return suggestion;
  }

  #pickDestination(
    candidate: RebalanceBindingCandidate,
    destination: EngineLoadView,
    input: RebalanceTickInput,
  ): string | undefined {
    for (const entry of candidate.gates.destinations) {
      if (
        !destination.targetIds.includes(entry.targetId) ||
        !entry.eligible ||
        entry.code !== undefined ||
        (input.targetInFlight.get(entry.targetId) ?? 0) !== 0
      ) {
        continue;
      }
      return entry.targetId;
    }
    return undefined;
  }

  #canonicalKeyOf(views: readonly EngineLoadView[], targetId: string): string | undefined {
    return this.#viewForTarget(views, targetId)?.canonicalKey;
  }

  #liveBindingKeys(groupId: string): Set<number> {
    const keys = new Set<number>();
    for (const suggestion of this.#suggestions.get(groupId)?.values() ?? []) {
      if (suggestion.state === "suggested") {
        keys.add(suggestion.incarnation);
      }
    }
    return keys;
  }
}

interface StabilityState {
  countedSequence: number;
  stable: number;
}

interface StabilityObservation {
  source: EngineLoadView;
  destination: EngineLoadView;
}

/** The first target of the idle engine the candidate could see, used to name a refusal. */
function destinationTargetOf(
  destination: EngineLoadView,
  candidate: RebalanceBindingCandidate,
): string {
  const seen = candidate.gates.destinations.find((entry) =>
    destination.targetIds.includes(entry.targetId),
  );
  return seen?.targetId ?? destination.targetIds[0] ?? "";
}
