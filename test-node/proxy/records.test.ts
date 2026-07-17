import { describe, expect, it } from "vitest";

import { displayEndpoint, endpointKind, requestMessageCount } from "../../src/proxy/records.js";

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
