import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { RuntimeTargetEndpoint } from "../src/config/schema.js";
import {
  assertValidHeaderPairs,
  buildUpstreamRequestHeaders,
  rawHeadersToPairs,
  removeHopByHopHeaders,
  type HeaderPair,
} from "../src/proxy/headers.js";
import { joinTargetPath, targetHostHeader } from "../src/proxy/target-url.js";

const endpoint: RuntimeTargetEndpoint = {
  protocol: "https:",
  hostname: "api.example.com",
  port: 443,
  origin: "https://api.example.com",
  basePath: "/v1",
};

type ProxyFixture = Readonly<{
  pathJoin: readonly Readonly<{ basePath: string; requestPath: string; expected: string }>[];
}>;

function isProxyFixture(value: unknown): value is ProxyFixture {
  if (!value || typeof value !== "object" || !("pathJoin" in value) || !Array.isArray(value.pathJoin)) {
    return false;
  }
  const pathJoin: unknown[] = value.pathJoin;
  return pathJoin.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      "basePath" in item &&
      typeof item.basePath === "string" &&
      "requestPath" in item &&
      typeof item.requestPath === "string" &&
      "expected" in item &&
      typeof item.expected === "string",
  );
}

describe("target URL domain logic", () => {
  it("matches every language-neutral path fixture", async () => {
    const input: unknown = JSON.parse(
      await readFile(new URL("../../../packages/test-fixtures/proxy/cases.json", import.meta.url), "utf8"),
    );
    if (!isProxyFixture(input)) {
      throw new TypeError("Invalid proxy fixture");
    }
    for (const fixture of input.pathJoin) {
      expect(joinTargetPath(fixture.basePath, fixture.requestPath)).toBe(fixture.expected);
    }
  });

  it("preserves query bytes and rejects unsupported request-target forms", () => {
    expect(joinTargetPath("/v1", "/models?name=a%2Fb&empty=")).toBe("/v1/models?name=a%2Fb&empty=");
    expect(joinTargetPath("/v1", "/v1?x=1")).toBe("/v1?x=1");
    expect(() => joinTargetPath("/v1", "http://evil.example/path")).toThrow("Absolute-form");
    expect(() => joinTargetPath("/v1", "/path#fragment")).toThrow("fragments");
  });

  it("formats default, non-default, and IPv6 Host headers", () => {
    expect(targetHostHeader(endpoint)).toBe("api.example.com");
    expect(targetHostHeader({ ...endpoint, port: 8443 })).toBe("api.example.com:8443");
    expect(targetHostHeader({ ...endpoint, hostname: "2001:db8::1" })).toBe("[2001:db8::1]");
  });
});

describe("header forwarding domain logic", () => {
  it("removes fixed and Connection-nominated hop-by-hop headers", () => {
    const headers: HeaderPair[] = [
      ["Connection", "keep-alive, X-Remove"],
      ["Keep-Alive", "timeout=5"],
      ["X-Remove", "private"],
      ["Transfer-Encoding", "chunked"],
      ["X-Keep", "one"],
      ["X-Keep", "two"],
    ];
    expect(removeHopByHopHeaders(headers)).toEqual([
      ["X-Keep", "one"],
      ["X-Keep", "two"],
    ]);
  });

  it("rebuilds forwarding headers and applies target/API key precedence", () => {
    const result = buildUpstreamRequestHeaders(
      [
        ["Host", "client.example:1234"],
        ["Authorization", "Bearer client"],
        ["X-Forwarded-For", "spoofed"],
        ["X-Forwarded-Proto", "https"],
        ["X-Multi", "one"],
        ["X-Multi", "two"],
      ],
      endpoint,
      { remoteAddress: "127.0.0.1", incomingProtocol: "http" },
      [
        ["X-Multi", "override-one"],
        ["X-Multi", "override-two"],
        ["Authorization", "Bearer configured-header"],
      ],
      "upstream-secret",
    );
    expect(result).toEqual([
      ["Host", "api.example.com"],
      ["X-Forwarded-For", "127.0.0.1"],
      ["X-Forwarded-Host", "client.example:1234"],
      ["X-Forwarded-Proto", "http"],
      ["X-Multi", "override-one"],
      ["X-Multi", "override-two"],
      ["Authorization", "Bearer upstream-secret"],
    ]);
  });

  it("preserves ordered repeated response headers", () => {
    const raw = ["Set-Cookie", "a=1", "Set-Cookie", "b=2", "X-Test", "one"];
    expect(removeHopByHopHeaders(rawHeadersToPairs(raw))).toEqual([
      ["Set-Cookie", "a=1"],
      ["Set-Cookie", "b=2"],
      ["X-Test", "one"],
    ]);
    expect(() => rawHeadersToPairs(["X-Odd"])).toThrow("name/value pairs");
  });

  it("uses Node header validation to reject injection and invalid names", () => {
    expect(() => {
      assertValidHeaderPairs([["X-Test", "safe\r\ninjected: true"]]);
    }).toThrow();
    expect(() => {
      assertValidHeaderPairs([["Bad Header", "value"]]);
    }).toThrow();
    expect(() =>
      buildUpstreamRequestHeaders(
        [],
        endpoint,
        { remoteAddress: "::1", incomingProtocol: "https" },
        [["X-Test", "bad\nvalue"]],
        "",
      ),
    ).toThrow();
  });
});
