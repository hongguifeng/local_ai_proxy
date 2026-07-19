import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTrayIconPath } from "../../electron/tray-icon.js";

describe("tray icon", () => {
  it("uses the packaged raster icon on Windows", () => {
    expect(resolveTrayIconPath(true, "C:\\app\\resources")).toBe(
      path.join("C:\\app\\resources", "tray-icon.png"),
    );
    expect(resolveTrayIconPath(false, "/unused", "/project")).toBe(
      path.resolve("/project", "resources", "tray-icon.png"),
    );
  });
});
