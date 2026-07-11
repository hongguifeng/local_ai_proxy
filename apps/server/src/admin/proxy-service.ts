import {
  ProxyReplaceRequestSchema,
  ProxyListResponseSchema,
  type AdminProxyUpdate,
  type ProxyListResponse,
} from "@llm-proxy/contracts";

import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { AtomicRuntimeConfig } from "../runtime/atomic-config.js";
import type { RuntimeManager, RuntimeStatus } from "../runtime/runtime-manager.js";

export class AdminProxyService {
  readonly #config: AtomicRuntimeConfig;
  readonly #runtimes: RuntimeManager;

  public constructor(config: AtomicRuntimeConfig, runtimes: RuntimeManager) {
    this.#config = config;
    this.#runtimes = runtimes;
  }

  public list(): ProxyListResponse {
    return publicList(this.#config.snapshot, this.#runtimes.list());
  }

  public async replace(input: unknown): Promise<ProxyListResponse> {
    const request = ProxyReplaceRequestSchema.parse(input);
    const current = this.#config.snapshot;
    await this.#config.replace({
      version: 1,
      proxies: request.proxies.map((proxy) => resolveProxy(proxy, current)),
      capture: current.capture,
      retention: current.retention,
    });
    return this.list();
  }

  public async setEnabled(proxyId: string, enabled: boolean): Promise<ProxyListResponse> {
    const current = this.#config.snapshot;
    if (!current.proxies.some((proxy) => proxy.id === proxyId)) throw new ProxyNotFoundError();
    await this.#config.replace({
      version: 1,
      proxies: current.proxies.map((proxy) => persistedProxy(proxy, proxy.id === proxyId ? enabled : proxy.enabled)),
      capture: current.capture,
      retention: current.retention,
    });
    return this.list();
  }
}

function persistedProxy(proxy: RuntimeConfigSnapshot["proxies"][number], enabled: boolean) {
  return {
    id: proxy.id,
    name: proxy.name,
    enabled,
    listenHost: proxy.listenHost,
    listenPort: proxy.listenPort,
    accessLog: proxy.accessLog,
    defaultTargetId: proxy.defaultTargetId,
    targets: proxy.targets.map((target) => {
      const { endpoint, ...persisted } = target;
      void endpoint;
      return persisted;
    }),
  };
}

export class ProxyNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = "PROXY_NOT_FOUND";

  public constructor() {
    super("Proxy does not exist");
  }
}

function resolveProxy(proxy: AdminProxyUpdate, current: RuntimeConfigSnapshot) {
  const existing = current.proxies.find((value) => value.id === proxy.id);
  return {
    ...proxy,
    targets: proxy.targets.map((target) => {
      const previous = existing?.targets.find((value) => value.id === target.id)?.targetApiKey ?? "";
      const targetApiKey =
        target.apiKey.action === "keep" ? previous : target.apiKey.action === "clear" ? "" : target.apiKey.value;
      const { apiKey, ...values } = target;
      void apiKey;
      return { ...values, targetApiKey };
    }),
  };
}

function publicList(config: RuntimeConfigSnapshot, statuses: readonly RuntimeStatus[]): ProxyListResponse {
  const runtimeById = new Map(statuses.map((status) => [status.id, status]));
  return ProxyListResponseSchema.parse({
    proxies: config.proxies.map((proxy) => {
      const runtime = runtimeById.get(proxy.id);
      return {
        id: proxy.id,
        name: proxy.name,
        enabled: proxy.enabled,
        listenHost: proxy.listenHost,
        listenPort: proxy.listenPort,
        accessLog: proxy.accessLog,
        defaultTargetId: proxy.defaultTargetId,
        targets: proxy.targets.map((target) => ({
          id: target.id,
          name: target.name,
          enabled: target.enabled,
          url: target.url,
          apiKey: secretState(target.targetApiKey),
          headers: [...target.headers],
          stripRequestFields: [...target.stripRequestFields],
          injectRequestFields: target.injectRequestFields,
          timeouts: target.timeouts,
          logRoot: target.logRoot,
          redactLogs: target.redactLogs,
          modelMappings: [...target.modelMappings],
        })),
        runtime: {
          state: runtime?.state ?? "configured",
          actualListenPort: runtime?.actualListenPort ?? null,
          ...(runtime?.errorCode ? { errorCode: runtime.errorCode } : {}),
        },
      };
    }),
  });
}

function secretState(secret: string): { configured: boolean; masked?: string } {
  if (!secret) return { configured: false };
  return { configured: true, masked: secret.length <= 4 ? "****" : `...${secret.slice(-4)}` };
}
