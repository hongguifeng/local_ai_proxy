import { describe, expect, it, vi } from "vitest";

import { startHeadlessElectronMain } from "../../electron/headless-main.js";

describe("startHeadlessElectronMain", () => {
  it("waits for readiness without creating a visible window", async () => {
    const on = vi.fn();
    const whenReady = vi.fn(() => Promise.resolve());

    await startHeadlessElectronMain({ on, whenReady });

    expect(whenReady).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("window-all-closed", expect.any(Function));
  });
});
