import { describe, expect, it } from "vitest";

import { Application } from "../../src/app/application.js";

describe("Application", () => {
  it("moves through the empty start and stop lifecycle", async () => {
    const application = new Application();

    expect(application.state).toBe("created");
    await application.start();
    expect(application.state).toBe("running");
    await application.stop();
    expect(application.state).toBe("stopped");
  });

  it("makes start and stop idempotent at stable states", async () => {
    const application = new Application();

    await application.start();
    await application.start();
    expect(application.state).toBe("running");

    await application.stop();
    await application.stop();
    expect(application.state).toBe("stopped");
  });
});
