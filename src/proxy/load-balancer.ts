import type {
  LoadBalancerGroup,
  LoadBalancerStrategy,
  ProxyPair,
  TargetConfig,
} from "../config/index.js";

import { loadBalancerMemberModelId, loadBalancerMemberTargetIds } from "../config/index.js";
import { createRequestId, stableJsonStringify, StructuredLogger } from "../shared/index.js";

import {
  BindingActivityLedger,
  type BindingActivity,
  type BindingUsageObservation,
} from "./binding-activity.js";
import { LoadAffinityTable, type AffinityBinding } from "./load-affinity.js";
import { INITIAL_GROUP_REVISION, type BindingRef } from "./load-migration-contract.js";
import {
  MigrationOperationStore,
  migrationRequestDigest,
  type CancelMoveOutcome,
  type CancelMoveRequest,
  type MigrationOperation,
  type MigrationOperationView,
  type MigrationRejection,
  type MigrationRejectionCode,
  type MoveBindingOutcome,
  type MoveBindingRequest,
} from "./load-migration.js";
import { tryCanonicalNodeKey } from "./node-identity.js";
import { modelPatternMatches } from "./routing.js";
import type { TaskIdentity } from "./protocol/task-identity.js";

/**
 * Per-pair load balancing state. The object outlives every pipeline rebuild, so
 * bindings, reservations and sampling state survive a configuration save. It only
 * knows node identity; URLs, credentials and request transforms stay in the pipeline.
 */

/** How stale a metric sample may be before it stops counting as load evidence. */
export const METRIC_FRESH_WINDOW_MS = 15_000;
/** A node at or above this share of its KV cache is treated as nearly full. */
export const KV_TIER_THRESHOLD = 0.9;
/** Cooldown grows exponentially and never exceeds this. */
export const MAX_COOLDOWN_MS = 60_000;
const BASE_COOLDOWN_MS = 1_000;
const MISSING_KV_USAGE = 1;

/** Until LB-08 samples the engines, selection runs on local reservations alone. */
export const EMPTY_LOAD_SAMPLES: ReadonlyMap<string, LoadSample> = new Map<string, LoadSample>();

/**
 * What one upstream engine answered at one moment. The numbers are what the engine said,
 * never what the proxy would have liked it to say: a field the engine left out stays
 * missing, and a missing field is a different fact from a zero. Only `running: 0` may make
 * a node look idle; `running: undefined` says the engine was asked and did not answer.
 */
export interface LoadSample {
  /** Which read of its physical engine produced this. Aliases of one key share the number. */
  readonly sampleSequence: number;
  /** When that read happened, on the pair's own clock. */
  readonly sampledAt: number;
  readonly running: number | undefined;
  readonly waiting: number | undefined;
  readonly kvUsage: number | undefined;
  readonly source: string;
  /** False only when the engine says it is asleep; then it is not selectable. */
  readonly awake?: boolean | undefined;
}

export interface LoadBalancerNode {
  readonly targetId: string;
  canonicalKey: string;
  enabled: boolean;
  /** Raw configuration values, needed to reach the engine's /metrics endpoint. */
  targetUrl: string;
  apiKey: string;
  lastDispatchedAt: number | undefined;
  cooldownUntil: number | undefined;
  failures: number;
  /** The latest parsed upstream sample, or nothing when metrics never worked. */
  sample: LoadSample | undefined;
}

export interface LoadBalancerGroupMatch {
  readonly group: LoadBalancerGroup;
  readonly table: LoadAffinityTable;
}

export interface LoadBalancerDecision {
  readonly groupId: string;
  readonly groupName: string;
  readonly strategy: LoadBalancerStrategy;
  readonly targetId: string;
  /** `affinity` reuses an existing binding, `new_task` created one. */
  readonly decision: "affinity" | "new_task";
  readonly matchedBy: "exact_key" | "prefix_bucket" | "new_task";
  readonly load: number;
  readonly kvUsage: number | undefined;
  readonly metricsSource: string | undefined;
}

/**
 * A synchronous choice. The caller owns the reservation: `release` must run once, no
 * matter whether the response finished, the client went away or the upstream failed.
 * `bindingRef` is the identity this reservation was created with, so a late release or a
 * late write can be checked against the current table instead of guessing by number.
 */
export interface LoadBalancerReservation {
  readonly decision: LoadBalancerDecision;
  readonly binding: AffinityBinding;
  readonly bindingRef: BindingRef;
  markDispatched(now?: number): void;
  release(): void;
}

export interface LoadBalancerPlanInput {
  readonly group: LoadBalancerGroup;
  readonly identity: TaskIdentity;
  readonly samples?: ReadonlyMap<string, LoadSample> | undefined;
  readonly now?: number | undefined;
  /** Nodes to leave out of the candidate list, used by a failover attempt. */
  readonly exclude?: ReadonlySet<string> | undefined;
}

export interface LoadBalancerOptions {
  readonly ttlMs?: number | undefined;
  readonly maxBindingsPerGroup?: number | undefined;
  readonly maxBucketSize?: number | undefined;
  readonly maxBucketScan?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Where the migration audit line goes; the default is the process's structured log. */
  readonly logger?: Pick<StructuredLogger, "info"> | undefined;
  /** How many migration records this runtime may hold; the documented cap is the default. */
  readonly maxMigrationRecords?: number | undefined;
}

export interface LoadBalancerSnapshot {
  readonly pairId: string;
  readonly groupIds: readonly string[];
  readonly nodes: readonly {
    readonly targetId: string;
    readonly canonicalKey: string;
    readonly enabled: boolean;
    readonly inFlight: number;
  }[];
  readonly bindings: Readonly<Record<string, number>>;
}

/**
 * One binding as the activity projection sees it: its identity, its target and the
 * ledger of what the request path has recorded against it. Built without calling
 * `lookup()`, so reading a list changes no TTL, no counter and no target.
 */
export interface LoadBalancerBindingEntry {
  readonly ref: BindingRef;
  readonly targetId: string;
  readonly routingRevision: number;
  readonly lastSeenAt: number;
  readonly lastBoundAt: number;
  readonly requestCount: number;
  readonly activity: BindingActivity;
}

/** The whole group's binding list with the versions a reader needs to trust it. */
export interface LoadBalancerBindingSnapshot {
  readonly runtimeEpoch: string;
  readonly groupId: string;
  readonly groupRevision: number | undefined;
  readonly entries: readonly LoadBalancerBindingEntry[];
}

export class LoadBalancer {
  readonly #pairId: string;
  readonly #options: LoadBalancerOptions;
  /**
   * Identity of this runtime. A LoadBalancer instance is the pair's long-lived state: built
   * when the pair starts, kept through a reload that leaves the listener alone, dropped when
   * the pair stops and replaced by a new one on the next start. So the value created here
   * changes exactly when the design says it must - pair stop, pair restart, process restart -
   * and survives exactly when it must not.
   */
  readonly #runtimeEpoch: string = createRequestId();
  /** The pair's clock, shared by the affinity tables and every ledger timestamp. */
  readonly #clock: () => number;
  /** Where the migration audit line goes. */
  readonly #logger: Pick<StructuredLogger, "info">;
  /** The bounded, runtime-scoped record of every move this pair was asked to make. */
  readonly #migrations: MigrationOperationStore;
  #groupRevisions = new Map<string, number>();
  #groupSignatures = new Map<string, string>();
  /** Revisions of groups that left the configuration, kept so a number is never replayed. */
  #retiredGroupRevisions = new Map<string, number>();
  /** One allocator for every table of this runtime, so incarnations never repeat here. */
  #nextIncarnation = 1;
  #nodes = new Map<string, LoadBalancerNode>();
  readonly #tables = new Map<string, LoadAffinityTable>();
  readonly #reservations = new Map<string, number>();
  /** Per-binding activity, keyed by incarnation so a reused number can never collide. */
  readonly #activity = new BindingActivityLedger();
  #groups: LoadBalancerGroup[] = [];
  #groupById = new Map<string, LoadBalancerGroup>();

  constructor(pairId: string, options: LoadBalancerOptions = {}) {
    this.#pairId = pairId;
    this.#options = options;
    this.#clock = options.now ?? Date.now;
    this.#logger =
      options.logger ??
      new StructuredLogger({ service: "llm-proxy-load-balancer", minimumLevel: "info" });
    this.#migrations = new MigrationOperationStore({
      pairId,
      now: this.#clock,
      logger: this.#logger,
      maxRecords: options.maxMigrationRecords,
    });
  }

  get pairId(): string {
    return this.#pairId;
  }

  /** The runtime every binding reference from this balancer carries. */
  get runtimeEpoch(): string {
    return this.#runtimeEpoch;
  }

  /** Apply a new configuration without dropping anything that is still valid. */
  reconfigure(pair: ProxyPair): void {
    this.#groups = [...pair.load_balancers];
    const configured = pair.targets;
    const next = new Map<string, LoadBalancerNode>();
    for (const target of configured) {
      const existing = this.#nodes.get(target.id);
      const node = existing ?? {
        targetId: target.id,
        canonicalKey: canonicalKeyFor(target),
        enabled: target.enabled,
        targetUrl: target.target_url,
        apiKey: target.target_api_key,
        lastDispatchedAt: undefined,
        cooldownUntil: undefined,
        failures: 0,
        sample: undefined,
      };
      node.canonicalKey = canonicalKeyFor(target);
      node.enabled = target.enabled;
      node.targetUrl = target.target_url;
      node.apiKey = target.target_api_key;
      next.set(target.id, node);
    }
    this.#nodes = next;
    this.#syncGroupVersions(pair);

    const groups = new Map<string, LoadBalancerGroup>();
    for (const group of pair.load_balancers) {
      groups.set(group.id, group);
    }
    this.#groupById = groups;
    for (const groupId of [...this.#tables.keys()]) {
      if (!groups.has(groupId)) {
        this.#tables.delete(groupId);
      }
    }
    for (const groupId of groups.keys()) {
      if (!this.#tables.has(groupId)) {
        this.#tables.set(groupId, this.#newTable());
      }
    }

    // Only prune what became invalid: removed nodes, disabled nodes and nodes that
    // left this particular group. Everything else keeps its binding.
    for (const [groupId, table] of this.#tables.entries()) {
      const group = groups.get(groupId);
      const allowed = new Set<string>(
        group === undefined
          ? []
          : loadBalancerMemberTargetIds(group).filter(
              (targetId) => next.get(targetId)?.enabled === true,
            ),
      );
      table.pruneTargets(allowed);
    }
    // A configuration save moves group revisions and can retire a group or a node, so every
    // intent that is still waiting is re-checked here: what it was registered under has to be
    // what the pair still is, or the intent is expired rather than silently kept.
    this.#refreshMigrationStates("reload");
  }

  nodes(): readonly LoadBalancerNode[] {
    return [...this.#nodes.values()];
  }

  nodeFor(targetId: string): LoadBalancerNode | undefined {
    return this.#nodes.get(targetId);
  }

  /** Every node this pair knows about, in configuration order. */
  nodeIds(): readonly string[] {
    return [...this.#nodes.keys()];
  }

  /** Every pair target that sits behind the same physical engine. */
  targetsForCanonicalKey(canonicalKey: string): readonly string[] {
    const ids: string[] = [];
    for (const node of this.#nodes.values()) {
      if (node.canonicalKey === canonicalKey) {
        ids.push(node.targetId);
      }
    }
    return ids;
  }

  tableFor(groupId: string): LoadAffinityTable | undefined {
    return this.#tables.get(groupId);
  }

  /**
   * The group's current version. A caller that saw an older number is stale: the bindings
   * may still be valid, but the target configuration behind them is not what was checked.
   * Nothing is handed out for a group this runtime never had, and a number is never reused.
   */
  groupRevision(groupId: string): number | undefined {
    return this.#groupRevisions.get(groupId);
  }

  /** The identity a caller has to carry to address this binding. */
  bindingRefFor(groupId: string, binding: AffinityBinding): BindingRef {
    return {
      runtimeEpoch: this.#runtimeEpoch,
      groupId,
      bindingId: binding.id,
      routingRevision: binding.routingRevision,
      incarnation: binding.incarnation,
    };
  }

  /**
   * Resolve a binding reference against this runtime. Four different things make a reference
   * dead, and all four resolve to nothing: a runtime that has since been replaced, a group
   * that disappeared, a binding that was evicted, and a numeric id a rebuilt table handed to
   * a different binding. A late write therefore can only ever reach the binding it was
   * created with, never the one that happens to share its number.
   */
  bindingForRef(ref: BindingRef): AffinityBinding | undefined {
    if (ref.runtimeEpoch !== this.#runtimeEpoch) {
      return undefined;
    }
    const table = this.#tables.get(ref.groupId);
    if (table === undefined) {
      return undefined;
    }
    const binding = table.bindingForId(ref.bindingId);
    if (binding === undefined) {
      return undefined;
    }
    return binding.incarnation === ref.incarnation ? binding : undefined;
  }

  /**
   * Record the request body size for the binding this reservation routes, at selection
   * time. It is the coarse cost signal the ledger falls back to when no usage protocol
   * answered; the body itself is never stored. A write against a binding the table has
   * given up on teaches nothing, same as a late response-id write.
   */
  noteBindingRequestBytes(ref: BindingRef, bytes: number): void {
    if (this.bindingForRef(ref) === undefined) {
      return;
    }
    this.#activity.noteRequestBytes(ref.incarnation, bytes);
  }

  /**
   * Backfill the latest usage after a response finished. Complete normalizations become
   * token signals with their endpoint and time; an unavailable one keeps the coarse
   * signal (body size when it was recorded, otherwise nothing) and never invents tokens.
   */
  recordBindingUsage(ref: BindingRef, observation: BindingUsageObservation): void {
    if (this.bindingForRef(ref) === undefined) {
      return;
    }
    this.#activity.recordUsage(ref.incarnation, observation, this.#clock());
  }

  /**
   * Internal carrier of the protection a manual move grants. The manual migration
   * service (TRI-07, TRI-08) is what will call these; nothing else sets the flag yet.
   */
  setManualProtection(ref: BindingRef): void {
    if (this.bindingForRef(ref) === undefined) {
      return;
    }
    this.#activity.setManualProtection(ref.incarnation, this.#clock());
  }

  /** Drop the manual protection flag when the user cancels or its lifecycle ends. */
  clearManualProtection(ref: BindingRef): void {
    if (this.bindingForRef(ref) === undefined) {
      return;
    }
    this.#activity.clearManualProtection(ref.incarnation);
  }

  /**
   * The one entry that moves a binding's target. A manual move (TRI-08) and a future automatic
   * policy (TRI-10) both call this, and nothing outside `LoadAffinityTable.rebind()` assigns
   * `targetId`. Every gate is checked twice - once here at submit and once again inside the
   * write - because a parked intent waits across `await` boundaries where the group, the target
   * configuration or the binding itself can change.
   *
   * What an answer claims, and what it does not: `applied` means the in-memory route changed
   * and the next request will see it; `pending_boundary` means nothing has changed yet;
   * `observed` is only reached later, when a request actually reserved the destination. None of
   * them says the upstream answered, and none of them touches a request already in flight.
   */
  moveBinding(request: MoveBindingRequest): MoveBindingOutcome {
    const digest = migrationRequestDigest(request);
    const idempotencyKey = request.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const replay = this.#migrations.findReplay(request.runtimeEpoch, idempotencyKey, digest);
      if (replay !== undefined) {
        // The same key with the same parameters never writes twice.
        return { kind: "replayed", operation: this.#migrations.viewOf(replay), effect: "none" };
      }
      const clash = this.#migrations.findByIdempotencyKey(request.runtimeEpoch, idempotencyKey);
      if (clash !== undefined) {
        return {
          kind: "rejected",
          operationId: clash.operationId,
          rejection: {
            code: "idempotency_conflict",
            reason: "That idempotency key was already used for a different move in this runtime.",
          },
        };
      }
    }

    const binding = this.bindingForRef(this.#moveRef(request));
    let rejection = this.#identityRejection(request, binding);
    if (rejection === undefined && binding !== undefined) {
      if (binding.targetId === request.destinationTargetId) {
        // Nothing to move, so nothing is recorded: no write happened and there is no outcome
        // worth auditing. A retry of the same key answers the same way.
        return { kind: "already_there", targetId: binding.targetId };
      }
      rejection =
        this.#eligibilityRejection(request.groupId, binding, request.destinationTargetId) ??
        this.#stateRejection(binding);
    }

    const operation = this.#migrations.open(request, digest);
    if (operation === undefined) {
      // The store had no room for a record. A refusal the gates already found is still the
      // answer the caller needs, so it is reported as found; only a move that would have gone
      // through is refused for the store's own limit.
      return {
        kind: "rejected",
        operationId: undefined,
        rejection:
          rejection ??
          migrationRejection(
            "migration_backlog_full",
            "This runtime is holding as many migration records as it is allowed to.",
          ),
      };
    }
    if (rejection !== undefined) {
      this.#migrations.reject(operation, rejection);
      return {
        kind: "rejected",
        operationId: operation.operationId,
        rejection,
      };
    }

    const attempt = this.#attemptMove(operation);
    if (attempt.kind === "applied") {
      this.#migrations.apply(operation, attempt.routingRevision);
      return {
        kind: "applied",
        operation: this.#migrations.viewOf(operation),
        effect: "next_request",
      };
    }
    if (attempt.kind === "blocked") {
      this.#migrations.reject(operation, attempt.rejection);
      return {
        kind: "rejected",
        operationId: operation.operationId,
        rejection: attempt.rejection,
      };
    }
    this.#migrations.park(operation, attempt.inFlight);
    return {
      kind: "pending_boundary",
      operation: this.#migrations.viewOf(operation),
      inFlightAtSubmit: attempt.inFlight,
      effect: "next_request",
    };
  }

  /**
   * Call off an intent that has not been applied yet. An applied move cannot be rewritten as
   * cancelled - the route did change - so the answer points the user at a move in the other
   * direction instead of pretending the write never happened.
   */
  cancelMoveBinding(request: CancelMoveRequest): CancelMoveOutcome {
    if (request.runtimeEpoch !== this.#runtimeEpoch) {
      return {
        kind: "rejected",
        reason: {
          code: "operation_not_found",
          reason: "That runtime epoch is not the one this pair is running now.",
        },
      };
    }
    const operation = this.#migrations.get(request.operationId);
    if (operation === undefined) {
      return {
        kind: "rejected",
        reason: {
          code: "operation_not_found",
          reason: "No migration record carries that id in this runtime.",
        },
      };
    }
    if (operation.state === "pending_boundary") {
      this.#migrations.cancel(operation);
      return { kind: "cancelled", operation: this.#migrations.viewOf(operation) };
    }
    if (operation.state === "applied" || operation.state === "observed") {
      return {
        kind: "rejected",
        reason: {
          code: "already_applied",
          reason: "The route already moved; a cancel cannot undo it. Submit a move back instead.",
        },
      };
    }
    return {
      kind: "rejected",
      reason: {
        code: "operation_not_cancellable",
        reason: `A record that is already ${operation.state} cannot be cancelled.`,
      },
    };
  }

  /**
   * Everything this runtime recorded about moves, as copies. This is the read a future list
   * uses; it touches nothing: no TTL refresh, no counter, no target, no eviction.
   */
  migrationOperations(): readonly MigrationOperationView[] {
    return this.#migrations.operations();
  }

  /**
   * A failover is an availability action and outranks a parked or applied intent: it takes the
   * binding now, so the intent that named this binding is dead. Pending intents expire and an
   * applied one becomes `expired_after_apply`, because the route moved again before anyone
   * could see the next request use the destination.
   */
  invalidateMigrationsFor(ref: BindingRef, reason: string): number {
    let expired = 0;
    for (const operation of this.#migrations.pendingFor(ref.incarnation)) {
      this.#migrations.expire(operation, `${reason} moved this binding before its boundary`);
      expired += 1;
    }
    for (const operation of this.#migrations.appliedFor(ref.incarnation)) {
      this.#migrations.expireAfterApply(
        operation,
        `${reason} moved the route again before the next request`,
      );
      expired += 1;
    }
    return expired;
  }

  /**
   * Re-check every live intent against the current state and drop records that stopped being
   * worth their space. The load monitor runs this after the TTL sweep, so an intent whose
   * binding was evicted and an intent whose target went away are reported here.
   */
  sweepPendingMigrations(): number {
    const expired = this.#refreshMigrationStates("the retention window");
    this.#migrations.dropExpiredRecords();
    return expired;
  }

  /**
   * One move attempt: re-read the binding, re-validate everything the submit validated, then
   * write. The revision bump and the target write are one step inside `rebind()`, so a reader
   * can never see a moved target still wearing the old revision. No reservation is established
   * here: the next request's `plan()` is the only place a reservation is made, and a reservation
   * already in flight is never re-bound by a move.
   */
  #attemptMove(operation: MigrationOperation): MoveAttempt {
    const binding = this.bindingForRef(this.#operationRef(operation));
    if (binding === undefined) {
      return {
        kind: "blocked",
        rejection: migrationRejection(
          "binding_not_found",
          "The binding left the table before the move could be applied.",
        ),
      };
    }
    const drift = this.#versionDrift(operation, binding);
    if (drift !== undefined) {
      return { kind: "blocked", rejection: drift };
    }
    const eligibility = this.#eligibilityRejection(
      operation.groupId,
      binding,
      operation.destinationTargetId,
    );
    if (eligibility !== undefined) {
      return { kind: "blocked", rejection: eligibility };
    }
    const state = this.#stateRejection(binding);
    if (state !== undefined) {
      return { kind: "blocked", rejection: state };
    }
    const inFlight = this.#activity.read(binding.incarnation).inFlight;
    if (inFlight > 0) {
      return { kind: "waiting", inFlight };
    }
    const table = this.#tables.get(operation.groupId);
    if (table === undefined) {
      return {
        kind: "blocked",
        rejection: migrationRejection(
          "binding_not_found",
          "The group's affinity table is gone from this runtime.",
        ),
      };
    }
    if (!table.rebind(binding, operation.destinationTargetId)) {
      return {
        kind: "blocked",
        rejection: migrationRejection(
          "binding_not_found",
          "The table gave this binding up between the check and the write.",
        ),
      };
    }
    if (operation.requestedBy === "manual") {
      // A human moved it, so a future automatic policy has to leave it alone.
      this.setManualProtection(this.#operationRef(operation));
    }
    return { kind: "applied", routingRevision: binding.routingRevision };
  }

  /**
   * The request boundary: the moment a reservation came back and nothing is in flight on this
   * binding any more. Parked intents get their second look here, which is what makes "the next
   * request goes to the target" true without ever touching the request that just finished.
   */
  #applyMigrationsAtBoundary(ref: BindingRef): void {
    for (const operation of this.#migrations.pendingFor(ref.incarnation)) {
      const attempt = this.#attemptMove(operation);
      if (attempt.kind === "applied") {
        this.#migrations.apply(operation, attempt.routingRevision);
      } else if (attempt.kind === "blocked") {
        this.#migrations.expire(operation, attempt.rejection.reason);
      }
      // `waiting` means another request is already in flight on this binding: the intent stays
      // parked and the current request keeps the target it was given.
    }
  }

  /** Mark an applied intent observed when this reservation actually routes to its destination. */
  #markMigrationObserved(binding: AffinityBinding, targetId: string): void {
    for (const operation of this.#migrations.appliedFor(binding.incarnation)) {
      if (operation.destinationTargetId !== targetId) {
        continue;
      }
      if (operation.appliedRoutingRevision !== binding.routingRevision) {
        continue;
      }
      this.#migrations.observe(operation);
    }
  }

  /**
   * Look every live intent over against the current runtime and versions. Anything that drifted
   * stops being applicable: a binding that left the table, a group revision that moved, a
   * target that went away, a route someone else moved. An applied intent whose binding vanished
   * or whose route moved again is `expired_after_apply` - the write happened, the next request
   * will not use the destination.
   */
  #refreshMigrationStates(cause: string): number {
    let expired = 0;
    const now = this.#clock();
    for (const operation of this.#migrations.live()) {
      if (operation.state === "applied") {
        if (operation.expiresAt <= now) {
          // Nobody came back to the destination within the window, so the intent stops being
          // something anyone could report on. The write did happen; it just was never followed.
          this.#migrations.expireAfterApply(
            operation,
            "no next request arrived within the retention window",
          );
          expired += 1;
          continue;
        }
        const binding = this.bindingForRef(this.#operationRef(operation));
        if (binding === undefined) {
          this.#migrations.expireAfterApply(
            operation,
            "the binding left the table before the next request",
          );
          expired += 1;
          continue;
        }
        if (operation.appliedRoutingRevision !== binding.routingRevision) {
          this.#migrations.expireAfterApply(
            operation,
            "the route moved again before the next request",
          );
          expired += 1;
        }
        continue;
      }
      if (operation.expiresAt <= now) {
        this.#migrations.expire(operation, `${cause} passed while the intent waited`);
        expired += 1;
        continue;
      }
      const drift = this.#driftReason(operation);
      if (drift !== undefined) {
        this.#migrations.expire(operation, drift);
        expired += 1;
      }
    }
    return expired;
  }

  /** Why a waiting intent can no longer be applied, or nothing when it still can. */
  #driftReason(operation: MigrationOperation): string | undefined {
    const binding = this.bindingForRef(this.#operationRef(operation));
    if (binding === undefined) {
      return "the binding left the table";
    }
    const drift =
      this.#versionDrift(operation, binding) ??
      this.#eligibilityRejection(operation.groupId, binding, operation.destinationTargetId) ??
      this.#stateRejection(binding);
    return drift?.reason;
  }

  /** How a caller addresses the binding a move request names. */
  #moveRef(request: MoveBindingRequest): BindingRef {
    return {
      runtimeEpoch: request.runtimeEpoch,
      groupId: request.groupId,
      bindingId: request.bindingId,
      routingRevision: request.expectedRoutingRevision,
      incarnation: request.incarnation,
    };
  }

  /** How the store's own record addresses the binding it was opened for. */
  #operationRef(operation: MigrationOperation): BindingRef {
    return {
      runtimeEpoch: operation.runtimeEpoch,
      groupId: operation.groupId,
      bindingId: operation.bindingId,
      routingRevision: operation.sourceRoutingRevision,
      incarnation: operation.incarnation,
    };
  }

  /**
   * Whether the caller still has the binding it says it has. A stale revision or a source target
   * that is no longer the binding's target means two people looked at the same binding and only
   * one of them is current, so the write is refused rather than allowed to overwrite.
   */
  #identityRejection(
    request: MoveBindingRequest,
    binding: AffinityBinding | undefined,
  ): MigrationRejection | undefined {
    if (binding === undefined) {
      return migrationRejection(
        "binding_not_found",
        "No binding in this runtime matches that runtime epoch, group, binding id and incarnation.",
      );
    }
    if (this.#groupById.get(request.groupId) === undefined) {
      return migrationRejection(
        "binding_not_found",
        "The group that binding names is no longer configured on this pair.",
      );
    }
    const groupRevision = this.#groupRevisions.get(request.groupId);
    if (groupRevision === undefined || groupRevision !== request.groupRevision) {
      return migrationRejection(
        "stale_group_revision",
        `The group is at revision ${groupRevision ?? "unassigned"}, not ${request.groupRevision}.`,
      );
    }
    if (binding.routingRevision !== request.expectedRoutingRevision) {
      return migrationRejection(
        "stale_routing_revision",
        `The binding is at routing revision ${binding.routingRevision}, not ${request.expectedRoutingRevision}.`,
      );
    }
    if (binding.targetId !== request.expectedSourceTargetId) {
      return migrationRejection(
        "source_target_mismatch",
        `The binding is on ${binding.targetId}, not on ${request.expectedSourceTargetId}.`,
      );
    }
    return undefined;
  }

  /** Version drift between what a record was opened under and what the binding is now. */
  #versionDrift(
    operation: MigrationOperation,
    binding: AffinityBinding,
  ): MigrationRejection | undefined {
    const groupRevision = this.#groupRevisions.get(operation.groupId);
    if (groupRevision === undefined || groupRevision !== operation.groupRevision) {
      return migrationRejection(
        "stale_group_revision",
        `The group is at revision ${groupRevision ?? "unassigned"}, not ${operation.groupRevision}.`,
      );
    }
    if (binding.routingRevision !== operation.sourceRoutingRevision) {
      return migrationRejection(
        "stale_routing_revision",
        `The binding is at routing revision ${binding.routingRevision}, not ${operation.sourceRoutingRevision}.`,
      );
    }
    if (binding.targetId !== operation.sourceTargetId) {
      return migrationRejection(
        "source_target_mismatch",
        `The binding is on ${binding.targetId}, not on ${operation.sourceTargetId}.`,
      );
    }
    return undefined;
  }

  /**
   * Whether the destination may receive this task at all. Every refusal is one condition, in
   * the order the request path would have checked them: it has to be a member of this group,
   * configured, enabled, out of cooldown, awake, a different physical engine, and forwarding the
   * same model name. v1 has no compatibility-domain declaration, so a different `model_id` is
   * simply refused.
   */
  #eligibilityRejection(
    groupId: string,
    binding: AffinityBinding,
    destinationTargetId: string,
  ): MigrationRejection | undefined {
    const group = this.#groupById.get(groupId);
    if (group === undefined) {
      return migrationRejection(
        "binding_not_found",
        "The group this intent was opened for is no longer configured on this pair.",
      );
    }
    if (!loadBalancerMemberTargetIds(group).includes(destinationTargetId)) {
      return migrationRejection(
        "target_not_in_group",
        `${destinationTargetId} is not a member of group ${groupId}.`,
      );
    }
    const destination = this.#nodes.get(destinationTargetId);
    if (destination === undefined) {
      return migrationRejection(
        "target_unknown",
        `${destinationTargetId} is no longer a target of this pair.`,
      );
    }
    if (!destination.enabled) {
      return migrationRejection(
        "target_disabled",
        `${destinationTargetId} is disabled, so a move would be undone by the next reload.`,
      );
    }
    const now = this.#clock();
    const cooldownMs = this.cooldownRemaining(destinationTargetId, now);
    if (cooldownMs > 0) {
      return migrationRejection(
        "target_cooldown",
        `${destinationTargetId} is cooling down for ${cooldownMs} more ms after a connection failure.`,
      );
    }
    if (isAsleep(destination.sample, now)) {
      return migrationRejection(
        "target_asleep",
        `${destinationTargetId} reported it is asleep, so it cannot take the task.`,
      );
    }
    const source = this.#nodes.get(binding.targetId);
    if (source === undefined) {
      return migrationRejection(
        "target_unknown",
        `The node this binding is on, ${binding.targetId}, is no longer a target of this pair.`,
      );
    }
    if (source.canonicalKey === destination.canonicalKey) {
      return migrationRejection(
        "same_physical_key",
        `${destinationTargetId} is another spelling of the engine this binding is already on (${source.canonicalKey}).`,
      );
    }
    const sourceModel = loadBalancerMemberModelId(group, binding.targetId);
    const destinationModel = loadBalancerMemberModelId(group, destinationTargetId);
    if (sourceModel !== destinationModel) {
      return migrationRejection(
        "model_mismatch",
        `${binding.targetId} forwards to ${sourceModel ?? "the requested model"} while ${destinationTargetId} forwards to ${destinationModel ?? "the requested model"}; v1 only moves between members with the same model id.`,
      );
    }
    return undefined;
  }

  /**
   * The server-side state gate, and the reason it looks the way it does.
   *
   * The only fact available to a move is what the binding's own evidence says. Three endpoint
   * kinds carry their whole conversation in the request body - `requestUserMessages` reads
   * `messages` for chat and messages and `prompt` for completions - so a move cannot strand
   * state the request did not bring with it. `responses` is the opposite: a request may name a
   * `previous_response_id` or a stored conversation and send almost nothing itself, and nothing
   * in this proxy proves the next engine can read that object. `other` is unknown by definition.
   *
   * A `response:` exact key carries no provenance, and that is what settles the gate.
   * `taskExactKeys` writes one from a request's `previous_response_id`, while `attachResponseIds`
   * writes one from an id a finished response body produced; the table stores both into the same
   * `binding.exactKeys` set as the same `response:<id>` string, so no reader can tell a state the
   * client depends on from an artefact an engine merely emitted. A request may name a response and
   * still carry its whole conversation, which is the shape this gate used to let through: the key
   * says the task is addressed through a response object, and that is a dependency this runtime
   * cannot prove portable whatever the endpoint kind is. Since the question has no answer, one
   * response key refuses the move everywhere - a chat task that learned its id from a finished
   * body is held for the same reason as one that names `previous_response_id` - until TRI-11
   * proves response state is shared across engines.
   *
   * What is left is the proof that needs no answer to that question: a self-contained kind moves
   * only when it holds no response key and the binding's own evidence shows user content came in
   * the body that created it. Without that content the request may be reading state that lives on
   * one engine, so it is refused as `state_unknown`. A `conversation`, `thread` or session key is
   * never accepted as proof - it is a client-side clue, and the same clue can name a conversation
   * the next engine has never seen.
   */
  #stateRejection(binding: AffinityBinding): MigrationRejection | undefined {
    if (carriesResponseChain(binding)) {
      return migrationRejection(
        "response_state_dependency",
        "This task is addressed through a response id, and nothing proves another engine can read that response.",
      );
    }
    const kind = binding.evidence.kind;
    if (!SELF_CONTAINED_ENDPOINT_KINDS.has(kind)) {
      return migrationRejection(
        "state_unknown",
        `The ${kind} endpoint may keep server-side state the request does not carry, and this runtime cannot prove the destination can reach it.`,
      );
    }
    if (!carriesConversationEvidence(binding)) {
      return migrationRejection(
        "state_unknown",
        `A ${kind} request that brought no user content of its own may be reading state that lives on one engine, and this runtime cannot prove the destination can reach it.`,
      );
    }
    return undefined;
  }

  /**
   * The binding list of one group joined with its activity ledger. This is the read the
   * future node list consumes instead of `lookup()`: it refreshes no TTL, bumps no
   * counter, moves no target and evicts nothing while it reads.
   */
  bindingSnapshot(groupId: string): LoadBalancerBindingSnapshot | undefined {
    const table = this.#tables.get(groupId);
    if (table === undefined) {
      return undefined;
    }
    const entries = table.bindingEntries().map((binding) => ({
      ref: {
        runtimeEpoch: this.#runtimeEpoch,
        groupId,
        bindingId: binding.bindingId,
        routingRevision: binding.routingRevision,
        incarnation: binding.incarnation,
      },
      targetId: binding.targetId,
      routingRevision: binding.routingRevision,
      lastSeenAt: binding.lastSeenAt,
      lastBoundAt: binding.lastBoundAt,
      requestCount: binding.requestCount,
      activity: this.#activity.read(binding.incarnation),
    }));
    return {
      runtimeEpoch: this.#runtimeEpoch,
      groupId,
      groupRevision: this.#groupRevisions.get(groupId),
      entries,
    };
  }

  /**
   * Garbage-collect ledgers whose binding left the table and holds nothing in flight.
   * Entries of evicted bindings that still carry a live reservation survive: the late
   * release must find its own ledger, and after it lands the sweep (or the release
   * itself) removes the entry. The monitor runs this right after the TTL sweep.
   */
  sweepBindingActivity(): number {
    const live = new Set<number>();
    for (const table of this.#tables.values()) {
      for (const entry of table.bindingEntries()) {
        live.add(entry.incarnation);
      }
    }
    return this.#activity.dropWhere(
      (incarnation, activity) => activity.inFlight === 0 && !live.has(incarnation),
    );
  }

  groupIds(): readonly string[] {
    return [...this.#tables.keys()];
  }

  /** The configuration object of a group, as it stood at the last reconfigure. */
  groupFor(groupId: string): LoadBalancerGroup | undefined {
    return this.#groupById.get(groupId);
  }

  /** Node-held metrics, used when the caller does not pass a snapshot of its own. */
  samples(): Map<string, LoadSample> {
    const samples = new Map<string, LoadSample>();
    for (const [targetId, node] of this.#nodes) {
      if (node.sample !== undefined) {
        samples.set(targetId, node.sample);
      }
    }
    return samples;
  }

  sampleFor(targetId: string): LoadSample | undefined {
    return this.#nodes.get(targetId)?.sample;
  }

  /** Store the latest parsed sample for one node; nothing raw from the engine is kept. */
  setSample(targetId: string, sample: LoadSample | undefined): void {
    const node = this.#nodes.get(targetId);
    if (node !== undefined) {
      node.sample = sample;
    }
  }

  /** The first enabled group, in configuration order, whose pattern matches the model. */
  matchGroup(requestedModel: string): LoadBalancerGroupMatch | undefined {
    if (requestedModel === "") {
      return undefined;
    }
    for (const group of this.#groups) {
      if (!group.enabled) {
        continue;
      }
      if (!modelPatternMatches(group.model_pattern, requestedModel)) {
        continue;
      }
      const table = this.#tables.get(group.id);
      if (table === undefined) {
        continue;
      }
      return { group, table };
    }
    return undefined;
  }

  /**
   * Choose a node and reserve it synchronously. Returns `undefined` when the group has
   * no usable node, which the caller must turn into a 503 instead of bypassing the group.
   */
  plan(input: LoadBalancerPlanInput): LoadBalancerReservation | undefined {
    const now = input.now ?? Date.now();
    const table = this.#tables.get(input.group.id);
    if (table === undefined) {
      return undefined;
    }
    const samples = input.samples ?? this.samples();
    const selectable = this.#selectableNodes(input.group, samples, now).filter(
      (node) => !input.exclude?.has(node.targetId),
    );
    if (selectable.length === 0) {
      return undefined;
    }

    // An affinity hit may still land on a cooling node: moving the task would cost a
    // cold prefill, which is the more expensive mistake.
    const boundNodes = new Set(
      loadBalancerMemberTargetIds(input.group).filter(
        (targetId) => this.#nodes.get(targetId)?.enabled === true,
      ),
    );
    const hit = table.lookup(input.identity, boundNodes);
    if (hit !== undefined && !input.exclude?.has(hit.binding.targetId)) {
      const targetId = hit.binding.targetId;
      // The recorded load is what the node carried when it was chosen, not counting the
      // reservation this request is about to make.
      const loadBefore = this.inFlight(targetId);
      this.reserve(targetId);
      return this.#reservation(
        hit.binding,
        {
          groupId: input.group.id,
          groupName: input.group.name,
          strategy: input.group.strategy,
          targetId,
          decision: "affinity",
          matchedBy: hit.matchedBy,
          load: loadBefore,
          kvUsage: freshKvUsage(samples.get(targetId), now),
          metricsSource: freshSample(samples.get(targetId), now)?.source,
        },
        now,
      );
    }

    const chosen =
      input.group.strategy === "round_robin"
        ? this.#pickRoundRobin(input.group, selectable)
        : this.#pickLeastLoad(input.group, selectable, samples, now);
    if (chosen === undefined) {
      return undefined;
    }

    const binding = table.bind(input.identity, chosen.targetId, { allowRebind: true });
    const loadBefore = this.#loadOf(chosen, samples.get(chosen.targetId), now);
    const sample = samples.get(chosen.targetId);
    this.reserve(chosen.targetId);
    return this.#reservation(
      binding,
      {
        groupId: input.group.id,
        groupName: input.group.name,
        strategy: input.group.strategy,
        targetId: chosen.targetId,
        decision: "new_task",
        matchedBy: "new_task",
        load: loadBefore,
        kvUsage: freshKvUsage(sample, now),
        metricsSource: freshSample(sample, now)?.source,
      },
      now,
    );
  }

  /** The chosen node received an upstream connection attempt; record when that was. */
  markDispatched(targetId: string, now = Date.now()): void {
    const node = this.#nodes.get(targetId);
    if (node !== undefined) {
      node.lastDispatchedAt = now;
    }
  }

  /** Count a connection failure and cool the node down exponentially, capped at 60s. */
  markFailure(targetId: string, now = Date.now()): number {
    const node = this.#nodes.get(targetId);
    if (node === undefined) {
      return 0;
    }
    node.failures += 1;
    const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (node.failures - 1));
    node.cooldownUntil = now + cooldown;
    return cooldown;
  }

  /** A successful connection clears the failure history and the cooldown. */
  noteSuccess(targetId: string): void {
    const node = this.#nodes.get(targetId);
    if (node === undefined) {
      return;
    }
    node.failures = 0;
    node.cooldownUntil = undefined;
  }

  /** Force a cooldown without a failure count, used by tests and manual isolation. */
  markCooldown(targetId: string, cooldownUntil: number): void {
    const node = this.#nodes.get(targetId);
    if (node !== undefined) {
      node.cooldownUntil = cooldownUntil;
    }
  }

  cooldownRemaining(targetId: string, now = Date.now()): number {
    const until = this.#nodes.get(targetId)?.cooldownUntil;
    return until === undefined ? 0 : Math.max(0, until - now);
  }

  /** Reserve one in-flight slot on a node. Called while the choice is still synchronous. */
  reserve(targetId: string): void {
    this.#reservations.set(targetId, (this.#reservations.get(targetId) ?? 0) + 1);
  }

  /** Release one slot. The ledger is per pair, so a reload cannot double count. */
  release(targetId: string): void {
    const current = this.#reservations.get(targetId) ?? 0;
    if (current <= 1) {
      this.#reservations.delete(targetId);
      return;
    }
    this.#reservations.set(targetId, current - 1);
  }

  inFlight(targetId: string): number {
    return this.#reservations.get(targetId) ?? 0;
  }

  /** A table of this runtime: its bindings get incarnations from the runtime's allocator. */
  #newTable(): LoadAffinityTable {
    return new LoadAffinityTable({
      ...this.#options,
      nextIncarnation: () => {
        const allocated = this.#nextIncarnation;
        this.#nextIncarnation += 1;
        return allocated;
      },
    });
  }

  /**
   * Version every group against its routing signature. A group keeps its revision while
   * nothing that changes routing moved; a material change - a target URL, a forwarded model
   * name, a request transform, a log root, membership or an enabled flag - bumps it, so an
   * intent registered under the old number is now visibly stale. A number is never handed
   * out twice inside one runtime: a group that comes back gets the next revision after the
   * one it retired, not the one it had before it disappeared.
   */
  #syncGroupVersions(pair: ProxyPair): void {
    const targetsById = new Map<string, TargetConfig>();
    for (const target of pair.targets) {
      targetsById.set(target.id, target);
    }

    const revisions = new Map<string, number>();
    const signatures = new Map<string, string>();
    for (const group of pair.load_balancers) {
      const signature = groupRoutingSignature(group, targetsById);
      const previousRevision = this.#groupRevisions.get(group.id);
      const previousSignature = this.#groupSignatures.get(group.id);
      const revision =
        previousRevision === undefined
          ? (this.#retiredGroupRevisions.get(group.id) ?? 0) + INITIAL_GROUP_REVISION
          : previousSignature === signature
            ? previousRevision
            : previousRevision + 1;
      revisions.set(group.id, revision);
      signatures.set(group.id, signature);
    }

    const retired = new Map(this.#retiredGroupRevisions);
    for (const [groupId, revision] of this.#groupRevisions) {
      if (!revisions.has(groupId)) {
        retired.set(groupId, revision);
      }
    }
    for (const groupId of revisions.keys()) {
      retired.delete(groupId);
    }

    this.#groupRevisions = revisions;
    this.#groupSignatures = signatures;
    this.#retiredGroupRevisions = retired;
  }

  #reservation(
    binding: AffinityBinding,
    decision: LoadBalancerDecision,
    now: number,
  ): LoadBalancerReservation {
    const targetId = decision.targetId;
    const bindingRef = this.bindingRefFor(decision.groupId, binding);
    // The reservation is established here and nowhere else, so this is the only place
    // the binding's own activity count goes up. It counts against the incarnation the
    // reservation was created with, never against a later binding reusing the number.
    this.#activity.begin(bindingRef.incarnation, now);
    this.#markMigrationObserved(binding, targetId);
    let released = false;
    return {
      decision,
      binding,
      bindingRef,
      markDispatched: (now?: number): void => {
        this.markDispatched(targetId, now);
      },
      release: (): void => {
        // Exactly one decrement of both counts, even when a client abort and a finally
        // block both fire. The binding count follows the target count: it moves after
        // the reservation was actually handed back, and a ledger that was already
        // cleaned up stays cleaned up - no negative, no resurrection, no new binding.
        if (released) {
          return;
        }
        released = true;
        this.release(targetId);
        const remaining = this.#activity.end(bindingRef.incarnation, this.#clock());
        if (remaining === 0 && this.bindingForRef(bindingRef) === undefined) {
          this.#activity.drop(bindingRef.incarnation);
        }
        // Only now is this binding at a request boundary: the counts came back, so a move that
        // was parked may be written. A binding the table already gave up on cannot be rewritten
        // by a late release - the attempt re-resolves the reference and finds nothing.
        this.#applyMigrationsAtBoundary(bindingRef);
      },
    };
  }

  /** Enabled members that are awake and out of cooldown, falling back when all are cooling. */
  #selectableNodes(
    group: LoadBalancerGroup,
    samples: ReadonlyMap<string, LoadSample> | undefined,
    now: number,
  ): LoadBalancerNode[] {
    const members = loadBalancerMemberTargetIds(group)
      .map((targetId) => this.#nodes.get(targetId))
      .filter((node): node is LoadBalancerNode => node?.enabled === true);
    if (members.length === 0) {
      return [];
    }
    const awake = members.filter((node) => !isAsleep(samples?.get(node.targetId), now));
    if (awake.length === 0) {
      return [];
    }
    const open = awake.filter(
      (node) => node.cooldownUntil === undefined || node.cooldownUntil <= now,
    );
    return open.length > 0 ? open : awake;
  }

  #rankOf(
    node: LoadBalancerNode,
    sample: LoadSample | undefined,
    now: number,
  ): { kvTier: number; load: number; lastDispatchedAt: number; kvUsage: number } {
    const kvUsage = freshKvUsage(sample, now);
    return {
      kvTier: kvUsage !== undefined && kvUsage >= KV_TIER_THRESHOLD ? 1 : 0,
      load: this.#loadOf(node, sample, now),
      lastDispatchedAt: node.lastDispatchedAt ?? Number.NEGATIVE_INFINITY,
      kvUsage: kvUsage ?? MISSING_KV_USAGE,
    };
  }

  /**
   * `running` already counts the requests the engine sees from this proxy, so the local
   * reservation is never added to it. `max` covers both sampling lag and fresh metrics.
   * A number the engine did not answer adds nothing to the sum, so what the engine gave is
   * a lower bound rather than a claim; when neither number came back there is no upstream
   * evidence to compare against, and the proxy's own reservation is the whole load it knows.
   *
   * That lower bound is the LB-05 request selector ranking on the numbers it already had - it
   * is not input an automatic judgement may act on. A strategy (TRI-10) reads
   * `assessLoadSample().usableForLoadJudgement`, which only lets a fresh, complete and awake
   * answer through, so here a partial sum may order two candidates while there it is no
   * evidence at all and a missing number is never read as an idle node.
   */
  #loadOf(node: LoadBalancerNode, sample: LoadSample | undefined, now: number): number {
    const fresh = freshSample(sample, now);
    const reported = fresh === undefined ? undefined : reportedLoad(fresh);
    const local = this.inFlight(node.targetId);
    return reported === undefined ? local : Math.max(local, reported);
  }

  #pickLeastLoad(
    group: LoadBalancerGroup,
    selectable: readonly LoadBalancerNode[],
    samples: ReadonlyMap<string, LoadSample> | undefined,
    now: number,
  ): LoadBalancerNode | undefined {
    if (selectable.length === 0) {
      return undefined;
    }
    const ranked = selectable.map((node, index) => ({
      node,
      index,
      rank: this.#rankOf(node, samples?.get(node.targetId), now),
    }));
    ranked.sort((left, right) => {
      if (left.rank.kvTier !== right.rank.kvTier) {
        return left.rank.kvTier - right.rank.kvTier;
      }
      if (left.rank.load !== right.rank.load) {
        return left.rank.load - right.rank.load;
      }
      if (left.rank.lastDispatchedAt !== right.rank.lastDispatchedAt) {
        return left.rank.lastDispatchedAt - right.rank.lastDispatchedAt;
      }
      if (left.rank.kvUsage !== right.rank.kvUsage) {
        return left.rank.kvUsage - right.rank.kvUsage;
      }
      return left.index - right.index;
    });
    return ranked[0]?.node;
  }

  /** Round robin ignores metrics and KV, but still obeys affinity and cooldown. */
  #pickRoundRobin(
    _group: LoadBalancerGroup,
    selectable: readonly LoadBalancerNode[],
  ): LoadBalancerNode | undefined {
    if (selectable.length === 0) {
      return undefined;
    }
    const ordered = selectable.map((node, index) => ({ node, index }));
    ordered.sort((left, right) => {
      const leftSeen = left.node.lastDispatchedAt ?? Number.NEGATIVE_INFINITY;
      const rightSeen = right.node.lastDispatchedAt ?? Number.NEGATIVE_INFINITY;
      if (leftSeen !== rightSeen) {
        return leftSeen - rightSeen;
      }
      return left.index - right.index;
    });
    return ordered[0]?.node;
  }

  /**
   * Drop everything the request path owns: bindings, reservations, activity ledgers and the
   * migration records. A release that arrives after a stop finds no ledger and changes nothing.
   * The group version counters stay, because they belong to this runtime and must never hand out
   * the same number twice should the pair be configured again before it is replaced. Migration
   * records do not survive: they belonged to the runtime that is going away, and a move is
   * runtime state - the next start begins with an empty store, so an old request cannot act on
   * new state.
   */
  clear(): void {
    for (const table of this.#tables.values()) {
      table.clear();
    }
    this.#tables.clear();
    this.#reservations.clear();
    this.#activity.dropAll();
    this.#migrations.dropAll();
  }

  snapshot(): LoadBalancerSnapshot {
    const bindings: Record<string, number> = {};
    for (const [groupId, table] of this.#tables.entries()) {
      bindings[groupId] = table.size;
    }
    return {
      pairId: this.#pairId,
      groupIds: this.groupIds(),
      nodes: this.nodes().map((node) => ({
        targetId: node.targetId,
        canonicalKey: node.canonicalKey,
        enabled: node.enabled,
        inFlight: this.inFlight(node.targetId),
      })),
      bindings,
    };
  }
}

function canonicalKeyFor(target: TargetConfig): string {
  return tryCanonicalNodeKey(target.target_url) ?? target.target_url;
}

/**
 * How one move attempt ended. `waiting` is not a refusal: it means a request is still in flight
 * on this binding, so the intent stays parked and the running request keeps the route it was
 * given. `blocked` carries the one condition that stopped it.
 */
type MoveAttempt =
  | { readonly kind: "applied"; readonly routingRevision: number }
  | { readonly kind: "blocked"; readonly rejection: MigrationRejection }
  | { readonly kind: "waiting"; readonly inFlight: number };

/** One refusal, named once, with the sentence a reader or a log line shows. */
function migrationRejection(code: MigrationRejectionCode, reason: string): MigrationRejection {
  return { code, reason };
}

/**
 * The endpoint kinds whose request body carries the whole conversation: `chat` and `messages`
 * read a `messages` array, `completions` reads a `prompt`. A move between nodes cannot strand
 * state these requests did not carry with them, which is what makes them movable while a
 * `responses` request - which may name a stored response or conversation and send almost nothing
 * itself - is not.
 */
const SELF_CONTAINED_ENDPOINT_KINDS: ReadonlySet<string> = new Set<string>([
  "chat",
  "messages",
  "completions",
]);

/**
 * Whether a `response:` key points at this binding. Both sources - a request's
 * `previous_response_id` and an id a finished response body produced - land in the same set
 * under the same spelling, so this answers only "is the task addressed through a response
 * object", never "which kind of response object".
 */
function carriesResponseChain(binding: AffinityBinding): boolean {
  for (const exactKey of binding.exactKeys) {
    if (exactKey.startsWith("response:")) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the binding's own evidence shows a conversation came in the request body that created
 * it: at least one user message was read out of that body. This is the only positive proof
 * available that moving the task cannot strand context, and it needs no answer to the question
 * the exact keys cannot answer - which `response:` key names state and which one an engine
 * merely produced. No user content means no proof, so the gate refuses.
 */
function carriesConversationEvidence(binding: AffinityBinding): boolean {
  return binding.evidence.userHashes.length > 0;
}

/**
 * What makes a group route differently: which nodes it may use and what each of them
 * receives, plus the group's own model pattern, strategy, sampling and failover switches.
 * Only how a group is named is left out, because a rename sends the same request to the
 * same node, and a binding that still points at that node under those rules is still the
 * binding it was.
 */
function groupRoutingSignature(
  group: LoadBalancerGroup,
  targetsById: ReadonlyMap<string, TargetConfig>,
): string {
  return stableJsonStringify({
    enabled: group.enabled,
    failoverEnabled: group.failover_enabled,
    members: group.members.map((member) => ({
      modelId: member.model_id,
      routing: targetRoutingSettings(targetsById.get(member.target_id)),
      targetId: member.target_id,
    })),
    metricsEnabled: group.metrics_enabled,
    modelPattern: group.model_pattern,
    strategy: group.strategy,
  });
}

/** The part of a target that changes what the node receives or where its log goes. */
function targetRoutingSettings(target: TargetConfig | undefined): Record<string, unknown> | null {
  if (target === undefined) {
    // The member names a target that is no longer in the pair.
    return null;
  }
  return {
    enabled: target.enabled,
    injectRequestFields: target.inject_request_fields,
    logRoot: target.log_root,
    modelMappings: target.model_mappings,
    stripRequestFields: target.strip_request_fields,
    targetHeaders: target.target_headers,
    targetUrl: target.target_url,
  };
}

/**
 * The load the engine actually reported, read only by the request selector's ranking. A
 * missing field contributes nothing, so this is a lower bound on what the engine is doing,
 * never an invented idle. Neither field present means no upstream number at all, which is
 * reported as nothing rather than as zero. An automatic judgement does not read this sum: it
 * reads `assessLoadSample`, which marks a half answer partial and refuses it.
 */
function reportedLoad(sample: LoadSample): number | undefined {
  if (sample.running === undefined && sample.waiting === undefined) {
    return undefined;
  }
  return (sample.running ?? 0) + (sample.waiting ?? 0);
}

function freshSample(sample: LoadSample | undefined, now: number): LoadSample | undefined {
  if (sample === undefined || now - sample.sampledAt > METRIC_FRESH_WINDOW_MS) {
    return undefined;
  }
  return sample;
}

function freshKvUsage(sample: LoadSample | undefined, now: number): number | undefined {
  return freshSample(sample, now)?.kvUsage;
}

function isAsleep(sample: LoadSample | undefined, now: number): boolean {
  return freshSample(sample, now)?.awake === false;
}
