import { describe, expect, it } from "vitest";

import { prepareTaskTimelineInput } from "../../src/maintenance/summary-input.js";
import { truncateText } from "../../src/maintenance/text-limit.js";
import { TASK_BRIEF_FACT_VALUE_LIMIT } from "../../src/maintenance/summary-prompts.js";
import type { RecordRow } from "../../src/persistence/index.js";

/**
 * [AI-11] The input-preparation boundary: what the summary model is sent.
 *
 * These tests are written against the text the model reads, because that text is the
 * only thing the model has. What is pinned is the reduction the project performs on a
 * stored request - keep the conversation, shorten the long tool payloads, drop what the
 * model cannot read anyway - and the small client block a brief gets so an agent name
 * is evidence rather than a guess. The timeline half pins the part the model must not
 * have to guess at: the order the log actually has, and which result answers which call.
 */

function record(overrides: Partial<RecordRow> = {}): Readonly<RecordRow> {
  return {
    id: "record-1",
    task_id: "task-1",
    sequence: 11,
    path: "/v1/responses",
    request_headers: {},
    request_body: null,
    ...overrides,
  } as Readonly<RecordRow>;
}

/** The events of a prepared timeline, without the source block. */
function eventsOf(record: Readonly<RecordRow> | undefined) {
  return prepareTaskTimelineInput(record).events;
}

describe("input preparation", () => {
  it("cuts a client hint to the length a brief value may have", () => {
    const input = prepareTaskTimelineInput(
      record({ request_headers: { "user-agent": "u".repeat(TASK_BRIEF_FACT_VALUE_LIMIT + 10) } }),
    );
    expect(input.client["user-agent"]).toBe(`${"u".repeat(TASK_BRIEF_FACT_VALUE_LIMIT)}…`);
    // The stored record has no request body at all, which is said out loud as an event
    // the model can cite instead of being handed an empty input.
    expect(input.events).toEqual([
      { event_no: 1, kind: "other", text: "[这条请求没有留下可读的请求体]" },
    ]);
  });

  it("sends no events for a record that was deleted between the reads", () => {
    const input = prepareTaskTimelineInput(undefined);
    expect(input.events).toEqual([]);
    expect(input.client).toEqual({});
    expect(input.source).toEqual({
      request_sequence: 0,
      api_kind: "other",
      event_count: 0,
      truncated: false,
    });
  });
});

describe("timeline event normalization", () => {
  it("numbers chat messages in the order the request carries them", () => {
    const events = eventsOf(
      record({
        path: "/v1/chat/completions",
        request_body: {
          model: "gpt-5",
          messages: [
            { role: "system", content: "You work in d:/code/local_ai_proxy." },
            { role: "user", content: "Fix the relay." },
            { role: "assistant", content: "Reading the loader." },
          ],
        },
      }),
    );
    expect(events.map((event) => event.event_no)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.kind)).toEqual([
      "system_message",
      "user_message",
      "assistant_message",
    ]);
    expect(events[2]?.role).toBe("assistant");
    expect(prepareTaskTimelineInput(record({ path: "/v1/chat/completions" })).source.api_kind).toBe(
      "chat",
    );
  });

  it("numbers responses input items in the order the input array carries them", () => {
    const events = eventsOf(
      record({
        request_body: {
          model: "gpt-5",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "check" }] },
            { type: "reasoning", summary: [{ type: "summary_text", text: "Read the loader." }] },
            { type: "function_call", call_id: "call-1", name: "read", arguments: '{"p":"a"}' },
            { type: "function_call_output", call_id: "call-1", output: "found it" },
            { type: "message", role: "assistant", content: "Done." },
          ],
        },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "user_message",
      "reasoning_summary",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(events.map((event) => event.event_no)).toEqual([1, 2, 3, 4, 5]);
    expect(prepareTaskTimelineInput(record()).source.api_kind).toBe("responses");
  });

  it("links a responses call to its result by call_id without moving either number", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [
            { type: "message", role: "user", content: "go" },
            { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
            { type: "message", role: "assistant", content: "waiting" },
            { type: "function_call_output", call_id: "call-1", output: "ok" },
          ],
        },
      }),
    );
    const call = events[1];
    const result = events[3];
    expect(call?.kind).toBe("tool_call");
    expect(result?.kind).toBe("tool_result");
    // The numbers stay where the log put them; only the relationship is added.
    expect(call?.event_no).toBe(2);
    expect(result?.event_no).toBe(4);
    expect(call?.call_id).toBe("call-1");
    expect(result?.call_id).toBe("call-1");
    expect(call?.operation_id).toBe("op-2");
    expect(result?.operation_id).toBe("op-2");
    expect(call?.result_event_no).toBe(4);
    expect(result?.call_event_no).toBe(2);
    expect(result?.unpaired).toBeUndefined();
  });

  it("links a chat call to its result by tool_call_id", () => {
    const events = eventsOf(
      record({
        path: "/v1/chat/completions",
        request_body: {
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call-9", type: "function", function: { name: "shell", arguments: "ls" } },
              ],
            },
            { role: "tool", tool_call_id: "call-9", content: "a file" },
          ],
        },
      }),
    );
    // An assistant turn with no text and only a call is the call, not an empty message.
    expect(events.map((event) => event.kind)).toEqual(["user_message", "tool_call", "tool_result"]);
    expect(events[1]?.event_no).toBe(2);
    expect(events[2]?.event_no).toBe(3);
    expect(events[1]?.call_id).toBe("call-9");
    expect(events[1]?.tool).toBe("shell");
    expect(events[1]?.arguments_preview).toBe("ls");
    expect(events[2]?.call_event_no).toBe(2);
    expect(events[1]?.result_event_no).toBe(3);
  });

  it("keeps parallel calls as separate evidence and never orders one before another", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [
            { type: "function_call", call_id: "a", name: "read", arguments: "{}" },
            { type: "function_call", call_id: "b", name: "read", arguments: "{}" },
            { type: "function_call_output", call_id: "b", output: "second" },
            { type: "function_call_output", call_id: "a", output: "first" },
          ],
        },
      }),
    );
    // Each call keeps its own number and its own result; the results arrive out of the
    // order the calls were sent, and neither pairing says anything about which call
    // happened first.
    expect(events.map((event) => event.event_no)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ]);
    expect(events[0]?.result_event_no).toBe(4);
    expect(events[1]?.result_event_no).toBe(3);
    expect(events[2]?.call_event_no).toBe(2);
    expect(events[3]?.call_event_no).toBe(1);
    expect(events[0]?.operation_id).toBe("op-1");
    expect(events[1]?.operation_id).toBe("op-2");
    expect(events[0]?.operation_id).not.toBe(events[1]?.operation_id);
  });

  it("marks a result whose call is not in the request instead of inventing one", () => {
    const events = eventsOf(
      record({
        request_body: {
          messages: [{ role: "tool", tool_call_id: "call-x", content: "orphan result" }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool_result");
    expect(events[0]?.call_id).toBe("call-x");
    expect(events[0]?.unpaired).toBe(true);
    expect(events[0]?.call_event_no).toBeUndefined();
    expect(events[0]?.operation_id).toBeUndefined();
  });

  it("keeps a call that has no result as a call", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [{ type: "function_call", call_id: "open", name: "read", arguments: "{}" }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool_call");
    expect(events[0]?.result_event_no).toBeUndefined();
    expect(events[0]?.operation_id).toBeUndefined();
  });

  it("does not pair a call with a result when the call id is missing", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [
            { type: "function_call", name: "read", arguments: "{}" },
            { type: "function_call_output", output: "maybe" },
          ],
        },
      }),
    );
    expect(events[0]?.call_id).toBeUndefined();
    expect(events[1]?.call_id).toBeUndefined();
    expect(events[0]?.result_event_no).toBeUndefined();
    expect(events[1]?.call_event_no).toBeUndefined();
    // Without an id there is nothing to pair on, so nothing is claimed either.
    expect(events[1]?.unpaired).toBeUndefined();
  });

  it("keeps a published reasoning summary and drops the hidden thinking", () => {
    const responses = eventsOf(
      record({
        request_body: {
          input: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "check the config first" }],
              encrypted_content: "SECRET-ENCRYPTED-THINKING",
            },
          ],
        },
      }),
    );
    expect(responses[0]?.kind).toBe("reasoning_summary");
    expect(responses[0]?.text).toBe("check the config first");

    const chat = eventsOf(
      record({
        path: "/v1/chat/completions",
        request_body: {
          messages: [
            {
              role: "assistant",
              content: "ok",
              reasoning_content: "SECRET CHAIN OF THOUGHT",
              reasoning_summary: "Checked the loader, then the tests.",
            },
          ],
        },
      }),
    );
    expect(chat.map((event) => event.kind)).toEqual(["assistant_message", "reasoning_summary"]);
    expect(JSON.stringify(chat)).not.toContain("SECRET CHAIN OF THOUGHT");
    expect(chat[1]?.text).toBe("Checked the loader, then the tests.");
  });

  it("keeps plaintext reasoning content when Responses leaves summary empty", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [
            {
              type: "reasoning",
              summary: [],
              content: [{ type: "reasoning_text", text: "先检查配置，再验证测试。" }],
              encrypted_content: { opaque: "SECRET-ENCRYPTED-THINKING" },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        event_no: 1,
        kind: "reasoning_summary",
        text: "先检查配置，再验证测试。",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET-ENCRYPTED-THINKING");
  });
  it("says a reasoning item has no published summary rather than reading its hidden content", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [{ type: "reasoning", id: "rs_1", encrypted_content: "OPAQUE-BLOB" }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("other");
    expect(events[0]?.text).toBe("[思考内容没有公开摘要]");
    expect(JSON.stringify(events)).not.toContain("OPAQUE-BLOB");
  });

  it("keeps the top-level instructions as the first system event", () => {
    const events = eventsOf(
      record({
        request_body: {
          model: "gpt-5",
          instructions: "Be concise.",
          input: [{ type: "message", role: "user", content: "hi" }],
        },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["system_message", "user_message"]);
    expect(events[0]?.text).toBe("Be concise.");
  });

  it("sends only the identifying headers in the client block", () => {
    const input = prepareTaskTimelineInput(
      record({
        request_headers: {
          "user-agent": "pi (win32 10.0.26100; x64)",
          "X-Session-Id": "session-7",
          "content-type": "application/json",
          authorization: "Bearer secret",
          "x-claude-code-session-id": ["", "claude-session"],
        },
        request_body: { model: "gpt-5", messages: [{ role: "user", content: "newest turn" }] },
      }),
    );
    expect(input.client).toEqual({
      "user-agent": "pi (win32 10.0.26100; x64)",
      "x-session-id": "session-7",
      "x-claude-code-session-id": "claude-session",
    });
    expect(JSON.stringify(input)).not.toContain("Bearer secret");
    expect(JSON.stringify(input)).not.toContain("content-type");
  });

  it("says when it compressed the text it sent, and puts a marker at the end", () => {
    const input = prepareTaskTimelineInput(
      record({
        request_body: {
          messages: [{ role: "user", content: "x".repeat(4001) }],
        },
      }),
    );
    expect(input.source.truncated).toBe(true);
    expect(input.source.event_count).toBe(input.events.length);
    const last = input.events[input.events.length - 1];
    expect(last?.kind).toBe("truncation_marker");
    expect(last?.event_no).toBe(2);
    expect(input.events[0]?.text?.endsWith("…")).toBe(true);
    // The marker is itself an event the model may cite, so it is inside the count.
    expect(input.source.event_count).toBe(2);
  });

  it("does not claim truncation for a request that fits", () => {
    const input = prepareTaskTimelineInput(
      record({ request_body: { messages: [{ role: "user", content: "short" }] } }),
    );
    expect(input.source.truncated).toBe(false);
    expect(input.events.map((event) => event.kind)).toEqual(["user_message"]);
  });

  it("marks media fields as cut away and keeps the text next to them", () => {
    const input = prepareTaskTimelineInput(
      record({
        request_body: {
          messages: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "look" },
                { type: "input_image", image_url: "http://x/png" },
              ],
            },
          ],
        },
      }),
    );
    expect(input.events[0]?.text).toBe("look");
    expect(JSON.stringify(input.events)).not.toContain("http://x/png");
    expect(input.source.truncated).toBe(true);
  });

  it("carries the source block: sequence, api kind and event count", () => {
    const input = prepareTaskTimelineInput(
      record({
        sequence: 7,
        path: "/v1/responses",
        request_body: { input: [{ type: "message", role: "user", content: "one" }] },
      }),
    );
    expect(input.source).toEqual({
      request_sequence: 7,
      api_kind: "responses",
      event_count: 1,
      truncated: false,
    });
  });

  it("keeps a tool payload preview inside the length a preview may have", () => {
    const events = eventsOf(
      record({
        request_body: {
          input: [
            { type: "function_call", call_id: "c", name: "read", arguments: "p".repeat(2001) },
          ],
        },
      }),
    );
    expect(events[0]?.arguments_preview).toBe(`${"p".repeat(2000)}…`);
  });

  it("gives a request with no conversation one other event", () => {
    const events = eventsOf(
      record({ path: "/v1/completions", request_body: { prompt: "a plain prompt" } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("other");
    expect(events[0]?.text).toContain("a plain prompt");
  });

  it("reads a plain string input as one user message", () => {
    const events = eventsOf(record({ request_body: { input: "plain question" } }));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("user_message");
    expect(events[0]?.text).toBe("plain question");
  });
});

describe("text limit", () => {
  it("shortens a value's text form and marks the cut", () => {
    expect(truncateText("abc", 10)).toBe("abc");
    expect(truncateText("abcdef", 3)).toBe("abc…");
    expect(truncateText(null, 10)).toBe("");
    expect(truncateText(undefined, 10)).toBe("");
    expect(truncateText({ a: 1 }, 10)).toBe('{"a":1}');
    expect(truncateText({ a: "value" }, 5)).toBe('{"a":…');
  });
});
