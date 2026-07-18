import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("keeps electron-builder publishing under workflow control", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["package:electron"]).toContain("--publish never");
  });

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

  it("publishes v-tag builds to a GitHub Release", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain('- "v*"');
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("gh release upload");
  });
});
