import { describe, expect, it } from "vitest";

import { ProxyRuntimeStateMachine } from "../../src/proxy/index.js";

describe("ProxyRuntimeStateMachine", () => {
  it("moves through start and stop states with a public snapshot", () => {
    const runtime = new ProxyRuntimeStateMachine();
    expect(runtime.snapshot).toEqual({
      state: "stopped",
      running: false,
      actualListenPort: null,
      error: undefined,
    });

    runtime.beginStart();
    expect(runtime.snapshot.state).toBe("starting");
    runtime.markRunning(43123);
    expect(runtime.snapshot).toMatchObject({
      state: "running",
      running: true,
      actualListenPort: 43123,
    });
    runtime.beginStop();
    expect(runtime.snapshot.state).toBe("stopping");
    runtime.markStopped();
    expect(runtime.snapshot).toMatchObject({
      state: "stopped",
      running: false,
      actualListenPort: null,
    });
  });

  it("records start and stop failures and allows recovery", () => {
    const runtime = new ProxyRuntimeStateMachine();
    runtime.beginStart();
    runtime.markStartFailed("bind failed");
    expect(runtime.snapshot).toMatchObject({
      state: "failed",
      running: false,
      error: { message: "bind failed" },
    });

    runtime.beginStart();
    runtime.markRunning(1234);
    runtime.beginStop();
    runtime.markStopFailed(new Error("close failed"));
    expect(runtime.snapshot).toMatchObject({
      state: "failed",
      actualListenPort: null,
      error: { message: "close failed" },
    });
  });

  it("rejects invalid transitions and ports", () => {
    const runtime = new ProxyRuntimeStateMachine();
    expect(() => runtime.markRunning(1234)).toThrow("from stopped to running");
    runtime.beginStart();
    expect(() => runtime.markRunning(0)).toThrow(RangeError);
    expect(() => runtime.beginStop()).toThrow("from starting to stopping");
  });
});
