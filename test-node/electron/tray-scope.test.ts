import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows tray scope", () => {
  it("does not register the application for login startup", async () => {
    const source = await readFile(new URL("../../electron/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("setLoginItemSettings");
  });
});
