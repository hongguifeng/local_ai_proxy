import { describe, expect, it, vi } from "vitest";

import { Application } from "../../src/app/index.js";
import { formatStartupError, runCli, type CliOptions } from "../../src/cli/index.js";

const options: CliOptions = {
  configFile: "state/proxies.json",
  host: "127.0.0.1",
  logRoot: "state/logs",
  noBrowser: false,
  port: 8088,
};

describe("runCli", () => {
  it("prints resolved paths and opens the bound admin address", async () => {
    const output = { write: vi.fn() };
    const openBrowser = vi.fn();
    const registerSignals = vi.fn();
    const application = new Application();
    await runCli(options, {
      cwd: "/workspace",
      output,
      openBrowser,
      registerSignals,
      createApplication: () => ({
        application,
        address: () => ({ host: "127.0.0.1", port: 9090 }),
      }),
    });

    expect(output.write.mock.calls.flat().join("")).toContain(
      "Proxy config: /workspace/state/proxies.json",
    );
    expect(output.write.mock.calls.flat().join("")).toContain(
      "Logs directory: /workspace/state/logs",
    );
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:9090");
    expect(registerSignals).toHaveBeenCalledWith(application);
    await application.stop();
  });

  it("does not open a browser in no-browser mode", async () => {
    const openBrowser = vi.fn();
    const application = new Application();
    await runCli(
      { ...options, noBrowser: true },
      {
        output: { write: vi.fn() },
        openBrowser,
        registerSignals: vi.fn(),
        createApplication: () => ({ application, address: () => undefined }),
      },
    );
    expect(openBrowser).not.toHaveBeenCalled();
    await application.stop();
  });
});

describe("formatStartupError", () => {
  it("formats nested and aggregate startup errors without a stack dump", () => {
    const nested = new Error("listen failed", { cause: new Error("EADDRINUSE 127.0.0.1:8088") });
    expect(formatStartupError(new AggregateError([nested], "Startup failed."))).toBe(
      "Startup failed. Error: listen failed Error: EADDRINUSE 127.0.0.1:8088",
    );
  });
});
