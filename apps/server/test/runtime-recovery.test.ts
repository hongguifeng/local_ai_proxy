import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { installFatalHooks } from "../src/lifecycle.js";
import { RuntimeRecovery } from "../src/runtime/recovery.js";
import type { RuntimeStatus } from "../src/runtime/runtime-manager.js";

describe("RuntimeRecovery", () => {
  it("reports degraded immediately and recovers with bounded exponential backoff", async () => {
    const delays: number[] = [];
    const warnings: string[] = [];
    let restarts = 0;
    const recovery = new RuntimeRecovery({
      maxAttempts: 3,
      baseDelayMs: 10,
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
      restart: () => {
        restarts += 1;
        return restarts < 3 ? Promise.reject(new Error("still down")) : Promise.resolve();
      },
      onWarning: (code) => warnings.push(code),
    });
    const pending = recovery.storageCrashed();
    expect(recovery.health([])).toMatchObject({ status: "degraded", storage: "degraded" });
    await pending;
    expect(delays).toEqual([10, 20, 40]);
    expect(warnings).toEqual(["STORAGE_RESTARTING", "STORAGE_RESTARTING", "STORAGE_RESTARTING"]);
    expect(recovery.health([])).toMatchObject({ status: "ok", storage: "ok", storageRestartAttempts: 0 });
  });

  it("coalesces concurrent crash notifications and becomes failed after the finite budget", async () => {
    let restarts = 0;
    const warnings: string[] = [];
    const recovery = new RuntimeRecovery({
      maxAttempts: 2,
      baseDelayMs: 0,
      delay: () => Promise.resolve(),
      restart: () => {
        restarts += 1;
        return Promise.reject(new Error("down"));
      },
      onWarning: (code) => warnings.push(code),
    });
    await Promise.all([recovery.storageCrashed(), recovery.storageCrashed(), recovery.storageCrashed()]);
    expect(restarts).toBe(2);
    expect(warnings).toEqual(["STORAGE_RESTARTING", "STORAGE_RESTARTING", "STORAGE_RESTART_EXHAUSTED"]);
    expect(recovery.health([])).toMatchObject({ status: "failed", storage: "failed", storageRestartAttempts: 2 });
  });

  it("includes failed proxy state in health without exposing error details", () => {
    const recovery = new RuntimeRecovery({ restart: () => Promise.resolve() });
    const proxies = [runtime("running"), runtime("failed")];
    expect(recovery.health(proxies)).toEqual({
      status: "failed",
      storage: "ok",
      storageRestartAttempts: 0,
      proxies: { configured: 2, running: 1, failed: 1 },
    });
  });
});

describe("fatal process hooks", () => {
  it("aborts global shutdown once and removes both listeners", () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    let aborts = 0;
    controller.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    const remove = installFatalHooks(controller, source);
    source.emit("uncaughtException", new Error("fatal"));
    source.emit("unhandledRejection", new Error("fatal"));
    expect(controller.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
    remove();
    expect(source.listenerCount("uncaughtException")).toBe(0);
    expect(source.listenerCount("unhandledRejection")).toBe(0);
  });
});

function runtime(state: RuntimeStatus["state"]): RuntimeStatus {
  return {
    id: state,
    name: state,
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort: 1234,
    actualListenPort: state === "running" ? 1234 : null,
    state,
    errorCode: state === "failed" ? "SECRET_DETAIL" : null,
    errorAddress: null,
  };
}
