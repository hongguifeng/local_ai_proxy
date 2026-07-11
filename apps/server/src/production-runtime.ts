import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createAdminApp } from "./admin/app.js";
import { AdminLogService, type AdminLogSource } from "./admin/log-service.js";
import { registerLogRoutes } from "./admin/log-routes.js";
import { AdminProxyService } from "./admin/proxy-service.js";
import { registerProxyRoutes } from "./admin/proxy-routes.js";
import { registerStaticAssets } from "./admin/static-assets.js";
import type { CliOptions } from "./cli-options.js";
import { ConfigRepository } from "./config/repository.js";
import { createRuntimeConfigSnapshot, type RuntimeConfigSnapshot, type RuntimeProxy } from "./config/schema.js";
import type { ApplicationRuntime } from "./lifecycle.js";
import { createRuntimeLogger } from "./logging.js";
import { InternalMetrics } from "./observability.js";
import { ProxyServer, type TrafficEventSink } from "./proxy/proxy-server.js";
import {
  AtomicRuntimeConfig,
  type PreparedRuntimeChange,
  type RuntimeConfigApplier,
  type RuntimeConfigChange,
} from "./runtime/atomic-config.js";
import { RuntimeRecovery } from "./runtime/recovery.js";
import { RuntimeManager, type RuntimeStatus } from "./runtime/runtime-manager.js";
import { RetentionJob } from "./storage/capacity.js";
import { QueuedTrafficEventSink } from "./storage/traffic-event-sink.js";
import type { TrafficEvent } from "./storage/traffic-events.js";
import { StorageWorkerRegistry, type StorageWorkerLease } from "./storage/worker-client.js";
import { StorageWriteQueue, type StorageQueueMetrics } from "./storage/write-queue.js";

const EMPTY_QUEUE_METRICS: StorageQueueMetrics = {
  depth: 0,
  estimatedBytes: 0,
  committed: 0,
  failed: 0,
  dropped: 0,
  coalesced: 0,
  lastWaitMs: 0,
  maxWaitMs: 0,
  lastCommitMs: 0,
  maxCommitMs: 0,
};

export function createProductionRuntime(options: CliOptions): ApplicationRuntime {
  const logger = createRuntimeLogger({ development: process.env.LLM_PROXY_PRETTY_LOGS === "1" });
  const repository = new ConfigRepository(options.configFile);
  const registry = new StorageWorkerRegistry();
  let coordinator: ProductionCoordinator | null = null;
  let config: AtomicRuntimeConfig | null = null;
  let admin: FastifyInstance | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  const recovery = new RuntimeRecovery({ restart: async () => coordinator?.restartStorage() });
  const metrics = new InternalMetrics(() => coordinator?.queueMetrics() ?? EMPTY_QUEUE_METRICS);
  return {
    async start(signal): Promise<void> {
      if (signal.aborted) throw new Error("Startup aborted");
      await mkdir(dirname(resolve(options.configFile)), { recursive: true });
      const snapshot = createRuntimeConfigSnapshot(await repository.load());
      coordinator = new ProductionCoordinator(snapshot, options, registry, metrics, logger);
      await coordinator.start();
      config = new AtomicRuntimeConfig(snapshot, repository, coordinator);
      const proxyService = new AdminProxyService(config, coordinator);
      admin = createAdminApp(
        {
          health: () => recovery.health(coordinator?.list() ?? []),
          metrics: () => metrics.snapshot(),
          registerRoutes: async (scope) => {
            registerProxyRoutes(scope, proxyService);
            registerLogRoutes(scope, {
              listTasks: (...args) => activeCoordinator(coordinator).logs.listTasks(...args),
              listRecords: (...args) => activeCoordinator(coordinator).logs.listRecords(...args),
              getRecord: (...args) => activeCoordinator(coordinator).logs.getRecord(...args),
              cleanup: (...args) => activeCoordinator(coordinator).logs.cleanup(...args),
              export: (...args) => activeCoordinator(coordinator).logs.export(...args),
            });
            await registerStaticAssets(scope, fileURLToPath(new URL("./public", import.meta.url)));
          },
        },
        { ...(options.adminToken ? { adminToken: options.adminToken } : {}) },
      );
      await admin.listen({ host: options.host, port: options.port });
      retentionTimer = setInterval(() => void coordinator?.runRetention(), 60 * 60 * 1_000);
      retentionTimer.unref();
    },
    async wait(signal): Promise<void> {
      if (signal.aborted) return;
      await new Promise<void>((resolvePromise) => {
        signal.addEventListener(
          "abort",
          () => {
            resolvePromise();
          },
          { once: true },
        );
      });
    },
    async stop(): Promise<void> {
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
      await admin?.close();
      admin = null;
      await coordinator?.close();
      coordinator = null;
      config = null;
    },
  };
}

interface RuntimeBundle {
  snapshot: RuntimeConfigSnapshot;
  manager: RuntimeManager;
  roots: Map<string, RootStorage>;
  logs: AdminLogService;
}

interface RootStorage {
  logRoot: string;
  lease: StorageWorkerLease;
  queue: StorageWriteQueue;
  sink: QueuedTrafficEventSink;
  source: AdminLogSource;
  retention: RetentionJob;
}

class ProductionCoordinator implements RuntimeConfigApplier {
  readonly #options: CliOptions;
  readonly #registry: StorageWorkerRegistry;
  readonly #metrics: InternalMetrics;
  readonly #logger: ReturnType<typeof createRuntimeLogger>;
  #bundle: RuntimeBundle | null = null;

  public constructor(
    snapshot: RuntimeConfigSnapshot,
    options: CliOptions,
    registry: StorageWorkerRegistry,
    metrics: InternalMetrics,
    logger: ReturnType<typeof createRuntimeLogger>,
  ) {
    this.#options = options;
    this.#registry = registry;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#initial = snapshot;
  }

  readonly #initial: RuntimeConfigSnapshot;

  public async start(): Promise<void> {
    this.#bundle = await this.#createBundle(this.#initial);
    await this.#bundle.manager.startEnabled();
  }

  public list(): RuntimeStatus[] {
    return this.#bundle?.manager.list() ?? [];
  }

  public get logs(): AdminLogService {
    if (!this.#bundle) throw new Error("Runtime is not started");
    return this.#bundle.logs;
  }

  public async prepare(change: RuntimeConfigChange): Promise<PreparedRuntimeChange> {
    const previous = this.#bundle;
    if (!previous) throw new Error("Runtime is not started");
    await previous.manager.stopAll();
    let next: RuntimeBundle | null = null;
    try {
      next = await this.#createBundle(change.next);
      const states = await next.manager.startEnabled();
      if (Object.values(states).some((state) => state === "failed")) throw new Error("Updated proxy failed to start");
    } catch (error) {
      if (next) await closeBundle(next);
      await previous.manager.startEnabled();
      throw error;
    }
    const preparedNext = next;
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.#bundle = preparedNext;
        void closeBundle(previous);
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        await preparedNext.manager.stopAll();
        await closeBundle(preparedNext);
        await previous.manager.startEnabled();
      },
    };
  }

  public queueMetrics(): StorageQueueMetrics {
    const values = [...(this.#bundle?.roots.values() ?? [])].map((root) => root.queue.metrics());
    return values.reduce(sumQueueMetrics, { ...EMPTY_QUEUE_METRICS });
  }

  public async runRetention(): Promise<void> {
    await Promise.allSettled([...(this.#bundle?.roots.values() ?? [])].map(async (root) => root.retention.run()));
  }

  public async restartStorage(): Promise<void> {
    const snapshot = this.#bundle?.snapshot;
    if (!snapshot) throw new Error("Runtime is not started");
    const change: RuntimeConfigChange = {
      previous: snapshot,
      next: snapshot,
      added: [],
      changed: snapshot.proxies,
      removed: [],
      unchanged: [],
    };
    const prepared = await this.prepare(change);
    prepared.commit();
  }

  public async close(): Promise<void> {
    const bundle = this.#bundle;
    this.#bundle = null;
    if (bundle) await closeBundle(bundle);
  }

  async #createBundle(snapshot: RuntimeConfigSnapshot): Promise<RuntimeBundle> {
    const roots = new Map<string, RootStorage>();
    const rootPaths = configuredRoots(snapshot, this.#options.logRoot);
    try {
      for (const logRoot of rootPaths) {
        await mkdir(logRoot, { recursive: true });
        const lease = await this.#registry.acquire(logRoot);
        const queue = new StorageWriteQueue(lease.client, {
          maxPendingCount: 2_000,
          maxPendingBytes: 128 * 1024 * 1024,
          maxEventBytes: 70 * 1024 * 1024,
          onWarning: (code, queueMetrics) => {
            this.#logger.warn({ event: "storage_degraded", code, logRoot, queue: queueMetrics }, "Storage degraded");
          },
        });
        const source = workerSource(logRoot, lease);
        roots.set(logRoot, {
          logRoot,
          lease,
          queue,
          sink: new QueuedTrafficEventSink(queue),
          source,
          retention: new RetentionJob({
            source,
            dataPath: logRoot,
            days: snapshot.retention.days,
            maxTasks: 100_000,
            lowWatermarkBytes: 256 * 1024 * 1024,
            isIdle: () => queue.metrics().depth === 0,
          }),
        });
      }
      const manager = new RuntimeManager(snapshot.proxies, (proxy) => this.#server(proxy, snapshot, roots));
      return { snapshot, manager, roots, logs: new AdminLogService([...roots.values()].map((root) => root.source)) };
    } catch (error) {
      await Promise.allSettled([...roots.values()].map(async (root) => root.lease.release()));
      throw error;
    }
  }

  #server(proxy: RuntimeProxy, snapshot: RuntimeConfigSnapshot, roots: Map<string, RootStorage>): ProxyServer {
    const sink = new RoutedTrafficSink(proxy, this.#options.logRoot, roots);
    return new ProxyServer({
      host: proxy.listenHost,
      port: proxy.listenPort,
      proxy,
      maxRequestBodyBytes: snapshot.capture.maxRequestBodyBytes,
      requestCaptureBytes: snapshot.capture.requestBytes,
      responseCaptureBytes: snapshot.capture.responseBytes,
      totalRequestTimeoutMs: Math.max(...proxy.targets.map((target) => target.timeouts.idleMs), 600_000),
      trafficSink: sink,
      onRequest: () => {
        this.#metrics.requestStarted(proxy.id);
      },
      onRequestOutcome: (_context, outcome) => {
        this.#metrics.requestCompleted({ proxyId: proxy.id, outcome: outcome.kind });
      },
      logger: this.#logger,
    });
  }
}

function activeCoordinator(value: ProductionCoordinator | null): ProductionCoordinator {
  if (!value) throw new Error("Runtime is not started");
  return value;
}

class RoutedTrafficSink implements TrafficEventSink {
  readonly #targetRoots: Map<string, QueuedTrafficEventSink | null>;
  readonly #pending = new Map<string, TrafficEvent[]>();
  readonly #selected = new Map<string, QueuedTrafficEventSink | null>();

  public constructor(proxy: RuntimeProxy, defaultRoot: string, roots: Map<string, RootStorage>) {
    this.#targetRoots = new Map(
      proxy.targets.map((target) => {
        const root = effectiveRoot(target.logRoot, defaultRoot);
        return [target.id, root ? (roots.get(root)?.sink ?? null) : null];
      }),
    );
  }

  public emit(event: TrafficEvent): void {
    let sink = this.#selected.get(event.requestId);
    if (event.kind === "routed") {
      sink = this.#targetRoots.get(event.target.id) ?? null;
      this.#selected.set(event.requestId, sink);
      for (const buffered of this.#pending.get(event.requestId) ?? []) sink?.emit(buffered);
      this.#pending.delete(event.requestId);
    }
    if (sink === undefined) this.#pending.set(event.requestId, [...(this.#pending.get(event.requestId) ?? []), event]);
    else sink?.emit(event);
    if (event.kind === "finished" || event.kind === "error") {
      this.#pending.delete(event.requestId);
      this.#selected.delete(event.requestId);
    }
  }
}

function configuredRoots(snapshot: RuntimeConfigSnapshot, defaultRoot: string): string[] {
  return [
    ...new Set(
      snapshot.proxies.flatMap((proxy) =>
        proxy.targets
          .map((target) => effectiveRoot(target.logRoot, defaultRoot))
          .filter((root): root is string => !!root),
      ),
    ),
  ].sort();
}

function effectiveRoot(configured: string | null, fallback: string): string | null {
  if (configured === "") return null;
  return resolve(configured ?? fallback);
}

function workerSource(logRoot: string, lease: StorageWorkerLease): AdminLogSource {
  return {
    logRoot,
    listTasks: (...args) => lease.client.listTasks(...args),
    listRecords: (...args) => lease.client.listRecords(...args),
    getRecord: (...args) => lease.client.getRecord(...args),
    cleanup: (...args) => lease.client.cleanup(...args),
  };
}

async function closeBundle(bundle: RuntimeBundle): Promise<void> {
  await bundle.manager.stopAll();
  await Promise.allSettled(
    [...bundle.roots.values()].map(async (root) => {
      await root.queue.close();
      await root.lease.client.drain();
      await root.lease.release();
    }),
  );
}

function sumQueueMetrics(total: StorageQueueMetrics, value: StorageQueueMetrics): StorageQueueMetrics {
  return {
    depth: total.depth + value.depth,
    estimatedBytes: total.estimatedBytes + value.estimatedBytes,
    committed: total.committed + value.committed,
    failed: total.failed + value.failed,
    dropped: total.dropped + value.dropped,
    coalesced: total.coalesced + value.coalesced,
    lastWaitMs: Math.max(total.lastWaitMs, value.lastWaitMs),
    maxWaitMs: Math.max(total.maxWaitMs, value.maxWaitMs),
    lastCommitMs: Math.max(total.lastCommitMs, value.lastCommitMs),
    maxCommitMs: Math.max(total.maxCommitMs, value.maxCommitMs),
  };
}
