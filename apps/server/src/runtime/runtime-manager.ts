import type { AddressInfo } from "node:net";

import type { RuntimeProxy } from "../config/schema.js";

export type ManagedRuntimeState = "configured" | "starting" | "running" | "stopping" | "failed";

export interface ManagedProxyServer {
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export type ManagedProxyServerFactory = (proxy: RuntimeProxy) => ManagedProxyServer;

export interface RuntimeStatus {
  id: string;
  name: string;
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  actualListenPort: number | null;
  state: ManagedRuntimeState;
  errorCode: string | null;
  errorAddress: string | null;
}

interface RuntimeEntry {
  proxy: RuntimeProxy;
  server: ManagedProxyServer | null;
  state: ManagedRuntimeState;
  actualListenPort: number | null;
  errorCode: string | null;
  errorAddress: string | null;
  operation: Promise<void>;
}

export class RuntimeManager {
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #createServer: ManagedProxyServerFactory;

  public constructor(proxies: readonly RuntimeProxy[], createServer: ManagedProxyServerFactory) {
    this.#createServer = createServer;
    validateProxies(proxies);
    for (const proxy of proxies) this.#entries.set(proxy.id, entry(proxy));
  }

  public list(): RuntimeStatus[] {
    return [...this.#entries.values()].map(status).sort((left, right) => left.id.localeCompare(right.id));
  }

  public start(proxyId: string): Promise<void> {
    return this.#enqueue(proxyId, async (runtime) => {
      if (runtime.state === "running") return;
      runtime.state = "starting";
      runtime.errorCode = null;
      runtime.errorAddress = null;
      const server = this.#createServer(runtime.proxy);
      runtime.server = server;
      try {
        const address = await server.start();
        runtime.actualListenPort = address.port;
        runtime.state = "running";
      } catch (error) {
        runtime.server = null;
        runtime.actualListenPort = null;
        runtime.state = "failed";
        runtime.errorCode = errorCode(error);
        runtime.errorAddress = safeAddress(runtime.proxy.listenHost, runtime.proxy.listenPort);
        try {
          await server.stop();
        } catch {
          // Preserve the original listen failure.
        }
        throw new RuntimeOperationError(runtime.errorCode, runtime.errorAddress, "Proxy failed to start", error);
      }
    });
  }

  public stop(proxyId: string): Promise<void> {
    return this.#enqueue(proxyId, async (runtime) => {
      const server = runtime.server;
      if (!server) {
        if (runtime.state !== "failed") runtime.state = "configured";
        runtime.actualListenPort = null;
        return;
      }
      runtime.state = "stopping";
      try {
        await server.stop();
        runtime.server = null;
        runtime.actualListenPort = null;
        runtime.state = "configured";
        runtime.errorCode = null;
        runtime.errorAddress = null;
      } catch (error) {
        runtime.state = "failed";
        runtime.errorCode = "STOP_FAILED";
        runtime.errorAddress = safeAddress(runtime.proxy.listenHost, runtime.proxy.listenPort);
        throw new RuntimeOperationError("STOP_FAILED", runtime.errorAddress, "Proxy failed to stop", error);
      }
    });
  }

  public restart(proxyId: string): Promise<void> {
    return this.#enqueue(proxyId, async (runtime) => {
      if (runtime.server) {
        runtime.state = "stopping";
        await runtime.server.stop();
        runtime.server = null;
        runtime.actualListenPort = null;
      }
      runtime.state = "starting";
      const server = this.#createServer(runtime.proxy);
      runtime.server = server;
      try {
        const address = await server.start();
        runtime.actualListenPort = address.port;
        runtime.state = "running";
        runtime.errorCode = null;
        runtime.errorAddress = null;
      } catch (error) {
        runtime.server = null;
        runtime.state = "failed";
        runtime.errorCode = errorCode(error);
        runtime.errorAddress = safeAddress(runtime.proxy.listenHost, runtime.proxy.listenPort);
        throw new RuntimeOperationError(runtime.errorCode, runtime.errorAddress, "Proxy failed to restart", error);
      }
    });
  }

  public async startEnabled(): Promise<Readonly<Record<string, "running" | "failed">>> {
    const results: Record<string, "running" | "failed"> = {};
    await Promise.all(
      [...this.#entries.values()].map(async (runtime) => {
        if (!runtime.proxy.enabled) return;
        try {
          await this.start(runtime.proxy.id);
          results[runtime.proxy.id] = "running";
        } catch {
          results[runtime.proxy.id] = "failed";
        }
      }),
    );
    return results;
  }

  public async stopAll(): Promise<void> {
    await Promise.allSettled([...this.#entries.keys()].map(async (id) => this.stop(id)));
  }

  public markFailed(proxyId: string, code: string): void {
    const runtime = this.#entries.get(proxyId);
    if (!runtime) return;
    runtime.state = "failed";
    runtime.errorCode = safeCode(code);
    runtime.errorAddress = safeAddress(runtime.proxy.listenHost, runtime.proxy.listenPort);
    runtime.actualListenPort = null;
  }

  #enqueue(proxyId: string, operation: (runtime: RuntimeEntry) => Promise<void>): Promise<void> {
    const runtime = this.#entries.get(proxyId);
    if (!runtime) return Promise.reject(new RuntimeOperationError("PROXY_NOT_FOUND", null, "Proxy does not exist"));
    const pending = runtime.operation.then(async () => operation(runtime));
    runtime.operation = pending.catch(() => undefined);
    return pending;
  }
}

export class RuntimeOperationError extends Error {
  public readonly code: string;
  public readonly listenAddress: string | null;

  public constructor(code: string, listenAddress: string | null, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RuntimeOperationError";
    this.code = code;
    this.listenAddress = listenAddress;
  }
}

function entry(proxy: RuntimeProxy): RuntimeEntry {
  return {
    proxy,
    server: null,
    state: "configured",
    actualListenPort: null,
    errorCode: null,
    errorAddress: null,
    operation: Promise.resolve(),
  };
}

function status(runtime: RuntimeEntry): RuntimeStatus {
  return {
    id: runtime.proxy.id,
    name: runtime.proxy.name,
    enabled: runtime.proxy.enabled,
    listenHost: runtime.proxy.listenHost,
    listenPort: runtime.proxy.listenPort,
    actualListenPort: runtime.actualListenPort,
    state: runtime.state,
    errorCode: runtime.errorCode,
    errorAddress: runtime.errorAddress,
  };
}

function validateProxies(proxies: readonly RuntimeProxy[]): void {
  const ids = new Set<string>();
  const listeners = new Set<string>();
  for (const proxy of proxies) {
    if (ids.has(proxy.id)) throw new RuntimeOperationError("DUPLICATE_PROXY_ID", null, "Duplicate proxy ID");
    ids.add(proxy.id);
    if (proxy.listenPort === 0) continue;
    const listener = `${proxy.listenHost.toLowerCase()}:${proxy.listenPort.toString()}`;
    if (listeners.has(listener))
      throw new RuntimeOperationError(
        "LISTEN_CONFLICT",
        safeAddress(proxy.listenHost, proxy.listenPort),
        "Listen conflict",
      );
    listeners.add(listener);
  }
}

function safeAddress(host: string, port: number): string {
  const safeHost = host.replaceAll(/[^A-Za-z0-9.:[\]_-]/gu, "_").slice(0, 253) || "unknown";
  return `${safeHost}:${port.toString()}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "LISTEN_FAILED";
}

function safeCode(code: string): string {
  return code.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 80) || "RUNTIME_FAILED";
}
