import { describe, expect, it, vi } from "vitest";

import { Application } from "../../src/app/index.js";
import { shutdownAndQuit } from "../../electron/exit.js";

describe("shutdownAndQuit", () => {
  it("waits for application shutdown before quitting Electron", async () => {
    const order: string[] = [];
    const application = new Application({
      stop: async () => {
        await Promise.resolve();
        order.push("stopped");
      },
    });
    await application.start();
    const electron = { quit: vi.fn(() => order.push("quit")) };

    await shutdownAndQuit(application, electron);

    expect(order).toEqual(["stopped", "quit"]);
    expect(application.state).toBe("stopped");
  });
});
