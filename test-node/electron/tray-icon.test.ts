import { describe, expect, it } from "vitest";

import { TRAY_ICON_DATA_URL } from "../../electron/tray-icon.js";

describe("tray icon", () => {
  it("embeds a scalable icon without an external file dependency", () => {
    expect(TRAY_ICON_DATA_URL).toMatch(/^data:image\/svg\+xml/u);
    expect(decodeURIComponent(TRAY_ICON_DATA_URL)).toContain("<svg");
    expect(decodeURIComponent(TRAY_ICON_DATA_URL)).toContain("#2563eb");
  });
});
