import { StructuredLogger } from "../shared/index.js";

import { loadBalancerMemberTargetIds } from "../config/index.js";

import {
  METRIC_FRESH_WINDOW_MS,
  type LoadBalancer,
  type LoadBalancerNode,
  type LoadSample,
} from "./load-balancer.js";
import { parseLoadMetrics, type LoadMetricsSnapshot } from "./load-metrics.js";
import { fetchTargetMetrics } from "./target-metrics.js";

/**
 * Owns the periodic work for one pair's load balancer: sampling the upstream engines and
 * garbage-collecting affinity. The monitor is the only place that touches timers, so
 * stopping a pair cannot leave a callback behind. Sampling is always background work: a
 * missing, stale or broken metric only costs accuracy, never a forwarded request.
 */

export const AFFINITY_SWEEP_INTERVAL_MS = 5 * 60_000;
export const METRIC_SAMPLE_INTERVAL_MS = 5_000;
export const METRIC_SAMPLE_TIMEOUT_MS = 4_000;

export interface LoadMonitorOptions {
  readonly intervalMs?: number | undefined;
  readonly sampleIntervalMs?: number | undefined;
  readonly sampleTimeoutMs?: number | undefined;
  readonly logger?: Pick<StructuredLogger, "info" | "warn"> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface LoadMonitorSweepResult {
  readonly removedBindings: number;
}

export interface LoadMonitorSampleResult {
  readonly sampled: number;
  readonly skipped: number;
  readonly failed: number;
}

/** What the status API shows for one node. It never carries a key, a body or raw metrics. */
export interface LoadNodeStatus {
  readonly canonicalKey: string;
  readonly metrics: {
    readonly kvUsage: number | undefined;
    readonly running: number;
    readonly sampledAt: number;
    readonly source: string;
    readonly waiting: number;
  } | null;
  readonly stale: boolean;
  readonly targetId: string;
}

function toLoadSample(snapshot: LoadMetricsSnapshot, sampledAt: number): LoadSample | undefined {
  if (
    snapshot.running === undefined &&
    snapshot.waiting === undefined &&
    snapshot.kvUsage === undefined
  ) {
    return undefined;
  }
  return {
    sampledAt,
    running: snapshot.running ?? 0,
    waiting: snapshot.waiting ?? 0,
    kvUsage: snapshot.kvUsage,
    source: snapshot.source ?? "unknown",
    ...(snapshot.awake === undefined ? {} : { awake: snapshot.awake }),
  };
}

export class LoadMonitor {
  #balancer: LoadBalancer;
  readonly #intervalMs: number;
  readonly #sampleIntervalMs: number;
  readonly #sampleTimeoutMs: number;
  readonly #logger: Pick<StructuredLogger, "info" | "warn">;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #sampling = new Set<string>();
  readonly #failing = new Set<string>();
  #lastSweepAt = 0;

  constructor(balancer: LoadBalancer, options: LoadMonitorOptions = {}) {
    this.#balancer = balancer;
    this.#intervalMs = options.intervalMs ?? AFFINITY_SWEEP_INTERVAL_MS;
    this.#sampleIntervalMs = options.sampleIntervalMs ?? METRIC_SAMPLE_INTERVAL_MS;
    this.#sampleTimeoutMs = options.sampleTimeoutMs ?? METRIC_SAMPLE_TIMEOUT_MS;
    this.#logger =
      options.logger ??
      new StructuredLogger({ service: "llm-proxy-load-monitor", minimumLevel: "info" });
    this.#now = options.now ?? (() => Date.now());
    for (const [name, value] of [
      ["Load monitor sweep interval", this.#intervalMs],
      ["Load monitor sample interval", this.#sampleIntervalMs],
      ["Load monitor sample timeout", this.#sampleTimeoutMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive number.`);
      }
    }
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  get sampleIntervalMs(): number {
    return this.#sampleIntervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#sampleIntervalMs);
    // Load balancing must never keep the process alive on its own.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#sampling.clear();
    this.#failing.clear();
  }

  /** Point at a rebuilt balancer. The pair keeps one monitor across reloads. */
  reconfigure(balancer: LoadBalancer): void {
    this.#balancer = balancer;
  }

  sweepNow(): LoadMonitorSweepResult {
    let removedBindings = 0;
    for (const groupId of this.#balancer.groupIds()) {
      removedBindings += this.#balancer.tableFor(groupId)?.sweepExpired() ?? 0;
    }
    // Ledgers follow bindings: an entry whose binding is gone and holds nothing in
    // flight is dropped here, while one still carrying a live reservation survives
    // until its late release lands and cleans it up.
    this.#balancer.sweepBindingActivity();
    this.#lastSweepAt = this.#now();
    return { removedBindings };
  }

  /** Sample every referenced enabled node, once per physical engine. Used by tests. */
  async sampleNow(): Promise<LoadMonitorSampleResult> {
    const outcomes = await Promise.all(this.#keysToSample().map((key) => this.#sampleKey(key)));
    return {
      sampled: outcomes.filter((outcome) => outcome === "sampled").length,
      skipped: outcomes.filter((outcome) => outcome === "skipped").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
    };
  }

  /** Per-node serving state for the status API, with nothing sensitive in it. */
  nodeStatuses(): readonly LoadNodeStatus[] {
    const now = this.#now();
    return this.#balancer.nodeIds().map((targetId) => {
      const node = this.#balancer.nodeFor(targetId);
      const sample = node?.sample;
      return {
        canonicalKey: node?.canonicalKey ?? targetId,
        metrics:
          sample === undefined
            ? null
            : {
                kvUsage: sample.kvUsage,
                running: sample.running,
                sampledAt: sample.sampledAt,
                source: sample.source,
                waiting: sample.waiting,
              },
        stale: sample === undefined || now - sample.sampledAt > METRIC_FRESH_WINDOW_MS,
        targetId,
      };
    });
  }

  async #tick(): Promise<void> {
    await this.sampleNow();
    const now = this.#now();
    if (now - this.#lastSweepAt >= this.#intervalMs) {
      this.sweepNow();
    }
  }

  /**
   * One canonical key means one engine. Two targets of the same GPU are sampled once and
   * both get the same numbers, so a pair with duplicated spellings cannot double its
   * metric traffic.
   */
  #keysToSample(): string[] {
    const keys = new Set<string>();
    for (const groupId of this.#balancer.groupIds()) {
      const group = this.#balancer.groupFor(groupId);
      if (!group?.enabled || !group.metrics_enabled) {
        continue;
      }
      for (const targetId of loadBalancerMemberTargetIds(group)) {
        const node = this.#balancer.nodeFor(targetId);
        if (!node?.enabled) {
          continue;
        }
        keys.add(node.canonicalKey);
      }
    }
    return [...keys];
  }

  async #sampleKey(canonicalKey: string): Promise<"failed" | "sampled" | "skipped"> {
    if (this.#sampling.has(canonicalKey)) {
      return "skipped";
    }
    this.#sampling.add(canonicalKey);
    try {
      const nodes = this.#nodesForKey(canonicalKey);
      const first = nodes[0];
      if (first === undefined) {
        return "skipped";
      }
      const response = await fetchTargetMetrics({
        apiKey: first.apiKey,
        targetUrl: first.targetUrl,
        timeoutMs: this.#sampleTimeoutMs,
      });
      if (!response.ok || response.text === undefined) {
        for (const node of nodes) {
          this.#balancer.setSample(node.targetId, undefined);
        }
        this.#noteFailure(canonicalKey, response.error ?? "metrics unavailable");
        return "failed";
      }
      // Anything the exposition does not answer stays missing: an unmeasured node is
      // judged on local inFlight alone, never on an invented zero.
      const sample = toLoadSample(parseLoadMetrics(response.text), this.#now());
      for (const node of nodes) {
        this.#balancer.setSample(node.targetId, sample);
      }
      this.#noteRecovery(canonicalKey);
      return "sampled";
    } finally {
      this.#sampling.delete(canonicalKey);
    }
  }

  #nodesForKey(canonicalKey: string): LoadBalancerNode[] {
    return this.#balancer
      .targetsForCanonicalKey(canonicalKey)
      .map((targetId) => this.#balancer.nodeFor(targetId))
      .filter((node): node is LoadBalancerNode => node?.enabled === true);
  }

  /** Log one line when a key starts failing, and one line when it comes back. */
  #noteFailure(canonicalKey: string, error: string): void {
    if (this.#failing.has(canonicalKey)) {
      return;
    }
    this.#failing.add(canonicalKey);
    this.#logger.warn("upstream metrics sampling failed", { canonicalKey, error });
  }

  #noteRecovery(canonicalKey: string): void {
    if (!this.#failing.has(canonicalKey)) {
      return;
    }
    this.#failing.delete(canonicalKey);
    this.#logger.info("upstream metrics sampling recovered", { canonicalKey });
  }
}
