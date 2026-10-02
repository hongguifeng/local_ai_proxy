import path from "node:path";
import type { ServerResponse } from "node:http";

import type { ProxyPair, PublicProxyPair, TargetConfig } from "../config/index.js";
import { TrafficLogService } from "../logging/index.js";
import { ActiveRequestRegistry } from "./active-requests.js";
import { parseHeaderOverrides } from "./headers.js";
import { ProxyListener } from "./proxy-listener.js";
import { ProxyRequestPipeline, type ProxyPipelineTarget } from "./proxy-request-pipeline.js";
import { ProxyRuntimeStateMachine, type ProxyRuntimeSnapshot } from "./proxy-runtime-state.js";
import { parseInjectRequestFields, parseStripRequestFields } from "./request-transform.js";
import { parseTargetUrl } from "./target.js";

/** A request pipeline and the requests that were started on it. */
interface ProxyRuntimePipelineState {
  readonly activeRequests: ActiveRequestRegistry;
  readonly pipeline: ProxyRequestPipeline;
}

interface ProxyRuntimeResources {
  readonly listener: ProxyListener;
  /** Swapped as a unit when a pair is reloaded; requests already in flight keep their own state. */
  current: ProxyRuntimePipelineState;
}

interface ProxyRuntimeEntry {
  readonly pairId: string;
  resources: ProxyRuntimeResources | undefined;
  /** Traffic log services reused across reloads while the pair keeps its listener. */
  logServices: Map<string, TrafficLogService>;
  readonly state: ProxyRuntimeStateMachine;
}

interface CompiledProxyTargets {
  readonly targets: ProxyPipelineTarget[];
  readonly retained: Map<string, TrafficLogService>;
  readonly superseded: TrafficLogService[];
}

interface ProxyDrainRecord {
  readonly activeRequests: ActiveRequestRegistry;
  readonly supersededLogServices: readonly TrafficLogService[];
  /** Assigned immediately after the record is created; readers treat it as read-only. */
  settled: Promise<void>;
  force(reason: Error): void;
}

export interface StartEnabledResult {
  readonly failed: ReadonlyMap<string, Error>;
  readonly started: ReadonlyMap<string, ProxyRuntimeSnapshot>;
}

export interface ProxyRuntimeRegistryOptions {
  readonly shutdownTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
}

export interface ProxyRuntimeDiagnostics {
  readonly activeRequests: number;
  readonly resourcePairs: number;
  readonly runningPairs: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;

export class ProxyRuntimeRegistry {
  readonly #entries = new Map<string, ProxyRuntimeEntry>();
  readonly #drains = new Set<ProxyDrainRecord>();
  readonly #shutdownTimeoutMs: number;
  readonly #drainTimeoutMs: number;

  constructor(options: ProxyRuntimeRegistryOptions = {}) {
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    for (const [name, value] of [
      ["Proxy shutdown timeout", this.#shutdownTimeoutMs],
      ["Proxy drain timeout", this.#drainTimeoutMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative number.`);
      }
    }
  }

  status(pairId: string): ProxyRuntimeSnapshot {
    return this.#entry(pairId).state.snapshot;
  }

  diagnostics(): ProxyRuntimeDiagnostics {
    let activeRequests = 0;
    let resourcePairs = 0;
    let runningPairs = 0;
    for (const entry of this.#entries.values()) {
      if (entry.resources !== undefined) {
        resourcePairs += 1;
        activeRequests += entry.resources.current.activeRequests.size;
      }
      if (entry.state.snapshot.running) {
        runningPairs += 1;
      }
    }
    // Requests that started before a reload keep running on the superseded pipeline.
    for (const record of this.#drains) {
      activeRequests += record.activeRequests.size;
    }
    return { activeRequests, resourcePairs, runningPairs };
  }

  publicPair(pair: ProxyPair): PublicProxyPair {
    const status = this.status(pair.id);
    return {
      ...pair,
      running: status.running,
      actual_listen_port: status.actualListenPort,
    };
  }

  async startPair(pair: ProxyPair): Promise<ProxyRuntimeSnapshot> {
    const entry = this.#entry(pair.id);
    if (entry.state.snapshot.running) {
      return entry.state.snapshot;
    }
    entry.state.beginStart();
    entry.logServices = new Map();
    const created: TrafficLogService[] = [];
    let compiled: CompiledProxyTargets;
    try {
      compiled = this.#compileTargets(entry, pair.targets, created);
    } catch (error) {
      entry.logServices = new Map();
      await closeLogServices(created);
      entry.state.markStartFailed(error);
      throw error;
    }
    entry.logServices = compiled.retained;
    const activeRequests = new ActiveRequestRegistry();
    const pipeline = new ProxyRequestPipeline({
      activeRequests,
      defaultTargetId: pair.default_target_id,
      pairId: pair.id,
      pairName: pair.name,
      targets: compiled.targets,
    });
    const current: ProxyRuntimePipelineState = { activeRequests, pipeline };
    const listener = new ProxyListener({
      host: pair.listen_host,
      port: pair.listen_port,
      onRequest: (request, response, context) => {
        // New requests follow the current pipeline; requests already in flight keep theirs.
        const active = entry.resources?.current;
        if (active === undefined) {
          respondUnavailable(response);
          return;
        }
        return active.pipeline.handle(request, response, context);
      },
    });
    entry.resources = { listener, current };
    try {
      const address = await listener.start();
      entry.state.markRunning(address.port);
      return entry.state.snapshot;
    } catch (error) {
      entry.resources = undefined;
      entry.logServices = new Map();
      await closeLogServices(created);
      entry.state.markStartFailed(error);
      throw error;
    }
  }

  /**
   * Replace the pipeline of a running pair without closing its listener, so requests that are
   * already in flight keep streaming on the configuration they started with.
   */
  async reloadPair(pair: ProxyPair): Promise<ProxyRuntimeSnapshot> {
    const entry = this.#entry(pair.id);
    const resources = entry.resources;
    if (resources === undefined || !entry.state.snapshot.running) {
      return this.startPair(pair);
    }
    const superseded = resources.current;
    const created: TrafficLogService[] = [];
    let compiled: CompiledProxyTargets;
    try {
      compiled = this.#compileTargets(entry, pair.targets, created);
    } catch (error) {
      await closeLogServices(created);
      throw error;
    }
    const activeRequests = new ActiveRequestRegistry();
    const pipeline = new ProxyRequestPipeline({
      activeRequests,
      defaultTargetId: pair.default_target_id,
      pairId: pair.id,
      pairName: pair.name,
      targets: compiled.targets,
    });
    entry.logServices = compiled.retained;
    resources.current = { activeRequests, pipeline };
    this.#drain(entry.pairId, superseded.activeRequests, compiled.superseded);
    return entry.state.snapshot;
  }

  async startEnabled(pairs: readonly ProxyPair[]): Promise<StartEnabledResult> {
    const started = new Map<string, ProxyRuntimeSnapshot>();
    const failed = new Map<string, Error>();
    for (const pair of pairs) {
      if (pair.enabled) {
        try {
          started.set(pair.id, await this.startPair(pair));
        } catch (error) {
          failed.set(pair.id, error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    return { failed, started };
  }

  async stopPair(pairId: string): Promise<ProxyRuntimeSnapshot> {
    const entry = this.#entry(pairId);
    const snapshot = entry.state.snapshot;
    if (snapshot.state === "stopped") {
      return snapshot;
    }
    entry.state.beginStop();
    const resources = entry.resources;
    entry.resources = undefined;
    try {
      if (resources !== undefined) {
        const closePromise = resources.listener.close();
        const closedGracefully = await settlesWithin(closePromise, this.#shutdownTimeoutMs);
        if (!closedGracefully) {
          resources.current.activeRequests.abortAll(new Error("Proxy pair shutdown timed out"));
          resources.listener.closeAllConnections();
          await closePromise;
        }
      }
      await closeLogServices([...entry.logServices.values()]);
      entry.logServices = new Map();
      entry.state.markStopped();
      return entry.state.snapshot;
    } catch (error) {
      entry.state.markStopFailed(error);
      throw error;
    }
  }

  async restartPair(pair: ProxyPair): Promise<ProxyRuntimeSnapshot> {
    await this.stopPair(pair.id);
    return this.startPair(pair);
  }

  async stopAll(): Promise<void> {
    const drains = [...this.#drains];
    for (const record of drains) {
      record.force(new Error("Proxy shutdown"));
    }
    await Promise.all([...this.#entries.keys()].map((pairId) => this.stopPair(pairId)));
    await Promise.all(drains.map((record) => record.settled));
  }

  #drain(
    pairId: string,
    activeRequests: ActiveRequestRegistry,
    supersededLogServices: readonly TrafficLogService[],
  ): ProxyDrainRecord {
    const record: ProxyDrainRecord = {
      activeRequests,
      supersededLogServices,
      settled: Promise.resolve(),
      force: (reason: Error) => {
        activeRequests.abortAll(reason);
      },
    };
    record.settled = (async () => {
      const drained = await settlesWithin(activeRequests.idle(), this.#drainTimeoutMs);
      if (!drained) {
        activeRequests.abortAll(new Error(`Proxy pair ${pairId} drain timed out.`));
        await settlesWithin(activeRequests.idle(), this.#shutdownTimeoutMs);
      }
      await closeLogServices(supersededLogServices);
      this.#drains.delete(record);
    })();
    this.#drains.add(record);
    return record;
  }

  #compileTargets(
    entry: ProxyRuntimeEntry,
    configuredTargets: readonly TargetConfig[],
    created: TrafficLogService[],
  ): CompiledProxyTargets {
    const retained = new Map<string, TrafficLogService>();
    const targets = configuredTargets.map((target) => {
      const key = logServiceKey(target);
      let service = retained.get(key) ?? entry.logServices.get(key);
      if (service === undefined) {
        service = new TrafficLogService(target.log_root === "" ? undefined : target.log_root, {
          redactLogs: target.redact_logs,
        });
        created.push(service);
      }
      retained.set(key, service);
      return runtimeTarget(target, service);
    });
    const superseded = [...entry.logServices]
      .filter(([key]) => !retained.has(key))
      .map(([, service]) => service);
    return { targets, retained, superseded };
  }

  #entry(pairId: string): ProxyRuntimeEntry {
    let entry = this.#entries.get(pairId);
    if (entry === undefined) {
      entry = {
        pairId,
        resources: undefined,
        logServices: new Map(),
        state: new ProxyRuntimeStateMachine(),
      };
      this.#entries.set(pairId, entry);
    }
    return entry;
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([promise.then(() => true), timedOut]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

async function closeLogServices(services: readonly TrafficLogService[]): Promise<void> {
  await Promise.all(
    services.map(async (service) => {
      await service.close().catch(() => undefined);
    }),
  );
}

function respondUnavailable(response: ServerResponse): void {
  response.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end("Proxy pair is stopping.");
}

function logServiceKey(target: TargetConfig): string {
  const logRoot = target.log_root.trim();
  const key = logRoot === "" ? "" : path.resolve(logRoot);
  return `${key}\u0000redact=${String(target.redact_logs)}`;
}

function runtimeTarget(target: TargetConfig, trafficLog: TrafficLogService): ProxyPipelineTarget {
  const parsed = parseTargetUrl(target.target_url);
  return {
    enabled: target.enabled,
    id: target.id,
    injectRequestFields: parseInjectRequestFields(target.inject_request_fields),
    modelMappings: target.model_mappings,
    modelPrices: target.model_prices,
    name: target.name,
    stripRequestFields: parseStripRequestFields(target.strip_request_fields),
    targetScheme: parsed.scheme,
    targetHost: parsed.host,
    targetPort: parsed.port,
    targetBasePath: parsed.basePath,
    targetApiKey: target.target_api_key,
    targetHeaders: parseHeaderOverrides(target.target_headers),
    trafficLog,
  };
}
