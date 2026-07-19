import { describe, expect, it, vi } from "vitest";

import { configureSingleInstance } from "../../electron/single-instance.js";

describe("configureSingleInstance", () => {
  it("quits a repeated instance before it can bind ports", () => {
    const quit = vi.fn();
    const app = {
      on: vi.fn(),
      quit,
      requestSingleInstanceLock: vi.fn(() => false),
    };

    expect(configureSingleInstance(app, vi.fn())).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
  });

  it("activates the existing instance when another launch is attempted", () => {
    let secondInstance: (() => void) | undefined;
    const activate = vi.fn();
    const app = {
      on: vi.fn((_event: "second-instance", listener: () => void) => {
        secondInstance = listener;
      }),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
    };

    expect(configureSingleInstance(app, activate)).toBe(true);
    secondInstance?.();
    expect(activate).toHaveBeenCalledOnce();
  });
});
