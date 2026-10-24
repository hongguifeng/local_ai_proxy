import { describe, expect, it } from "vitest";

import {
  MAX_TASK_USER_HASHES,
  boundaryWithoutUser,
  contentFingerprint,
  hasContinuationEvidence,
  mergeLegacyContextKeys,
  requestBoundaryFingerprints,
  requestContextKeys,
  requestFingerprints,
  requestUserMessages,
  taskIdentity,
  userHashPrefixMatches,
  userMessageHashes,
  userMessagesPrefixMatches,
} from "../../src/proxy/index.js";

function chatPayload(
  system: string,
  users: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "qwen-test",
    stream: true,
    messages: [
      { role: "system", content: system },
      ...users.map((content) => ({ role: "user", content })),
    ],
    ...extra,
  };
}

function responsesPayload(
  instructions: string,
  users: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "qwen-test",
    instructions,
    input: users.map((content) => ({ role: "user", content })),
    ...extra,
  };
}

describe("task identity projections", () => {
  it("LB02-01 produces exactly the fields the task matcher stores", () => {
    const payload = chatPayload("rules", ["first", "second"]);
    const identity = taskIdentity({ payload, path: "/v1/chat/completions" });

    expect(identity.kind).toBe("chat");
    expect(identity.endpoint).toBe("/v1/chat/completions");
    expect(identity.model).toBe("qwen-test");
    expect(identity.boundary).toEqual(requestBoundaryFingerprints("chat", payload));
    expect(identity.contentFingerprint).toBe(contentFingerprint("chat", payload));
    expect(identity.userHashes.length).toBe(requestUserMessages("chat", payload).length);
    expect(Object.keys(identity.boundaryWithoutUser)).not.toContain("first_user");
  });

  it("LB02-02 orders exact keys response, conversation, session, prompt cache", () => {
    const payload = {
      model: "qwen-test",
      previous_response_id: "resp_1",
      prompt_cache_key: "cache-1",
      metadata: { session_id: "session-1" },
    };
    const headers = { "X-Claude-Code-Session-Id": ["claude-1"] };

    expect(taskIdentity({ payload, headers, path: "/v1/responses" }).exactKeys).toEqual([
      "response:resp_1",
      "conversation:session-1",
      "prompt_cache:cache-1",
      "claude_session:claude-1",
    ]);
  });

  it("LB02-02 ignores a blank previous response id and non-string header values", () => {
    const payload = { model: "qwen-test", previous_response_id: "  " };
    const headers = { "x-claude-code-session-id": [42] };

    expect(taskIdentity({ payload, headers, path: "/v1/responses" }).exactKeys).toEqual([]);
  });

  it("LB02-03 compares a stable boundary without the first user turn", () => {
    const first = responsesPayload("rules", ["hello"]);
    const continued = responsesPayload("rules", ["hello", "follow up"]);
    const differentRules = responsesPayload("rules changed", ["hello"]);
    const differentFirstUser = responsesPayload("rules", ["good morning"]);
    const identities = [first, continued, differentRules, differentFirstUser].map((payload) =>
      taskIdentity({ payload, path: "/v1/responses" }),
    );

    expect(identities[0]?.boundaryWithoutUser).toEqual(identities[1]?.boundaryWithoutUser);
    expect(identities[0]?.boundaryWithoutUser).not.toEqual(identities[2]?.boundaryWithoutUser);
    expect(identities[1]?.boundary["first_user"]).toBe(identities[0]?.boundary["first_user"]);
    expect(identities[3]?.boundary["first_user"]).not.toBe(identities[0]?.boundary["first_user"]);
    expect(identities[1]?.userHashes).not.toEqual(identities[0]?.userHashes);
    expect(boundaryWithoutUser(identities[0]?.boundary ?? {})).not.toHaveProperty("first_user");
  });

  it("LB02-04 matches a stored user prefix in both hash and JSON form", () => {
    const payload = chatPayload("rules", ["a", "b", "c"]);
    const messages = requestUserMessages("chat", payload);
    const full = userMessageHashes("chat", payload).hashes;

    expect(full).toHaveLength(messages.length);
    expect(new Set(full).size).toBe(messages.length);
    expect(userMessagesPrefixMatches(messages.slice(0, 2), messages)).toBe(true);
    expect(userHashPrefixMatches(full.slice(0, 2), full)).toBe(true);
    expect(userMessagesPrefixMatches(messages, messages.slice(0, 2))).toBe(false);
    expect(userHashPrefixMatches([], full)).toBe(false);
    expect(userMessagesPrefixMatches(messages, [])).toBe(false);
  });

  it("LB02-05 changes the content fingerprint exactly when continuation evidence changes", () => {
    const first = chatPayload("rules", ["question"]);
    const repeated = chatPayload("rules", ["question"]);
    const extended = chatPayload("rules", ["question", "follow up"]);

    expect(contentFingerprint("chat", repeated)).toBe(contentFingerprint("chat", first));
    expect(contentFingerprint("chat", extended)).not.toBe(contentFingerprint("chat", first));
    expect(hasContinuationEvidence("chat", extended, requestUserMessages("chat", first), {})).toBe(
      true,
    );
    expect(
      hasContinuationEvidence("chat", repeated, requestUserMessages("chat", first), {
        messages: requestFingerprints("chat", first)["messages"],
      }),
    ).toBe(false);
    expect(
      hasContinuationEvidence("chat", extended, undefined, {
        messages: requestFingerprints("chat", first)["messages"],
      }),
    ).toBe(true);
  });

  it("LB02-05 reports no fingerprint for a payload without an input or message body", () => {
    expect(contentFingerprint("other", {})).toBeUndefined();
    expect(taskIdentity({ payload: {}, path: "/health" }).contentFingerprint).toBeUndefined();
  });

  it("LB02-06 derives context keys from the live request alone", () => {
    const payload = { model: "m", prompt_cache_key: " cache-1 " };
    const headers = { "x-claude-code-session-id": ["claude-1"] };

    expect(requestContextKeys(payload, headers)).toEqual([
      "prompt_cache:cache-1",
      "claude_session:claude-1",
    ]);
    expect(requestContextKeys(payload, undefined)).toEqual(["prompt_cache:cache-1"]);
    expect(requestContextKeys("not a record", headers)).toEqual(["claude_session:claude-1"]);
  });

  it("LB02-06 keeps the legacy record-only keys ahead of the session header", () => {
    const runtime = ["conversation:c-1", "prompt_cache:p-1", "claude_session:s-1"];
    const legacy = ["prompt_cache:record-1", "client_session:s-9"];

    expect(mergeLegacyContextKeys(runtime, legacy)).toEqual([
      "conversation:c-1",
      "prompt_cache:p-1",
      "prompt_cache:record-1",
      "client_session:s-9",
      "claude_session:s-1",
    ]);
    expect(mergeLegacyContextKeys(["conversation:c-1"], legacy)).toEqual([
      "conversation:c-1",
      "prompt_cache:record-1",
      "client_session:s-9",
    ]);
    expect(mergeLegacyContextKeys(runtime, [])).toEqual(runtime);
  });

  it("LB02-07 bounds the retained user hashes and flags an oversized conversation", () => {
    const users = Array.from({ length: MAX_TASK_USER_HASHES + 36 }, (_, index) => `turn ${index}`);
    const payload = chatPayload("rules", users);
    const identity = taskIdentity({ payload, path: "/v1/chat/completions" });

    expect(identity.userHashes).toHaveLength(MAX_TASK_USER_HASHES);
    expect(new Set(identity.userHashes).size).toBe(MAX_TASK_USER_HASHES);
    expect(identity.bounded).toBe(true);
    expect(identity.oversize).toBe(false);
  });

  it("LB02-07 marks a conversation beyond the message guard as oversized", () => {
    const users = Array.from({ length: 4_100 }, (_, index) => `turn ${index}`);
    const identity = taskIdentity({
      payload: chatPayload("rules", users),
      path: "/v1/chat/completions",
    });

    expect(identity.oversize).toBe(true);
    expect(identity.bounded).toBe(true);
  });

  it("LB02-01 keeps endpoint kinds and empty payloads predictable", () => {
    const identity = taskIdentity({ payload: null, path: "/v1/responses/" });

    expect(identity.kind).toBe("responses");
    expect(identity.model).toBeUndefined();
    expect(identity.exactKeys).toEqual([]);
    expect(identity.boundary).toEqual({});
    expect(identity.userHashes).toEqual([]);
  });
});
