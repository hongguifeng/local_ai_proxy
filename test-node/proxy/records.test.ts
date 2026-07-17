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
