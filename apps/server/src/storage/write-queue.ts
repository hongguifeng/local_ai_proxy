import type { RecordDetail } from "@llm-proxy/contracts";

export type StorageQueueResult =
  | Readonly<{ accepted: true; status: "queued" | "coalesced" }>
  | Readonly<{
      accepted: false;
      status: "degraded";
      code: "STORAGE_QUEUE_FULL" | "STORAGE_EVENT_TOO_LARGE" | "STORAGE_CLOSED";
    }>;

export type StorageQueueMetrics = Readonly<{
  depth: number;
  estimatedBytes: number;
  committed: number;
  failed: number;
  dropped: number;
  coalesced: number;
  lastWaitMs: number;
  maxWaitMs: number;
  lastCommitMs: number;
  maxCommitMs: number;
}>;

export type StorageWriteQueueOptions = Readonly<{
  maxPendingCount: number;
  maxPendingBytes: number;
  maxEventBytes: number;
  warningIntervalMs?: number;
  onWarning?: (code: string, metrics: StorageQueueMetrics) => void;
  now?: () => number;
}>;

export interface StorageQueueWriter {
  writeTraffic(
    record: RecordDetail,
    transferredPayloads?: Readonly<{ request?: ArrayBuffer; response?: ArrayBuffer }>,
  ): Promise<unknown>;
}

export type StorageWriteEvent = Readonly<{
  record: RecordDetail;
  transferredPayloads?: Readonly<{ request?: ArrayBuffer; response?: ArrayBuffer }>;
  estimatedBytes?: number;
}>;

interface QueueEntry {
  event: StorageWriteEvent;
  estimatedBytes: number;
  enqueuedAt: number;
  priority: "pending" | "final";
}

export class StorageWriteQueue {
  readonly #writer: StorageQueueWriter;
  readonly #options: Required<
    Pick<StorageWriteQueueOptions, "maxPendingCount" | "maxPendingBytes" | "maxEventBytes" | "warningIntervalMs">
  >;
  readonly #onWarning: StorageWriteQueueOptions["onWarning"];
  readonly #now: () => number;
  readonly #pending: QueueEntry[] = [];
  readonly #final: QueueEntry[] = [];
  readonly #drainWaiters: (() => void)[] = [];
  #pendingBytes = 0;
  #processing = false;
  #scheduled = false;
  #closed = false;
  #lastWarningAt = Number.NEGATIVE_INFINITY;
  #committed = 0;
  #failed = 0;
  #dropped = 0;
  #coalesced = 0;
  #lastWaitMs = 0;
  #maxWaitMs = 0;
  #lastCommitMs = 0;
  #maxCommitMs = 0;

  public constructor(writer: StorageQueueWriter, options: StorageWriteQueueOptions) {
    assertPositiveInteger(options.maxPendingCount, "maxPendingCount");
    assertPositiveInteger(options.maxPendingBytes, "maxPendingBytes");
    assertPositiveInteger(options.maxEventBytes, "maxEventBytes");
    const warningIntervalMs = options.warningIntervalMs ?? 30_000;
    if (!Number.isFinite(warningIntervalMs) || warningIntervalMs < 0)
      throw new RangeError("warningIntervalMs is invalid");
    this.#writer = writer;
    this.#options = { ...options, warningIntervalMs };
    this.#onWarning = options.onWarning;
    this.#now = options.now ?? Date.now;
  }

  public enqueue(event: StorageWriteEvent): StorageQueueResult {
    if (this.#closed) return this.#degraded("STORAGE_CLOSED");
    const estimatedBytes = event.estimatedBytes ?? estimateEventBytes(event);
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0 || estimatedBytes > this.#options.maxEventBytes) {
      return this.#degraded("STORAGE_EVENT_TOO_LARGE");
    }
    const priority = event.record.event === "request_received" ? "pending" : "final";
    if (priority === "pending") {
      const index = this.#pending.findIndex((entry) => entry.event.record.id === event.record.id);
      if (index !== -1) {
        const existing = this.#pending[index];
        if (!existing) return this.#degraded("STORAGE_QUEUE_FULL");
        const nextBytes = this.#pendingBytes - existing.estimatedBytes + estimatedBytes;
        if (nextBytes > this.#options.maxPendingBytes) return this.#degraded("STORAGE_QUEUE_FULL");
        this.#pending[index] = { event, estimatedBytes, enqueuedAt: existing.enqueuedAt, priority };
        this.#pendingBytes = nextBytes;
        this.#coalesced += 1;
        return { accepted: true, status: "coalesced" };
      }
    }

    if (priority === "final") this.#evictPendingUntilFits(estimatedBytes);
    if (!this.#fits(estimatedBytes)) return this.#degraded("STORAGE_QUEUE_FULL");
    const entry: QueueEntry = { event, estimatedBytes, enqueuedAt: this.#now(), priority };
    (priority === "final" ? this.#final : this.#pending).push(entry);
    this.#pendingBytes += estimatedBytes;
    this.#schedule();
    return { accepted: true, status: "queued" };
  }

  public metrics(): StorageQueueMetrics {
    return {
      depth: this.#depth(),
      estimatedBytes: this.#pendingBytes,
      committed: this.#committed,
      failed: this.#failed,
      dropped: this.#dropped,
      coalesced: this.#coalesced,
      lastWaitMs: this.#lastWaitMs,
      maxWaitMs: this.#maxWaitMs,
      lastCommitMs: this.#lastCommitMs,
      maxCommitMs: this.#maxCommitMs,
    };
  }

  public async drain(): Promise<void> {
    if (!this.#processing && this.#depth() === 0) return;
    await new Promise<void>((resolvePromise) => {
      this.#drainWaiters.push(resolvePromise);
    });
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }

  #schedule(): void {
    if (this.#scheduled || this.#processing) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#process();
    });
  }

  async #process(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      let entry: QueueEntry | undefined;
      while ((entry = this.#final.shift() ?? this.#pending.shift())) {
        this.#pendingBytes -= entry.estimatedBytes;
        const startedAt = this.#now();
        this.#lastWaitMs = Math.max(0, startedAt - entry.enqueuedAt);
        this.#maxWaitMs = Math.max(this.#maxWaitMs, this.#lastWaitMs);
        try {
          await this.#writer.writeTraffic(entry.event.record, entry.event.transferredPayloads);
          this.#committed += 1;
        } catch {
          this.#failed += 1;
          this.#warn("STORAGE_WRITE_FAILED");
        }
        this.#lastCommitMs = Math.max(0, this.#now() - startedAt);
        this.#maxCommitMs = Math.max(this.#maxCommitMs, this.#lastCommitMs);
      }
    } finally {
      this.#processing = false;
      if (this.#depth() > 0) this.#schedule();
      else this.#resolveDrain();
    }
  }

  #evictPendingUntilFits(incomingBytes: number): void {
    while (!this.#fits(incomingBytes) && this.#pending.length > 0) {
      const evicted = this.#pending.shift();
      if (!evicted) break;
      this.#pendingBytes -= evicted.estimatedBytes;
      this.#dropped += 1;
      this.#warn("STORAGE_PENDING_EVICTED");
    }
  }

  #fits(incomingBytes: number): boolean {
    return (
      this.#depth() < this.#options.maxPendingCount &&
      this.#pendingBytes + incomingBytes <= this.#options.maxPendingBytes
    );
  }

  #degraded(code: "STORAGE_QUEUE_FULL" | "STORAGE_EVENT_TOO_LARGE" | "STORAGE_CLOSED"): StorageQueueResult {
    this.#dropped += 1;
    this.#warn(code);
    return { accepted: false, status: "degraded", code };
  }

  #warn(code: string): void {
    const now = this.#now();
    if (now - this.#lastWarningAt < this.#options.warningIntervalMs) return;
    this.#lastWarningAt = now;
    this.#onWarning?.(code, this.metrics());
  }

  #depth(): number {
    return this.#pending.length + this.#final.length;
  }

  #resolveDrain(): void {
    for (const resolvePromise of this.#drainWaiters.splice(0)) resolvePromise();
  }
}

function estimateEventBytes(event: StorageWriteEvent): number {
  const structured = Buffer.byteLength(JSON.stringify(event.record), "utf8");
  return (
    structured +
    (event.transferredPayloads?.request?.byteLength ?? 0) +
    (event.transferredPayloads?.response?.byteLength ?? 0)
  );
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}
