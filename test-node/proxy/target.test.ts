import { describe, expect, it } from "vitest";

import { joinTargetPath, parseTargetUrl } from "../../src/proxy/target.js";

describe("parseTargetUrl", () => {
  it.each([
    [
      "http://example.com",
      {
        scheme: "http",
        host: "example.com",
        port: 80,
        basePath: "",
        displayUrl: "http://example.com",
      },
    ],
    [
      "HTTPS://Example.COM:8443/api/v1///",
      {
        scheme: "https",
        host: "example.com",
        port: 8443,
        basePath: "/api/v1",
        displayUrl: "HTTPS://Example.COM:8443/api/v1",
      },
    ],
    [
      "http://[::1]:1235/v1",
      {
        scheme: "http",
        host: "::1",
        port: 1235,
        basePath: "/v1",
        displayUrl: "http://[::1]:1235/v1",
      },
    ],
  ])("parses %s", (rawTargetUrl, expected) => {
    expect(parseTargetUrl(rawTargetUrl)).toEqual(expected);
  });

  it.each([
    "",
    "example.com/v1",
    "ftp://example.com/v1",
    "http:/example.com/v1",
    "http://",
    "http://example.com:65536/v1",
  ])("rejects invalid target URL %j", (rawTargetUrl) => {
    expect(() => parseTargetUrl(rawTargetUrl)).toThrow(
      "target_url must look like http://host[:port][/base-path] or https://host[:port][/base-path].",
    );
  });
});

describe("joinTargetPath", () => {
  it.each([
    ["/v1", "/chat/completions", "/v1/chat/completions"],
    ["/v1", "/v1/chat/completions", "/v1/chat/completions"],
    ["/v1", "/v1/models?limit=10", "/v1/models?limit=10"],
    ["/v1", "/v1?limit=10", "/v1?limit=10"],
    ["/v1", "/v1", "/v1"],
    ["/v1", "/v10/models", "/v1/v10/models"],
    ["/api/v1", "models", "/api/v1/models"],
    ["/api/v1", "?limit=10", "/api/v1/?limit=10"],
    ["/api/v1", "/", "/api/v1/"],
    ["", "/models?limit=10", "/models?limit=10"],
    ["", "models", "models"],
  ])("joins %j and %j as %j", (basePath, requestPath, expected) => {
    expect(joinTargetPath(basePath, requestPath)).toBe(expected);
  });
});
