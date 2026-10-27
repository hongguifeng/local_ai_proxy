import type { BindingActivity, BindingCostSource } from "./binding-activity.js";
import type {
  LoadBalancer,
  LoadBalancerNode,
  LoadBalancerBindingEntry,
  LoadBalancerMoveDestinationGate,
  LoadBalancerMoveGates,
} from "./load-balancer.js";
import type { MigrationState } from "./load-migration-contract.js";
import type { MigrationAnswerEffect, MigrationAnswerState } from "./load-migration.js";
import type {
  MigrationOperationView,
  MigrationRejectionCode,
  MoveBindingOutcome,
  MoveBindingRequest,
} from "./load-migration.js";
import {
  assessLoadSample,
  type LoadSampleAssessment,
  type MetricCompleteness,
  type SampleFreshness,
} from "./load-evidence.js";
import type { LoadMonitor, LoadNodeStatus } from "./load-monitor.js";
import { tryCanonicalNodeKey } from "./node-identity.js";
import type { EndpointKind } from "./protocol/analysis.js";
import type { TargetConfig } from "../config/index.js";
import type { LoadBalancerGroup, PublicProxyPair } from "../config/index.js";
import { loadBalancerMemberTargetIds } from "../config/index.js";
import type {
  AssociatedTask,
  BindingHistoryAssociation,
  BindingHistoryCoverage,
  BindingHistoryQuery,
  HistoryAssociationConfidence,
  HistoryAssociationLevel,
  HistoryAssociationReason,
  HistoryCoverageState,
  HistoryQueryFailure,
} from "../maintenance/binding-history-association.js";

/**
 * Read-only view of load balancing for the admin UI.
 *
 * The status read touches nothing: every number it returns is already in memory. The binding
 * list reads the runtime's side-effect-free projection for the live state and asks the traffic
 * log - through the reader the assembly injects, for the page it is about to return - what the
 * stored history says about each binding. It never runs from the request path, never calls
 * `lookup()`, and never opens a database that is not already there.
 */

export interface LoadBalancerAdminSource {
  pairs(): readonly PublicProxyPair[];
  loadBalancer(pairId: string): LoadBalancer | undefined;
  loadMonitor(pairId: string): LoadMonitor | undefined;
  /**
   * Where one target's traffic log lives, resolved the way the runtime resolves it.
   * `undefined` means the target logs nowhere, which the history reader reports as
   * `no_log_configured` rather than as an empty history.
   */
  logRootForTarget(pairId: string, targetId: string): string | undefined;
  /** The read-only binding-to-history service the assembly wired. */
  bindingHistory: LoadBalancerBindingHistoryReader;
}

/**
 * One node's upstream numbers as the console sees them. Null means the engine did not
 * answer that field; a zero the engine really reported stays a zero, so an unmeasured node
 * is never shown as an idle one.
 */
export interface LoadBalancerMetricsSnapshot {
  readonly kvUsage: number | undefined;
  readonly running: number | null;
  readonly sampledAt: number;
  readonly source: string;
  readonly waiting: number | null;
}

export interface LoadBalancerStatusNode {
  /** How many tasks are currently bound to this node. */
  readonly bindings: number;
  readonly canonicalKey: string;
  readonly cooldownRemainingMs: number;
  readonly enabled: boolean;
  readonly failures: number;
  readonly inFlight: number;
  /** Enabled and out of cooldown; a sleeping engine is judged per request, not here. */
  readonly inRotation: boolean;
  readonly lastDispatchedAt: number | null;
  /** Null when no read ever produced a number: never sampled, or the last read failed. */
  readonly metrics: LoadBalancerMetricsSnapshot | null;
  /** True when the stored sample is older than the freshness window, or there is none. */
  readonly stale: boolean;
  readonly targetId: string;
}

export interface LoadBalancerStatusGroup {
  readonly bindings: number;
  readonly enabled: boolean;
  readonly failoverEnabled: boolean;
  readonly id: string;
  readonly metricsEnabled: boolean;
  readonly modelPattern: string;
  readonly name: string;
  readonly nodeTargetIds: readonly string[];
  readonly nodes: readonly LoadBalancerStatusNode[];
  readonly strategy: string;
}

export interface LoadBalancerStatusPair {
  readonly enabled: boolean;
  readonly groups: readonly LoadBalancerStatusGroup[];
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
}

export interface LoadBalancerStatusResponse {
  readonly now: number;
  readonly pairs: readonly LoadBalancerStatusPair[];
}

/** The model ids an engine reports through `GET /models`. */

function statusGroup(
  group: LoadBalancerGroup,
  balancer: LoadBalancer | undefined,
  monitor: LoadMonitor | undefined,
  now: number,
): LoadBalancerStatusGroup {
  const statuses = new Map<string, LoadNodeStatus>(
    (monitor?.nodeStatuses() ?? []).map((status) => [status.targetId, status]),
  );
  const boundByTarget = balancer?.tableFor(group.id)?.snapshot().byTarget ?? {};
  return {
    bindings: balancer?.tableFor(group.id)?.size ?? 0,
    enabled: group.enabled,
    failoverEnabled: group.failover_enabled,
    id: group.id,
    metricsEnabled: group.metrics_enabled,
    modelPattern: group.model_pattern,
    name: group.name,
    nodeTargetIds: loadBalancerMemberTargetIds(group),
    nodes: loadBalancerMemberTargetIds(group).map((targetId) => {
      const node = balancer?.nodeFor(targetId);
      const status = statuses.get(targetId);
      const cooldownRemainingMs = balancer?.cooldownRemaining(targetId, now) ?? 0;
      return {
        bindings: boundByTarget[targetId] ?? 0,
        canonicalKey: node?.canonicalKey ?? "",
        cooldownRemainingMs,
        enabled: node?.enabled ?? false,
        failures: node?.failures ?? 0,
        inFlight: balancer?.inFlight(targetId) ?? 0,
        inRotation: (node?.enabled ?? false) && cooldownRemainingMs === 0,
        lastDispatchedAt: node?.lastDispatchedAt ?? null,
        metrics: status?.metrics ?? null,
        stale: status?.stale ?? true,
        targetId,
      };
    }),
    strategy: group.strategy,
  };
}

// ------------------------------------------ [TRI-05] the binding list a node panel reads

/** How long a history failure message may be on the wire. */
const MAX_HISTORY_FAILURE_MESSAGE = 512;

/**
 * What the console asks for: one group's bindings, optionally narrowed to one node, with a
 * page. The caps are declared in `admin-schemas.ts`, which is what a client cannot exceed.
 */
export interface LoadBalancerBindingListQuery {
  readonly pairId: string;
  readonly groupId: string;
  readonly targetId: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

/**
 * The history reader this projection composes with. It is handed in by the assembly rather
 * than built here, so the proxy side keeps no runtime dependency on the persistence or
 * maintenance modules: the reader is the only route to the database this file can take.
 */
export interface LoadBalancerBindingHistoryReader {
  queryBindingHistory(query: Readonly<BindingHistoryQuery>): BindingHistoryAssociation;
}

/** A read that cannot be answered because the pair or the group is not configured. */
export type LoadBalancerBindingListErrorCode = "pair_not_found" | "group_not_found";

/**
 * The answer of one binding-list read: a page, or the reason there is nothing to page.
 * The two 404 causes stay distinct, or the console cannot tell "this pair is not configured"
 * from "this group is not in that pair".
 */
export type LoadBalancerBindingListReply =
  | { readonly response: LoadBalancerBindingListResponse }
  | { readonly error: LoadBalancerBindingListErrorCode };

/**
 * Whether a move can be performed at all on this pair right now. `available` means the pair
 * has a runtime whose `moveBinding()` the console can address; `unavailable` means it has
 * none, which is why an unstarted pair answers an empty binding list too.
 */
export type LoadBalancerMigrationAvailability = "available" | "unavailable";

/**
 * Why this binding cannot be offered to any destination, in the state gate's own code names,
 * plus the one fact the gate cannot give as a refusal: every other member of the group failed
 * the eligibility gate, so there is nowhere to move to.
 */
export type LoadBalancerMovableReason =
  "response_state_dependency" | "state_unknown" | "no_eligible_destination";

/** The eligibility gate's refusals that can name a candidate destination. */
export type LoadBalancerDestinationReason =
  "target_unknown" | "target_disabled" | "target_cooldown" | "target_asleep" | "model_mismatch";

/**
 * One group member as a destination for this binding.
 *
 * `eligible` is the write gate's answer, reported here so the console never has to compare
 * target URLs, model names or cooldowns by itself; the refusal code travels with it so the
 * reason is the server's, not an invented one. `metricsUnknown` is not a refusal: a node whose
 * engine numbers are missing, stale or incomplete can still be chosen by hand, but the console
 * has to say it is unmeasured and ask for a deliberate confirmation.
 */
export interface LoadBalancerBindingMoveDestination {
  readonly eligible: boolean;
  readonly metricsUnknown: boolean;
  readonly reason: LoadBalancerDestinationReason | null;
  readonly targetId: string;
}

/**
 * Whether this binding could be moved, and where to.
 *
 * `ok` is true when the binding itself passes the state gate and at least one member passes
 * the eligibility gate - which is what makes the affordance real rather than decorative. A
 * binding with a request in flight is not refused: its intent waits for the request boundary,
 * which is what the row's own `inFlight` and `activity` already say.
 */
export interface LoadBalancerBindingMovability {
  readonly destinations: readonly LoadBalancerBindingMoveDestination[];
  readonly ok: boolean;
  readonly reasons: readonly LoadBalancerMovableReason[];
}

/** Every state an intent can be seen in from the list, including the terminal ones. */
export type LoadBalancerMigrationOperationState = MigrationState;

/**
 * One migration record as the list reports it.
 *
 * This is a sanitized projection, not `MigrationOperationView`: the request digest and the
 * idempotency key stay inside the store, because neither is a fact the console needs to say
 * where a route went, and publishing them would let a page replay a submission it never made.
 * `cancellable` is the server's answer, so a page does not re-derive the state machine.
 */
export interface LoadBalancerMigrationOperation {
  readonly appliedRoutingRevision: number | null;
  readonly bindingId: number;
  readonly cancellable: boolean;
  readonly createdAt: number;
  readonly destinationTargetId: string;
  readonly endReason: string | null;
  readonly endedAt: number | null;
  readonly expiresAt: number;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly incarnation: number;
  readonly operationId: string;
  readonly sourceRoutingRevision: number;
  readonly sourceTargetId: string;
  readonly state: LoadBalancerMigrationOperationState;
}

/** How many records one list answer may carry. Newest first, so the live ones come first. */
export const MAX_MIGRATION_OPERATION_ROWS = 100;

/** Whether the proxy has seen this binding's request path at all. */
export type LoadBalancerBindingActivityState = "in_flight" | "idle" | "unknown";

/** The latest cost signal of one binding, and where it actually came from. */
export interface LoadBalancerBindingContext {
  readonly cacheReadTokens: number | null;
  readonly inputTokens: number | null;
  readonly observedAt: number | null;
  readonly requestBytes: number | null;
  readonly source: BindingCostSource;
}

/** What the traffic log says about one task connected to this binding. */
export interface LoadBalancerAssociatedTask {
  readonly endpoint: string | null;
  readonly exactKeyMatches: number;
  readonly historyTargetNode: "same" | "different" | "unknown";
  readonly kind: string;
  readonly lastResponseAt: string | null;
  readonly lastSeenAt: string;
  readonly level: HistoryAssociationLevel;
  readonly model: string | null;
  readonly pendingRequestOnly: boolean;
  readonly requestCount: number;
  readonly taskId: string;
}

/** Why a history read could not be done, as the reader reported it. */
export interface LoadBalancerHistoryFailure {
  readonly code: string | null;
  readonly errorName: string;
  readonly message: string;
  readonly phase: HistoryQueryFailure["phase"];
}

/**
 * What the history reader had to stop at, and what it actually looked at. The log root is
 * left out: it is configuration the pairs API already answers, and a binding list has no
 * business repeating host paths.
 */
export interface LoadBalancerHistoryCoverage {
  readonly candidateRowsRead: number;
  readonly candidateScanLimit: number;
  readonly exactKeysExamined: number;
  readonly exactKeysLinked: number;
  readonly exactKeysOmitted: number;
  readonly exactKeysRequested: number;
  readonly exactKeysWithoutLink: number;
  readonly exactLinkRowsRead: number;
  readonly failure: LoadBalancerHistoryFailure | null;
  readonly historyRowsRead: number;
  readonly historyTruncated: boolean;
  readonly latestStoredRecordAt: string | null;
  readonly linkedTasksRead: number;
  readonly logWriteMayBePending: boolean;
  readonly returnedTaskLimit: number;
  readonly state: HistoryCoverageState;
}

/** The whole history answer for one binding: a grade, the tasks, and the limits that shaped it. */
export interface LoadBalancerBindingAssociations {
  readonly ambiguous: boolean;
  readonly confidence: HistoryAssociationConfidence;
  readonly coverage: LoadBalancerHistoryCoverage;
  readonly reasons: readonly HistoryAssociationReason[];
  readonly taskIds: readonly string[];
  readonly tasks: readonly LoadBalancerAssociatedTask[];
}

/** One node of the group, with the engine's numbers classified. */
export interface LoadBalancerBindingNode {
  readonly bindings: number;
  readonly canonicalKey: string;
  readonly cooldownRemainingMs: number;
  readonly enabled: boolean;
  readonly failures: number;
  readonly inFlight: number;
  readonly inRotation: boolean;
  readonly lastDispatchedAt: number | null;
  readonly metrics: LoadBalancerNodeMetrics;
  readonly targetId: string;
}

/**
 * One engine answer as the reader classified it. A field the engine left out stays null:
 * `never_sampled` and `no_load_numbers` are facts about the read, not zeros to display.
 */
export interface LoadBalancerNodeMetrics {
  readonly awake: boolean | null;
  readonly completeness: MetricCompleteness;
  readonly freshness: SampleFreshness;
  readonly kvUsage: number | null;
  readonly running: number | null;
  readonly sampleSequence: number | null;
  readonly sampledAt: number | null;
  readonly source: string | null;
  readonly usableForLoadJudgement: boolean;
  readonly waiting: number | null;
}

/**
 * One binding as the list answers it: its full address, its live activity, its cost signal,
 * what the history thinks of it, and whether it could be moved. The numeric id alone is never
 * an address - `runtimeEpoch` and `groupId` come from the response envelope, and `incarnation`
 * travels with the row so a client can see that a reused number is not the same binding.
 */
export interface LoadBalancerBindingListItem {
  readonly activity: LoadBalancerBindingActivityState;
  readonly associations: LoadBalancerBindingAssociations;
  readonly bindingId: number;
  readonly context: LoadBalancerBindingContext;
  readonly endpoint: string;
  readonly endpointKind: EndpointKind;
  readonly incarnation: number;
  readonly inFlight: number;
  readonly lastBoundAt: number;
  readonly lastRequestStartedAt: number | null;
  readonly lastResponseEndedAt: number | null;
  readonly lastSeenAt: number;
  readonly model: string | null;
  readonly movable: LoadBalancerBindingMovability;
  readonly recentRequestStarts: readonly number[];
  readonly requestCount: number;
  readonly routingRevision: number;
  readonly targetId: string;
}

/** A page of the group's bindings, with the versions and node state around it. */
export interface LoadBalancerBindingListResponse {
  readonly groupRevision: number | null;
  readonly groupId: string;
  readonly hasMore: boolean;
  readonly items: readonly LoadBalancerBindingListItem[];
  readonly limit: number;
  readonly migration: LoadBalancerMigrationAvailability;
  /**
   * What this group's migration records look like now, for the whole group and independent of
   * `targetFilter`. A binding that moved has left the filtered page it was listed on, so the
   * operation that moved it could only be followed from here - which is why the current state
   * of an operation is read from the list and never by repeating the `POST`.
   */
  readonly migrationOperations: readonly LoadBalancerMigrationOperation[];
  readonly nextOffset: number;
  readonly nodes: readonly LoadBalancerBindingNode[];
  readonly now: number;
  readonly offset: number;
  readonly pairId: string;
  readonly runtimeEpoch: string | null;
  readonly targetFilter: string | null;
  readonly totalBindings: number;
}

// ------------------------------------------ [TRI-08] the manual move the console submits

/**
 * What a client has to name to ask for one move. Every version is required because the safe
 * entry re-checks all of them: `groupRevision` and `routingRevision` are what makes a late
 * submit refuse to overwrite a newer one, `expectedSourceTargetId` is what proves the caller is
 * looking at the route it thinks it is, and `incarnation` is the write-side guard that keeps a
 * reference off a binding that happened to reuse the number. The binding list hands all of them
 * out - `runtimeEpoch` and `groupRevision` on the page, `incarnation` and `routingRevision` on
 * the row - so a client never has to read twice to build one instruction.
 *
 * `reason` is a bounded audit label, not an operation parameter: the same move worded
 * differently is still the same move, so it stays out of the idempotency digest.
 */
export interface LoadBalancerBindingMoveQuery {
  readonly pairId: string;
  readonly groupId: string;
  readonly runtimeEpoch: string;
  readonly bindingId: number;
  readonly incarnation: number;
  readonly groupRevision: number;
  readonly expectedRoutingRevision: number;
  readonly expectedSourceTargetId: string;
  readonly destinationTargetId: string;
  readonly idempotencyKey: string;
  readonly reason: string | undefined;
}

/** The four causes this service finds before it ever reaches a balancer. */
export type LoadBalancerMovePreflightCode =
  "pair_not_found" | "group_not_found" | "runtime_not_running" | "runtime_epoch_mismatch";

/** Every way a move submit can be refused, service causes and balancer causes together. */
export type LoadBalancerTaskMoveRejectionCode =
  MigrationRejectionCode | LoadBalancerMovePreflightCode;

/**
 * A refusal, in the service's own words. `detail` is the sentence the migration service or the
 * balancer gave - the two 404 causes and the runtime causes each say which one it was - and is
 * absent when the cause is a configuration fact the route names itself.
 */
export interface LoadBalancerTaskMoveRejection {
  readonly code: LoadBalancerTaskMoveRejectionCode;
  readonly detail: string | undefined;
}

/** What a move did to the route: `next_request` changed it, `none` changed nothing. */
export type LoadBalancerMoveEffect = MigrationAnswerEffect;

/**
 * The states an answer can report: what the submit decided, plus `cancelled`, which is what a
 * cancel of a parked intent answers with. The rest of the state machine - `observed`, `expired`,
 * `expired_after_apply` - belongs to the intent's life after the answer, which the binding list
 * projection reports (TRI-09); a repeated POST repeats the receipt it was answered with.
 */
export type LoadBalancerMoveState = MigrationAnswerState | "cancelled";

/**
 * The answer of one submit or one cancel. `state` and the outcome fields travel together, and
 * none of them says the upstream answered: `applied` means the in-memory route changed,
 * `pending_boundary` means nothing changed yet, `already_there` means no write was needed and
 * `cancelled` means a parked intent was called off without ever reaching a route.
 *
 * `runtimeEpoch` and `groupRevision` ride along so a client can see whether the runtime it
 * addressed is still the one this pair is running, instead of guessing from a number that
 * changed while its page was open.
 */
export interface LoadBalancerTaskMoveResult {
  readonly bindingId: number;
  readonly effect: LoadBalancerMoveEffect;
  readonly fromTargetId: string;
  readonly groupRevision: number;
  readonly inFlightAtRequest: number;
  readonly operationId: string | null;
  readonly routingRevision: number;
  readonly runtimeEpoch: string;
  readonly state: LoadBalancerMoveState;
  readonly toTargetId: string;
}

/** Every way a cancel can be refused, named the way design section 6.2 names them. */
export type LoadBalancerCancelMoveRejectionCode =
  | "operation_not_found"
  | "operation_already_applied"
  | "operation_expired"
  | "operation_not_cancellable";

export interface LoadBalancerCancelMoveRejection {
  readonly code: LoadBalancerCancelMoveRejectionCode;
  readonly detail: string | undefined;
}

export type LoadBalancerTaskMoveReply =
  | { readonly response: LoadBalancerTaskMoveResult }
  | { readonly rejection: LoadBalancerTaskMoveRejection };

export type LoadBalancerCancelMoveReply =
  | { readonly response: LoadBalancerTaskMoveResult }
  | { readonly rejection: LoadBalancerCancelMoveRejection };

export interface LoadBalancerAdminService {
  getStatus(): LoadBalancerStatusResponse;
  getBindings(query: LoadBalancerBindingListQuery): LoadBalancerBindingListReply;
  /**
   * Ask for one binding to move. The service never assigns a target: it turns the client's
   * address into a `MoveBindingRequest` and hands it to the one safe entry the balancer owns.
   */
  moveBinding(query: LoadBalancerBindingMoveQuery): LoadBalancerTaskMoveReply;
  /** Call off an intent that has not been applied yet; a write is never rewritten as a cancel. */
  cancelMoveBinding(operationId: string): LoadBalancerCancelMoveReply;
}

export function createLoadBalancerAdminService(
  source: LoadBalancerAdminSource,
): LoadBalancerAdminService {
  return {
    /** Pure memory reads: no database, no upstream request, no request content. */
    getStatus(): LoadBalancerStatusResponse {
      const now = Date.now();
      return {
        now,
        pairs: source.pairs().map((pair) => {
          const balancer = source.loadBalancer(pair.id);
          const monitor = source.loadMonitor(pair.id);
          return {
            enabled: pair.enabled,
            groups: pair.load_balancers.map((group) => statusGroup(group, balancer, monitor, now)),
            id: pair.id,
            name: pair.name,
            running: pair.running,
          };
        }),
      };
    },
    /**
     * The group's bindings, joined with the activity ledger, the node state and the traffic
     * log. Reading this changes nothing: `bindingSnapshot()` is the side-effect-free
     * projection, so no TTL is refreshed, no `requestCount` bumped, no target moved and no
     * binding evicted, and the history reader only opens a database that already exists.
     */
    getBindings(query: LoadBalancerBindingListQuery): LoadBalancerBindingListReply {
      const now = Date.now();
      const pair = source.pairs().find((item) => item.id === query.pairId);
      if (pair === undefined) {
        return { error: "pair_not_found" };
      }
      const group = pair.load_balancers.find((item) => item.id === query.groupId);
      if (group === undefined) {
        return { error: "group_not_found" };
      }

      const balancer = source.loadBalancer(pair.id);
      const entries = balancer?.bindingSnapshot(group.id)?.entries ?? [];
      const targetsById = new Map(pair.targets.map((target) => [target.id, target]));
      const bindingsByTarget: Record<string, number> = {};
      for (const entry of entries) {
        bindingsByTarget[entry.targetId] = (bindingsByTarget[entry.targetId] ?? 0) + 1;
      }

      const nodes = loadBalancerMemberTargetIds(group).map((targetId) =>
        bindingNode(
          targetId,
          balancer?.nodeFor(targetId),
          targetsById.get(targetId),
          bindingsByTarget[targetId] ?? 0,
          balancer,
          now,
        ),
      );
      const nodesByTarget = new Map(nodes.map((node) => [node.targetId, node]));
      const migrationOperations = migrationOperationRows(balancer, group.id);

      // Newest activity first, then the table's own order, so a page is reproducible.
      const ordered = entries
        .filter((entry) => query.targetId === undefined || entry.targetId === query.targetId)
        .sort(
          (left, right) =>
            right.lastSeenAt - left.lastSeenAt || left.ref.bindingId - right.ref.bindingId,
        );
      const totalBindings = ordered.length;
      const page = ordered.slice(query.offset, query.offset + query.limit);
      const hasMore = query.offset + page.length < totalBindings;

      return {
        response: {
          groupRevision: balancer?.groupRevision(group.id) ?? null,
          groupId: group.id,
          hasMore,
          items: page.map((entry) =>
            bindingItem(
              entry,
              nodesByTarget.get(entry.targetId),
              nodesByTarget,
              pair.id,
              source,
              balancer,
            ),
          ),
          limit: query.limit,
          // A pair with no runtime has nothing to move a binding in; the write entry exists,
          // but there is no runtime to address, so the honest answer is `unavailable`.
          migration: balancer === undefined ? "unavailable" : "available",
          migrationOperations,
          nextOffset: hasMore ? query.offset + page.length : query.offset,
          nodes,
          now,
          offset: query.offset,
          pairId: pair.id,
          runtimeEpoch: balancer?.runtimeEpoch ?? null,
          targetFilter: query.targetId ?? null,
          totalBindings,
        },
      };
    },
    /**
     * Ask for one binding to move. This method writes nothing: it turns the client's address into
     * a `MoveBindingRequest` and hands it to `LoadBalancer.moveBinding()`, the single entry that
     * checks every version and target twice and then writes through the table's one `rebind()`.
     * A pair that is configured but not running has no runtime to address, and a runtime epoch
     * that is not the current one names a runtime that no longer exists; both are reported before
     * the call so the two causes stay readable in the answer.
     *
     * The order the checks run in is part of the answer. A pair, a runtime and an epoch have to
     * be located first, because a runtime that is gone or replaced holds no receipt to answer
     * from. Then the runtime is asked what it already knows about the idempotency key, and only
     * an instruction it has never answered is put through the configuration preflight: a retry of
     * an instruction this runtime answered is answered that answer even when the group the
     * request names has since left the configuration, because it is the first submission the
     * client is repeating, not a new claim about what is configured now. Asking the other way
     * round would answer a remembered retry with a 404 the receipt should have forestalled.
     */
    moveBinding(query: LoadBalancerBindingMoveQuery): LoadBalancerTaskMoveReply {
      const pair = source.pairs().find((item) => item.id === query.pairId);
      if (pair === undefined) {
        return { rejection: { code: "pair_not_found", detail: undefined } };
      }
      const balancer = source.loadBalancer(pair.id);
      if (balancer === undefined) {
        return {
          rejection: {
            code: "runtime_not_running",
            detail: "This pair is not running, so no runtime holds a binding to move.",
          },
        };
      }
      if (query.runtimeEpoch !== balancer.runtimeEpoch) {
        return {
          rejection: {
            code: "runtime_epoch_mismatch",
            detail: "The runtime epoch in the request is not the one this pair is running now.",
          },
        };
      }
      const request = moveRequestOf(query);
      if (balancer.lookUpIdempotencyKey(request) === "nothing") {
        const group = pair.load_balancers.find((item) => item.id === query.groupId);
        if (group === undefined) {
          return { rejection: { code: "group_not_found", detail: undefined } };
        }
      }
      return describeMove(balancer.moveBinding(request));
    },
    /**
     * Call off an intent that has not been applied. Migration records live in the runtime of the
     * pair that was asked, and an operation id is unique across the process, so the search walks
     * the running pairs until one holds the record; looking a record over has no effect on it.
     *
     * The balancer's own refusal cannot tell "a lifecycle event called this off" from "the user
     * already cancelled this", and design section 6.2 names those separately, so the record's own
     * state decides which of the four codes the answer carries.
     */
    cancelMoveBinding(operationId: string): LoadBalancerCancelMoveReply {
      for (const pair of source.pairs()) {
        const balancer = source.loadBalancer(pair.id);
        if (balancer === undefined) {
          continue;
        }
        const record = balancer
          .migrationOperations()
          .find((operation) => operation.operationId === operationId);
        if (record === undefined) {
          continue;
        }
        return describeCancellation(balancer, record, operationId);
      }
      return { rejection: { code: "operation_not_found", detail: undefined } };
    },
  };
}

/**
 * One node of the group. With a balancer the serving state is its own; without one the pair
 * is not running, so the only honest facts left are what the configuration says about the
 * target and the fact that nothing was ever sampled.
 */
function bindingNode(
  targetId: string,
  node: LoadBalancerNode | undefined,
  configTarget: TargetConfig | undefined,
  bindings: number,
  balancer: LoadBalancer | undefined,
  now: number,
): LoadBalancerBindingNode {
  const cooldownRemainingMs = balancer?.cooldownRemaining(targetId, now) ?? 0;
  const enabled = node?.enabled ?? configTarget?.enabled ?? false;
  const canonicalKey =
    node?.canonicalKey ??
    (configTarget === undefined ? "" : (tryCanonicalNodeKey(configTarget.target_url) ?? ""));
  return {
    bindings,
    canonicalKey,
    cooldownRemainingMs,
    enabled,
    failures: node?.failures ?? 0,
    inFlight: balancer?.inFlight(targetId) ?? 0,
    inRotation: enabled && cooldownRemainingMs === 0,
    lastDispatchedAt: node?.lastDispatchedAt ?? null,
    metrics: nodeMetricsOf(assessLoadSample(node?.sample, now)),
    targetId,
  };
}

/** The assessment with the missing numbers spelled as null, so a reader cannot misread them. */
function nodeMetricsOf(assessment: LoadSampleAssessment): LoadBalancerNodeMetrics {
  return {
    awake: assessment.awake ?? null,
    completeness: assessment.completeness,
    freshness: assessment.freshness,
    kvUsage: assessment.kvUsage ?? null,
    running: assessment.running ?? null,
    sampleSequence: assessment.sampleSequence ?? null,
    sampledAt: assessment.sampledAt ?? null,
    source: assessment.source ?? null,
    usableForLoadJudgement: assessment.usableForLoadJudgement,
    waiting: assessment.waiting ?? null,
  };
}

/**
 * One row of the list. The history question is asked per binding because each binding has its
 * own keys, its own boundary and its own node, and the log root belongs to that node. The
 * move question is asked here too, because the answer has to name the destinations the write
 * gate would accept - and the only place that answer is trustworthy is the gate itself.
 */
function bindingItem(
  entry: LoadBalancerBindingEntry,
  node: LoadBalancerBindingNode | undefined,
  nodesByTarget: ReadonlyMap<string, LoadBalancerBindingNode>,
  pairId: string,
  source: LoadBalancerAdminSource,
  balancer: LoadBalancer | undefined,
): LoadBalancerBindingListItem {
  const activity = entry.activity;
  const association = source.bindingHistory.queryBindingHistory({
    binding: {
      boundaryWithoutUser: entry.evidence.boundaryWithoutUser,
      endpoint: entry.evidence.endpoint,
      exactKeys: entry.exactKeys,
      firstUserHash: entry.evidence.firstUserHash,
      kind: entry.evidence.kind,
      model: entry.evidence.model,
    },
    canonicalKey: node?.canonicalKey ?? "",
    lastRequestStartedAt: activity.lastRequestStartedAt,
    logRoot: source.logRootForTarget(pairId, entry.targetId),
    targetId: entry.targetId,
  });
  return {
    activity: activityStateOf(activity),
    associations: associationsOf(association),
    bindingId: entry.ref.bindingId,
    context: contextOf(activity),
    endpoint: entry.evidence.endpoint,
    endpointKind: entry.evidence.kind,
    incarnation: entry.ref.incarnation,
    inFlight: activity.inFlight,
    lastBoundAt: entry.lastBoundAt,
    lastRequestStartedAt: activity.lastRequestStartedAt ?? null,
    lastResponseEndedAt: activity.lastResponseEndedAt ?? null,
    lastSeenAt: entry.lastSeenAt,
    model: entry.evidence.model ?? null,
    movable: movabilityOf(balancer?.moveGatesFor(entry.ref.groupId, entry.ref), nodesByTarget),
    recentRequestStarts: activity.recentRequestStarts,
    requestCount: entry.requestCount,
    routingRevision: entry.routingRevision,
    targetId: entry.targetId,
  };
}

/**
 * The three states the ledger can actually support. `unknown` is the case where no reservation
 * ever passed through this binding: `requestCount` counts affinity lookups, not reservations,
 * so a binding can be known to the table and still never have been observed by the request
 * path. Nothing here claims a task finished.
 */
function activityStateOf(activity: BindingActivity): LoadBalancerBindingActivityState {
  if (activity.inFlight > 0) return "in_flight";
  if (activity.lastRequestStartedAt !== undefined || activity.lastResponseEndedAt !== undefined) {
    return "idle";
  }
  return "unknown";
}

/** The latest cost signal, with its source named as the ledger recorded it. */
function contextOf(activity: BindingActivity): LoadBalancerBindingContext {
  const usage = activity.lastUsage;
  return {
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    inputTokens: usage?.inputTokens ?? null,
    observedAt: usage?.observedAt ?? null,
    requestBytes: activity.lastRequestBytes ?? null,
    source:
      usage?.costSource ?? (activity.lastRequestBytes === undefined ? "none" : "request_bytes"),
  };
}

/**
 * Whether this binding can be moved, and where to, taken from the balancer's own gates.
 *
 * `ok` is true only when the binding passes the state gate and at least one member passes the
 * eligibility gate. A binding with a request in flight is not refused: the intent it registers
 * waits for the request boundary, which the row's own `inFlight` and `activity` already show.
 * A refusal is named with the code the gate gave, never with an invented one; the one fact the
 * gates cannot return as a refusal - that no member is eligible - is reported as
 * `no_eligible_destination` so the console has a reason to show.
 *
 * The metric warning is not a gate result. `usableForLoadJudgement` is the classification the
 * evidence module already makes for the node, and it is false whenever the numbers are missing,
 * stale or incomplete - so an unmeasured destination is offered with a warning rather than
 * silently passed as idle.
 */
function movabilityOf(
  gates: LoadBalancerMoveGates | undefined,
  nodesByTarget: ReadonlyMap<string, LoadBalancerBindingNode>,
): LoadBalancerBindingMovability {
  if (gates === undefined) {
    // The binding left the table between the snapshot and this call. Nothing can be shown as
    // a destination that was never looked at, so the row says it cannot be moved.
    return { destinations: [], ok: false, reasons: ["no_eligible_destination"] };
  }
  const destinations = gates.destinations.map((destination) => ({
    eligible: destination.eligible,
    metricsUnknown: !nodesByTarget.get(destination.targetId)?.metrics.usableForLoadJudgement,
    reason: destinationReasonOf(destination),
    targetId: destination.targetId,
  }));
  const eligibleCount = destinations.filter((destination) => destination.eligible).length;
  const reasons: LoadBalancerMovableReason[] = gates.blocking.map(blockingReasonOf);
  if (eligibleCount === 0) reasons.push("no_eligible_destination");
  return {
    destinations,
    ok: gates.blocking.length === 0 && eligibleCount > 0,
    reasons,
  };
}

/**
 * The gate's refusal for one candidate, as the declared wire code. Only the six refusals the
 * eligibility gate can reach for a listed member are declared, because the other codes name
 * conditions a listed member cannot meet: the group was already found, and the list is built
 * from that group's own members. Anything else is reported as no reason rather than as a code
 * the schema does not know - which a contract test reads as a drift to fix, not to hide.
 */
function destinationReasonOf(
  destination: LoadBalancerMoveDestinationGate,
): LoadBalancerDestinationReason | null {
  const code = destination.code;
  if (code === undefined) return null;
  return DESTINATION_REASONS.has(code) ? (code as LoadBalancerDestinationReason) : null;
}

/**
 * The state gate's refusal, as a declared wire reason. `#stateRejection()` produces only
 * `response_state_dependency` and `state_unknown`, so those two are declared; anything else is
 * folded into `state_unknown`, which is literally true of a refusal this projection cannot name
 * - the runtime cannot prove the move is safe - and keeps the button disabled rather than
 * letting an unknown code turn into an unexplained `ok: true`.
 */
function blockingReasonOf(code: MigrationRejectionCode): LoadBalancerMovableReason {
  return code === "response_state_dependency" ? code : "state_unknown";
}

const DESTINATION_REASONS: ReadonlySet<string> = new Set<string>([
  "target_unknown",
  "target_disabled",
  "target_cooldown",
  "target_asleep",
  "same_physical_key",
  "model_mismatch",
]);

/**
 * This group's migration records, newest first, as the console may show them.
 *
 * The read is `migrationOperations()`, which copies the records and touches nothing: no TTL,
 * no counter, no target, no eviction and no sweep. The list is group-scoped and independent
 * of `targetFilter` on purpose - a binding that has been applied leaves the node page it was
 * listed on, and the record of the move must still be visible there.
 */
function migrationOperationRows(
  balancer: LoadBalancer | undefined,
  groupId: string,
): readonly LoadBalancerMigrationOperation[] {
  if (balancer === undefined) {
    return [];
  }
  // The store's own order is the order its records were opened, so two records stamped in the
  // same millisecond are still separated: the one opened later is the one a reader saw last.
  return balancer
    .migrationOperations()
    .filter((operation) => operation.groupId === groupId)
    .map((operation, openedAt) => ({ operation, openedAt }))
    .sort(
      (left, right) =>
        right.operation.createdAt - left.operation.createdAt || right.openedAt - left.openedAt,
    )
    .slice(0, MAX_MIGRATION_OPERATION_ROWS)
    .map(({ operation }) => operationOf(operation));
}

/**
 * One record, minus the two fields the console has no business seeing. `requestDigest` is what
 * binds an idempotency key to one exact instruction and `idempotencyKey` is what replays it, so
 * handing either to a page would let it repeat a submission it never made.
 */
function operationOf(operation: MigrationOperationView): LoadBalancerMigrationOperation {
  return {
    appliedRoutingRevision: operation.appliedRoutingRevision ?? null,
    bindingId: operation.bindingId,
    cancellable: operation.state === "pending_boundary",
    createdAt: operation.createdAt,
    destinationTargetId: operation.destinationTargetId,
    endReason: operation.endReason ?? null,
    endedAt: operation.endedAt ?? null,
    expiresAt: operation.expiresAt,
    groupId: operation.groupId,
    groupRevision: operation.groupRevision,
    incarnation: operation.incarnation,
    operationId: operation.operationId,
    sourceRoutingRevision: operation.sourceRoutingRevision,
    sourceTargetId: operation.sourceTargetId,
    state: operation.state,
  };
}

function associationsOf(association: BindingHistoryAssociation): LoadBalancerBindingAssociations {
  return {
    ambiguous: association.ambiguous,
    confidence: association.confidence,
    coverage: coverageOf(association.coverage),
    reasons: association.reasons,
    taskIds: association.tasks.map((task) => task.taskId),
    tasks: association.tasks.map(taskOf),
  };
}

/** The stored task, projected to what a console may show: no body, no key, no target address. */
function taskOf(task: AssociatedTask): LoadBalancerAssociatedTask {
  return {
    endpoint: task.endpoint,
    exactKeyMatches: task.exactKeyMatches,
    historyTargetNode: task.historyTargetNode,
    kind: task.kind,
    lastResponseAt: task.lastResponseAt,
    lastSeenAt: task.lastSeenAt,
    level: task.level,
    model: task.model,
    pendingRequestOnly: task.pendingRequestOnly,
    requestCount: task.requestCount,
    taskId: task.taskId,
  };
}

function coverageOf(coverage: BindingHistoryCoverage): LoadBalancerHistoryCoverage {
  return {
    candidateRowsRead: coverage.candidateRowsRead,
    candidateScanLimit: coverage.candidateScanLimit,
    exactKeysExamined: coverage.exactKeysExamined,
    exactKeysLinked: coverage.exactKeysLinked,
    exactKeysOmitted: coverage.exactKeysOmitted,
    exactKeysRequested: coverage.exactKeysRequested,
    exactKeysWithoutLink: coverage.exactKeysWithoutLink,
    exactLinkRowsRead: coverage.exactLinkRowsRead,
    failure: coverage.failure === null ? null : failureOf(coverage.failure),
    historyRowsRead: coverage.historyRowsRead,
    historyTruncated: coverage.historyTruncated,
    latestStoredRecordAt: coverage.latestStoredRecordAt,
    linkedTasksRead: coverage.linkedTasksRead,
    logWriteMayBePending: coverage.logWriteMayBePending,
    returnedTaskLimit: coverage.returnedTaskLimit,
    state: coverage.state,
  };
}

/** The failure as the reader named it, capped so the declared wire length stays true. */
function failureOf(failure: HistoryQueryFailure): LoadBalancerHistoryFailure {
  return {
    code: failure.code,
    errorName: failure.errorName,
    message: failure.message.slice(0, MAX_HISTORY_FAILURE_MESSAGE),
    phase: failure.phase,
  };
}

// ------------------------------------------ [TRI-08] the two helpers the migration answers use

/** The balancer's own request shape, built from the address the client carried. */
function moveRequestOf(query: LoadBalancerBindingMoveQuery): MoveBindingRequest {
  return {
    runtimeEpoch: query.runtimeEpoch,
    groupId: query.groupId,
    groupRevision: query.groupRevision,
    bindingId: query.bindingId,
    incarnation: query.incarnation,
    expectedRoutingRevision: query.expectedRoutingRevision,
    expectedSourceTargetId: query.expectedSourceTargetId,
    destinationTargetId: query.destinationTargetId,
    requestedBy: "manual",
    reason: query.reason ?? "",
    idempotencyKey: query.idempotencyKey,
  };
}

/**
 * The answer of one submit, in the fields the console reads. Every number comes from the answer
 * the migration service decided, never from the route as it stands now: a same-key retry is
 * handed back the first submission's receipt, so it repeats the status, the effect, the counts
 * and the versions that were true when that answer was given. What the intent became afterwards -
 * observed, cancelled, expired - is the binding list's question (TRI-09), not this answer's, and
 * reading it here would stamp a later move's revision and counts onto an earlier instruction.
 *
 * A refusal is answered on a retry exactly as it was answered the first time: the same code and
 * the same sentence, which is what gives the route the same status to map. None of these answers
 * says the upstream answered - `applied` means the in-memory route changed, `pending_boundary`
 * means nothing changed yet, `already_there` means no write was needed - and none of them is
 * decided here: this only reports what `moveBinding()` answered.
 */
function describeMove(outcome: MoveBindingOutcome): LoadBalancerTaskMoveReply {
  if (outcome.kind === "rejected") {
    return { rejection: { code: outcome.rejection.code, detail: outcome.rejection.reason } };
  }
  const answer = outcome.answer;
  if (answer.kind === "refused") {
    // The first answer was a refusal, so the retry is refused the same way: the code and the
    // sentence the gate gave are kept in the receipt and answered again, not rewritten as a
    // success that reports a rejected state.
    return { rejection: { code: answer.rejection.code, detail: answer.rejection.reason } };
  }
  return {
    response: {
      bindingId: answer.bindingId,
      effect: answer.effect,
      fromTargetId: answer.fromTargetId,
      groupRevision: answer.groupRevision,
      inFlightAtRequest: answer.inFlightAtRequest,
      operationId: answer.operationId,
      routingRevision: answer.routingRevision,
      runtimeEpoch: answer.runtimeEpoch,
      state: answer.state,
      toTargetId: answer.toTargetId,
    },
  };
}

/**
 * The answer of one cancel, decided by the state the record had when it was looked over. A
 * parked intent goes through the balancer's own entry, which is the only thing that moves it;
 * everything already finished is refused by name so a route that changed is never reported as
 * having been called off. An `expired` record says what invalidated it, because that is the
 * sentence the console needs to explain why the button stopped working.
 */
function describeCancellation(
  balancer: LoadBalancer,
  record: MigrationOperationView,
  operationId: string,
): LoadBalancerCancelMoveReply {
  if (record.state === "pending_boundary") {
    const answer = balancer.cancelMoveBinding({
      operationId,
      runtimeEpoch: balancer.runtimeEpoch,
    });
    if (answer.kind === "cancelled") {
      const operation = answer.operation;
      return {
        response: {
          bindingId: operation.bindingId,
          effect: "none",
          fromTargetId: operation.sourceTargetId,
          // The group revision the intent was opened under: a cancel writes nothing, so the
          // version a client has to carry is the one it submitted against, not whatever the
          // group reached while the intent waited.
          groupRevision: operation.groupRevision,
          // The count the intent was accepted under, which `park()` keeps on the record: only a
          // parked intent is ever answered `cancelled`, and parking is what records a count. The
          // binding it waited for may have left the table by now, and a count read off a route
          // that is gone would be a guess reported as a measurement.
          inFlightAtRequest: operation.inFlightAtSubmit ?? 0,
          operationId: operation.operationId,
          // Nothing was written, so the route is still at the revision the submit named.
          routingRevision: operation.sourceRoutingRevision,
          runtimeEpoch: balancer.runtimeEpoch,
          // The balancer only answers `cancelled` for an intent it actually called off, and this
          // branch is reached only when that is what it answered.
          state: "cancelled",
          toTargetId: operation.destinationTargetId,
        },
      };
    }
    // The record was still waiting when it was looked over and was not by the time the call
    // landed. Whatever it became, the balancer's own refusal is the answer the client gets.
    return { rejection: { code: "operation_not_cancellable", detail: answer.reason.reason } };
  }
  if (record.state === "applied" || record.state === "observed") {
    return { rejection: { code: "operation_already_applied", detail: undefined } };
  }
  if (record.state === "expired" || record.state === "expired_after_apply") {
    return { rejection: { code: "operation_expired", detail: record.endReason } };
  }
  return {
    rejection: {
      code: "operation_not_cancellable",
      detail: `A ${record.state} operation cannot be cancelled.`,
    },
  };
}
