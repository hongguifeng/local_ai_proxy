import { StructuredLogger } from "../shared/index.js";

import { loadBalancerMemberTargetIds, type LoadBalancerGroup } from "../config/index.js";

import { type LoadBalancer, type LoadBalancerNode, type LoadSample } from "./load-balancer.js";
import { assessLoadSample, engineLoadViews } from "./load-evidence.js";
import {
  ADVISE_OBSERVATION_POLICY,
  RebalanceAdvisor,
  type RebalanceBindingCandidate,
  type RebalanceGroupView,
  type RebalancePolicy,
  type RebalanceSuggestion,
  type RebalanceTickInput,
} from "./load-rebalance.js";
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
  /**
   * The named parameters the advisor runs on. The default is the uncalibrated advise
   * observation policy; tests (and a future calibrated policy) may hand in another one.
   */
  readonly rebalancePolicy?: RebalancePolicy | undefined;
}

export interface LoadMonitorSweepResult {
  readonly removedBindings: number;
}

export interface LoadMonitorSampleResult {
  readonly sampled: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * What the status API shows for one node. It never carries a key, a body or raw metrics.
 * `metrics` is null when no read ever produced a number; inside a sample, `running` or
 * `waiting` being null means the engine answered the exposition but not that field. A real
 * zero is printed as zero, so the console can tell "measured idle" from "not measured".
 */
export interface LoadNodeStatus {
  readonly canonicalKey: string;
  readonly metrics: {
    readonly kvUsage: number | undefined;
    readonly running: number | null;
    readonly sampledAt: number;
    readonly source: string;
    readonly waiting: number | null;
  } | null;
  readonly stale: boolean;
  readonly targetId: string;
}

/**
 * Turns a parsed engine answer into a node sample. A field the answer left out stays
 * missing: a zero that never existed would let an unmeasured node look idle, and a strategy
 * reading that zero would move work to a node whose load is simply unknown.
 */
function toLoadSample(
  snapshot: LoadMetricsSnapshot,
  sampledAt: number,
  sampleSequence: number,
): LoadSample {
  return {
    sampleSequence,
    sampledAt,
    running: snapshot.running,
    waiting: snapshot.waiting,
    kvUsage: snapshot.kvUsage,
    source: snapshot.source ?? "unknown",
    ...(snapshot.awake === undefined ? {} : { awake: snapshot.awake }),
  };
}

/** Whether the exposition answered at least one number, which is what makes it a sample. */
function answeredAnyMetric(snapshot: LoadMetricsSnapshot): boolean {
  return (
    snapshot.running !== undefined ||
    snapshot.waiting !== undefined ||
    snapshot.kvUsage !== undefined
  );
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
  /**
   * How many samples each physical engine has produced. Read across a stop on purpose:
   * a restarted monitor must not hand out a number an older sample already used, or two
   * different answers would look like the same one to anything that counts by sequence.
   */
  readonly #sampleSequences = new Map<string, number>();
  /**
   * The advisor state (TRI-10). It runs on this monitor's tick, never on its own timer, so
   * stopping a pair drops the suggestions along with the sampling state and nothing keeps
   * running only because a UI page happens to be open.
   */
  readonly #advisor = new RebalanceAdvisor();
  readonly #rebalancePolicy: RebalancePolicy;
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
    this.#rebalancePolicy = options.rebalancePolicy ?? ADVISE_OBSERVATION_POLICY;
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
    // Advisor state follows the pair: a stopped runtime has no suggestions worth keeping,
    // and the next runtime starts with the empty store, exactly like the migration records.
    this.#advisor.clear();
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
    // Migration records follow both: an intent whose binding was just evicted, or whose target
    // went away, or whose retention window passed is reported here, and records that stopped
    // being worth keeping are dropped.
    this.#balancer.sweepPendingMigrations();
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
      // One place decides what "still current" means, so the badge and the ranking cannot
      // drift apart on the same number.
      const assessment = assessLoadSample(sample, now);
      return {
        canonicalKey: node?.canonicalKey ?? targetId,
        metrics:
          sample === undefined
            ? null
            : {
                kvUsage: sample.kvUsage,
                running: sample.running ?? null,
                sampledAt: sample.sampledAt,
                source: sample.source,
                waiting: sample.waiting ?? null,
              },
        stale: assessment.freshness !== "fresh",
        targetId,
      };
    });
  }

  async #tick(): Promise<void> {
    await this.sampleNow();
    this.#runAdvisor();
    const now = this.#now();
    if (now - this.#lastSweepAt >= this.#intervalMs) {
      this.sweepNow();
    }
  }

  /**
   * [TRI-10] What the status API reads for the automatic rebalance state of every group on
   * this pair. Purely in-memory: the advisor's own store, no sampling, no database.
   */
  rebalanceViews(): readonly RebalanceGroupView[] {
    return this.#balancer
      .groupIds()
      .map((groupId) =>
        this.#advisor.viewFor(groupId, this.#balancer.groupFor(groupId)?.rebalance_mode ?? "off"),
      );
  }

  /**
   * [TRI-10] One advisor pass over every group that asked for it. `off` groups are not even
   * read - their advisor state is dropped instead, so "off computes nothing" is enforced at
   * the entry point, not by filtering results afterwards. A disabled group or one with
   * metrics off has no fresh evidence to judge by, so it gets the same treatment.
   */
  #runAdvisor(): void {
    const now = this.#now();
    for (const groupId of this.#balancer.groupIds()) {
      const group = this.#balancer.groupFor(groupId);
      if (
        group === undefined ||
        !group.enabled ||
        !group.metrics_enabled ||
        group.rebalance_mode === "off"
      ) {
        this.#advisor.dropGroup(groupId);
        continue;
      }
      const input = this.#advisorInput(groupId, group, now);
      if (input === undefined) {
        continue;
      }
      const result = this.#advisor.tick(input);
      for (const suggestion of result.created) {
        this.#logSuggestion("load rebalance suggestion", suggestion);
      }
      for (const suggestion of result.expired) {
        this.#logSuggestion("load rebalance suggestion expired", suggestion);
      }
      // A refusal is part of "what the automatic policy would do and why it did not": the
      // store keeps it and the status API shows it, so the log must not stay silent on it.
      for (const suggestion of result.rejected) {
        this.#logSuggestion("load rebalance suggestion refused", suggestion);
      }
    }
  }

  #logSuggestion(message: string, suggestion: RebalanceSuggestion): void {
    // Only ids, targets, revisions and numbers: never a body, an exact key or a session id.
    this.#logger.info(message, {
      bindingId: suggestion.bindingId,
      destinationTargetId: suggestion.destinationTargetId,
      groupId: suggestion.groupId,
      incarnation: suggestion.incarnation,
      sourceTargetId: suggestion.sourceTargetId,
      stableSamples: suggestion.stableSamples,
      suggestionId: suggestion.suggestionId,
      // A created suggestion has no reason yet; an expired or refused one names its own.
      ...(suggestion.stateReason === undefined ? {} : { stateReason: suggestion.stateReason }),
    });
  }

  /**
   * The advisor's whole input, assembled from memory only: node identities with their
   * already-stored samples, target reservations, the binding projection (which touches
   * nothing) and the write gate's own answer for each binding. No fetch, no database, no
   * second authority - the gate codes are the balancer's decision, read not re-derived.
   */
  #advisorInput(
    groupId: string,
    group: LoadBalancerGroup,
    now: number,
  ): RebalanceTickInput | undefined {
    const snapshot = this.#balancer.bindingSnapshot(groupId);
    if (snapshot === undefined) {
      return undefined;
    }
    const memberIds = loadBalancerMemberTargetIds(group);
    const nodes = memberIds
      .map((targetId) => this.#balancer.nodeFor(targetId))
      .filter((node): node is LoadBalancerNode => node !== undefined);
    const targetInFlight = new Map<string, number>(
      memberIds.map((targetId) => [targetId, this.#balancer.inFlight(targetId)]),
    );
    const candidates: RebalanceBindingCandidate[] = [];
    for (const entry of snapshot.entries) {
      const gates = this.#balancer.moveGatesFor(groupId, entry.ref);
      if (gates === undefined) {
        continue;
      }
      candidates.push({
        activity: entry.activity,
        gates,
        ref: entry.ref,
        targetId: entry.targetId,
      });
    }
    return {
      candidates,
      engineViews: engineLoadViews(nodes, now),
      groupId,
      groupRevision: snapshot.groupRevision,
      memberOrder: memberIds,
      now,
      policy: this.#rebalancePolicy,
      runtimeEpoch: snapshot.runtimeEpoch,
      targetInFlight,
    };
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
      // Anything the exposition does not answer stays missing. A read that produced no
      // number at all is no sample, so the node keeps its unknown state instead of carrying
      // an empty one, and a read that proved nothing spends no sequence number.
      const snapshot = parseLoadMetrics(response.text);
      const sample = answeredAnyMetric(snapshot)
        ? toLoadSample(snapshot, this.#now(), this.#nextSampleSequence(canonicalKey))
        : undefined;
      for (const node of nodes) {
        this.#balancer.setSample(node.targetId, sample);
      }
      this.#noteRecovery(canonicalKey);
      return "sampled";
    } finally {
      this.#sampling.delete(canonicalKey);
    }
  }

  /**
   * Number the samples of one physical engine in the order they were accepted. Every target
   * alias of that key shares the number, so a reader can tell one answer looked at twice
   * from a second answer, and the same number is never handed out twice.
   */
  #nextSampleSequence(canonicalKey: string): number {
    const next = (this.#sampleSequences.get(canonicalKey) ?? 0) + 1;
    this.#sampleSequences.set(canonicalKey, next);
    return next;
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
