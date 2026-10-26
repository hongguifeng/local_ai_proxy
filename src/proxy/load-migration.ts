import { createRequestId, StructuredLogger, type LogContext } from "../shared/index.js";

import { isMigrationTransitionAllowed, type MigrationState } from "./load-migration-contract.js";
import { stableHash } from "./protocol/analysis.js";

/**
 * The record half of the unified safe migration service. This module owns what a migration
 * intent looks like, which states it may hold and how they may move; `LoadBalancer` owns when
 * an intent is checked and written, because only it can see bindings, reservations, nodes and
 * group versions at once. Manual moves (TRI-08) and a future automatic policy (TRI-10) both
 * go through the same `moveBinding()` entry, so neither ever assigns `targetId` on its own.
 *
 * Nothing stored here is request text, an exact key, a user message or a token: ids, versions,
 * timestamps, one digest over the routing parameters, and a bounded reason label supplied by
 * the caller. The reason is a description of why the move was asked for, never a place to put
 * request content.
 */

/**
 * How long a record stays interesting. A parked intent has to be able to outlive the longest
 * stream this proxy carries, so this is a memory bound rather than a routing threshold: it is
 * not the automatic policy's stability window, which TRI-10 calibrates separately.
 */
export const MIGRATION_RETENTION_MS = 15 * 60_000;

/**
 * How many migration records one pair runtime keeps. The affinity table is bounded at 4096
 * bindings, so one record per binding is the natural ceiling; past that the oldest finished
 * record goes first, and a store full of still-live intents refuses new work.
 */
export const MAX_MIGRATION_RECORDS = 4_096;

/** How long the caller's reason may be, so an audit line cannot grow into a request body. */
export const MAX_MIGRATION_REASON_CHARS = 200;

/** Who asked for a move. `auto` arrives with TRI-10; the entry and the audit already agree. */
export type MigrationActor = "manual" | "auto";

/** Every way a submit can be refused, each with exactly one meaning. */
export type MigrationRejectionCode =
  | "binding_not_found"
  | "stale_group_revision"
  | "stale_routing_revision"
  | "source_target_mismatch"
  | "target_unknown"
  | "target_not_in_group"
  | "target_disabled"
  | "target_cooldown"
  | "target_asleep"
  | "same_physical_key"
  | "model_mismatch"
  | "response_state_dependency"
  | "state_unknown"
  | "idempotency_conflict"
  | "migration_backlog_full";

/** Every way a cancel can be refused. */
export type CancelRejectionCode =
  "operation_not_found" | "already_applied" | "operation_not_cancellable";

export interface MigrationRejection {
  readonly code: MigrationRejectionCode;
  readonly reason: string;
}

export interface CancelRejection {
  readonly code: CancelRejectionCode;
  readonly reason: string;
}

/**
 * What a caller has to address one binding by. `incarnation` is required, not optional: the
 * numeric `bindingId` is only unique inside one group table, and a reload that drops and
 * recreates a group table hands the same number to a different binding while the
 * `runtimeEpoch` stays the same. The incarnation is what makes a late reference name the
 * object it was taken from rather than whatever reused its number.
 */
export interface MoveBindingRequest {
  readonly runtimeEpoch: string;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly bindingId: number;
  readonly incarnation: number;
  readonly expectedRoutingRevision: number;
  readonly expectedSourceTargetId: string;
  readonly destinationTargetId: string;
  readonly requestedBy: MigrationActor;
  readonly reason: string;
  readonly idempotencyKey: string | undefined;
}

/** What a caller has to name in order to cancel one intent. */
export interface CancelMoveRequest {
  readonly operationId: string;
  readonly runtimeEpoch: string;
}

/** The stored intent. `state` and the outcome fields move as the service acts on it. */
export interface MigrationOperation {
  readonly operationId: string;
  readonly runtimeEpoch: string;
  readonly pairId: string;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly bindingId: number;
  readonly incarnation: number;
  readonly sourceRoutingRevision: number;
  readonly sourceTargetId: string;
  readonly destinationTargetId: string;
  readonly requestedBy: MigrationActor;
  readonly reason: string;
  readonly idempotencyKey: string | undefined;
  readonly requestDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: MigrationState;
  /** The routing revision the write produced, once the write happened. */
  appliedRoutingRevision: number | undefined;
  /** When a later request was seen using the destination. */
  observedAt: number | undefined;
  /** Why the intent stopped moving: the rejection, cancellation or expiry reason. */
  endReason: string | undefined;
  endedAt: number | undefined;
}

/** The copy a reader gets: nothing handed out can write back into the store. */
export interface MigrationOperationView {
  readonly operationId: string;
  readonly runtimeEpoch: string;
  readonly pairId: string;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly bindingId: number;
  readonly incarnation: number;
  readonly sourceRoutingRevision: number;
  readonly sourceTargetId: string;
  readonly destinationTargetId: string;
  readonly requestedBy: MigrationActor;
  readonly reason: string;
  readonly idempotencyKey: string | undefined;
  readonly requestDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: MigrationState;
  readonly appliedRoutingRevision: number | undefined;
  readonly observedAt: number | undefined;
  readonly endReason: string | undefined;
  readonly endedAt: number | undefined;
}

/**
 * What `moveBinding()` answered. Each kind says something different about the route, and none
 * of them says the upstream request succeeded: `applied` means the in-memory route changed,
 * `pending_boundary` means nothing changed yet, `already_there` means no write was needed.
 */
export type MoveBindingOutcome =
  | {
      readonly kind: "rejected";
      /** The record of the refusal, or nothing when the store had no room to open one. */
      readonly operationId: string | undefined;
      readonly rejection: MigrationRejection;
    }
  | { readonly kind: "already_there"; readonly targetId: string }
  | {
      readonly kind: "applied";
      readonly operation: MigrationOperationView;
      /** The route changed; the effect is on the next request, never on one in flight. */
      readonly effect: "next_request";
    }
  | {
      readonly kind: "pending_boundary";
      readonly operation: MigrationOperationView;
      readonly inFlightAtSubmit: number;
      readonly effect: "next_request";
    }
  | {
      readonly kind: "replayed";
      readonly operation: MigrationOperationView;
      /** A replay never writes again; the recorded outcome says what the route did. */
      readonly effect: "none";
    };

/** What `cancelMoveBinding()` answered. */
export type CancelMoveOutcome =
  | { readonly kind: "cancelled"; readonly operation: MigrationOperationView }
  | { readonly kind: "rejected"; readonly reason: CancelRejection };

export interface MigrationOperationStoreOptions {
  readonly pairId: string;
  readonly now: () => number;
  readonly retentionMs?: number | undefined;
  readonly maxRecords?: number | undefined;
  readonly logger?: Pick<StructuredLogger, "info"> | undefined;
}

/** Trim and bound the caller's reason; the audit line must stay a label, not a body. */
export function normalizeMigrationReason(reason: string): string {
  return reason.trim().slice(0, MAX_MIGRATION_REASON_CHARS);
}

/**
 * The routing parameters an idempotent retry has to repeat exactly.
 *
 * Every version and source field is in here on purpose. They are not decoration: they are what
 * decides whether the move is safe, so a request that repeats the key while naming a different
 * group revision, routing revision, incarnation or source target is not a retry of the first
 * instruction - it is a different instruction that happens to reuse its key, and it has to be
 * refused rather than silently replayed. `reason` is deliberately left out: it is a bounded
 * audit label, not an operation parameter, and the same move worded differently is still the
 * same move.
 */
export function migrationRequestDigest(request: MoveBindingRequest): string {
  return stableHash({
    runtimeEpoch: request.runtimeEpoch,
    groupId: request.groupId,
    groupRevision: request.groupRevision,
    bindingId: request.bindingId,
    incarnation: request.incarnation,
    expectedRoutingRevision: request.expectedRoutingRevision,
    expectedSourceTargetId: request.expectedSourceTargetId,
    destinationTargetId: request.destinationTargetId,
    requestedBy: request.requestedBy,
  });
}

/** States that cannot move again; nothing terminal is ever revived or rewritten. */
const TERMINAL_STATES: ReadonlySet<MigrationState> = new Set<MigrationState>([
  "rejected",
  "observed",
  "cancelled",
  "expired",
  "expired_after_apply",
]);

function toView(operation: MigrationOperation): MigrationOperationView {
  return {
    operationId: operation.operationId,
    runtimeEpoch: operation.runtimeEpoch,
    pairId: operation.pairId,
    groupId: operation.groupId,
    groupRevision: operation.groupRevision,
    bindingId: operation.bindingId,
    incarnation: operation.incarnation,
    sourceRoutingRevision: operation.sourceRoutingRevision,
    sourceTargetId: operation.sourceTargetId,
    destinationTargetId: operation.destinationTargetId,
    requestedBy: operation.requestedBy,
    reason: operation.reason,
    idempotencyKey: operation.idempotencyKey,
    requestDigest: operation.requestDigest,
    createdAt: operation.createdAt,
    expiresAt: operation.expiresAt,
    state: operation.state,
    appliedRoutingRevision: operation.appliedRoutingRevision,
    observedAt: operation.observedAt,
    endReason: operation.endReason,
    endedAt: operation.endedAt,
  };
}

function idempotencyLookupKey(runtimeEpoch: string, idempotencyKey: string): string {
  return `${runtimeEpoch} ${idempotencyKey}`;
}

/**
 * The bounded, in-memory record set behind `moveBinding()`. Nothing here outlives the runtime:
 * a pair stop drops everything, and a rebuilt `LoadBalancer` starts with an empty store, so a
 * request replayed after a restart finds no record and cannot act on the new state.
 *
 * Which record goes where:
 *
 * | event                              | store behavior                                            |
 * | ---------------------------------- | --------------------------------------------------------- |
 * | submit                             | one record at `requested`, then its submit outcome         |
 * | applied                            | keeps the routing revision the write produced              |
 * | a later request used the destination | `observed`, terminal                                    |
 * | cancel of a parked intent          | `cancelled`, terminal                                      |
 * | lifecycle or version drift         | `expired`, terminal                                        |
 * | binding lost after the write       | `expired_after_apply`, terminal                            |
 * | terminal and past the retention    | record dropped, and its idempotency entry goes with it     |
 */
export class MigrationOperationStore {
  readonly #pairId: string;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maxRecords: number;
  readonly #logger: Pick<StructuredLogger, "info">;

  readonly #records = new Map<string, MigrationOperation>();
  /** Idempotency index, scoped to the runtime that recorded it. */
  readonly #byIdempotencyKey = new Map<string, MigrationOperation>();
  /** Records that may still move: `requested`, `pending_boundary` and `applied`. */
  readonly #live = new Set<MigrationOperation>();
  /**
   * Bindings this runtime has an intent for. The request path looks an intent up by binding
   * incarnation on every reservation and on every release, so the lookup cannot be a scan of
   * everything the store holds; this index is what keeps a hot path off the whole record set.
   */
  readonly #byIncarnation = new Map<number, Set<MigrationOperation>>();

  constructor(options: MigrationOperationStoreOptions) {
    this.#pairId = options.pairId;
    this.#now = options.now;
    this.#retentionMs = options.retentionMs ?? MIGRATION_RETENTION_MS;
    this.#maxRecords = options.maxRecords ?? MAX_MIGRATION_RECORDS;
    this.#logger =
      options.logger ??
      new StructuredLogger({ service: "llm-proxy-load-balancer", minimumLevel: "info" });
  }

  get size(): number {
    return this.#records.size;
  }

  /** Open the record for a submit, before any gate has been checked. */
  open(request: MoveBindingRequest, requestDigest: string): MigrationOperation | undefined {
    this.#evictFinished();
    if (this.#records.size >= this.#maxRecords) {
      return undefined;
    }
    const now = this.#now();
    const idempotencyKey = request.idempotencyKey;
    const operation: MigrationOperation = {
      operationId: createRequestId(),
      runtimeEpoch: request.runtimeEpoch,
      pairId: this.#pairId,
      groupId: request.groupId,
      groupRevision: request.groupRevision,
      bindingId: request.bindingId,
      incarnation: request.incarnation,
      sourceRoutingRevision: request.expectedRoutingRevision,
      sourceTargetId: request.expectedSourceTargetId,
      destinationTargetId: request.destinationTargetId,
      requestedBy: request.requestedBy,
      reason: normalizeMigrationReason(request.reason),
      idempotencyKey,
      requestDigest,
      createdAt: now,
      expiresAt: now + this.#retentionMs,
      state: "requested",
      appliedRoutingRevision: undefined,
      observedAt: undefined,
      endReason: undefined,
      endedAt: undefined,
    };
    this.#records.set(operation.operationId, operation);
    this.#live.add(operation);
    const indexed = this.#byIncarnation.get(operation.incarnation) ?? new Set<MigrationOperation>();
    indexed.add(operation);
    this.#byIncarnation.set(operation.incarnation, indexed);
    if (idempotencyKey !== undefined) {
      this.#byIdempotencyKey.set(
        idempotencyLookupKey(request.runtimeEpoch, idempotencyKey),
        operation,
      );
    }
    this.#audit(operation, "requested");
    return operation;
  }

  /** The record a same-key, same-parameters retry should return instead of acting again. */
  findReplay(
    runtimeEpoch: string,
    idempotencyKey: string,
    requestDigest: string,
  ): MigrationOperation | undefined {
    const found = this.findByIdempotencyKey(runtimeEpoch, idempotencyKey);
    if (found?.requestDigest !== requestDigest) {
      return undefined;
    }
    return found;
  }

  /** Whatever this runtime last recorded under that key, whatever its parameters were. */
  findByIdempotencyKey(
    runtimeEpoch: string,
    idempotencyKey: string,
  ): MigrationOperation | undefined {
    return this.#byIdempotencyKey.get(idempotencyLookupKey(runtimeEpoch, idempotencyKey));
  }

  get(operationId: string): MigrationOperation | undefined {
    return this.#records.get(operationId);
  }

  /** Copies of everything recorded, oldest first. */
  operations(): readonly MigrationOperationView[] {
    return [...this.#records.values()].map(toView);
  }

  /** The copy of one of the store's own records. */
  viewOf(operation: MigrationOperation): MigrationOperationView {
    return toView(operation);
  }

  /** The store's own records that may still move, for the service to act on. */
  live(): readonly MigrationOperation[] {
    return [...this.#live];
  }

  /** Intents parked for one binding, waiting for their request boundary. */
  pendingFor(incarnation: number): readonly MigrationOperation[] {
    return this.#forIncarnation(incarnation).filter(
      (operation) => operation.state === "pending_boundary",
    );
  }

  /** Intents whose write happened but whose next request has not been seen yet. */
  appliedFor(incarnation: number): readonly MigrationOperation[] {
    return this.#forIncarnation(incarnation).filter((operation) => operation.state === "applied");
  }

  #forIncarnation(incarnation: number): readonly MigrationOperation[] {
    return [...(this.#byIncarnation.get(incarnation) ?? [])];
  }

  reject(operation: MigrationOperation, rejection: MigrationRejection): void {
    this.#transition(operation, "rejected", rejection.reason);
    this.#audit(operation, "rejected", { code: rejection.code });
  }

  park(operation: MigrationOperation, inFlightAtSubmit: number): void {
    this.#transition(operation, "pending_boundary");
    this.#audit(operation, "pending_boundary", { inFlightAtSubmit });
  }

  apply(operation: MigrationOperation, appliedRoutingRevision: number): void {
    operation.appliedRoutingRevision = appliedRoutingRevision;
    this.#transition(operation, "applied");
    this.#audit(operation, "applied", { routingRevision: appliedRoutingRevision });
  }

  observe(operation: MigrationOperation): void {
    operation.observedAt = this.#now();
    this.#transition(operation, "observed");
    this.#audit(operation, "observed", { routingRevision: operation.appliedRoutingRevision });
  }

  cancel(operation: MigrationOperation): void {
    this.#transition(operation, "cancelled", "cancelled by the caller");
    this.#audit(operation, "cancelled");
  }

  expire(operation: MigrationOperation, reason: string): void {
    this.#transition(operation, "expired", reason);
    this.#audit(operation, "expired");
  }

  expireAfterApply(operation: MigrationOperation, reason: string): void {
    this.#transition(operation, "expired_after_apply", reason);
    this.#audit(operation, "expired_after_apply");
  }

  /** Pair stop or runtime replacement: nothing survives, and no old key can match again. */
  dropAll(): void {
    this.#records.clear();
    this.#byIdempotencyKey.clear();
    this.#byIncarnation.clear();
    this.#live.clear();
  }

  /**
   * Forget records that stopped being worth their space: terminal, and past the retention window
   * counted from when they stopped moving. A record is kept while it can still answer a question
   * - "what happened to my move", or an idempotent replay - and an intent that applied only a
   * moment ago is exactly the answer the console needs, so the clock for dropping starts when the
   * record ended, not when it began. A replay much later then becomes a fresh evaluation rather
   * than a phantom hit on a record nobody could explain any more.
   */
  dropExpiredRecords(): number {
    const cutoff = this.#now() - this.#retentionMs;
    let dropped = 0;
    for (const operation of [...this.#records.values()]) {
      const endedAt = operation.endedAt ?? operation.createdAt;
      if (this.#live.has(operation) || endedAt > cutoff) {
        continue;
      }
      this.#drop(operation);
      dropped += 1;
    }
    return dropped;
  }

  #transition(operation: MigrationOperation, to: MigrationState, reason?: string): void {
    if (!isMigrationTransitionAllowed(operation.state, to)) {
      throw new Error(`Migration state ${operation.state} cannot become ${to}.`);
    }
    operation.state = to;
    if (reason !== undefined) {
      operation.endReason = reason;
    }
    if (TERMINAL_STATES.has(to)) {
      operation.endedAt = this.#now();
      this.#live.delete(operation);
    }
  }

  /** Only metadata reaches the log: ids, versions, targets and the bounded reason label. */
  #audit(operation: MigrationOperation, state: MigrationState, extra: LogContext = {}): void {
    this.#logger.info(`binding move ${state}`, {
      operationId: operation.operationId,
      runtimeEpoch: operation.runtimeEpoch,
      pairId: operation.pairId,
      groupId: operation.groupId,
      groupRevision: operation.groupRevision,
      bindingId: operation.bindingId,
      incarnation: operation.incarnation,
      fromTargetId: operation.sourceTargetId,
      toTargetId: operation.destinationTargetId,
      movedBy: operation.requestedBy,
      reason: operation.reason,
      sourceRoutingRevision: operation.sourceRoutingRevision,
      state,
      ...extra,
    });
  }

  #oldestFinished(): MigrationOperation | undefined {
    let oldest: MigrationOperation | undefined;
    for (const operation of this.#records.values()) {
      if (this.#live.has(operation)) {
        continue;
      }
      if (oldest === undefined || operation.createdAt < oldest.createdAt) {
        oldest = operation;
      }
    }
    return oldest;
  }

  #evictFinished(): void {
    while (this.#records.size >= this.#maxRecords) {
      const oldest = this.#oldestFinished();
      if (oldest === undefined) {
        return;
      }
      this.#drop(oldest);
    }
  }

  #drop(operation: MigrationOperation): void {
    this.#records.delete(operation.operationId);
    this.#live.delete(operation);
    const indexed = this.#byIncarnation.get(operation.incarnation);
    if (indexed !== undefined) {
      indexed.delete(operation);
      if (indexed.size === 0) {
        this.#byIncarnation.delete(operation.incarnation);
      }
    }
    const key = operation.idempotencyKey;
    if (key !== undefined) {
      const lookup = idempotencyLookupKey(operation.runtimeEpoch, key);
      if (this.#byIdempotencyKey.get(lookup) === operation) {
        this.#byIdempotencyKey.delete(lookup);
      }
    }
  }
}
