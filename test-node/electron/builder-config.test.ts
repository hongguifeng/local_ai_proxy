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

  it("builds both an installable and portable Windows application", async () => {
    const config = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(config).toContain("- nsis");
    expect(config).toContain("- portable");
    expect(config).toContain("oneClick: false");
  });

  it("unpacks the SQLite native module from the application archive", async () => {
    const config = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(config).toContain("node_modules/better-sqlite3/**/*");
    expect(config).toContain("npmRebuild: true");
  });

  it("allows documented unsigned development releases", async () => {
    const config = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(config).toContain("forceCodeSigning: false");
  });

  it("pins an Electron version compatible with the SQLite native addon", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(packageJson.devDependencies?.["electron"]).toBe("40.9.3");
  });
});
