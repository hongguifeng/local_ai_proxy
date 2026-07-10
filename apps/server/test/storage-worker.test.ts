import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StorageWorkerClient, StorageWorkerRegistry } from "../src/storage/worker-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("storage Worker RPC", () => {
  it("starts, becomes ready, migrates, drains, queries, and closes", async () => {
    const client = new StorageWorkerClient(join(await root(), "traffic.db"));
    await client.start();
    const migration = (await client.migrate()) as { schemaVersion: number; threadId: number };
    expect(migration.schemaVersion).toBe(1);
    expect(migration.threadId).toBeGreaterThan(0);
    await expect(client.listTasks()).resolves.toMatchObject({ total: 0, tasks: [] });
    await expect(client.drain()).resolves.toBeUndefined();
    await client.close();
    await expect(client.listTasks()).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
  });

  it("reuses one Worker for normalized log roots with reference counting", async () => {
    const directory = await root();
    const registry = new StorageWorkerRegistry();
    const first = await registry.acquire(directory);
    const second = await registry.acquire(join(directory, "."));
    expect(first.client).toBe(second.client);
    expect(registry.size).toBe(1);
    await first.release();
    expect(registry.size).toBe(1);
    await second.release();
    expect(registry.size).toBe(0);
  });

  it("times out worker startup without leaving a live handle", async () => {
    const timeout = new StorageWorkerClient(join(await root(), "timeout.db"), { requestTimeoutMs: 1 });
    await expect(timeout.start()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await timeout.close();
  });

  it("rejects pending promises on forced exit and restarts within budget", async () => {
    const client = new StorageWorkerClient(join(await root(), "crash.db"), { requestTimeoutMs: 5_000 });
    await client.start();
    const restarting = client.forceRestart();
    const pending = client.listTasks();
    const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await restarting;
    await rejected;
    const restarted = (await client.migrate()) as { schemaVersion: number; threadId: number };
    expect(restarted.schemaVersion).toBe(1);
    expect(restarted.threadId).toBeGreaterThan(0);
    await client.close();
  });

  it("transfers binary ownership without cloning and validates worker operations", async () => {
    const client = new StorageWorkerClient(join(await root(), "transfer.db"));
    await client.start();
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const request = client.writeTraffic(recordWithBinary(buffer.byteLength), { request: buffer });
    const rejected = expect(request).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await Promise.resolve();
    expect(buffer.byteLength).toBe(0);
    await rejected;
    await client.close();
  });

  it("enforces a finite restart budget and validates options", async () => {
    const client = new StorageWorkerClient(join(await root(), "restart.db"), { maxRestarts: 0 });
    await client.start();
    await client.forceRestart();
    await expect(client.migrate()).rejects.toMatchObject({ code: "STORAGE_RESTART_EXHAUSTED" });
    await client.close();
    expect(() => new StorageWorkerClient("x", { requestTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new StorageWorkerClient("x", { maxRestarts: -1 })).toThrow(RangeError);
  });
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "llm-proxy-worker-"));
  roots.push(directory);
  return directory;
}

function recordWithBinary(capturedBytes: number) {
  const body = { kind: "binary" as const, base64: "", observedBytes: capturedBytes, capturedBytes, truncated: false };
  return {
    id: "record-1",
    taskId: "missing-task",
    sequence: 1,
    event: "request_finished" as const,
    timestamp: "2026-07-11T00:00:00.000Z",
    durationMs: 1,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    errorCode: null,
    messageCount: 1,
    tokenCount: 1,
    client: { host: "127.0.0.1", port: 1 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Target", url: "https://example.com/v1/responses" },
    request: { headers: {}, body },
    response: null,
  };
}
