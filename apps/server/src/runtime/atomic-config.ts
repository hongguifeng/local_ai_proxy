import type { PersistedConfig, RuntimeConfigSnapshot, RuntimeProxy } from "../config/schema.js";
import { createRuntimeConfigSnapshot, parsePersistedConfig } from "../config/schema.js";

export interface ConfigPersistence {
  save(config: PersistedConfig): Promise<void>;
}

export interface PreparedRuntimeChange {
  commit(): void;
  rollback(): Promise<void>;
}

export interface RuntimeConfigApplier {
  prepare(change: RuntimeConfigChange): Promise<PreparedRuntimeChange>;
}

export interface RuntimeConfigChange {
  previous: RuntimeConfigSnapshot;
  next: RuntimeConfigSnapshot;
  added: readonly RuntimeProxy[];
  changed: readonly RuntimeProxy[];
  removed: readonly RuntimeProxy[];
  unchanged: readonly RuntimeProxy[];
}

export interface ProxyApplyResult {
  id: string;
  action: "added" | "changed" | "removed" | "unchanged";
}

export interface ConfigApplyResult {
  changed: boolean;
  proxies: ProxyApplyResult[];
}

export class AtomicRuntimeConfig {
  readonly #persistence: ConfigPersistence;
  readonly #runtime: RuntimeConfigApplier;
  #snapshot: RuntimeConfigSnapshot;
  #tail: Promise<void> = Promise.resolve();

  public constructor(initial: RuntimeConfigSnapshot, persistence: ConfigPersistence, runtime: RuntimeConfigApplier) {
    this.#snapshot = initial;
    this.#persistence = persistence;
    this.#runtime = runtime;
  }

  public get snapshot(): RuntimeConfigSnapshot {
    return this.#snapshot;
  }

  public replace(input: unknown): Promise<ConfigApplyResult> {
    const operation = this.#tail.then(async () => this.#replace(input));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #replace(input: unknown): Promise<ConfigApplyResult> {
    const persisted = parsePersistedConfig(input);
    const next = createRuntimeConfigSnapshot(persisted);
    const change = diffConfig(this.#snapshot, next);
    const results = applyResults(change);
    if (change.added.length + change.changed.length + change.removed.length === 0)
      return { changed: false, proxies: results };

    const prepared = await this.#runtime.prepare(change);
    try {
      await this.#persistence.save(persisted);
    } catch (error) {
      await prepared.rollback();
      throw error;
    }
    prepared.commit();
    this.#snapshot = next;
    return { changed: true, proxies: results };
  }
}

export function diffConfig(previous: RuntimeConfigSnapshot, next: RuntimeConfigSnapshot): RuntimeConfigChange {
  const before = new Map(previous.proxies.map((proxy) => [proxy.id, proxy]));
  const after = new Map(next.proxies.map((proxy) => [proxy.id, proxy]));
  const added: RuntimeProxy[] = [];
  const changed: RuntimeProxy[] = [];
  const removed: RuntimeProxy[] = [];
  const unchanged: RuntimeProxy[] = [];
  for (const proxy of next.proxies) {
    const existing = before.get(proxy.id);
    if (!existing) added.push(proxy);
    else if (sameProxy(existing, proxy)) unchanged.push(proxy);
    else changed.push(proxy);
  }
  for (const proxy of previous.proxies) if (!after.has(proxy.id)) removed.push(proxy);
  return { previous, next, added, changed, removed, unchanged };
}

function sameProxy(left: RuntimeProxy, right: RuntimeProxy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyResults(change: RuntimeConfigChange): ProxyApplyResult[] {
  return [
    ...change.added.map((proxy) => ({ id: proxy.id, action: "added" as const })),
    ...change.changed.map((proxy) => ({ id: proxy.id, action: "changed" as const })),
    ...change.removed.map((proxy) => ({ id: proxy.id, action: "removed" as const })),
    ...change.unchanged.map((proxy) => ({ id: proxy.id, action: "unchanged" as const })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}
