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

export class ProxyRuntimeRegistry {
  readonly #entries = new Map<string, ProxyRuntimeEntry>();

  status(pairId: string): ProxyRuntimeSnapshot {
    return this.#entry(pairId).state.snapshot;
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

  async startEnabled(
    pairs: readonly ProxyPair[],
  ): Promise<ReadonlyMap<string, ProxyRuntimeSnapshot>> {
    const started = new Map<string, ProxyRuntimeSnapshot>();
    for (const pair of pairs) {
      if (pair.enabled) {
        started.set(pair.id, await this.startPair(pair));
      }
    }
    return started;
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
        resources.activeRequests.abortAll(new Error("Proxy pair stopped"));
        await resources.listener.close();
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
