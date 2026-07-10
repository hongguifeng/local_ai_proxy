import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  displayEndpoint,
  endpointKind,
  requestBoundaryFingerprints,
  requestFingerprints,
  requestIdentifiers,
  requestMessageCount,
  requestUserMessages,
  responseIdsFromBody,
  responseTokenCount,
  stableHash,
  summarizeRecordPayload,
} from "../src/proxy/records.js";

type TaskFixture = Readonly<{
  cases: readonly Readonly<{
    requests: readonly Readonly<{ path?: string; body?: unknown; responseIds?: readonly string[] }>[];
  }>[];
}>;

const fixture = await loadFixture();

describe("endpoint and record summaries", () => {
  it("classifies endpoint suffixes while ignoring case, query, and trailing slashes", () => {
    expect(endpointKind("/v1/RESPONSES/?x=1")).toBe("responses");
    expect(endpointKind("/v1/messages/")).toBe("messages");
    expect(endpointKind("/chat/completions")).toBe("chat");
    expect(endpointKind("/completions")).toBe("completions");
    expect(endpointKind("/models")).toBe("other");
    expect(displayEndpoint("/v1/responses/?foo=bar")).toBe("/v1/responses");
    expect(displayEndpoint(null)).toBe("/");
  });

  it("counts messages for common API shapes", () => {
    expect(requestMessageCount("responses", { instructions: "system", input: [{}, {}] })).toBe(3);
    expect(requestMessageCount("messages", { system: [{}, {}], messages: [{}, {}] })).toBe(4);
    expect(requestMessageCount("chat", { messages: [{}, {}] })).toBe(2);
    expect(requestMessageCount("completions", { prompt: ["a", "b"] })).toBe(2);
    expect(requestMessageCount("other", { input: "one" })).toBe(1);
    expect(requestMessageCount("other", null)).toBeNull();
  });

  it("extracts token counts from JSON and stream-summary usage shapes", () => {
    expect(responseTokenCount({ usage: { total_tokens: 9 } })).toBe(9);
    expect(responseTokenCount({ stream_summary: { usage: { input_tokens: 3, output_tokens: 2 } } })).toBe(5);
    expect(responseTokenCount({ response: { usage: { cache_creation_input_tokens: 4 } } })).toBe(4);
    expect(responseTokenCount({ usage: { total_tokens: true } })).toBeNull();
    expect(responseTokenCount({ ok: true })).toBeNull();
  });

  it("extracts response, previous response, and context identifiers", () => {
    expect(responseIdsFromBody({ id: "resp-1", response: { id: "resp-1" } })).toEqual(["resp-1"]);
    expect(
      requestIdentifiers({
        previous_response_id: "resp-0",
        conversation: { id: "conv-1" },
        prompt_cache_key: "cache-1",
      }),
    ).toEqual({
      previousResponseId: "resp-0",
      contextKeys: ["conversation:conv-1", "prompt_cache:cache-1"],
    });
    expect(requestIdentifiers({}, { clientThreadId: "thread-1", clientSessionId: "session-1" }).contextKeys).toEqual([
      "client_thread:thread-1",
      "client_session:session-1",
    ]);
  });

  it("reads every completed payload in the language-neutral task fixture", () => {
    for (const testCase of fixture.cases) {
      for (const request of testCase.requests) {
        if (!request.path || request.body === undefined) continue;
        const summary = summarizeRecordPayload(request.path, request.body, { id: request.responseIds?.[0] });
        expect(summary.kind).not.toBe("other");
        expect(summary.messageCount).not.toBeNull();
        expect(summary.responseIds).toEqual(request.responseIds ?? []);
      }
    }
  });
});

describe("bounded fingerprints and user summaries", () => {
  it("creates stable canonical hashes independent of object key order", () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    expect(stableHash({ b: 2, a: 1 })).toBe("43258cff783f");
    expect(stableHash("hello")).toBe("5aa762ae383f");
  });

  it("builds fingerprints, boundaries, and bounded user summaries", () => {
    const payload = {
      system: "policy",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "next" },
      ],
      tools: [{ name: "search" }],
    };
    const fingerprints = requestFingerprints("messages", payload);
    expect(Object.keys(fingerprints)).toEqual(
      expect.arrayContaining(["system", "messages_prefix", "messages", "first_user", "tools"]),
    );
    expect(requestBoundaryFingerprints("messages", payload)).toEqual({
      system: fingerprints.system,
      first_user: fingerprints.first_user,
    });
    expect(requestUserMessages("messages", payload)).toHaveLength(2);
  });

  it("excludes fixed environment context messages", () => {
    const messages = requestUserMessages("chat", {
      messages: [
        { role: "user", content: "<environment_context>secret machine context</environment_context>" },
        { role: "user", content: "real request" },
      ],
    });
    expect(messages).toEqual([{ role: "user", content: "real request" }]);
  });

  it("bounds hostile depth and item counts and never throws from the aggregate path", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 10_000; index += 1) deep = [deep];
    const many = Array.from({ length: 20_000 }, (_, index) => ({ role: "user", content: String(index) }));
    expect(() => summarizeRecordPayload("/v1/chat/completions", { messages: many, tools: deep }, null)).not.toThrow();
    const boundedMessages = requestUserMessages("chat", { messages: many });
    expect(boundedMessages.length).toBeGreaterThan(0);
    expect(boundedMessages.length).toBeLessThanOrEqual(1_000);

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile payload");
        },
      },
    );
    expect(summarizeRecordPayload("/v1/responses", hostile, null)).toMatchObject({
      kind: "responses",
      fingerprints: {},
      userMessages: [],
    });
  });
});

async function loadFixture(): Promise<TaskFixture> {
  const input: unknown = JSON.parse(
    await readFile(new URL("../../../packages/test-fixtures/tasks/cases.json", import.meta.url), "utf8"),
  );
  if (!input || typeof input !== "object" || !("cases" in input)) throw new TypeError("Invalid task fixture");
  return input as TaskFixture;
}
