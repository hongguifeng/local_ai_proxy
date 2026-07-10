import { describe, expect, it } from "vitest";

import { MultiRootTaskQuery, type TaskQuerySource } from "../src/storage/multi-root-query.js";

describe("MultiRootTaskQuery", () => {
  it("merges stable pages without duplicates or omissions", async () => {
    const query = new MultiRootTaskQuery([
      source("root-b", [task("b-1", "2026-07-11T00:00:00.000Z"), task("b-2", "2026-07-09T00:00:00.000Z")]),
      source("root-a", [task("a-1", "2026-07-10T00:00:00.000Z"), task("a-2", "2026-07-08T00:00:00.000Z")]),
    ]);

    const first = await query.list("", 2, 0);
    const second = await query.list("", 2, 2);
    expect([...first.tasks, ...second.tasks].map((entry) => entry.task.id)).toEqual(["b-1", "a-1", "b-2", "a-2"]);
    expect(first).toMatchObject({ total: 4, hasMore: true, failures: [] });
    expect(second).toMatchObject({ total: 4, hasMore: false, failures: [] });
  });

  it("uses task id and root as deterministic tie breakers", async () => {
    const timestamp = "2026-07-11T00:00:00.000Z";
    const query = new MultiRootTaskQuery([
      source("root-b", [task("same", timestamp)]),
      source("root-a", [task("same", timestamp), task("alpha", timestamp)]),
    ]);
    expect((await query.list("", 10, 0)).tasks.map((entry) => `${entry.task.id}:${entry.logRoot}`)).toEqual([
      "alpha:root-a",
      "same:root-a",
      "same:root-b",
    ]);
  });

  it("returns successful data with explicit per-root failures", async () => {
    const unavailable: TaskQuerySource = {
      logRoot: "broken",
      listTasks: () => Promise.reject(new Error("secret filesystem detail")),
    };
    const invalid: TaskQuerySource = { logRoot: "invalid", listTasks: () => Promise.resolve({ bad: true }) };
    const result = await new MultiRootTaskQuery([
      source("healthy", [task("ok", "2026-07-11T00:00:00.000Z")]),
      unavailable,
      invalid,
    ]).list("", 10, 0);
    expect(result.tasks.map((entry) => entry.task.id)).toEqual(["ok"]);
    expect(result.failures).toEqual([
      { logRoot: "broken", code: "STORAGE_UNAVAILABLE" },
      { logRoot: "invalid", code: "INVALID_STORAGE_RESPONSE" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret filesystem detail");
  });
});

function source(logRoot: string, tasks: ReturnType<typeof task>[]): TaskQuerySource {
  return {
    logRoot,
    listTasks: (_query, limit, offset) =>
      Promise.resolve({
        total: tasks.length,
        limit,
        offset,
        hasMore: offset + limit < tasks.length,
        tasks: tasks.slice(offset, offset + limit),
      }),
  };
}

function task(id: string, lastSeenAt: string) {
  return {
    id,
    kind: "responses" as const,
    endpoint: "/v1/responses",
    model: "gpt-5",
    target: "primary",
    startedAt: lastSeenAt,
    lastSeenAt,
    requestCount: 1,
    pending: false,
  };
}
