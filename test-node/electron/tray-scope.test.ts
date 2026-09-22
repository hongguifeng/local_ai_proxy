import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows tray auto start", () => {
  it("registers the packaged application for login startup from the tray menu", async () => {
    const source = await readFile(new URL("../../electron/index.ts", import.meta.url), "utf8");
    expect(source).toContain("createAutoStartController");
    const autoStartSource = await readFile(
      new URL("../../electron/auto-start.ts", import.meta.url),
      "utf8",
    );
    expect(autoStartSource).toContain("setLoginItemSettings");
  });
});
