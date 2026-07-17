import { describe, expect, it } from "vitest";

import {
  applyTargetHeaderSettings,
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

describe("applyTargetHeaderSettings", () => {
  it("applies target overrides and then gives the API key final Authorization priority", () => {
    expect(
      applyTargetHeaderSettings(
        [
          ["Authorization", "Bearer client-value"],
          ["X-Override", "client-one"],
          ["x-override", "client-two"],
          ["X-Repeated", "first"],
          ["X-Repeated", "second"],
        ],
        [
          ["X-Override", "target-value"],
          ["Authorization", "Target header must lose to API key"],
        ],
        " fixture-api-key ",
      ),
    ).toEqual([
      ["X-Repeated", "first"],
      ["X-Repeated", "second"],
      ["X-Override", "target-value"],
      ["Authorization", "Bearer fixture-api-key"],
    ]);
  });

  it("preserves an already Bearer-prefixed API key", () => {
    expect(applyTargetHeaderSettings([], [], "bEaReR fixture-token")).toEqual([
      ["Authorization", "bEaReR fixture-token"],
    ]);
  });

  it("retains multiple configured values for the same override", () => {
    expect(
      applyTargetHeaderSettings(
        [["X-Repeated", "client"]],
        [
          ["X-Repeated", "target-one"],
          ["x-repeated", "target-two"],
        ],
        "",
      ),
    ).toEqual([
      ["X-Repeated", "target-one"],
      ["x-repeated", "target-two"],
    ]);
  });
});
