import { describe, expect, it } from "vitest";

import { InternalMetrics, serviceHealth } from "../src/observability.js";

const storage = {
  depth: 2,
  estimatedBytes: 10,
  committed: 3,
  failed: 1,
  dropped: 4,
  coalesced: 0,
  lastWaitMs: 2,
  maxWaitMs: 3,
  lastCommitMs: 4,
  maxCommitMs: 5,
};

describe("internal observability", () => {
  it("tracks bounded low-cardinality metrics without request IDs or paths", () => {
    const metrics = new InternalMetrics(() => storage, 1);
    metrics.requestStarted("proxy-1", "target-1");
    metrics.requestCompleted({
      proxyId: "proxy-1",
      targetId: "target-1",
      outcome: "timed_out",
      requestBytes: 12,
      responseBytes: 34,
      truncated: true,
    });
    metrics.requestStarted("proxy-2", "target-2");
    metrics.requestCompleted({ proxyId: "proxy-2", targetId: "target-2", outcome: "aborted" });
    expect(metrics.snapshot()).toEqual({
      requests: { active: 0, completed: 2, aborted: 1, timedOut: 1, failed: 0 },
      traffic: { requestBytes: 12, responseBytes: 34, truncated: 1 },
      storage,
      labels: { tracked: 1, overflowed: 2 },
    });
  });

  it("distinguishes live, ready and degraded", () => {
    const runtime = {
      status: "degraded" as const,
      storage: "degraded" as const,
      storageRestartAttempts: 1,
      proxies: { configured: 2, running: 1, failed: 0 },
    };
    expect(serviceHealth(runtime, true)).toMatchObject({ live: true, ready: true, degraded: true });
    expect(serviceHealth({ ...runtime, status: "failed" }, true)).toMatchObject({
      live: true,
      ready: false,
      degraded: false,
    });
  });
});
