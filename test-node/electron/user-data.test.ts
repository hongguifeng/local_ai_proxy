import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { configureElectronUserData } from "../../electron/user-data.js";

describe("Electron user data isolation", () => {
  it("leaves the default path unchanged without an override", () => {
    const setPath = vi.fn();
    expect(configureElectronUserData({ setPath }, {})).toBeUndefined();
    expect(setPath).not.toHaveBeenCalled();
  });

  it("sets an absolute user-data path before the single-instance lock", () => {
    const setPath = vi.fn();
    const configured = configureElectronUserData(
      { setPath },
      { LLM_PROXY_USER_DATA_DIR: "smoke/user-data" },
    );
    expect(configured).toBe(path.resolve("smoke/user-data"));
    expect(setPath).toHaveBeenCalledWith("userData", configured);
  });
});
