import { describe, expect, it } from "vitest";

import {
  HOP_BY_HOP_HEADERS,
  headersToDictionary,
  parseHeaderOverrides,
} from "../../src/proxy/headers.js";

describe("HOP_BY_HOP_HEADERS", () => {
  it("matches the Python proxy hop-by-hop header set", () => {
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
  });
});

describe("parseHeaderOverrides", () => {
  it.each([undefined, null, []])("parses %j as no overrides", (rawHeaders) => {
    expect(parseHeaderOverrides(rawHeaders)).toEqual([]);
  });

  it("splits on the first colon and trims names and values", () => {
    expect(
      parseHeaderOverrides([
        " Authorization : Bearer fixture ",
        "X-Endpoint: https://provider.example:v1",
        "X-Empty:   ",
      ]),
    ).toEqual([
      ["Authorization", "Bearer fixture"],
      ["X-Endpoint", "https://provider.example:v1"],
      ["X-Empty", ""],
    ]);
  });

  it("rejects an override without a colon", () => {
    expect(() => parseHeaderOverrides(["missing-colon"])).toThrow(
      `Invalid header override "missing-colon". Expected 'Name: value'.`,
    );
  });

  it("rejects an empty header name", () => {
    expect(() => parseHeaderOverrides(["  : value"])).toThrow(
      'Invalid header override "  : value". Header name is empty.',
    );
  });
});

describe("headersToDictionary", () => {
  it("preserves repeated header values in arrival order", () => {
    expect(
      headersToDictionary([
        ["X-Repeated", "first"],
        ["Content-Type", "application/json"],
        ["X-Repeated", "second"],
        ["X-Repeated", "third,with,commas"],
      ]),
    ).toEqual({
      "X-Repeated": ["first", "second", "third,with,commas"],
      "Content-Type": ["application/json"],
    });
  });

  it("retains the source header name casing", () => {
    expect(
      headersToDictionary([
        ["X-Fixture", "upper"],
        ["x-fixture", "lower"],
      ]),
    ).toEqual({ "X-Fixture": ["upper"], "x-fixture": ["lower"] });
  });
});
