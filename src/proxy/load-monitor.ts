import type { LoadBalancer } from "./load-balancer.js";

/**
 * Owns the periodic work for one pair's load balancer. In this step it only keeps
 * affinity garbage-collected; upstream metric sampling lands in the same timer later.
 * The monitor is the only place that touches timers, so stopping a pair cannot leave
 * a callback behind.
 */

export const AFFINITY_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface LoadMonitorOptions {
  readonly intervalMs?: number | undefined;
}

export interface LoadMonitorSweepResult {
  readonly removedBindings: number;
}

export class LoadMonitor {
  #balancer: LoadBalancer;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(balancer: LoadBalancer, options: LoadMonitorOptions = {}) {
    this.#balancer = balancer;
    this.#intervalMs = options.intervalMs ?? AFFINITY_SWEEP_INTERVAL_MS;
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new RangeError("Load monitor interval must be a positive number.");
    }
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      this.sweepNow();
    }, this.#intervalMs);
    // Load balancing must never keep the process alive on its own.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
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
    return { removedBindings };
  }
}
