import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TASK_MATCH_STRATEGY_VERSION,
  TaskMatcher,
  type TaskAssignment,
} from "../../src/logging/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("TaskAssignment", () => {
  it("keeps task matching on strategy version 6", () => {
    expect(TASK_MATCH_STRATEGY_VERSION).toBe(6);
  });

  it("carries the complete result needed to persist a matched request", () => {
    const assignment = {
      task: { id: "task-1", kind: "responses" },
      sequence: 2,
      kind: "responses",
      requestPayload: { input: "hello" },
      responsePayload: { id: "resp-1" },
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
      supersededTaskIds: [],
    } satisfies TaskAssignment;

    expect(assignment).toMatchObject({
      task: { id: "task-1" },
      sequence: 2,
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
      supersededTaskIds: [],
    });
  });

  it("creates a pending task and promotes it when the request body arrives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-matcher-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const matcher = new TaskMatcher(repository, {
      createId: () => "task-pending",
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const pendingRecord = trafficRecord("request-1", true, {});
    const pending = matcher.assign(pendingRecord);
    if (pending === undefined) {
      throw new Error("Pending record was not assigned.");
    }
    expect(pending).toMatchObject({
      task: {
        id: "task-pending",
        anchor: "pending-request-1",
        pending_request_only: true,
        request_count: 1,
      },
      sequence: 1,
      requestPayload: {},
      responsePayload: null,
    });
    repository.upsertTask(pending.task);
    repository.upsertRecord({
      id: "request-1",
      task_id: "task-pending",
      sequence: pending.sequence,
      method: "POST",
      path: "/v1/responses",
    });

    const finished = matcher.assign(trafficRecord("request-1", false, { model: "gpt-5" }));
    expect(finished?.task).toMatchObject({
      id: "task-pending",
      kind: "responses",
      endpoint: "/v1/responses",
      pending_request_only: false,
      match_confidence: 1,
    });
    expect(finished?.sequence).toBe(1);
    if (finished === undefined) {
      throw new Error("Finished record was not assigned.");
    }
    repository.upsertTask(finished.task);
    repository.upsertRecord({
      id: "request-1",
      task_id: "task-pending",
      sequence: finished.sequence,
      method: "POST",
      path: "/v1/responses",
    });

    const repeated = matcher.assign(trafficRecord("request-1", false, { model: "gpt-5" }));
    expect(repeated).toMatchObject({ task: { id: "task-pending" }, sequence: 1 });
    expect(repeated?.task["request_count"]).toBe(1);
    repository.close();
  });

  it("replaces a pending task with the matched conversation task when the body arrives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-pending-match-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `pending-match-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const firstPayload = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second" },
      ],
    };
    const firstPending = matcher.assign(
      trafficRecord("pending-match-request-1", true, {}, "/v1/chat/completions"),
    );
    if (firstPending === undefined) {
      throw new Error("Initial pending request was not assigned.");
    }
    persistAssignment(repository, firstPending, "pending-match-request-1");
    const firstFinished = matcher.assign(
      trafficRecord("pending-match-request-1", false, firstPayload, "/v1/chat/completions"),
    );
    if (firstFinished === undefined) {
      throw new Error("Initial finished request was not assigned.");
    }
    persistAssignment(repository, firstFinished, "pending-match-request-1");

    const followupPending = matcher.assign(
      trafficRecord("pending-match-request-2", true, {}, "/v1/chat/completions"),
    );
    if (followupPending === undefined) {
      throw new Error("Follow-up pending request was not assigned.");
    }
    expect(followupPending.task["id"]).toBe("pending-match-task-2");
    persistAssignment(repository, followupPending, "pending-match-request-2");

    const followupFinished = matcher.assign(
      trafficRecord(
        "pending-match-request-2",
        false,
        {
          model: "gpt-5",
          messages: [
            ...firstPayload.messages,
            { role: "assistant", content: "second answer" },
            { role: "user", content: "third" },
          ],
        },
        "/v1/chat/completions",
      ),
    );
    expect(followupFinished).toMatchObject({
      task: {
        id: "pending-match-task-1",
        request_count: 2,
        match_confidence: 0.95,
      },
      sequence: 2,
      supersededTaskIds: ["pending-match-task-2"],
    });
    if (followupFinished === undefined) {
      throw new Error("Follow-up finished request was not assigned.");
    }
    persistAssignment(repository, followupFinished, "pending-match-request-2");

    expect(repository.getTask("pending-match-task-2")).toBeUndefined();
    expect(repository.getRecord("pending-match-request-2")).toMatchObject({
      task_id: "pending-match-task-1",
      sequence: 2,
    });
    repository.close();
  });

  it("uses a Responses previous_response_id link for follow-up requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-response-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const first = matcher.assign(
      trafficRecord("request-1", false, { model: "gpt-5", input: "start" }),
    );
    if (first === undefined) {
      throw new Error("Initial Responses request was not assigned.");
    }
    expect(first.responseIds).toEqual(["resp-request-1"]);
    persistAssignment(repository, first, "request-1");

    const followup = matcher.assign(
      trafficRecord("request-2", false, {
        model: "gpt-5",
        previous_response_id: "resp-request-1",
        input: "continue",
      }),
    );
    expect(followup).toMatchObject({ task: { id: "task-1" }, sequence: 2 });
    expect(followup?.responseIds).toEqual(["resp-request-2"]);
    repository.close();
  });

  it("generates and matches conversation, thread, session, Claude session, and prompt-cache context keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-context-link-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `context-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const firstRecord = {
      ...trafficRecord("context-request-1", false, {
        model: "gpt-5",
        conversation: { id: "conversation-1" },
        prompt_cache_key: "payload-cache",
        input: "start",
      }),
      prompt_cache_key: "record-cache",
      client_metadata: { thread_id: "thread-1", session_id: "session-1" },
      request: {
        ...trafficRecord("unused", false, {}).request,
        path: "/v1/responses",
        body: {
          size_bytes: 0,
          text: JSON.stringify({
            model: "gpt-5",
            conversation: { id: "conversation-1" },
            prompt_cache_key: "payload-cache",
            input: "start",
          }),
        },
        headers: { "X-Claude-Code-Session-Id": ["claude-session-1"] },
      },
    };
    const first = matcher.assign(firstRecord);
    if (first === undefined) {
      throw new Error("Context-linked request was not assigned.");
    }
    expect(first.contextKeys).toEqual([
      "conversation:conversation-1",
      "prompt_cache:payload-cache",
      "prompt_cache:record-cache",
      "client_thread:thread-1",
      "client_session:session-1",
      "claude_session:claude-session-1",
    ]);
    persistAssignment(repository, first, "context-request-1");

    const followupRecord = trafficRecord("context-request-2", false, {
      model: "gpt-5",
      input: "continue",
    });
    const followup = matcher.assign({
      ...followupRecord,
      request: {
        ...followupRecord.request,
        headers: { "x-claude-code-session-id": "claude-session-1" },
      },
    });
    expect(followup).toMatchObject({ task: { id: "context-task-1" }, sequence: 2 });
    repository.close();
  });

  it("matches Claude continuations when ephemeral cache controls disappear", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-claude-cache-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `claude-cache-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const cachedResult = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "result",
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const first = matcher.assign(
      trafficRecord(
        "claude-cache-request-1",
        false,
        {
          model: "claude-local",
          system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "start", cache_control: { type: "ephemeral" } }],
            },
            { role: "assistant", content: "working" },
            cachedResult,
          ],
        },
        "/v1/messages?beta=true",
      ),
    );
    if (first === undefined) {
      throw new Error("Claude cache-control baseline request was not assigned.");
    }
    persistAssignment(repository, first, "claude-cache-request-1");

    const followup = matcher.assign(
      trafficRecord(
        "claude-cache-request-2",
        false,
        {
          model: "claude-local",
          system: [{ type: "text", text: "system" }],
          messages: [
            { role: "user", content: [{ type: "text", text: "start" }] },
            { role: "assistant", content: "working" },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }],
            },
            { role: "assistant", content: "done" },
            { role: "user", content: "continue" },
          ],
        },
        "/v1/messages?beta=true",
      ),
    );

    expect(followup).toMatchObject({
      task: { id: "claude-cache-task-1", request_count: 2, match_confidence: 0.95 },
      sequence: 2,
    });
    repository.close();
  });

  it("rejects an explicit context link when static request boundaries change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-boundaries-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `boundary-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const first = matcher.assign(
      trafficRecord("boundary-request-1", false, {
        model: "gpt-5",
        instructions: "first system boundary",
        conversation_id: "boundary-conversation",
        input: [{ role: "user", content: "start" }],
      }),
    );
    if (first === undefined) {
      throw new Error("Boundary request was not assigned.");
    }
    persistAssignment(repository, first, "boundary-request-1");

    const changed = matcher.assign(
      trafficRecord("boundary-request-2", false, {
        model: "gpt-5",
        instructions: "different system boundary",
        conversation_id: "boundary-conversation",
        input: [{ role: "user", content: "continue" }],
      }),
    );
    expect(changed?.task["id"]).toBe("boundary-task-2");
    repository.close();
  });

  it("starts a new task when model, path, or endpoint kind changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-static-identity-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `identity-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const first = matcher.assign(
      trafficRecord("identity-request-1", false, {
        model: "gpt-5",
        conversation_id: "identity-conversation",
        input: "start",
      }),
    );
    if (first === undefined) {
      throw new Error("Identity baseline request was not assigned.");
    }
    persistAssignment(repository, first, "identity-request-1");

    const changedModel = matcher.assign(
      trafficRecord("identity-request-2", false, {
        model: "qwen3",
        conversation_id: "identity-conversation",
        input: "continue",
      }),
    );
    const changedPath = matcher.assign(
      trafficRecord(
        "identity-request-3",
        false,
        {
          model: "gpt-5",
          conversation_id: "identity-conversation",
          input: "continue",
        },
        "/alternate/responses",
      ),
    );
    const changedKind = matcher.assign(
      trafficRecord(
        "identity-request-4",
        false,
        {
          model: "gpt-5",
          conversation_id: "identity-conversation",
          messages: [{ role: "user", content: "continue" }],
        },
        "/v1/chat/completions",
      ),
    );
    expect([changedModel, changedPath, changedKind].map((item) => item?.task["id"])).toEqual([
      "identity-task-2",
      "identity-task-3",
      "identity-task-4",
    ]);
    repository.close();
  });

  it("uses an inclusive 24-hour window for heuristic task matching", async () => {
    for (const [timestamp, expectedTaskId] of [
      ["2026-07-19T10:00:01.000+08:00", "window-task-1"],
      ["2026-07-19T10:00:01.001+08:00", "window-task-2"],
    ] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-window-"));
      temporaryDirectories.push(root);
      const repository = new TrafficRepository(root);
      let taskNumber = 0;
      const matcher = new TaskMatcher(repository, {
        createId: () => `window-task-${++taskNumber}`,
        now: () => "2026-07-18T10:00:00.000+08:00",
      });
      const firstRecord = {
        ...trafficRecord(
          "window-request-1",
          false,
          { model: "gpt-5", prompt: "same prompt" },
          "/v1/completions",
        ),
        timestamp: "2026-07-18T10:00:01.000+08:00",
      };
      const first = matcher.assign(firstRecord);
      if (first === undefined) {
        throw new Error("Window baseline request was not assigned.");
      }
      persistAssignment(repository, first, "window-request-1");

      const followupRecord = {
        ...trafficRecord(
          "window-request-2",
          false,
          { model: "gpt-5", prompt: "same prompt" },
          "/v1/completions",
        ),
        timestamp,
      };
      expect(matcher.assign(followupRecord)?.task["id"]).toBe(expectedTaskId);
      repository.close();
    }
  });

  it("requires the previous user-message sequence as a heuristic prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-user-prefix-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `prefix-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const first = matcher.assign(
      trafficRecord(
        "prefix-request-1",
        false,
        {
          model: "gpt-5",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "second" },
          ],
        },
        "/v1/chat/completions",
      ),
    );
    if (first === undefined) {
      throw new Error("User-prefix baseline request was not assigned.");
    }
    persistAssignment(repository, first, "prefix-request-1");

    const continuation = matcher.assign(
      trafficRecord(
        "prefix-request-2",
        false,
        {
          model: "gpt-5",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "second" },
            { role: "assistant", content: "another answer" },
            { role: "user", content: "third" },
          ],
        },
        "/v1/chat/completions",
      ),
    );
    const changedHistory = matcher.assign(
      trafficRecord(
        "prefix-request-3",
        false,
        {
          model: "gpt-5",
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "different answer" },
            { role: "user", content: "replacement second" },
            { role: "user", content: "third" },
          ],
        },
        "/v1/chat/completions",
      ),
    );
    expect(continuation?.task["id"]).toBe("prefix-task-1");
    expect(changedHistory?.task["id"]).toBe("prefix-task-2");
    repository.close();
  });

  it("requires continuation evidence instead of grouping identical requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-continuation-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    let taskNumber = 0;
    const matcher = new TaskMatcher(repository, {
      createId: () => `continuation-task-${++taskNumber}`,
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const baselinePayload = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "first answer" },
      ],
    };
    const first = matcher.assign(
      trafficRecord("continuation-request-1", false, baselinePayload, "/v1/chat/completions"),
    );
    if (first === undefined) {
      throw new Error("Continuation baseline request was not assigned.");
    }
    persistAssignment(repository, first, "continuation-request-1");

    const duplicate = matcher.assign(
      trafficRecord("continuation-request-2", false, baselinePayload, "/v1/chat/completions"),
    );
    const changedConversation = matcher.assign(
      trafficRecord(
        "continuation-request-3",
        false,
        {
          model: "gpt-5",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "revised answer" },
          ],
        },
        "/v1/chat/completions",
      ),
    );
    expect(duplicate?.task["id"]).toBe("continuation-task-2");
    expect(changedConversation?.task["id"]).toBe("continuation-task-1");
    repository.close();
  });

  it("updates request count and last-seen/response timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-task-updates-"));
    temporaryDirectories.push(root);
    const repository = new TrafficRepository(root);
    const matcher = new TaskMatcher(repository, {
      createId: () => "updated-task",
      now: () => "2026-07-18T10:00:00.000+08:00",
    });
    const firstRecord = {
      ...trafficRecord("updated-request-1", false, {
        model: "gpt-5",
        conversation_id: "updated-conversation",
        input: "start",
      }),
      timestamp: "2026-07-18T10:01:00.000+08:00",
    };
    const first = matcher.assign(firstRecord);
    if (first === undefined) {
      throw new Error("Task update baseline request was not assigned.");
    }
    expect(first.task).toMatchObject({
      match_strategy_version: 6,
      request_count: 1,
      last_seen_at: "2026-07-18T10:01:00.000+08:00",
      last_response_at: "2026-07-18T10:01:00.000+08:00",
    });
    persistAssignment(repository, first, "updated-request-1");

    const secondRecord = {
      ...trafficRecord("updated-request-2", false, {
        model: "gpt-5",
        conversation_id: "updated-conversation",
        input: "continue",
      }),
      timestamp: "2026-07-18T10:02:00.000+08:00",
    };
    const second = matcher.assign(secondRecord);
    expect(second?.task).toMatchObject({
      id: "updated-task",
      request_count: 2,
      last_seen_at: "2026-07-18T10:02:00.000+08:00",
      last_response_at: "2026-07-18T10:02:00.000+08:00",
    });
    repository.close();
  });
});

function trafficRecord(
  id: string,
  bodyPending: boolean,
  payload: unknown,
  requestPath = "/v1/responses",
) {
  return {
    id,
    timestamp: "2026-07-18T10:00:01.000+08:00",
    request: {
      method: "POST",
      path: requestPath,
      body_pending: bodyPending,
      body: { size_bytes: 0, text: JSON.stringify(payload) },
    },
    response: {
      status: 200,
      body: { size_bytes: 0, text: JSON.stringify({ id: `resp-${id}` }) },
    },
  };
}

function persistAssignment(
  repository: TrafficRepository,
  assignment: TaskAssignment,
  requestId: string,
): void {
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
      request_body: assignment.requestPayload,
      response_body: assignment.responsePayload,
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
