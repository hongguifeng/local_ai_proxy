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
});
