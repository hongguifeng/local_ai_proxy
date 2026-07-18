import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { showStartupError } from "../../electron/startup-error.js";

describe("showStartupError", () => {
  it("shows a readable system dialog for startup failures", () => {
    const dialog = { showErrorBox: vi.fn() };
    showStartupError(new Error("listen EADDRINUSE 127.0.0.1:8088"), dialog);

    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      "LLM Proxy failed to start",
      "Error: listen EADDRINUSE 127.0.0.1:8088",
    );
  });

  it("writes a diagnostic file for automated artifact smoke tests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-startup-error-"));
    try {
      const errorFile = path.join(root, "diagnostics", "startup.txt");
      showStartupError(
        new Error("fixture startup failure"),
        { showErrorBox: vi.fn() },
        {
          LLM_PROXY_STARTUP_ERROR_FILE: errorFile,
        },
      );
      await expect(readFile(errorFile, "utf8")).resolves.toBe("Error: fixture startup failure\n");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
