import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("run.bat", () => {
  it("launches the built Node CLI without Python", async () => {
    const script = await readFile(new URL("../../run.bat", import.meta.url), "utf8");
    expect(script).toContain("dist-node\\src\\main.js");
    expect(script).toContain("--no-browser %*");
    expect(script.toLowerCase()).not.toContain("python");
  });
});
