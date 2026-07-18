import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("uploads Electron artifacts and checksums from Windows", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("npm run package:electron");
    expect(workflow).toContain("npm run smoke:artifact");
    expect(workflow).toContain("release/SHA256SUMS.txt");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });
});
