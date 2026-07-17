import { describe, expect, it } from "vitest";

import {
  displayEndpoint,
  endpointKind,
  requestMessageCount,
  responseTokenCount,
} from "../../src/proxy/records.js";

describe("endpointKind", () => {
  it.each([
    ["/responses", "responses"],
    ["/v1/responses/?stream=true", "responses"],
    ["/V1/MESSAGES", "messages"],
    ["/api/v1/chat/completions/", "chat"],
    ["/v1/completions?model=demo", "completions"],
    ["/v1/models", "other"],
    ["/v1/chat/completions-extra", "other"],
  ])("classifies %s as %s", (path, expected) => {
    expect(endpointKind(path)).toBe(expected);
  });
});

describe("displayEndpoint", () => {
  it.each([
    ["/v1/responses?foo=bar/", "/v1/responses"],
    ["/v1/messages///", "/v1/messages"],
    ["/", "/"],
    ["", "/"],
    [null, "/"],
  ])("normalizes %j as %s", (path, expected) => {
    expect(displayEndpoint(path)).toBe(expected);
  });
});

describe("requestMessageCount responses", () => {
  it.each([
    [{ instructions: "system", input: [{ role: "user" }, { type: "function_call" }] }, 3],
    [{ input: "single prompt" }, 1],
    [{ input: null }, 0],
    [{ instructions: "", input: [] }, 0],
    [{ instructions: [], input: [] }, 0],
    [{ instructions: {}, input: [] }, 0],
  ])("counts %# as %i messages", (payload, expected) => {
    expect(requestMessageCount("responses", payload)).toBe(expected);
  });

  it("returns undefined for a non-object payload", () => {
    expect(requestMessageCount("responses", [])).toBeUndefined();
  });
});

describe("requestMessageCount messages", () => {
  it.each([
    [
      {
        system: [{ text: "system" }, { text: "developer" }],
        messages: [{ role: "user" }, { role: "assistant" }],
      },
      4,
    ],
    [{ system: "system prompt", messages: [{ role: "user" }] }, 2],
    [{ system: "", messages: [] }, 0],
    [{ system: {}, messages: "not-an-array" }, 0],
  ])("counts %# as %i messages", (payload, expected) => {
    expect(requestMessageCount("messages", payload)).toBe(expected);
  });
});

describe("requestMessageCount chat and completions", () => {
  it("counts Chat Completions messages", () => {
    expect(
      requestMessageCount("chat", {
        messages: [{ role: "system" }, { role: "user" }, { role: "assistant" }],
      }),
    ).toBe(3);
    expect(requestMessageCount("chat", { messages: "invalid" })).toBe(0);
  });

  it.each([
    [{ prompt: ["first", "second"] }, 2],
    [{ prompt: "one prompt" }, 1],
    [{ prompt: false }, 1],
    [{ prompt: null }, 0],
    [{}, 0],
  ])("counts Completions payload %# as %i", (payload, expected) => {
    expect(requestMessageCount("completions", payload)).toBe(expected);
  });

  it("uses messages and input as the generic fallback", () => {
    expect(requestMessageCount("other", { messages: [1, 2] })).toBe(2);
    expect(requestMessageCount("other", { input: [1, 2, 3] })).toBe(3);
    expect(requestMessageCount("other", { input: "single" })).toBe(1);
    expect(requestMessageCount("other", {})).toBeUndefined();
  });
});

describe("responseTokenCount", () => {
  it.each([
    [{ usage: { total_tokens: 9 } }, 9],
    [{ usage: { total_tokens: 9.0 } }, 9],
    [{ stream_summary: { usage: { input_tokens: 3, output_tokens: 2 } } }, 5],
    [{ response: { usage: { input_tokens: 4 } } }, 4],
    [
      {
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
      17,
    ],
    [{ usage: { input_tokens: 0 } }, 0],
  ])("reads %# as %i tokens", (payload, expected) => {
    expect(responseTokenCount(payload)).toBe(expected);
  });

  it("uses stream usage before top-level and nested response usage", () => {
    expect(
      responseTokenCount({
        stream_summary: { usage: { total_tokens: 1 } },
        usage: { total_tokens: 2 },
        response: { usage: { total_tokens: 3 } },
      }),
    ).toBe(1);
  });

  it.each([
    { ok: true },
    { usage: {} },
    { usage: { total_tokens: "9" } },
    { usage: { input_tokens: true, output_tokens: 1.5 } },
    null,
  ])("returns undefined for unsupported usage %#", (payload) => {
    expect(responseTokenCount(payload)).toBeUndefined();
  });
});
