import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { startHeadlessElectronMain } from "../../electron/headless-main.js";

describe("startHeadlessElectronMain", () => {
  it("does not block ESM evaluation while waiting for Electron readiness", async () => {
    const source = await readFile(new URL("../../electron/index.ts", import.meta.url), "utf8");
    expect(source).toContain("void start().catch");
    expect(source).not.toContain("await start();");
  });

  it("waits for readiness without creating a visible window", async () => {
    const on = vi.fn();
    const whenReady = vi.fn(() => Promise.resolve());

    await startHeadlessElectronMain({ on, whenReady });

    expect(whenReady).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("window-all-closed", expect.any(Function));
  });
});
