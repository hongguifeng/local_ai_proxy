import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskMatcher, type TaskAssignment } from "../../src/logging/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";
import { requestContextKeys, taskIdentity } from "../../src/proxy/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

function trafficRecord(
  id: string,
  payload: unknown,
  headers: Record<string, string[]>,
  requestPath = "/v1/responses",
) {
  return {
    id,
    timestamp: "2026-07-18T10:00:01.000+08:00",
    request: {
      method: "POST",
      path: requestPath,
      headers,
      body: { size_bytes: 0, text: JSON.stringify(payload) },
    },
    response: {
      status: 200,
      body: { size_bytes: 0, text: JSON.stringify({ id: `resp-${id}` }) },
    },
  };
}

function persist(repository: TrafficRepository, assignment: TaskAssignment, requestId: string) {
  const taskId = assignment.task["id"];
  if (typeof taskId !== "string") {
    throw new Error("Task assignment is missing a string task ID.");
  }
  repository.transaction(() => {
    repository.upsertTask(assignment.task);
    repository.upsertRecord({
      id: requestId,
      task_id: taskId,
      sequence: assignment.sequence,
      method: "POST",
      path: "/v1/responses",
    });
    for (const responseId of assignment.responseIds) {
      repository.upsertResponseLink(responseId, taskId);
    }
    for (const contextKey of assignment.contextKeys) {
      repository.upsertContextLink(contextKey, taskId);
    }
    repository.deleteTasks(assignment.supersededTaskIds);
  });
}

function assignAndPersist(
  repository: TrafficRepository,
  matcher: TaskMatcher,
  requestId: string,
  payload: unknown,
  headers: Record<string, string[]>,
): TaskAssignment {
  const assignment = matcher.assign(trafficRecord(requestId, payload, headers));
  if (assignment === undefined) {
    throw new Error(`Record ${requestId} was not assigned.`);
  }
  persist(repository, assignment, requestId);
  return assignment;
}

function taskId(assignment: TaskAssignment): string {
  const id = assignment.task["id"];
  if (typeof id !== "string") {
    throw new Error("Task is missing an id.");
  }
  return id;
}

function identityOf(payload: unknown, headers: Record<string, string[]>, path = "/v1/responses") {
  return taskIdentity({ payload, headers, path });
}

function splitEvidence(
  left: ReturnType<typeof identityOf>,
  right: ReturnType<typeof identityOf>,
): string[] {
  const differences: string[] = [];
  if (left.kind !== right.kind) {
    differences.push("kind");
  }
  if (left.endpoint !== right.endpoint) {
    differences.push("endpoint");
  }
  if (left.model !== right.model) {
    differences.push("model");
  }
  if (JSON.stringify(left.boundaryWithoutUser) !== JSON.stringify(right.boundaryWithoutUser)) {
    differences.push("boundary");
  }
  if (left.contentFingerprint !== right.contentFingerprint) {
    differences.push("content");
  }
  if (left.userHashes.join() !== right.userHashes.join()) {
    differences.push("userHashes");
  }
  if (left.exactKeys.join() !== right.exactKeys.join()) {
    differences.push("exactKeys");
  }
  return differences;
}

describe("task identity boundary between the matcher and the router", () => {
  it("LB02-08 splits requests exactly where the matcher splits them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-identity-boundary-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let nextTask = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `boundary-task-${++nextTask}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });

    const session = { "x-claude-code-session-id": ["session-1"] };
    const first = {
      model: "gpt-5",
      instructions: "rules",
      input: [{ role: "user", content: "question one" }],
    };
    const differentSession = { "x-claude-code-session-id": ["session-2"] };
    const sameAsFirst = {
      model: "gpt-5",
      instructions: "rules",
      input: [{ role: "user", content: "question one" }],
    };
    const differentModel = {
      model: "gpt-4",
      instructions: "rules",
      input: [{ role: "user", content: "question one" }],
    };
    const differentInstructions = {
      model: "gpt-5",
      instructions: "other rules",
      input: [{ role: "user", content: "question one" }],
    };
    const secondTurn = {
      model: "gpt-5",
      instructions: "rules",
      input: [
        { role: "user", content: "question one" },
        { role: "user", content: "question two" },
      ],
    };

    const firstAssignment = assignAndPersist(repository, matcher, "req-1", first, session);
    const sameSession = assignAndPersist(repository, matcher, "req-2", sameAsFirst, session);
    const otherSession = assignAndPersist(
      repository,
      matcher,
      "req-3",
      sameAsFirst,
      differentSession,
    );
    const otherModel = assignAndPersist(repository, matcher, "req-4", differentModel, session);
    const otherInstructions = assignAndPersist(
      repository,
      matcher,
      "req-5",
      differentInstructions,
      session,
    );
    const continued = assignAndPersist(repository, matcher, "req-6", secondTurn, session);

    expect(taskId(firstAssignment)).toBe(taskId(sameSession));
    expect(splitEvidence(identityOf(first, session), identityOf(sameAsFirst, session))).toEqual([]);

    // A different session with an identical body is a separate task for the matcher,
    // because nothing continued. The router still sees the same boundary and the same
    // user hashes, so it may keep this request on the node the identical body already
    // used. That is the allowed direction: the router merges more, never less.
    expect(taskId(otherSession)).not.toBe(taskId(firstAssignment));
    expect(
      splitEvidence(identityOf(first, session), identityOf(sameAsFirst, differentSession)),
    ).toEqual(["exactKeys"]);

    expect(taskId(otherModel)).not.toBe(taskId(firstAssignment));
    expect(
      splitEvidence(identityOf(first, session), identityOf(differentModel, session)),
    ).toContain("model");

    expect(taskId(otherInstructions)).not.toBe(taskId(firstAssignment));
    expect(
      splitEvidence(identityOf(first, session), identityOf(differentInstructions, session)),
    ).toContain("boundary");

    // A continued turn is the same task for the matcher. The router follows the session
    // binding, not the changed content, so a change here must never start a new binding.
    expect(taskId(continued)).toBe(taskId(firstAssignment));
    expect(splitEvidence(identityOf(first, session), identityOf(secondTurn, session))).toEqual([
      "content",
      "userHashes",
    ]);
    repository.close();
  });

  it("LB02-08 sees at least every context key the matcher can reach in the request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-identity-keys-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const matcher = new TaskMatcher(repository, {
      createId: () => "keys-task",
      now: () => "2026-07-18T10:00:00.000+08:00",
    });

    const payload = {
      model: "gpt-5",
      instructions: "rules",
      input: [{ role: "user", content: "question" }],
      prompt_cache_key: "cache-1",
    };
    const headers = { "x-claude-code-session-id": ["session-1"] };
    const assignment = assignAndPersist(repository, matcher, "req-keys", payload, headers);
    const runtimeKeys = requestContextKeys(payload, headers);

    expect(runtimeKeys).toContain("prompt_cache:cache-1");
    expect(runtimeKeys).toContain("claude_session:session-1");
    for (const key of runtimeKeys) {
      expect(assignment.contextKeys).toContain(key);
    }
    repository.close();
  });

  it("LB02-08 keeps record columns as a history fallback the router cannot use", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-identity-legacy-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const matcher = new TaskMatcher(repository, {
      createId: () => "legacy-task",
      now: () => "2026-07-18T10:00:00.000+08:00",
    });

    const payload = {
      model: "gpt-5",
      instructions: "rules",
      input: [{ role: "user", content: "question" }],
    };
    const headers = { "x-test": ["1"] };
    const record = {
      ...trafficRecord("req-legacy", payload, headers),
      prompt_cache_key: "cache-from-column",
      client_metadata: { session_id: "session-from-column" },
    };
    const assignment = matcher.assign(record);
    if (assignment === undefined) {
      throw new Error("Legacy record was not assigned.");
    }

    expect(requestContextKeys(payload, headers)).toEqual([]);
    expect(assignment.contextKeys).toEqual([
      "prompt_cache:cache-from-column",
      "client_session:session-from-column",
    ]);
    repository.close();
  });

  it("LB02-08 keeps the same identity across endpoint spellings of the same kind", () => {
    const payload = { model: "gpt-5", messages: [{ role: "user", content: "hello" }] };
    const headers = {};
    const direct = identityOf(payload, headers, "/v1/chat/completions");
    const withBase = identityOf(payload, headers, "/base/v1/chat/completions");

    expect(direct.kind).toBe(withBase.kind);
    expect(direct.boundaryWithoutUser).toEqual(withBase.boundaryWithoutUser);
    expect(direct.endpoint).not.toBe(withBase.endpoint);
  });
});
