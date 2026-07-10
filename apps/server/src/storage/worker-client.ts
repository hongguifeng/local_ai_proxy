import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  StorageWorkerRequestSchema,
  StorageWorkerResponseSchema,
  type RecordDetail,
  type StorageWorkerRequest,
  type StorageWorkerResponse,
} from "@llm-proxy/contracts";

export class StorageRpcError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageRpcError";
    this.code = code;
  }
}

export type StorageWorkerClientOptions = Readonly<{
  requestTimeoutMs?: number;
  maxRestarts?: number;
}>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RequestInput = StorageWorkerRequest extends infer Request
  ? Request extends StorageWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export class StorageWorkerClient {
  readonly #databasePath: string;
  readonly #requestTimeoutMs: number;
  readonly #maxRestarts: number;
  readonly #pending = new Map<string, PendingRequest>();
  #worker: Worker | null = null;
  #online: Promise<void> | null = null;
  #ready: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;
  #starts = 0;
  #closed = false;

  public constructor(databasePath: string, options: StorageWorkerClientOptions = {}) {
    this.#databasePath = databasePath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxRestarts = options.maxRestarts ?? 1;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1)
      throw new RangeError("requestTimeoutMs must be positive");
    if (!Number.isSafeInteger(this.#maxRestarts) || this.#maxRestarts < 0)
      throw new RangeError("maxRestarts must be non-negative");
  }

  public async start(): Promise<void> {
    this.#ensureWorker();
    await this.#ready;
  }

  public async migrate(): Promise<unknown> {
    return this.request({ kind: "migrate" });
  }

  public async listTasks(query = "", limit = 50, offset = 0): Promise<unknown> {
    return this.request({ kind: "listTasks", query, pagination: { limit, offset } });
  }

  public async listRecords(taskId: string, limit = 50, offset = 0, query = ""): Promise<unknown> {
    return this.request({ kind: "listRecords", taskId, query, pagination: { limit, offset } });
  }

  public async getRecord(recordId: string): Promise<unknown> {
    return this.request({ kind: "getRecord", recordId });
  }

  public async writeTraffic(
    record: RecordDetail,
    transferredPayloads?: Readonly<{ request?: ArrayBuffer; response?: ArrayBuffer }>,
  ): Promise<unknown> {
    const transferList = [transferredPayloads?.request, transferredPayloads?.response].filter(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    );
    return this.request(
      { kind: "writeTraffic", record, ...(transferredPayloads ? { transferredPayloads } : {}) },
      transferList,
    );
  }

  public async drain(): Promise<void> {
    await this.request({ kind: "drain" });
  }

  public async cleanup(options: {
    taskIds?: string[];
    olderThanDays?: number;
    keepLatest?: number;
    batchSize?: number;
  }): Promise<unknown> {
    return this.request({ kind: "cleanup", batchSize: 250, ...options });
  }

  public async maintenance(operation: "checkpoint" | "optimize" | "integrityCheck"): Promise<unknown> {
    return this.request({ kind: "maintenance", operation });
  }

  public async forceRestart(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    const exited = new Promise<void>((resolvePromise) => {
      worker.once("exit", () => {
        resolvePromise();
      });
    });
    worker.postMessage({ kind: "__force_exit__" });
    await exited;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    const worker = this.#worker;
    if (worker) {
      try {
        await this.request({ kind: "close" });
      } catch {
        // Closing remains idempotent when a crashed worker cannot acknowledge the command.
      } finally {
        await this.#online;
        await worker.terminate();
      }
    }
    this.#closed = true;
    this.#rejectPending(new StorageRpcError("STORAGE_CLOSED", "Storage worker is closed"));
  }

  public async request(input: RequestInput, transferList: readonly ArrayBuffer[] = []): Promise<unknown> {
    if (this.#closed) throw new StorageRpcError("STORAGE_CLOSED", "Storage worker is closed");
    this.#ensureWorker();
    await this.#ready;
    const requestId = `rpc-${randomUUID()}`;
    const request = StorageWorkerRequestSchema.parse({ ...input, requestId });
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        rejectPromise(new StorageRpcError("STORAGE_TIMEOUT", "Storage operation timed out"));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        const worker = this.#worker;
        if (!worker) throw new Error("Storage worker exited before request could be sent");
        worker.postMessage(request, transferList);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        rejectPromise(new StorageRpcError("STORAGE_SEND_FAILED", "Unable to send storage operation", { cause: error }));
      }
    });
  }

  #ensureWorker(): void {
    if (this.#worker) return;
    if (this.#starts > this.#maxRestarts)
      throw new StorageRpcError("STORAGE_RESTART_EXHAUSTED", "Storage worker restart limit reached");
    this.#starts += 1;
    const sourceMode = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(
      sourceMode ? "../../dist/storage/storage-worker.js" : "./storage-worker.js",
      import.meta.url,
    );
    this.#ready = new Promise<void>((resolvePromise, rejectPromise) => {
      this.#resolveReady = resolvePromise;
      this.#rejectReady = rejectPromise;
    });
    this.#readyTimer = setTimeout(() => {
      this.#onFailure(new StorageRpcError("STORAGE_TIMEOUT", "Storage worker start timed out"));
    }, this.#requestTimeoutMs);
    const worker = new Worker(workerUrl, { workerData: { databasePath: this.#databasePath } });
    this.#online = new Promise<void>((resolvePromise) => {
      worker.once("online", resolvePromise);
      worker.once("error", resolvePromise);
    });
    this.#worker = worker;
    worker.on("message", (message: unknown) => {
      this.#onMessage(message);
    });
    worker.on("error", (error: unknown) => {
      this.#onFailure(toError(error));
    });
    worker.on("exit", (code) => {
      if (this.#worker === worker) this.#worker = null;
      if (code !== 0 && !this.#closed) this.#onFailure(new Error(`Storage worker exited with code ${code.toString()}`));
    });
  }

  #onMessage(message: unknown): void {
    if (isLifecycleMessage(message)) {
      if (message.kind === "ready") {
        this.#clearReadyTimer();
        this.#resolveReady?.();
      } else this.#onFailure(new StorageRpcError(message.error.code, message.error.message));
      return;
    }
    const parsed = StorageWorkerResponseSchema.safeParse(message);
    if (!parsed.success) {
      this.#onFailure(new StorageRpcError("INVALID_WORKER_RESPONSE", "Storage worker response is invalid"));
      return;
    }
    this.#settle(parsed.data);
  }

  #settle(response: StorageWorkerResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new StorageRpcError(response.error.code, response.error.message));
  }

  #onFailure(error: Error): void {
    this.#clearReadyTimer();
    this.#rejectReady?.(new StorageRpcError("STORAGE_UNAVAILABLE", "Storage worker is unavailable", { cause: error }));
    this.#rejectPending(new StorageRpcError("STORAGE_UNAVAILABLE", "Storage worker is unavailable", { cause: error }));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }
}

type LifecycleMessage =
  Readonly<{ kind: "ready" }> | Readonly<{ kind: "fatal"; error: Readonly<{ code: string; message: string }> }>;

function isLifecycleMessage(value: unknown): value is LifecycleMessage {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "ready") return Object.keys(value).length === 1;
  if (value.kind !== "fatal" || !("error" in value) || !value.error || typeof value.error !== "object") return false;
  return (
    "code" in value.error &&
    typeof value.error.code === "string" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  );
}

export interface StorageWorkerLease {
  client: StorageWorkerClient;
  release(): Promise<void>;
}

export class StorageWorkerRegistry {
  readonly #entries = new Map<string, { client: StorageWorkerClient; references: number }>();
  readonly #options: StorageWorkerClientOptions;

  public constructor(options: StorageWorkerClientOptions = {}) {
    this.#options = options;
  }

  public async acquire(logRoot: string): Promise<StorageWorkerLease> {
    const key = normalizeLogRoot(logRoot);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { client: new StorageWorkerClient(join(key, "traffic.db"), this.#options), references: 0 };
      this.#entries.set(key, entry);
      try {
        await entry.client.start();
      } catch (error) {
        this.#entries.delete(key);
        throw error;
      }
    }
    entry.references += 1;
    let released = false;
    return {
      client: entry.client,
      release: async () => {
        if (released) return;
        released = true;
        const current = this.#entries.get(key);
        if (!current) return;
        current.references -= 1;
        if (current.references === 0) {
          this.#entries.delete(key);
          await current.client.close();
        }
      },
    };
  }

  public get size(): number {
    return this.#entries.size;
  }
}

function normalizeLogRoot(logRoot: string): string {
  const normalized = resolve(logRoot);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown storage worker error");
}
