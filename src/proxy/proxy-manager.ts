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

export class ProxyListenConflictError extends Error {
  readonly conflictingPairId: string;
  readonly host: string;
  readonly pairId: string;
  readonly port: number;

  constructor(pair: ProxyPair, conflictingPair: ProxyPair) {
    super(
      `Proxy pair ${pair.id} conflicts with ${conflictingPair.id} on ${pair.listen_host}:${pair.listen_port}.`,
    );
    this.name = "ProxyListenConflictError";
    this.pairId = pair.id;
    this.conflictingPairId = conflictingPair.id;
    this.host = pair.listen_host;
    this.port = pair.listen_port;
  }
}

export function assertNoEnabledListenConflicts(pairs: readonly ProxyPair[]): void {
  const enabled = pairs.filter((pair) => pair.enabled && pair.listen_port !== 0);
  for (const [index, pair] of enabled.entries()) {
    const conflict = enabled
      .slice(0, index)
      .find(
        (candidate) =>
          candidate.listen_port === pair.listen_port &&
          hostsConflict(candidate.listen_host, pair.listen_host),
      );
    if (conflict !== undefined) {
      throw new ProxyListenConflictError(pair, conflict);
    }
  }
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

function hostsConflict(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return (
    normalizedLeft === normalizedRight ||
    isWildcardHost(normalizedLeft) ||
    isWildcardHost(normalizedRight)
  );
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}
