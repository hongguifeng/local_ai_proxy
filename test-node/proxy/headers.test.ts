import { describe, expect, it } from "vitest";

import {
  applyTargetHeaderSettings,
  buildForwardHeaders,
  HOP_BY_HOP_HEADERS,
  headersToDictionary,
  parseHeaderOverrides,
  replaceContentLength,
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

describe("buildForwardHeaders", () => {
  it("filters connection headers and adds upstream Host and X-Forwarded headers", () => {
    expect(
      buildForwardHeaders(
        [
          ["Host", "client.example:9000"],
          ["Connection", "keep-alive"],
          ["Transfer-Encoding", "chunked"],
          ["Content-Type", "application/json"],
          ["X-Repeated", "first"],
          ["X-Repeated", "second"],
        ],
        {
          clientHost: "127.0.0.1",
          targetApiKey: "",
          targetHeaders: [],
          targetHost: "provider.example",
          targetPort: 8443,
          targetScheme: "https",
        },
      ),
    ).toEqual([
      ["Content-Type", "application/json"],
      ["X-Repeated", "first"],
      ["X-Repeated", "second"],
      ["Host", "provider.example:8443"],
      ["X-Forwarded-For", "127.0.0.1"],
      ["X-Forwarded-Host", "client.example:9000"],
    ]);
  });

  it.each([
    ["http", "example.com", 80, "example.com"],
    ["https", "example.com", 443, "example.com"],
    ["http", "::1", 1235, "[::1]:1235"],
    ["https", "::1", 443, "[::1]"],
  ] as const)(
    "formats an %s upstream Host",
    (targetScheme, targetHost, targetPort, expectedHost) => {
      const headers = buildForwardHeaders([], {
        clientHost: "client",
        targetApiKey: "",
        targetHeaders: [],
        targetHost,
        targetPort,
        targetScheme,
      });

      expect(headers.find(([name]) => name === "Host")?.[1]).toBe(expectedHost);
      expect(headers.find(([name]) => name === "X-Forwarded-Host")?.[1]).toBe("");
    },
  );
});

describe("replaceContentLength", () => {
  it("replaces the client length with the transformed byte length", () => {
    const transformedBody = Buffer.from('{"input":"你好","stream":true}', "utf8");
    expect(
      replaceContentLength(
        [
          ["content-length", "999"],
          ["Content-Type", "application/json"],
        ],
        transformedBody.byteLength,
      ),
    ).toEqual([
      ["Content-Type", "application/json"],
      ["Content-Length", String(transformedBody.byteLength)],
    ]);
  });

  it("preserves an explicit zero length only when requested", () => {
    expect(replaceContentLength([["Content-Length", "1"]], 0)).toEqual([]);
    expect(replaceContentLength([["Content-Length", "1"]], 0, true)).toEqual([
      ["Content-Length", "0"],
    ]);
  });
});
