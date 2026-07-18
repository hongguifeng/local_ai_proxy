import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { Application } from "../../src/app/index.js";
import { installShutdownSignals } from "../../src/cli/index.js";

describe("installShutdownSignals", () => {
  it("stops once and removes both signal listeners", async () => {
    const events = new EventEmitter();
    const stop = vi.fn();
    const application = new Application({ stop });
    await application.start();
    installShutdownSignals(application, events);

    events.emit("SIGTERM");
    events.emit("SIGINT");
    await vi.waitFor(() => expect(application.state).toBe("stopped"));

    expect(stop).toHaveBeenCalledOnce();
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
  });
});
