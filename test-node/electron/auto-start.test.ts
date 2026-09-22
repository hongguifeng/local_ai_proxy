import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createAutoStartController, readAutoStartState } from "../../electron/auto-start.js";

function makeApp(overrides: { isPackaged?: boolean; openAtLogin?: boolean } = {}) {
  let openAtLogin = overrides.openAtLogin ?? false;
  const setLoginItemSettings = vi.fn((options: { openAtLogin: boolean }) => {
    openAtLogin = options.openAtLogin;
  });
  return {
    setLoginItemSettings,
    isPackaged: overrides.isPackaged ?? true,
    getAppPath: () => "C:/Program Files/LLM Proxy/LLM Proxy.exe",
    getLoginItemSettings: () => ({ openAtLogin }),
  };
}

async function withTempDirectory<T>(run: (dataDirectory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-auto-start-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("createAutoStartController", () => {
  it("restores the persisted choice and applies it to the login item on start", async () => {
    await withTempDirectory(async (dataDirectory) => {
      const app = makeApp();
      const controller = await createAutoStartController({
        app,
        environment: {},
        dataDirectory,
      });
      expect(controller.state.autoStart).toBe(false);

      await controller.toggle();
      expect(controller.state.autoStart).toBe(true);
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
      const configPath = path.join(dataDirectory, "auto-start.json");
      expect(await readFile(configPath, "utf8")).toContain('"autoStart": true');

      const reloaded = await createAutoStartController({
        app: makeApp(),
        environment: {},
        dataDirectory,
      });
      expect(reloaded.state.autoStart).toBe(true);
      expect(reloaded.state).toEqual({ autoStart: true });
      await reloaded.toggle();
      expect(reloaded.state.autoStart).toBe(false);
    });
  });

  it("skips the registry for the portable executable and reports disabled", async () => {
    await withTempDirectory(async (dataDirectory) => {
      const app = makeApp();
      const controller = await createAutoStartController({
        app,
        environment: { PORTABLE_EXECUTABLE_DIR: "D:/Portable Program/llm-proxy" },
        dataDirectory,
      });
      expect(controller.state.autoStart).toBe(false);

      await controller.toggle();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
      expect(controller.state.autoStart).toBe(false);
    });
  });

  it("does not touch the registry in dev mode and tracks the requested state", async () => {
    await withTempDirectory(async (dataDirectory) => {
      const app = makeApp({ isPackaged: false });
      const controller = await createAutoStartController({
        app,
        environment: {},
        dataDirectory,
      });
      expect(controller.state.autoStart).toBe(false);

      await controller.toggle();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(controller.state.autoStart).toBe(true);

      await controller.toggle();
      expect(controller.state.autoStart).toBe(false);
    });
  });

  it("falls back to the requested state when reading the login item fails", () => {
    const app = {
      ...makeApp(),
      getLoginItemSettings: () => {
        throw new Error("registry unavailable");
      },
    };
    expect(readAutoStartState(app, true)).toEqual({ autoStart: true });
    expect(readAutoStartState(app, false)).toEqual({ autoStart: false });
  });
});
