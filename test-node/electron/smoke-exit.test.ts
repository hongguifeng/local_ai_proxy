import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installSmokeExitSignal } from "../../electron/smoke-exit.js";

describe("packaged smoke exit signal", () => {
  it("does nothing unless an exit file is configured", () => {
    const exit = vi.fn(() => Promise.resolve());
    installSmokeExitSignal(undefined, exit)();
    expect(exit).not.toHaveBeenCalled();
  });

  it("requests graceful shutdown when the exit file appears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-smoke-exit-"));
    const exitFile = path.join(root, "exit.signal");
    const exit = vi.fn(() => Promise.resolve());
    const stop = installSmokeExitSignal(exitFile, exit, 10);
    try {
      await writeFile(exitFile, "exit\n");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    } finally {
      stop();
      await rm(root, { recursive: true });
    }
  });
});
