import { describe, expect, it } from "vitest";

import { prepareBriefInput, prepareSummaryInput } from "../../src/maintenance/summary-input.js";
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
 * is evidence rather than a guess.
 */

function record(overrides: Partial<RecordRow> = {}): Readonly<RecordRow> {
  return {
    id: "record-1",
    task_id: "task-1",
    request_headers: {},
    request_body: null,
    ...overrides,
  } as Readonly<RecordRow>;
}

describe("input preparation", () => {
  it("keeps the fields that carry the conversation and drops the rest", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      input: [{ type: "message", content: "responses item" }],
      instructions: "be brief",
      stream: true,
      temperature: 1,
      tools: [{ type: "function" }],
    });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["input", "instructions", "messages", "model"]);
    expect(parsed["model"]).toBe("gpt-5");
    expect(parsed["instructions"]).toBe("be brief");
  });

  it("summarizes the whole request when it carries no conversation", () => {
    const input = prepareSummaryInput({
      prompt: "x".repeat(4200),
      count: 3,
      nested: { a: [1, 2] },
    });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    expect(parsed["count"]).toBe(3);
    expect(parsed["nested"]).toEqual({ a: [1, 2] });
    expect(String(parsed["prompt"])).toHaveLength(4001);
    expect(String(parsed["prompt"]).endsWith("…")).toBe(true);
  });

  it("passes a request that is not an object through as it stands", () => {
    expect(prepareSummaryInput("a plain string")).toBe('"a plain string"');
    expect(prepareSummaryInput(null)).toBe("null");
  });

  it("shortens a long message and keeps the role", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      messages: [{ role: "user", content: "y".repeat(4001) }],
    });
    const parsed = JSON.parse(input) as { messages: { role: string; content: string }[] };
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.content).toHaveLength(4001);
    expect(parsed.messages[0]?.content.endsWith("…")).toBe(true);
  });

  it("keeps a responses tool item's identity and shortens its payload", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      input: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: "z".repeat(2001),
        },
        { type: "function_call_output", call_id: "call-1", output: ["a", "b"] },
        { role: "tool", tool_call_id: "call-2", content: "w".repeat(2001) },
      ],
    });
    const parsed = JSON.parse(input) as { input: Record<string, unknown>[] };
    expect(parsed.input[0]).toEqual({
      role: "unknown",
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: `${"z".repeat(2000)}…`,
    });
    expect(parsed.input[1]?.["output"]).toEqual(["a", "b"]);
    expect(String(parsed.input[2]?.["content"]).endsWith("…")).toBe(true);
  });

  it("keeps a chat tool call with its name and shortens its arguments", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "run", arguments: "q".repeat(2001) },
            },
          ],
        },
      ],
    });
    const parsed = JSON.parse(input) as {
      messages: {
        role: string;
        tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[];
      }[];
    };
    expect(parsed.messages[0]?.tool_calls[0]).toEqual({
      id: "call-1",
      type: "function",
      function: { name: "run", arguments: `${"q".repeat(2000)}…` },
    });
  });

  it("drops what a text model cannot read and stops at the depth limit", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: { text: "look", image_url: "http://x/png", file: { data: "base64" } },
        },
      ],
    });
    const parsed = JSON.parse(input) as { messages: { content: Record<string, unknown> }[] };
    expect(parsed.messages[0]?.content).toEqual({ text: "look" });

    const deep = prepareSummaryInput({
      model: "gpt-5",
      messages: [{ role: "user", content: { a: { b: { c: { d: "too deep" } } } } }],
    });
    // A string is kept however deep it is; only a nested object is cut away, and what
    // is cut away is named so the model knows the text is not the whole story.
    expect(deep).toContain("[内容已省略]");
    expect(deep).not.toContain("too deep");
  });

  it("bounds a nested array to its first thirty items", () => {
    const input = prepareSummaryInput({
      model: "gpt-5",
      notes: Array.from({ length: 40 }, (_unused, index) => `note ${index}`),
    });
    const parsed = JSON.parse(input) as { notes: unknown[] };
    expect(parsed.notes).toHaveLength(30);
    expect(parsed.notes[29]).toBe("note 29");
  });

  it("sends a brief the newest request plus only the identifying headers", () => {
    const input = prepareBriefInput(
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
    const parsed = JSON.parse(input) as { client: Record<string, string>; request: unknown };
    expect(parsed.client).toEqual({
      "user-agent": "pi (win32 10.0.26100; x64)",
      "x-session-id": "session-7",
      "x-claude-code-session-id": "claude-session",
    });
    expect(input).toContain("newest turn");
    expect(input).not.toContain("Bearer secret");
    expect(input).not.toContain("content-type");
    // The block order the brief model has always seen: client first, request second.
    expect(input.startsWith('{"client":')).toBe(true);
  });

  it("cuts a client hint to the length a brief value may have", () => {
    const input = prepareBriefInput(
      record({ request_headers: { "user-agent": "u".repeat(TASK_BRIEF_FACT_VALUE_LIMIT + 10) } }),
    );
    const parsed = JSON.parse(input) as { client: Record<string, string> };
    expect(parsed.client["user-agent"]).toBe(`${"u".repeat(TASK_BRIEF_FACT_VALUE_LIMIT)}…`);
    expect(input).toContain('"request":null');
  });

  it("sends an empty request for a record that was deleted between the reads", () => {
    expect(prepareBriefInput(undefined)).toBe('{"client":{},"request":null}');
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
