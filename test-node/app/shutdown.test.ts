import { describe, expect, it, vi } from "vitest";

import { ShutdownCoordinator } from "../../src/app/shutdown.js";

describe("ShutdownCoordinator", () => {
  it("runs tasks in reverse registration order and reuses one promise", async () => {
    const coordinator = new ShutdownCoordinator();
    const calls: string[] = [];
    coordinator.register("database", (reason) => {
      calls.push(`database:${reason}`);
    });
    coordinator.register("server", async (reason) => {
      await Promise.resolve();
      calls.push(`server:${reason}`);
    });

    const first = coordinator.shutdown("test");
    const second = coordinator.shutdown("ignored");

    expect(first).toBe(second);
    await first;
    expect(calls).toEqual(["server:test", "database:test"]);
    expect(coordinator.shuttingDown).toBe(true);
    expect(() => coordinator.register("late", vi.fn())).toThrow(/after shutdown started/u);
  });

  it("continues remaining tasks and aggregates shutdown failures", async () => {
    const coordinator = new ShutdownCoordinator();
    const completed = vi.fn();
    coordinator.register("completed", completed);
    coordinator.register("failed", () => {
      throw new Error("fixture failure");
    });

    await expect(coordinator.shutdown()).rejects.toBeInstanceOf(AggregateError);
    expect(completed).toHaveBeenCalledOnce();
  });

  it("allows a task to be unregistered before shutdown", async () => {
    const coordinator = new ShutdownCoordinator();
    const task = vi.fn();
    const unregister = coordinator.register("temporary", task);

    unregister();
    await coordinator.shutdown();

    expect(task).not.toHaveBeenCalled();
  });
});
