import type {
  LoadBalancerGroup,
  LoadBalancerStrategy,
  ProxyPair,
  TargetConfig,
} from "../config/index.js";

import { loadBalancerMemberTargetIds } from "../config/index.js";

import { LoadAffinityTable, type AffinityBinding } from "./load-affinity.js";
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

export interface LoadSample {
  readonly sampledAt: number;
  readonly running: number;
  readonly waiting: number;
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
 */
export interface LoadBalancerReservation {
  readonly decision: LoadBalancerDecision;
  readonly binding: AffinityBinding;
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

export class LoadBalancer {
  readonly #pairId: string;
  readonly #options: LoadBalancerOptions;
  #nodes = new Map<string, LoadBalancerNode>();
  readonly #tables = new Map<string, LoadAffinityTable>();
  readonly #reservations = new Map<string, number>();
  #groups: LoadBalancerGroup[] = [];
  #groupById = new Map<string, LoadBalancerGroup>();

  constructor(pairId: string, options: LoadBalancerOptions = {}) {
    this.#pairId = pairId;
    this.#options = options;
  }

  get pairId(): string {
    return this.#pairId;
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
        this.#tables.set(groupId, new LoadAffinityTable(this.#options));
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
      return this.#reservation(hit.binding, {
        groupId: input.group.id,
        groupName: input.group.name,
        strategy: input.group.strategy,
        targetId,
        decision: "affinity",
        matchedBy: hit.matchedBy,
        load: loadBefore,
        kvUsage: freshKvUsage(samples.get(targetId), now),
        metricsSource: freshSample(samples.get(targetId), now)?.source,
      });
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
    return this.#reservation(binding, {
      groupId: input.group.id,
      groupName: input.group.name,
      strategy: input.group.strategy,
      targetId: chosen.targetId,
      decision: "new_task",
      matchedBy: "new_task",
      load: loadBefore,
      kvUsage: freshKvUsage(sample, now),
      metricsSource: freshSample(sample, now)?.source,
    });
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

  #reservation(binding: AffinityBinding, decision: LoadBalancerDecision): LoadBalancerReservation {
    const targetId = decision.targetId;
    let released = false;
    return {
      decision,
      binding,
      markDispatched: (now?: number): void => {
        this.markDispatched(targetId, now);
      },
      release: (): void => {
        // Exactly one decrement, even when a client abort and a finally block both fire.
        if (released) {
          return;
        }
        released = true;
        this.release(targetId);
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
   */
  #loadOf(node: LoadBalancerNode, sample: LoadSample | undefined, now: number): number {
    const fresh = freshSample(sample, now);
    const metricLoad = fresh === undefined ? 0 : fresh.running + fresh.waiting;
    return Math.max(this.inFlight(node.targetId), metricLoad);
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

  clear(): void {
    for (const table of this.#tables.values()) {
      table.clear();
    }
    this.#tables.clear();
    this.#reservations.clear();
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
