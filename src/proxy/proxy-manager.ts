import type { ProxyPair } from "../config/index.js";
import { stableJsonStringify } from "../shared/index.js";

export interface UpdatedProxyPair {
  readonly before: ProxyPair;
  readonly after: ProxyPair;
}

export interface ProxyPairConfigDiff {
  readonly added: readonly ProxyPair[];
  readonly removed: readonly ProxyPair[];
  readonly unchanged: readonly ProxyPair[];
  readonly updated: readonly UpdatedProxyPair[];
}

export function diffProxyPairs(
  current: readonly ProxyPair[],
  next: readonly ProxyPair[],
): ProxyPairConfigDiff {
  const currentById = new Map(current.map((pair) => [pair.id, pair]));
  const nextIds = new Set(next.map((pair) => pair.id));
  const added: ProxyPair[] = [];
  const unchanged: ProxyPair[] = [];
  const updated: UpdatedProxyPair[] = [];
  for (const pair of next) {
    const existing = currentById.get(pair.id);
    if (existing === undefined) {
      added.push(pair);
    } else if (stableJsonStringify(existing) === stableJsonStringify(pair)) {
      unchanged.push(pair);
    } else {
      updated.push({ before: existing, after: pair });
    }
  }
  return {
    added,
    removed: current.filter((pair) => !nextIds.has(pair.id)),
    unchanged,
    updated,
  };
}
