import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("electron-builder configuration", () => {
  it("defines the application identity, entry point, and output directory", async () => {
    const [config, packageJson] = await Promise.all([
      readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ]);
    expect(config).toContain("appId: com.localai.llmproxy");
    expect(config).toContain("output: release");
    expect(JSON.parse(packageJson)).toMatchObject({ main: "dist-node/electron/index.js" });
  });
});
