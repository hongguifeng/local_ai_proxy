import { describe, expect, it } from "vitest";

import type { TaskAssignment } from "../../src/logging/index.js";

describe("TaskAssignment", () => {
  it("carries the complete result needed to persist a matched request", () => {
    const assignment = {
      task: { id: "task-1", kind: "responses" },
      sequence: 2,
      kind: "responses",
      requestPayload: { input: "hello" },
      responsePayload: { id: "resp-1" },
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
    } satisfies TaskAssignment;

    expect(assignment).toMatchObject({
      task: { id: "task-1" },
      sequence: 2,
      responseIds: ["resp-1"],
      contextKeys: ["conversation:conv-1"],
    });
  });
});
