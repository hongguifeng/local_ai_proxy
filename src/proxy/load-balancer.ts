import type { LoadBalancerGroup, ProxyPair, TargetConfig } from "../config/index.js";

import { LoadAffinityTable } from "./load-affinity.js";
import { tryCanonicalNodeKey } from "./node-identity.js";

/**
 * Per-pair load balancing state. The object outlives every pipeline rebuild, so
 * bindings, reservations and sampling state survive a configuration save. It only
 * knows node identity; URLs, credentials and request transforms stay in the pipeline.
 */

export interface LoadBalancerNode {
  readonly targetId: string;
  canonicalKey: string;
  enabled: boolean;
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

  constructor(pairId: string, options: LoadBalancerOptions = {}) {
    this.#pairId = pairId;
    this.#options = options;
  }

  get pairId(): string {
    return this.#pairId;
  }

  /** Apply a new configuration without dropping anything that is still valid. */
  reconfigure(pair: ProxyPair): void {
    const configured = pair.targets;
    const next = new Map<string, LoadBalancerNode>();
    for (const target of configured) {
      const existing = this.#nodes.get(target.id);
      const node = existing ?? {
        targetId: target.id,
        canonicalKey: canonicalKeyFor(target),
        enabled: target.enabled,
      };
      node.canonicalKey = canonicalKeyFor(target);
      node.enabled = target.enabled;
      next.set(target.id, node);
    }
    this.#nodes = next;

    const groups = new Map<string, LoadBalancerGroup>();
    for (const group of pair.load_balancers) {
      groups.set(group.id, group);
    }
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
          : group.node_target_ids.filter((targetId) => next.get(targetId)?.enabled === true),
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
