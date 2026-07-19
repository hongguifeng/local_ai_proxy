import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CI workflow", () => {
  it("uses only the Node toolchain", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).toContain("npm run check");
    expect(workflow).not.toContain("setup-python");
    expect(workflow).not.toContain("PyInstaller");
  });
});
