import { stableJsonStringify } from "../shared/index.js";

import { INITIAL_ROUTING_REVISION } from "./load-migration-contract.js";
import { stableHash, type EndpointKind } from "./protocol/analysis.js";
import { userHashPrefixMatches, type TaskIdentity } from "./protocol/task-identity.js";

/**
 * The affinity table answers one question: has this request been routed to a node
 * before, and is that node still the right one? Affinity is kept in memory because
 * a routing decision must never wait for the database or an upstream request.
 *
 * Caps are independent: a prefix bucket is bounded so a burst of near-identical
 * probes cannot push an older task out of the bucket, and the whole group is bounded
 * so a long session cannot grow the table without limit.
 */

export const AFFINITY_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_BINDINGS_PER_GROUP = 4_096;
export const MAX_BUCKET_SIZE = 32;
export const MAX_BUCKET_SCAN = 16;

export interface LoadAffinityOptions {
  readonly ttlMs?: number | undefined;
  readonly maxBindingsPerGroup?: number | undefined;
  readonly maxBucketSize?: number | undefined;
  readonly maxBucketScan?: number | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Allocator for binding incarnations. A pair runtime shares one allocator across all of
   * its group tables, so a rebuilt table cannot hand out an incarnation that a reference
   * from earlier in the same runtime still points at. Without one the table counts on its
   * own, which is only unique inside that table.
   */
  readonly nextIncarnation?: (() => number) | undefined;
}

/** What a binding keeps. Only hashes and ids, never request text. */
export interface AffinityEvidence {
  readonly kind: EndpointKind;
  readonly endpoint: string;
  readonly model: string | undefined;
  readonly boundaryWithoutUser: Readonly<Record<string, string>>;
  readonly userHashes: readonly string[];
}

export interface AffinityBinding {
  /** Unique inside this table, and only inside it: never an identifier on its own. */
  readonly id: number;
  /**
   * Unique inside one pair runtime. It is allocated once when the binding is created and
   * never rewritten, so a reference that carries it can only name the binding object it was
   * taken from, never a later binding that happened to reuse the numeric `id`.
   */
  readonly incarnation: number;
  targetId: string;
  /**
   * Version of this binding's target. It starts at `INITIAL_ROUTING_REVISION` and moves by
   * one every time the target actually changes, so every path that moves a task - a rebind,
   * a rebinding `bind()`, a failover - is observable from a stale reference. `rebind()` below
   * is the only write that touches either field, so no caller assigns them on its own.
   */
  routingRevision: number;
  readonly bucketKey: string;
  readonly evidence: AffinityEvidence;
  lastSeenAt: number;
  lastBoundAt: number;
  requestCount: number;
  /** Exact keys currently pointing at this binding, for symmetric cleanup. */
  readonly exactKeys: Set<string>;
}

export type AffinityHit =
  | {
      readonly matchedBy: "exact_key";
      readonly exactKey: string;
      readonly binding: AffinityBinding;
      readonly scanned: number;
    }
  | {
      readonly matchedBy: "prefix_bucket";
      readonly binding: AffinityBinding;
      readonly scanned: number;
    };

export interface AffinitySnapshot {
  readonly bindings: number;
  readonly exactKeys: number;
  readonly buckets: number;
  readonly byTarget: Readonly<Record<string, number>>;
}

/**
 * Plain copy of one binding, safe to hand to a reader that must not change it.
 *
 * The boundary evidence and the exact keys ride along because a management reader has to
 * ask the traffic log what it knows about this binding, and that question needs them. They
 * are the binding's identity material, not display data: a reader that hands this entry on
 * to a browser leaks exact keys and user-message hashes, so the admin projection passes
 * them to the history query and keeps them out of every response.
 */
export interface AffinityBindingEntry {
  readonly bindingId: number;
  readonly incarnation: number;
  readonly targetId: string;
  readonly routingRevision: number;
  readonly lastSeenAt: number;
  readonly lastBoundAt: number;
  readonly requestCount: number;
  readonly evidence: AffinityEvidence;
  readonly exactKeys: readonly string[];
}

export class LoadAffinityTable {
  readonly #ttlMs: number;
  readonly #maxBindings: number;
  readonly #maxBucketSize: number;
  readonly #maxBucketScan: number;
  readonly #now: () => number;

  readonly #bindings = new Map<number, AffinityBinding>();
  readonly #exactIndex = new Map<string, AffinityBinding>();
  readonly #buckets = new Map<string, AffinityBinding[]>();
  readonly #allocateIncarnation: () => number;
  #localNextIncarnation = 1;
  #nextId = 1;

  constructor(options: LoadAffinityOptions = {}) {
    this.#ttlMs = options.ttlMs ?? AFFINITY_TTL_MS;
    this.#maxBindings = options.maxBindingsPerGroup ?? MAX_BINDINGS_PER_GROUP;
    this.#maxBucketSize = options.maxBucketSize ?? MAX_BUCKET_SIZE;
    this.#maxBucketScan = options.maxBucketScan ?? MAX_BUCKET_SCAN;
    this.#now = options.now ?? Date.now;
    this.#allocateIncarnation =
      options.nextIncarnation ??
      (() => {
        const allocated = this.#localNextIncarnation;
        this.#localNextIncarnation += 1;
        return allocated;
      });
  }

  get size(): number {
    return this.#bindings.size;
  }

  /** Find the node that already carries this task, without touching load. */
  lookup(identity: TaskIdentity, allowedTargetIds?: ReadonlySet<string>): AffinityHit | undefined {
    const exact = this.#lookupExact(identity, allowedTargetIds);
    if (exact !== undefined) {
      return exact;
    }
    return this.#lookupBucket(identity, allowedTargetIds);
  }

  #lookupExact(
    identity: TaskIdentity,
    allowedTargetIds: ReadonlySet<string> | undefined,
  ): AffinityHit | undefined {
    for (const exactKey of identity.exactKeys) {
      const binding = this.#exactIndex.get(exactKey);
      if (binding === undefined) {
        continue;
      }
      if (!this.#usable(binding, identity, allowedTargetIds)) {
        // The key now describes a different task; stop pointing at the old binding.
        this.#detachExactKey(binding, exactKey);
        continue;
      }
      this.#touch(binding);
      return { matchedBy: "exact_key", exactKey, binding, scanned: 0 };
    }
    return undefined;
  }

  #lookupBucket(
    identity: TaskIdentity,
    allowedTargetIds: ReadonlySet<string> | undefined,
  ): AffinityHit | undefined {
    const bucket = this.#buckets.get(bucketKeyFor(identity));
    if (bucket === undefined || bucket.length === 0) {
      return undefined;
    }
    // Most recently used first, and only ever a bounded slice of the bucket.
    const ordered = [...bucket].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    const limit = Math.min(this.#maxBucketScan, ordered.length);
    let scanned = 0;
    for (const binding of ordered.slice(0, limit)) {
      scanned += 1;
      if (!this.#usable(binding, identity, allowedTargetIds)) {
        continue;
      }
      if (!userHashPrefixMatches(binding.evidence.userHashes, identity.userHashes)) {
        continue;
      }
      this.#touch(binding);
      return { matchedBy: "prefix_bucket", binding, scanned };
    }
    return undefined;
  }

  /**
   * Create or refresh the binding for a request and return it. Moving an existing binding
   * to another node - the `allowRebind` path `plan()` uses, and the one a failover takes -
   * also moves its routing revision, so a caller that saw the old target can tell. The move
   * itself is handed to `rebind()`: this table has exactly one place that writes a target.
   */
  bind(
    identity: TaskIdentity,
    targetId: string,
    options: { readonly allowRebind?: boolean | undefined } = {},
  ): AffinityBinding {
    const hit = this.lookup(identity);
    if (hit !== undefined) {
      if (hit.binding.targetId !== targetId && options.allowRebind) {
        this.rebind(hit.binding, targetId);
      }
      this.#registerExactKeys(hit.binding, identity.exactKeys);
      return hit.binding;
    }

    const binding: AffinityBinding = {
      id: this.#nextId++,
      incarnation: this.#allocateIncarnation(),
      targetId,
      routingRevision: INITIAL_ROUTING_REVISION,
      bucketKey: bucketKeyFor(identity),
      evidence: evidenceFor(identity),
      lastSeenAt: this.#now(),
      lastBoundAt: this.#now(),
      requestCount: 1,
      exactKeys: new Set<string>(),
    };
    this.#bindings.set(binding.id, binding);
    const bucket = this.#buckets.get(binding.bucketKey) ?? [];
    bucket.push(binding);
    this.#buckets.set(binding.bucketKey, bucket);
    this.#registerExactKeys(binding, identity.exactKeys);
    this.#enforceBucketCap(binding);
    this.#enforceGroupCap();
    return binding;
  }

  /**
   * The single write that points a binding at another node. Selection, failover and the
   * migration service all end here, so a target move always carries its version change and
   * no path can assign `targetId` behind the table's back. Returns false when the binding is
   * no longer in the table: a reference that arrives after a TTL, LRU or prune eviction must
   * not rewrite a binding the table already gave up on.
   */
  rebind(binding: AffinityBinding, targetId: string): boolean {
    if (this.#bindings.get(binding.id) !== binding) {
      return false;
    }
    const now = this.#now();
    if (binding.targetId !== targetId) {
      binding.routingRevision += 1;
      binding.targetId = targetId;
    }
    binding.lastSeenAt = now;
    binding.lastBoundAt = now;
    return true;
  }

  /**
   * Learn the response ids a completed response produced for this binding. A response that
   * finished after its binding was evicted teaches nothing: writing the keys back would put
   * an object the table removed back into the exact index.
   */
  attachResponseIds(binding: AffinityBinding, responseIds: readonly string[]): void {
    if (this.#bindings.get(binding.id) !== binding) {
      return;
    }
    const keys = responseIds
      .filter((responseId) => responseId !== "")
      .map((responseId) => `response:${responseId}`);
    this.#registerExactKeys(binding, keys);
  }

  /** Remove one binding and every index entry that pointed at it. */
  remove(binding: AffinityBinding): void {
    for (const exactKey of binding.exactKeys) {
      if (this.#exactIndex.get(exactKey) === binding) {
        this.#exactIndex.delete(exactKey);
      }
    }
    const bucket = this.#buckets.get(binding.bucketKey);
    if (bucket !== undefined) {
      const index = bucket.indexOf(binding);
      if (index !== -1) {
        bucket.splice(index, 1);
      }
      if (bucket.length === 0) {
        this.#buckets.delete(binding.bucketKey);
      }
    }
    this.#bindings.delete(binding.id);
  }

  /** Drop only the bindings that point at nodes which are no longer usable. */
  pruneTargets(allowedTargetIds: ReadonlySet<string>): number {
    const doomed = [...this.#bindings.values()].filter(
      (binding) => !allowedTargetIds.has(binding.targetId),
    );
    for (const binding of doomed) {
      this.remove(binding);
    }
    return doomed.length;
  }

  /** Remove every binding, used when a group disappears from the configuration. */
  clear(): number {
    const count = this.#bindings.size;
    for (const binding of [...this.#bindings.values()]) {
      this.remove(binding);
    }
    return count;
  }

  /** Lazy cleanup for bindings that have not been seen within the TTL. */
  sweepExpired(): number {
    const cutoff = this.#now() - this.#ttlMs;
    const expired = [...this.#bindings.values()].filter((binding) => binding.lastSeenAt < cutoff);
    for (const binding of expired) {
      this.remove(binding);
    }
    return expired.length;
  }

  snapshot(): AffinitySnapshot {
    const byTarget: Record<string, number> = {};
    for (const binding of this.#bindings.values()) {
      byTarget[binding.targetId] = (byTarget[binding.targetId] ?? 0) + 1;
    }
    return {
      bindings: this.#bindings.size,
      exactKeys: this.#exactIndex.size,
      buckets: this.#buckets.size,
      byTarget,
    };
  }

  /**
   * Everything the table holds right now, as copies. Unlike `lookup()` this touches
   * nothing: no TTL refresh, no counter bump, no target rewrite, no eviction. A list can
   * be built from here without changing what it describes, which is what the binding
   * projection and, later, the node list endpoint need.
   */
  bindingEntries(): readonly AffinityBindingEntry[] {
    return [...this.#bindings.values()].map((binding) => ({
      bindingId: binding.id,
      incarnation: binding.incarnation,
      targetId: binding.targetId,
      routingRevision: binding.routingRevision,
      lastSeenAt: binding.lastSeenAt,
      lastBoundAt: binding.lastBoundAt,
      requestCount: binding.requestCount,
      evidence: copyEvidence(binding.evidence),
      exactKeys: [...binding.exactKeys],
    }));
  }

  bindingForExactKey(exactKey: string): AffinityBinding | undefined {
    return this.#exactIndex.get(exactKey);
  }

  /**
   * Look a binding up by its numeric id without touching its TTL or its counters. The id is
   * only unique inside this table, so a caller that came from further away must still check
   * the incarnation before it writes anything.
   */
  bindingForId(bindingId: number): AffinityBinding | undefined {
    return this.#bindings.get(bindingId);
  }

  #usable(
    binding: AffinityBinding,
    identity: TaskIdentity,
    allowedTargetIds: ReadonlySet<string> | undefined,
  ): boolean {
    if (allowedTargetIds !== undefined && !allowedTargetIds.has(binding.targetId)) {
      return false;
    }
    if (this.#expired(binding)) {
      this.remove(binding);
      return false;
    }
    if (binding.evidence.kind !== identity.kind) {
      return false;
    }
    if (binding.evidence.model !== identity.model) {
      return false;
    }
    if (!boundariesMatch(binding.evidence.boundaryWithoutUser, identity.boundaryWithoutUser)) {
      return false;
    }
    const stored = binding.evidence.endpoint;
    return stored === "" || identity.endpoint === "" || stored === identity.endpoint;
  }

  #expired(binding: AffinityBinding): boolean {
    return binding.lastSeenAt < this.#now() - this.#ttlMs;
  }

  #touch(binding: AffinityBinding): void {
    binding.lastSeenAt = this.#now();
    binding.requestCount += 1;
  }

  #registerExactKeys(binding: AffinityBinding, exactKeys: readonly string[]): void {
    for (const exactKey of exactKeys) {
      if (exactKey === "") {
        continue;
      }
      this.#exactIndex.set(exactKey, binding);
      binding.exactKeys.add(exactKey);
    }
  }

  #detachExactKey(binding: AffinityBinding, exactKey: string): void {
    this.#exactIndex.delete(exactKey);
    binding.exactKeys.delete(exactKey);
  }

  #enforceBucketCap(binding: AffinityBinding): void {
    const bucket = this.#buckets.get(binding.bucketKey);
    if (bucket === undefined) {
      return;
    }
    while (bucket.length > this.#maxBucketSize) {
      // Evict the least recently used member of this bucket only.
      let oldest = bucket[0] ?? binding;
      for (const candidate of bucket) {
        if (candidate.lastSeenAt < oldest.lastSeenAt) {
          oldest = candidate;
        }
      }
      this.remove(oldest);
      if (oldest === binding) {
        return;
      }
    }
  }

  #enforceGroupCap(): void {
    while (this.#bindings.size > this.#maxBindings) {
      let oldest: AffinityBinding | undefined;
      for (const binding of this.#bindings.values()) {
        if (oldest === undefined || binding.lastSeenAt < oldest.lastSeenAt) {
          oldest = binding;
        }
      }
      if (oldest === undefined) {
        return;
      }
      this.remove(oldest);
    }
  }
}

function bucketKeyFor(identity: TaskIdentity): string {
  return stableHash({
    kind: identity.kind,
    model: identity.model ?? null,
    boundary: identity.boundaryWithoutUser,
  });
}

/**
 * A copy of the evidence, nested objects included. `readonly` is a TypeScript promise rather
 * than a runtime lock, so handing out the binding's own objects would let a reader write
 * back into the table's evidence.
 */
function copyEvidence(evidence: AffinityEvidence): AffinityEvidence {
  return {
    kind: evidence.kind,
    endpoint: evidence.endpoint,
    model: evidence.model,
    boundaryWithoutUser: { ...evidence.boundaryWithoutUser },
    userHashes: [...evidence.userHashes],
  };
}

function evidenceFor(identity: TaskIdentity): AffinityEvidence {
  return {
    kind: identity.kind,
    endpoint: identity.endpoint,
    model: identity.model,
    boundaryWithoutUser: identity.boundaryWithoutUser,
    userHashes: identity.userHashes,
  };
}

function boundariesMatch(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}
