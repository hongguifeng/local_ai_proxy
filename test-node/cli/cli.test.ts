import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openBrowserLater, loadCliOptions, parseCliArgs } from "../../src/cli/index.js";

afterEach(() => vi.useRealTimers());

describe("parseCliArgs", () => {
  it("uses the loopback host by default", () => {
    expect(parseCliArgs([]).host).toBe("127.0.0.1");
  });

  it("parses --host", () => {
    expect(parseCliArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
  });

  it("parses and validates --port", () => {
    expect(parseCliArgs([]).port).toBe(18080);
    expect(parseCliArgs(["--port", "9090"]).port).toBe(9090);
    expect(() => parseCliArgs(["--port", "abc"])).toThrow("integer TCP port");
    expect(() => parseCliArgs(["--port", "65536"])).toThrow("between 1 and 65535");
  });

  it("parses --config-file", () => {
    expect(parseCliArgs([]).configFile).toBe("logs/proxies.json");
    expect(parseCliArgs(["--config-file", "state/pairs.json"]).configFile).toBe("state/pairs.json");
  });

  it("parses --log-root", () => {
    expect(parseCliArgs([]).logRoot).toBe("logs");
    expect(parseCliArgs(["--log-root", "state/history"]).logRoot).toBe("state/history");
  });

  it("parses --no-browser", () => {
    expect(parseCliArgs([]).noBrowser).toBe(false);
    expect(parseCliArgs(["--no-browser"]).noBrowser).toBe(true);
  });

  it("reads all supported environment variables", () => {
    expect(
      parseCliArgs([], {
        LLM_PROXY_UI_HOST: "::1",
        LLM_PROXY_UI_PORT: "8181",
        LLM_PROXY_CONFIG_FILE: "env/config.json",
        LLM_PROXY_LOG_ROOT: "env/logs",
        LLM_PROXY_NO_BROWSER: "1",
      }),
    ).toEqual({
      applicationConfigFile: "llm-proxy.json",
      host: "::1",
      port: 8181,
      configFile: "env/config.json",
      logRoot: "env/logs",
      noBrowser: true,
    });
  });

  it("loads the admin address from the application config file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-cli-config-"));
    try {
      await writeFile(
        path.join(directory, "custom.json"),
        JSON.stringify({ admin: { host: "127.0.0.2", port: 19090 } }),
        "utf8",
      );
      await expect(
        loadCliOptions(["--application-config", "custom.json"], {}, directory),
      ).resolves.toMatchObject({
        applicationConfigFile: path.join(directory, "custom.json"),
        host: "127.0.0.2",
        port: 19090,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates a default application config in the selected data directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-cli-default-"));
    try {
      await expect(loadCliOptions([], {}, directory)).resolves.toMatchObject({ port: 18080 });
      await expect(
        readFile(path.join(directory, "llm-proxy.json"), "utf8").then(JSON.parse),
      ).resolves.toEqual({ admin: { host: "127.0.0.1", port: 18080 } });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("lets command-line options override environment variables", () => {
    expect(
      parseCliArgs(["--host", "127.0.0.2", "--port", "8282", "--config-file", "cli.json"], {
        LLM_PROXY_UI_HOST: "::1",
        LLM_PROXY_UI_PORT: "8181",
        LLM_PROXY_CONFIG_FILE: "env.json",
      }),
    ).toMatchObject({ host: "127.0.0.2", port: 8282, configFile: "cli.json" });
  });

  it("rejects a missing host", () => {
    expect(() => parseCliArgs(["--host"])).toThrow("Option --host requires a value.");
  });
});

describe("openBrowserLater", () => {
  it("waits before opening the admin URL", () => {
    vi.useFakeTimers();
    const launch = vi.fn();
    openBrowserLater("http://127.0.0.1:8088", 500, launch);

    expect(launch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(launch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(launch).toHaveBeenCalledWith("http://127.0.0.1:8088");
  });
});
