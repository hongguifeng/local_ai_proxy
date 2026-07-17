import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { StructuredLogger, redactLogContext } from "../../src/shared/logger.js";

describe("StructuredLogger", () => {
  it("writes newline-delimited structured JSON and respects the minimum level", () => {
    const destination = new PassThrough();
    let output = "";
    destination.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const logger = new StructuredLogger({
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      destination,
      minimumLevel: "info",
      service: "fixture-service",
    });

    logger.debug("hidden", { value: 1 });
    logger.info("started", { pairId: "pair-1" });

    expect(output.trim()).not.toContain("hidden");
    expect(JSON.parse(output.trim())).toEqual({
      timestamp: "2026-01-02T03:04:05.000Z",
      level: "info",
      service: "fixture-service",
      message: "started",
      pairId: "pair-1",
    });
  });

  it("redacts sensitive headers, secrets, and body fields recursively", () => {
    const value = redactLogContext({
      authorization: "Bearer secret",
      nested: {
        api_key: "secret",
        body: { prompt: "private" },
        safe: "visible",
      },
      target_api_key: "secret",
      headers: [{ "X-API-Key": "secret" }],
    });

    expect(value).toEqual({
      authorization: "[redacted]",
      nested: { api_key: "[redacted]", body: "[redacted]", safe: "visible" },
      target_api_key: "[redacted]",
      headers: [{ "X-API-Key": "[redacted]" }],
    });
  });

  it("handles circular diagnostic context without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(redactLogContext(circular)).toEqual({ self: "[circular]" });
  });
});
