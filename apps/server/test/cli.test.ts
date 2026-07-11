import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ExitCode, parseCliArgs, VERSION } from "../src/cli-options.js";
import { createScaffoldRuntime, waitForAbort, type ApplicationRuntime, type SignalSource } from "../src/lifecycle.js";
import { createDefaultDependencies, main, type MainDependencies } from "../src/main.js";

function dependencies(runtime: ApplicationRuntime): {
  dependencies: MainDependencies;
  stdout: string[];
  stderr: string[];
  signals: EventEmitter;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const signals = new EventEmitter();
  return {
    dependencies: {
      createRuntime: () => runtime,
      environment: {},
      signalSource: signals as SignalSource,
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
      openBrowser: vi.fn(() => Promise.resolve()),
    },
    stdout,
    stderr,
    signals,
  };
}

function resolvedRuntime(overrides: Partial<ApplicationRuntime> = {}): ApplicationRuntime {
  return {
    start: vi.fn(() => Promise.resolve()),
    wait: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("CLI options", () => {
  it("parses defaults and environment overrides", () => {
    const action = parseCliArgs([], { LLM_PROXY_UI_PORT: "9090", LLM_PROXY_NO_BROWSER: "1" });
    expect(action).toEqual({
      kind: "run",
      options: {
        host: "127.0.0.1",
        port: 9090,
        configFile: "logs/proxies.json",
        logRoot: "logs",
        noBrowser: true,
        allowRemoteAdmin: false,
        adminToken: undefined,
      },
    });
  });

  it("requires an explicit flag and token for remote admin", () => {
    expect(() => parseCliArgs(["--host", "0.0.0.0"])).toThrow("--allow-remote-admin");
    expect(() => parseCliArgs(["--host", "0.0.0.0", "--allow-remote-admin"])).toThrow("--admin-token");
    expect(parseCliArgs(["--host", "0.0.0.0", "--allow-remote-admin", "--admin-token", "secret"]).kind).toBe("run");
  });

  it("rejects unknown arguments, empty hosts, and invalid ports", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow();
    expect(() => parseCliArgs(["--host", " "])).toThrow("--host");
    expect(() => parseCliArgs(["--port", "70000"])).toThrow("--port");
  });
});

describe("main composition root", () => {
  it("handles help and version without creating a runtime", async () => {
    const runtime = resolvedRuntime();
    const help = dependencies(runtime);
    const version = dependencies(runtime);

    await expect(main(["--help"], help.dependencies)).resolves.toBe(ExitCode.success);
    await expect(main(["--version"], version.dependencies)).resolves.toBe(ExitCode.success);
    expect(help.stdout[0]).toContain("Usage: llm-proxy");
    expect(version.stdout).toEqual([VERSION]);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("returns a usage exit code and machine-readable error", async () => {
    const context = dependencies(resolvedRuntime());
    await expect(main(["--port", "invalid"], context.dependencies)).resolves.toBe(ExitCode.usageError);
    expect(JSON.parse(context.stderr[0] ?? "{}")).toMatchObject({ event: "error", code: "USAGE_ERROR" });
  });

  it("starts, emits a secret-free ready event, waits, and stops", async () => {
    const runtime = resolvedRuntime();
    const context = dependencies(runtime);
    await expect(
      main(["--admin-token", "do-not-log", "--config-file", "config.json"], context.dependencies),
    ).resolves.toBe(ExitCode.success);

    expect(JSON.parse(context.stdout[0] ?? "{}")).toMatchObject({ event: "ready", configFile: "config.json" });
    expect(context.stdout.join("\n")).not.toContain("do-not-log");
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.wait).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("opens the browser only after ready, supports --no-browser, and isolates open failures", async () => {
    const runtime = resolvedRuntime();
    const opened = dependencies(runtime);
    await expect(main([], opened.dependencies)).resolves.toBe(ExitCode.success);
    expect(opened.dependencies.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:8088/");

    const disabled = dependencies(runtime);
    await expect(main(["--no-browser"], disabled.dependencies)).resolves.toBe(ExitCode.success);
    expect(disabled.dependencies.openBrowser).not.toHaveBeenCalled();

    const failed = dependencies(runtime);
    await expect(
      main([], {
        ...failed.dependencies,
        openBrowser: vi.fn(() => Promise.reject(new Error("private browser failure"))),
      }),
    ).resolves.toBe(ExitCode.success);
    expect(JSON.parse(failed.stderr[0] ?? "{}")).toMatchObject({ code: "BROWSER_OPEN_FAILED" });
    expect(failed.stderr.join("\n")).not.toContain("private browser failure");
  });

  it("maps startup/runtime errors and still attempts shutdown", async () => {
    const startup = resolvedRuntime({ start: vi.fn(() => Promise.reject(new Error("secret detail"))) });
    const startupContext = dependencies(startup);
    await expect(main([], startupContext.dependencies)).resolves.toBe(ExitCode.runtimeError);
    expect(JSON.parse(startupContext.stderr[0] ?? "{}")).toMatchObject({ code: "STARTUP_ERROR" });
    expect(startupContext.stderr.join("\n")).not.toContain("secret detail");

    const runtime = resolvedRuntime({ wait: vi.fn(() => Promise.reject(new Error("failed"))) });
    const runtimeContext = dependencies(runtime);
    await expect(main([], runtimeContext.dependencies)).resolves.toBe(ExitCode.runtimeError);
    expect(JSON.parse(runtimeContext.stderr[0] ?? "{}")).toMatchObject({ code: "RUNTIME_ERROR" });
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("logs a stable shutdown error without changing the successful runtime result", async () => {
    const runtime = resolvedRuntime({ stop: vi.fn(() => Promise.reject(new Error("private shutdown detail"))) });
    const context = dependencies(runtime);
    await expect(main([], context.dependencies)).resolves.toBe(ExitCode.success);
    expect(JSON.parse(context.stderr[0] ?? "{}")).toMatchObject({ code: "SHUTDOWN_ERROR" });
    expect(context.stderr.join("\n")).not.toContain("private shutdown detail");
  });

  it("propagates a shutdown signal through AbortSignal", async () => {
    const runtime = resolvedRuntime({ wait: vi.fn(waitForAbort) });
    const context = dependencies(runtime);
    const result = main([], context.dependencies);
    await vi.waitFor(() => {
      expect(runtime.wait).toHaveBeenCalledOnce();
    });
    context.signals.emit("SIGTERM");
    await expect(result).resolves.toBe(ExitCode.success);
  });
});

describe("scaffold lifecycle", () => {
  it("constructs default dependencies without starting work on import", async () => {
    const action = parseCliArgs([]);
    if (action.kind !== "run") {
      throw new Error("Expected run options");
    }
    const runtime = createScaffoldRuntime(action.options);
    await expect(runtime.start(new AbortController().signal)).resolves.toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(runtime.wait(aborted.signal)).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(createDefaultDependencies().createRuntime).toBe(createScaffoldRuntime);
    await expect(import("../src/cli.js")).resolves.toBeDefined();
  });

  it("returns immediately when waiting on an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAbort(controller.signal)).resolves.toBeUndefined();
  });
});
