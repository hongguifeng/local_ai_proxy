import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { configureElectronUserData } from "../../electron/user-data.js";

describe("Electron user data isolation", () => {
  it("uses Electron's persistent user-data directory for installed builds", () => {
    const setPath = vi.fn();
    const getPath = vi.fn(() => "C:\\Users\\fixture\\AppData\\Roaming\\LLM Proxy");
    const configured = configureElectronUserData({ getPath, setPath }, {});
    expect(configured).toBe("C:\\Users\\fixture\\AppData\\Roaming\\LLM Proxy");
    expect(setPath).toHaveBeenCalledWith("userData", configured);
  });

  it("uses the original portable executable directory instead of its temp extraction", () => {
    const setPath = vi.fn();
    const configured = configureElectronUserData(
      { getPath: vi.fn(() => "temporary-user-data"), setPath },
      { PORTABLE_EXECUTABLE_DIR: "portable/location" },
    );
    expect(configured).toBe(path.resolve("portable/location"));
    expect(setPath).toHaveBeenCalledWith("userData", configured);
  });

  it("allows an explicit persistent data directory override", () => {
    const setPath = vi.fn();
    const configured = configureElectronUserData(
      { getPath: vi.fn(() => "default-user-data"), setPath },
      { LLM_PROXY_DATA_DIR: "custom/data", PORTABLE_EXECUTABLE_DIR: "portable/location" },
    );
    expect(configured).toBe(path.resolve("custom/data"));
  });
});
