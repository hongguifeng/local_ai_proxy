import type { ProxyPair, PublicProxyPair, TargetConfig } from "../config/index.js";
import { TrafficLogService } from "../logging/index.js";
import { ActiveRequestRegistry } from "./active-requests.js";
import { parseHeaderOverrides } from "./headers.js";
import { ProxyListener } from "./proxy-listener.js";
import { ProxyRequestPipeline, type ProxyPipelineTarget } from "./proxy-request-pipeline.js";
import { ProxyRuntimeStateMachine, type ProxyRuntimeSnapshot } from "./proxy-runtime-state.js";
import { parseInjectRequestFields, parseStripRequestFields } from "./request-transform.js";
import { parseTargetUrl } from "./target.js";

interface ProxyRuntimeResources {
  readonly activeRequests: ActiveRequestRegistry;
  readonly listener: ProxyListener;
  readonly logServices: readonly TrafficLogService[];
}

interface ProxyRuntimeEntry {
  resources: ProxyRuntimeResources | undefined;
  readonly state: ProxyRuntimeStateMachine;
}

export interface StartEnabledResult {
  readonly failed: ReadonlyMap<string, Error>;
  readonly started: ReadonlyMap<string, ProxyRuntimeSnapshot>;
}

export interface ProxyRuntimeRegistryOptions {
  readonly shutdownTimeoutMs?: number;
}

export interface ProxyRuntimeDiagnostics {
  readonly activeRequests: number;
  readonly resourcePairs: number;
  readonly runningPairs: number;
}

export class ProxyRuntimeRegistry {
  readonly #entries = new Map<string, ProxyRuntimeEntry>();
  readonly #shutdownTimeoutMs: number;

  constructor(options: ProxyRuntimeRegistryOptions = {}) {
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    if (!Number.isFinite(this.#shutdownTimeoutMs) || this.#shutdownTimeoutMs < 0) {
      throw new RangeError("Proxy shutdown timeout must be a non-negative number.");
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
        activeRequests += entry.resources.activeRequests.size;
      }
      if (entry.state.snapshot.running) {
        runningPairs += 1;
      }
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
    const activeRequests = new ActiveRequestRegistry();
    const logServices: TrafficLogService[] = [];
    try {
      const targets = pair.targets.map((target) => {
        const logService = new TrafficLogService(
          target.log_root === "" ? undefined : target.log_root,
          {
            redactLogs: target.redact_logs,
          },
        );
        logServices.push(logService);
        return runtimeTarget(target, logService);
      });
      const pipeline = new ProxyRequestPipeline({
        activeRequests,
        defaultTargetId: pair.default_target_id,
        pairId: pair.id,
        pairName: pair.name,
        targets,
      });
      const listener = new ProxyListener({
        host: pair.listen_host,
        port: pair.listen_port,
        onRequest: (request, response, context) => pipeline.handle(request, response, context),
      });
      const address = await listener.start();
      entry.resources = { activeRequests, listener, logServices };
      entry.state.markRunning(address.port);
      return entry.state.snapshot;
    } catch (error) {
      await Promise.all(logServices.map((service) => service.close()));
      entry.resources = undefined;
      entry.state.markStartFailed(error);
      throw error;
    }
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
    try {
      if (resources !== undefined) {
        const closePromise = resources.listener.close();
        const closedGracefully = await settlesWithin(closePromise, this.#shutdownTimeoutMs);
        if (!closedGracefully) {
          resources.activeRequests.abortAll(new Error("Proxy pair shutdown timed out"));
          resources.listener.closeAllConnections();
          await closePromise;
        }
        await Promise.all(resources.logServices.map((service) => service.close()));
      }
      entry.resources = undefined;
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
    await Promise.all([...this.#entries.keys()].map((pairId) => this.stopPair(pairId)));
  }

  #entry(pairId: string): ProxyRuntimeEntry {
    let entry = this.#entries.get(pairId);
    if (entry === undefined) {
      entry = { resources: undefined, state: new ProxyRuntimeStateMachine() };
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

function runtimeTarget(target: TargetConfig, trafficLog: TrafficLogService): ProxyPipelineTarget {
  const parsed = parseTargetUrl(target.target_url);
  return {
    enabled: target.enabled,
    id: target.id,
    injectRequestFields: parseInjectRequestFields(target.inject_request_fields),
    modelMappings: target.model_mappings,
    name: target.name,
    stripRequestFields: parseStripRequestFields(target.strip_request_fields),
    targetScheme: parsed.scheme,
    targetHost: parsed.host,
    targetPort: parsed.port,
    targetBasePath: parsed.basePath,
    targetApiKey: target.target_api_key,
    targetHeaders: parseHeaderOverrides(target.target_headers),
    timeoutMs: target.timeout * 1_000,
    trafficLog,
  };
}
