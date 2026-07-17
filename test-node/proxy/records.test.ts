import { describe, expect, it } from "vitest";

import {
  displayEndpoint,
  endpointKind,
  requestFingerprints,
  requestMessageCount,
  responseTokenCount,
  stableHash,
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

describe("stableHash", () => {
  it("matches Python's sorted compact UTF-8 SHA-256 output", () => {
    const value = { b: 2, a: [3, { z: true, y: "你" }] };

    expect(stableHash(value)).toBe("3db37498571f");
    expect(stableHash(value, 64)).toBe(
      "3db37498571f7a713893992636e345c97de0ec3c2135fad33fb2297c1686f86c",
    );
    expect(stableHash({ a: [3, { y: "你", z: true }], b: 2 })).toBe(stableHash(value));
  });

  it("sorts Unicode keys by code point like Python", () => {
    expect(stableHash({ "😀": "emoji", "": "private", a: 1 }, 64)).toBe(
      "540396678c4f5495919ca8ab4c9d661f9f27cc7f3630d209015eea62db96f58e",
    );
  });
});

describe("requestFingerprints chat", () => {
  it("matches Python fingerprints for Chat request boundaries and content", () => {
    expect(
      requestFingerprints("chat", {
        model: "demo",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "developer", content: [{ type: "text", text: "Use tools." }] },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "Next" },
        ],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
      }),
    ).toEqual({
      system: "6e4721b144fb",
      messages_prefix: "9bb75b481dea",
      messages: "4d81d3c1cbd5",
      first_user: "c25bf945aaff",
      tools: "91fec0c1af8c",
    });
  });

  it("falls back to legacy functions only when tools is absent", () => {
    const functions = [{ name: "legacy" }];
    expect(requestFingerprints("chat", { messages: [], functions })).toEqual({
      tools: stableHash(functions),
    });
    expect(requestFingerprints("chat", { messages: [], tools: null, functions })).toEqual({});
  });

  it("fingerprints Completions prompts", () => {
    expect(requestFingerprints("completions", { prompt: ["one", "two"] })).toEqual({
      prompt: "33688af4ac8c",
    });
  });
});

describe("requestFingerprints responses", () => {
  it("matches Python fingerprints for Responses input and function calls", () => {
    expect(
      requestFingerprints("responses", {
        instructions: "Follow policy",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Hello" }] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"x"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "result" },
        ],
        tools: [{ type: "function", name: "search" }],
      }),
    ).toEqual({
      instructions: "010232a64e9d",
      tools: "4eb42649f94f",
      first_user: "024650ad788f",
      input_prefix: "1fb1bcba2c12",
      input: "1fb1bcba2c12",
    });
  });

  it("normalizes scalar Responses input into the prefix list", () => {
    expect(requestFingerprints("responses", { input: "hello" })).toEqual({
      input_prefix: stableHash(["hello"]),
      input: stableHash("hello"),
    });
  });
});
