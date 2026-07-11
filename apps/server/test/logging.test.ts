import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createRuntimeLogger, RateLimitedLogger } from "../src/logging.js";

describe("runtime logging", () => {
  it("emits stable JSON and redacts configured secrets", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createRuntimeLogger({ stream });
    logger
      .child({ requestId: "request-1", proxyId: "proxy-1", targetId: "target-1" })
      .info(
        { event: "request_completed", authorization: "Bearer secret", apiKey: "secret", outcome: "finished" },
        "done",
      );
    const entry = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: "request_completed",
      requestId: "request-1",
      proxyId: "proxy-1",
      targetId: "target-1",
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
      outcome: "finished",
    });
    expect(lines.join("")).not.toContain("Bearer secret");
  });

  it("rate limits repeated component faults by code", () => {
    const warn = vi.fn();
    let now = 1_000;
    const logger = new RateLimitedLogger({ warn } as never, 100, () => now);
    expect(logger.warn("QUEUE_FULL", { depth: 10 }, "full")).toBe(true);
    expect(logger.warn("QUEUE_FULL", { depth: 11 }, "full")).toBe(false);
    now += 100;
    expect(logger.warn("QUEUE_FULL", { depth: 12 }, "full")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
