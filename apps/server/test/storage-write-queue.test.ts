import { describe, expect, it, vi } from "vitest";

import { StorageWriteQueue, type StorageQueueWriter } from "../src/storage/write-queue.js";

describe("bounded storage write queue", () => {
  it("supersedes an uncommitted pending event with its terminal record", async () => {
    const writes: string[] = [];
    const writer: StorageQueueWriter = {
      writeTraffic(value) {
        writes.push(value.event);
        return Promise.resolve();
      },
    };
    const queue = new StorageWriteQueue(writer, limits());
    queue.enqueue({ record: record("same", "request_received") });
    queue.enqueue({ record: record("same", "request_finished") });
    await queue.drain();
    expect(writes).toEqual(["request_finished"]);
    expect(queue.metrics().coalesced).toBe(1);
  });

  it("coalesces pending records and prioritizes final records", async () => {
    const writes: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let call = 0;
    const writer: StorageQueueWriter = {
      async writeTraffic(record) {
        writes.push(`${record.id}:${record.event}`);
        call += 1;
        if (call === 1) await firstBlocked;
      },
    };
    const queue = new StorageWriteQueue(writer, limits());
    queue.enqueue({ record: record("active", "request_received"), estimatedBytes: 10 });
    await Promise.resolve();
    queue.enqueue({ record: record("same", "request_received"), estimatedBytes: 10 });
    expect(queue.enqueue({ record: record("same", "request_received", 2), estimatedBytes: 12 })).toEqual({
      accepted: true,
      status: "coalesced",
    });
    queue.enqueue({ record: record("other", "request_received"), estimatedBytes: 10 });
    queue.enqueue({ record: record("final", "request_finished"), estimatedBytes: 10 });
    releaseFirst?.();
    await queue.drain();
    expect(writes).toEqual([
      "active:request_received",
      "final:request_finished",
      "same:request_received",
      "other:request_received",
    ]);
    expect(queue.metrics()).toMatchObject({ committed: 4, coalesced: 1, depth: 0, estimatedBytes: 0 });
  });

  it("evicts pending work for final events and returns typed degradation", () => {
    const writer = blockedWriter();
    const warnings: string[] = [];
    const queue = new StorageWriteQueue(writer, {
      ...limits(),
      maxPendingCount: 2,
      maxPendingBytes: 20,
      maxEventBytes: 100,
      onWarning: (code) => warnings.push(code),
    });
    expect(queue.enqueue({ record: record("one", "request_received"), estimatedBytes: 10 }).accepted).toBe(true);
    expect(queue.enqueue({ record: record("two", "request_received"), estimatedBytes: 10 }).accepted).toBe(true);
    expect(queue.enqueue({ record: record("final", "failed"), estimatedBytes: 10 }).accepted).toBe(true);
    expect(queue.metrics()).toMatchObject({ depth: 2, estimatedBytes: 20, dropped: 1 });
    expect(queue.enqueue({ record: record("too-large", "failed"), estimatedBytes: 101 })).toEqual({
      accepted: false,
      status: "degraded",
      code: "STORAGE_EVENT_TOO_LARGE",
    });
    expect(warnings).toHaveLength(1);
  });

  it("rate-limits warnings and records failures and timing metrics", async () => {
    let now = 100;
    const warnings: string[] = [];
    const writer: StorageQueueWriter = {
      writeTraffic() {
        now += 7;
        return Promise.reject(new Error("database unavailable"));
      },
    };
    const queue = new StorageWriteQueue(writer, {
      ...limits(),
      warningIntervalMs: 50,
      now: () => now,
      onWarning: (code) => warnings.push(code),
    });
    queue.enqueue({ record: record("one", "failed"), estimatedBytes: 10 });
    now += 5;
    queue.enqueue({ record: record("two", "failed"), estimatedBytes: 10 });
    await queue.drain();
    expect(queue.metrics()).toMatchObject({ failed: 2, lastCommitMs: 7, maxCommitMs: 7 });
    expect(warnings).toEqual(["STORAGE_WRITE_FAILED"]);
  });

  it("stays bounded when producers are much faster than the writer", () => {
    const writer = blockedWriter();
    const queue = new StorageWriteQueue(writer, { ...limits(), maxPendingCount: 100, maxPendingBytes: 1_000 });
    let accepted = 0;
    for (let index = 0; index < 100_000; index += 1) {
      const result = queue.enqueue({
        record: record(`record-${index.toString()}`, "request_received"),
        estimatedBytes: 10,
      });
      if (result.accepted) accepted += 1;
    }
    expect(accepted).toBe(100);
    expect(queue.metrics()).toMatchObject({ depth: 100, estimatedBytes: 1_000, dropped: 99_900 });
  });

  it("drains on close, rejects new work, and validates limits", async () => {
    const writer: StorageQueueWriter = { writeTraffic: vi.fn(() => Promise.resolve(undefined)) };
    const queue = new StorageWriteQueue(writer, limits());
    queue.enqueue({ record: record("one", "request_finished") });
    await queue.close();
    expect(queue.metrics().committed).toBe(1);
    expect(queue.enqueue({ record: record("two", "failed") })).toMatchObject({
      accepted: false,
      code: "STORAGE_CLOSED",
    });
    expect(() => new StorageWriteQueue(writer, { ...limits(), maxPendingCount: 0 })).toThrow(RangeError);
  });
});

function limits() {
  return { maxPendingCount: 10, maxPendingBytes: 1_000, maxEventBytes: 10_000, warningIntervalMs: 1_000 };
}

function blockedWriter(): StorageQueueWriter {
  return { writeTraffic: () => new Promise<unknown>(() => undefined) };
}

function record(id: string, event: "request_received" | "request_finished" | "failed", durationMs = 1) {
  const empty = { kind: "empty" as const, observedBytes: 0, capturedBytes: 0, truncated: false };
  return {
    id,
    taskId: "task-1",
    sequence: 1,
    event,
    timestamp: "2026-07-11T00:00:00.000Z",
    durationMs,
    method: "POST",
    path: "/v1/responses",
    status: event === "request_received" ? null : 200,
    errorCode: event === "failed" ? "UPSTREAM_FAILED" : null,
    messageCount: 1,
    tokenCount: null,
    client: { host: "127.0.0.1", port: 1 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Target", url: "https://example.com/v1/responses" },
    request: { headers: {}, body: empty },
    response: null,
  };
}
