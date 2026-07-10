import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

import unzipper from "unzipper";
import { describe, expect, it } from "vitest";

import { ExportCapacityError, StreamingZipExporter, type ExportSource } from "../src/storage/zip-export.js";

describe("StreamingZipExporter", () => {
  it("creates a readable ZIP with stable safe names and JSON content", async () => {
    const exporter = new StreamingZipExporter();
    const data = await collect(exporter.export(source(2, "task..one")));
    const zip = await unzipper.Open.buffer(data);
    const names = zip.files.map((file) => file.path);
    expect(names).toEqual([
      "manifest.json",
      "tasks/task_one/task.json",
      "tasks/task_one/records/00000001-record-1.json",
      "tasks/task_one/records/00000002-record-2.json",
    ]);
    expect(JSON.parse((await required(zip.files[2]).buffer()).toString("utf8"))).toMatchObject({ id: "record-1" });
    expect(names.every((name) => !name.includes("..") && !name.startsWith("/"))).toBe(true);
  });

  it("pages a large data set and keeps record detail work sequential", async () => {
    const count = 5_000;
    const fixture = source(count);
    const before = process.memoryUsage().heapUsed;
    let bytes = 0;
    await pipeline(
      new StreamingZipExporter().export(fixture),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback();
        },
      }),
    );
    const growth = process.memoryUsage().heapUsed - before;
    expect(bytes).toBeGreaterThan(100_000);
    expect(fixture.metrics.maxPageSize).toBeLessThanOrEqual(50);
    expect(fixture.metrics.maxConcurrentDetails).toBe(1);
    expect(growth).toBeLessThan(64 * 1024 * 1024);
  });

  it("aborts active work and releases the concurrency slot", async () => {
    const controller = new AbortController();
    const exporter = new StreamingZipExporter(1);
    const blocked: ExportSource = {
      listTasks: () => {
        controller.abort();
        return Promise.resolve({ total: 0, limit: 50, offset: 0, hasMore: false, tasks: [] });
      },
      listRecords: () => Promise.reject(new Error("not reached")),
      getRecord: () => Promise.reject(new Error("not reached")),
    };
    const stream = exporter.export(blocked, { signal: controller.signal });
    expect(() => exporter.export(source(0))).toThrow(ExportCapacityError);
    await expect(collect(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(exporter.active).toBe(0);
    await expect(collect(exporter.export(source(0)))).resolves.toBeInstanceOf(Buffer);
  });
});

function source(recordCount: number, taskId = "task-1") {
  const metrics = { maxPageSize: 0, concurrentDetails: 0, maxConcurrentDetails: 0 };
  const task = {
    id: taskId,
    kind: "responses" as const,
    endpoint: "/v1/responses",
    model: "gpt-5",
    target: "primary",
    startedAt: "2026-07-11T00:00:00.000Z",
    lastSeenAt: "2026-07-11T00:00:00.000Z",
    requestCount: recordCount,
    pending: false,
  };
  return {
    metrics,
    listTasks: (_query: string, limit: number, offset: number) =>
      Promise.resolve({ total: 1, limit, offset, hasMore: false, tasks: offset === 0 ? [task] : [] }),
    listRecords: (_taskId: string, limit: number, offset: number) => {
      metrics.maxPageSize = Math.max(metrics.maxPageSize, limit);
      const length = Math.max(0, Math.min(limit, recordCount - offset));
      const records = Array.from({ length }, (_, index) => recordSummary(offset + index + 1, taskId));
      return Promise.resolve({ total: recordCount, limit, offset, hasMore: offset + length < recordCount, records });
    },
    getRecord: async (recordId: string) => {
      metrics.concurrentDetails += 1;
      metrics.maxConcurrentDetails = Math.max(metrics.maxConcurrentDetails, metrics.concurrentDetails);
      await Promise.resolve();
      metrics.concurrentDetails -= 1;
      const sequence = Number(recordId.slice("record-".length));
      return recordDetail(sequence, taskId);
    },
  } satisfies ExportSource & { metrics: typeof metrics };
}

function recordSummary(sequence: number, taskId: string) {
  return {
    id: `record-${sequence.toString()}`,
    taskId,
    sequence,
    event: "request_finished" as const,
    timestamp: "2026-07-11T00:00:00.000Z",
    durationMs: 1,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    errorCode: null,
    messageCount: 1,
    tokenCount: 1,
  };
}

function recordDetail(sequence: number, taskId: string) {
  const empty = { kind: "empty" as const, observedBytes: 0, capturedBytes: 0, truncated: false };
  return {
    ...recordSummary(sequence, taskId),
    client: { host: "127.0.0.1", port: 1 },
    proxy: { id: "proxy-1", name: "Proxy" },
    target: { id: "target-1", name: "Target", url: "https://example.com/v1/responses" },
    request: { headers: {}, body: empty },
    response: { headers: {}, body: empty },
  };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected ZIP entry");
  return value;
}
