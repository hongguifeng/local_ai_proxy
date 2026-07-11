import type { RuntimeHealthSnapshot } from "./runtime/recovery.js";
import type { StorageQueueMetrics } from "./storage/write-queue.js";

export interface ProxyMetricEvent {
  proxyId: string;
  targetId?: string | null;
  outcome: "finished" | "aborted" | "timed_out" | "failed";
  requestBytes?: number;
  responseBytes?: number;
  truncated?: boolean;
}

export interface InternalMetricsSnapshot {
  requests: { active: number; completed: number; aborted: number; timedOut: number; failed: number };
  traffic: { requestBytes: number; responseBytes: number; truncated: number };
  storage: StorageQueueMetrics;
  labels: { tracked: number; overflowed: number };
}

export interface MetricsAdapter {
  snapshot(): InternalMetricsSnapshot;
}

export class InternalMetrics implements MetricsAdapter {
  readonly #storage: () => StorageQueueMetrics;
  readonly #maxLabels: number;
  readonly #labels = new Set<string>();
  #overflowed = 0;
  #active = 0;
  #completed = 0;
  #aborted = 0;
  #timedOut = 0;
  #failed = 0;
  #requestBytes = 0;
  #responseBytes = 0;
  #truncated = 0;

  public constructor(storage: () => StorageQueueMetrics, maxLabels = 100) {
    if (!Number.isSafeInteger(maxLabels) || maxLabels < 1 || maxLabels > 10_000)
      throw new RangeError("Invalid metric label limit");
    this.#storage = storage;
    this.#maxLabels = maxLabels;
  }

  public requestStarted(proxyId: string, targetId?: string | null): void {
    this.#track(proxyId, targetId);
    this.#active += 1;
  }

  public requestCompleted(event: ProxyMetricEvent): void {
    this.#track(event.proxyId, event.targetId);
    this.#active = Math.max(0, this.#active - 1);
    this.#completed += 1;
    if (event.outcome === "aborted") this.#aborted += 1;
    if (event.outcome === "timed_out") this.#timedOut += 1;
    if (event.outcome === "failed") this.#failed += 1;
    this.#requestBytes += event.requestBytes ?? 0;
    this.#responseBytes += event.responseBytes ?? 0;
    if (event.truncated) this.#truncated += 1;
  }

  public snapshot(): InternalMetricsSnapshot {
    return {
      requests: {
        active: this.#active,
        completed: this.#completed,
        aborted: this.#aborted,
        timedOut: this.#timedOut,
        failed: this.#failed,
      },
      traffic: { requestBytes: this.#requestBytes, responseBytes: this.#responseBytes, truncated: this.#truncated },
      storage: this.#storage(),
      labels: { tracked: this.#labels.size, overflowed: this.#overflowed },
    };
  }

  #track(proxyId: string, targetId?: string | null): void {
    const label = `${proxyId}\u0000${targetId ?? ""}`;
    if (this.#labels.has(label)) return;
    if (this.#labels.size >= this.#maxLabels) this.#overflowed += 1;
    else this.#labels.add(label);
  }
}

export function serviceHealth(
  runtime: RuntimeHealthSnapshot,
  started: boolean,
): RuntimeHealthSnapshot & { live: boolean; ready: boolean; degraded: boolean } {
  return {
    ...runtime,
    live: true,
    ready: started && runtime.status !== "failed",
    degraded: runtime.status === "degraded",
  };
}
