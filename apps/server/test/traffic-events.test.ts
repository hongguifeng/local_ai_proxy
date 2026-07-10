import { describe, expect, it } from "vitest";

import { openStorageDatabase } from "../src/storage/migration.js";
import { StorageRepository } from "../src/storage/repository.js";
import { TrafficEventReducer } from "../src/storage/traffic-events.js";
import { TrafficRecordWriter } from "../src/storage/traffic-record-writer.js";

const timestamp = "2026-07-11T00:00:00.000Z";

describe("traffic event folding and transaction", () => {
  it("folds accepted/body/routed/headers/finished into one idempotent record", () => {
    usingStore((repository, writer) => {
      const reducer = new TrafficEventReducer();
      const accepted = reducer.apply(acceptedEvent());
      const pending = writer.write(required(accepted));
      const body = reducer.apply({
        kind: "body_read",
        requestId: "request-1",
        timestamp,
        headers: { "content-type": ["application/json"] },
        captured: Buffer.from('{"model":"gpt-5","input":"hello"}'),
        observedBytes: 100,
      });
      writer.write(required(body));
      writer.write(
        required(
          reducer.apply({
            kind: "routed",
            requestId: "request-1",
            timestamp,
            target: { id: "target-1", name: "Primary", url: "https://example.com/v1/responses" },
          }),
        ),
      );
      writer.write(
        required(
          reducer.apply({
            kind: "headers",
            requestId: "request-1",
            timestamp,
            status: 200,
            headers: { "content-type": ["application/json"] },
          }),
        ),
      );
      const finalRecord = reducer.apply({
        kind: "finished",
        requestId: "request-1",
        timestamp,
        status: 200,
        captured: Buffer.from('{"id":"resp-1","usage":{"total_tokens":5}}'),
        observedBytes: 100,
        durationMs: 20,
        messageCount: 1,
        tokenCount: 5,
      });
      const final = writer.write(required(finalRecord));
      const retry = writer.write(required(finalRecord));
      expect(final.task.id).toBe(pending.task.id);
      expect(final.sequence).toBe(pending.sequence);
      expect(retry.task.id).toBe(final.task.id);
      expect(repository.listTasks("", 50, 0).tasks[0]).toMatchObject({ requestCount: 1, pending: false });
      expect(repository.listRecords(final.task.id, 50, 0)).toMatchObject({
        total: 1,
        records: [{ event: "request_finished" }],
      });
      expect(repository.taskIdForResponse("resp-1")).toBe(final.task.id);
    });
  });

  it("removes secrets before enqueue-compatible records are produced", () => {
    const secret = "never-persist-me";
    const reducer = new TrafficEventReducer();
    reducer.apply(acceptedEvent({ Authorization: [`Bearer ${secret}`] }));
    const record = reducer.apply({
      kind: "body_read",
      requestId: "request-1",
      timestamp,
      headers: { "X-API-Key": [secret] },
      captured: Buffer.from(JSON.stringify({ model: "gpt-5", password: secret })),
      observedBytes: 100,
    });
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it("stores safe error code/stage/message and ignores later nonterminal events", () => {
    const reducer = new TrafficEventReducer();
    reducer.apply(acceptedEvent());
    const failed = reducer.apply({
      kind: "error",
      requestId: "request-1",
      timestamp,
      code: "UPSTREAM FAILED!",
      stage: "response headers",
      safeMessage: "safe\r\nmessage",
      durationMs: 3,
      status: 502,
    });
    expect(failed).toMatchObject({
      event: "failed",
      errorCode: "UPSTREAM_FAILED_",
      errorStage: "response_headers",
      errorMessage: "safe  message",
    });
    expect(reducer.apply({ kind: "routed", requestId: "request-1", timestamp, target: required(failed).target })).toBe(
      failed,
    );
  });

  it("preserves aborted and timed_out terminal outcomes", () => {
    for (const outcome of ["aborted", "timed_out"] as const) {
      const reducer = new TrafficEventReducer();
      reducer.apply(acceptedEvent());
      expect(
        reducer.apply({
          kind: "error",
          requestId: "request-1",
          timestamp,
          code: outcome === "aborted" ? "CLIENT_ABORTED" : "UPSTREAM_IDLE_TIMEOUT",
          stage: "response_body",
          safeMessage: "request ended",
          outcome,
          durationMs: 5,
        }),
      ).toMatchObject({ event: outcome });
    }
  });

  it("rolls back task, record, FTS, and links when any assignment write fails", () => {
    const database = openStorageDatabase(":memory:");
    try {
      const repository = new StorageRepository(database);
      const writer = new TrafficRecordWriter(repository);
      const reducer = new TrafficEventReducer();
      const pending = required(reducer.apply(acceptedEvent()));
      const assignment = writer.write(pending);
      database.exec("DROP TABLE response_links");
      const body = required(
        reducer.apply({
          kind: "body_read",
          requestId: "request-1",
          timestamp,
          headers: {},
          captured: Buffer.from('{"model":"gpt-5","input":"hello"}'),
          observedBytes: 100,
        }),
      );
      const final = {
        ...body,
        event: "request_finished" as const,
        response: {
          headers: {},
          body: {
            kind: "json" as const,
            value: { id: "resp" },
            observedBytes: 13,
            capturedBytes: 13,
            truncated: false,
          },
        },
      };
      expect(() => writer.write(final)).toThrow();
      expect(repository.getRecord("request-1")).toMatchObject({
        event: "request_received",
        taskId: assignment.task.id,
      });
      expect(repository.listTasks("", 50, 0).tasks[0]).toMatchObject({ pending: true, requestCount: 1 });
    } finally {
      database.close();
    }
  });
});

function acceptedEvent(headers: Readonly<Record<string, readonly string[]>> = {}) {
  return {
    kind: "accepted" as const,
    requestId: "request-1",
    timestamp,
    method: "POST",
    path: "/v1/responses",
    client: { host: "127.0.0.1", port: 1234 },
    proxy: { id: "proxy-1", name: "Proxy" },
    requestHeaders: headers,
  };
}

function usingStore(run: (repository: StorageRepository, writer: TrafficRecordWriter) => void): void {
  const database = openStorageDatabase(":memory:");
  try {
    const repository = new StorageRepository(database);
    run(repository, new TrafficRecordWriter(repository));
  } finally {
    database.close();
  }
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("Expected traffic record state");
  return value;
}
