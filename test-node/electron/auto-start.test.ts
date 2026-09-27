import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createAutoStartController,
  readAutoStartState,
  resolveLoginItemPath,
} from "../../electron/auto-start.js";

// Electron defaults the login-item path to the currently running executable,
// which for a portable build is the temporary unpacked copy.
const CURRENT_EXEC = "C:\\Users\\hong\\AppData\\Local\\Temp\\unpack\\LLM Proxy.exe";

function makeApp(overrides: { isPackaged?: boolean; openAtLogin?: boolean } = {}) {
  let openAtLogin = overrides.openAtLogin ?? false;
  let registeredPath = CURRENT_EXEC;
  const setLoginItemSettings = vi.fn((options: { openAtLogin: boolean; path?: string }) => {
    openAtLogin = options.openAtLogin;
    registeredPath = options.path ?? CURRENT_EXEC;
  });
  return {
    setLoginItemSettings,
    isPackaged: overrides.isPackaged ?? true,
    getAppPath: () => "C:/Program Files/LLM Proxy/LLM Proxy.exe",
    // Electron compares the stored Run entry against the queried path, so a
    // mismatched (or missing) `path` option reports openAtLogin false.
    getLoginItemSettings: (options?: { path?: string }) => ({
      openAtLogin: openAtLogin && (options?.path ?? CURRENT_EXEC) === registeredPath,
    }),
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

  it("registers the portable launcher executable instead of the unpacked copy", async () => {
    await withTempDirectory(async (dataDirectory) => {
      const portableFile = "D:/Portable Program/llm_proxy/LLM-Proxy-0.4.9-x64-portable.exe";
      const environment = {
        PORTABLE_EXECUTABLE_DIR: "D:/Portable Program/llm_proxy",
        PORTABLE_EXECUTABLE_FILE: portableFile,
      };
      const app = makeApp();
      const controller = await createAutoStartController({
        app,
        environment,
        dataDirectory,
      });
      expect(controller.state.autoStart).toBe(false);

      await controller.toggle();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        path: portableFile,
      });
      expect(controller.state.autoStart).toBe(true);
      const configPath = path.join(dataDirectory, "auto-start.json");
      expect(await readFile(configPath, "utf8")).toContain('"autoStart": true');

      // A fresh process re-applies the persisted choice with the same path,
      // so the read-back matches even though it runs from the temp copy.
      const reloaded = await createAutoStartController({
        app: makeApp(),
        environment,
        dataDirectory,
      });
      expect(reloaded.state.autoStart).toBe(true);

      await reloaded.toggle();
      expect(reloaded.state.autoStart).toBe(false);
    });
  });

  it("falls back to the launcher directory plus app filename when the file env is missing", async () => {
    await withTempDirectory(async (dataDirectory) => {
      const environment = {
        PORTABLE_EXECUTABLE_DIR: "D:/Portable Program/llm-proxy",
        PORTABLE_EXECUTABLE_APP_FILENAME: "LLM Proxy.exe",
      };
      const app = makeApp();
      const controller = await createAutoStartController({
        app,
        environment,
        dataDirectory,
      });

      await controller.toggle();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        path: path.resolve("D:/Portable Program/llm-proxy", "LLM Proxy.exe"),
      });
      expect(controller.state.autoStart).toBe(true);
    });
  });

  it("still skips the registry when a portable build exposes no stable path", async () => {
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

describe("resolveLoginItemPath", () => {
  it("prefers the portable executable file over the directory plus filename", () => {
    expect(
      resolveLoginItemPath({
        PORTABLE_EXECUTABLE_DIR: "D:/Portable Program/llm-proxy",
        PORTABLE_EXECUTABLE_FILE: "D:/Portable Program/llm-proxy/LLM-Proxy-portable.exe",
        PORTABLE_EXECUTABLE_APP_FILENAME: "LLM Proxy.exe",
      }),
    ).toBe("D:/Portable Program/llm-proxy/LLM-Proxy-portable.exe");
  });

  it("trims blank launcher values and returns undefined without portable hints", () => {
    expect(resolveLoginItemPath({ PORTABLE_EXECUTABLE_FILE: "   " })).toBeUndefined();
    expect(resolveLoginItemPath({ PORTABLE_EXECUTABLE_DIR: "D:/x" })).toBeUndefined();
    expect(resolveLoginItemPath({})).toBeUndefined();
  });
});
