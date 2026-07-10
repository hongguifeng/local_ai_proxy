import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  TASK_MATCH_RECENT_LIMIT,
  TASK_MATCH_STRATEGY_VERSION,
  TaskMatcher,
  type ExistingRecordAssignment,
  type TaskAssignment,
  type TaskMatchRepository,
  type TaskMatchState,
} from "../src/tasks/task-matcher.js";

type Fixture = Readonly<{ cases: readonly FixtureCase[] }>;
type FixtureCase = Readonly<{
  name: string;
  requests: readonly Readonly<{
    recordId: string;
    event?: "request_received" | "request_finished";
    path?: string;
    bodyPending?: boolean;
    body?: unknown;
    responseIds?: readonly string[];
  }>[];
  expectedSequences: readonly number[];
  expectedTaskRelation: readonly ("same" | "different")[];
}>;

const fixture = JSON.parse(
  await readFile(new URL("../../../packages/test-fixtures/tasks/cases.json", import.meta.url), "utf8"),
) as Fixture;

describe("TaskMatcher", () => {
  it("matches every language-neutral task assignment fixture", () => {
    for (const testCase of fixture.cases) {
      const repository = new MemoryRepository();
      let nextId = 0;
      const matcher = new TaskMatcher(repository, {
        idFactory: () => `task-${(++nextId).toString()}`,
        now: () => "2026-07-11T00:00:00.000Z",
      });
      const assignments: TaskAssignment[] = [];
      for (const [index, request] of testCase.requests.entries()) {
        const assignment = matcher.assign({
          recordId: request.recordId,
          event: request.event ?? "request_finished",
          timestamp: `2026-07-11T00:00:0${index.toString()}.000Z`,
          ...(request.path ? { path: request.path } : {}),
          ...(request.bodyPending ? {} : { payload: request.body }),
          responsePayload: request.responseIds?.[0] ? { id: request.responseIds[0] } : null,
        });
        repository.persist(request.recordId, assignment);
        assignments.push(assignment);
      }
      expect(
        assignments.map((assignment) => assignment.sequence),
        testCase.name,
      ).toEqual(testCase.expectedSequences);
      for (const [index, relation] of testCase.expectedTaskRelation.entries()) {
        const same = assignments[index]?.task.id === assignments[index + 1]?.task.id;
        expect(same, testCase.name).toBe(relation === "same");
      }
    }
  });

  it("uses explicit links before heuristic matching", () => {
    const repository = new MemoryRepository();
    const matcher = matcherFor(repository);
    const first = matcher.assign(input("one", { model: "gpt-5", input: "hello", conversation_id: "conv" }));
    repository.persist("one", first);
    const explicit = matcher.assign(
      input("two", { model: "gpt-5", input: "next", previous_response_id: "resp-one" }, { id: "resp-two" }),
    );
    repository.responseLinks.set("resp-one", first.task.id);
    const rematched = matcher.assign(
      input("three", { model: "gpt-5", input: "next", previous_response_id: "resp-one" }),
    );
    expect(explicit.reason).toBe("new_task");
    expect(rematched).toMatchObject({ reason: "previous_response", confidence: 1, strategyVersion: 4 });
  });

  it("groups heuristic continuation but isolates concurrent and model-changing tasks", () => {
    const repository = new MemoryRepository();
    const matcher = matcherFor(repository);
    const first = matcher.assign(chat("one", "model-a", [user("hello")]));
    repository.persist("one", first);
    const continuation = matcher.assign(
      chat("two", "model-a", [user("hello"), { role: "assistant", content: "hi" }, user("next")]),
    );
    expect(continuation.task.id).toBe(first.task.id);
    expect(continuation.reason).toBe("heuristic_continuation");
    const concurrent = matcher.assign(chat("three", "model-a", [user("different")]));
    const changed = matcher.assign(chat("four", "model-b", [user("hello"), user("next")]));
    expect(concurrent.task.id).not.toBe(first.task.id);
    expect(changed.task.id).not.toBe(first.task.id);
    expect(repository.lastRecentLimit).toBe(TASK_MATCH_RECENT_LIMIT);
  });

  it("promotes pending records in place and preserves sequence", () => {
    const repository = new MemoryRepository();
    const matcher = matcherFor(repository);
    const pending = matcher.assign({
      recordId: "same",
      event: "request_received",
      timestamp: "2026-07-11T00:00:00.000Z",
    });
    repository.persist("same", pending);
    const final = matcher.assign(input("same", { model: "gpt-5", input: "hello" }));
    expect(final).toMatchObject({
      sequence: pending.sequence,
      reason: "pending_promoted",
      strategyVersion: TASK_MATCH_STRATEGY_VERSION,
    });
    expect(final.task.id).toBe(pending.task.id);
    expect(final.task.pending).toBe(false);
  });
});

class MemoryRepository implements TaskMatchRepository {
  readonly tasks = new Map<string, TaskMatchState>();
  readonly records = new Map<string, ExistingRecordAssignment>();
  readonly responseLinks = new Map<string, string>();
  readonly contextLinks = new Map<string, string>();
  lastRecentLimit = 0;

  assignmentForRecord(recordId: string) {
    return this.records.get(recordId) ?? null;
  }
  getTaskState(taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  taskIdForResponse(responseId: string) {
    return this.responseLinks.get(responseId) ?? null;
  }
  taskIdForContext(contextKey: string) {
    return this.contextLinks.get(contextKey) ?? null;
  }
  recentTaskStates(query: Parameters<TaskMatchRepository["recentTaskStates"]>[0]) {
    this.lastRecentLimit = query.limit;
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.lastSeenAt >= query.since &&
          task.kind === query.kind &&
          task.endpoint === query.endpoint &&
          task.model === query.model,
      )
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, query.limit);
  }
  recordCount(taskId: string) {
    return [...this.records.values()].filter((record) => record.taskId === taskId).length;
  }
  nextSequence(taskId: string) {
    return this.recordCount(taskId) + 1;
  }

  persist(recordId: string, assignment: TaskAssignment): void {
    this.tasks.set(assignment.task.id, assignment.task);
    this.records.set(recordId, { taskId: assignment.task.id, sequence: assignment.sequence });
    for (const id of assignment.responseIds) this.responseLinks.set(id, assignment.task.id);
    for (const key of assignment.contextKeys) this.contextLinks.set(key, assignment.task.id);
  }
}

function matcherFor(repository: MemoryRepository): TaskMatcher {
  let id = 0;
  return new TaskMatcher(repository, {
    idFactory: () => `task-${(++id).toString()}`,
    now: () => "2026-07-11T00:00:00.000Z",
  });
}

function input(recordId: string, payload: unknown, responsePayload: unknown = null) {
  return {
    recordId,
    event: "request_finished" as const,
    timestamp: "2026-07-11T00:00:00.000Z",
    path: "/v1/responses",
    payload,
    responsePayload,
  };
}

function chat(recordId: string, model: string, messages: unknown[]) {
  return { ...input(recordId, { model, messages }), path: "/v1/chat/completions" };
}

function user(content: string) {
  return { role: "user", content };
}
