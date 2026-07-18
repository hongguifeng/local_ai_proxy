import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README runtime instructions", () => {
  it("uses the Node CLI in the English quick start", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const quickStart = readme.slice(readme.indexOf("## Quick Start"), readme.indexOf("## Web Console"));
    expect(quickStart).toContain("npm start");
    expect(quickStart).toContain("npm run package:electron");
    expect(quickStart).not.toContain("python -m llm_proxy");
  });

  it("uses the Node CLI in the Chinese quick start", async () => {
    const readme = await readFile(new URL("../../README.cn.md", import.meta.url), "utf8");
    const quickStart = readme.slice(readme.indexOf("## 快速开始"), readme.indexOf("## Web 控制台"));
    expect(quickStart).toContain("npm start");
    expect(quickStart).toContain("npm run package:electron");
    expect(quickStart).not.toContain("python -m llm_proxy");
  });

  it("documents current install, test, development, and packaging commands", async () => {
    const readmes = await Promise.all(
      ["README.md", "README.cn.md"].map((name) =>
        readFile(new URL(`../../${name}`, import.meta.url), "utf8"),
      ),
    );
    for (const readme of readmes) {
      for (const command of ["npm ci", "npm run check", "npm run dev", "npm run package:electron"]) {
        expect(readme).toContain(command);
      }
    }
  });

  it("documents the Node and Electron project structure", async () => {
    for (const name of ["README.md", "README.cn.md"]) {
      const readme = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
      expect(readme).toContain("src/");
      expect(readme).toContain("electron/");
      expect(readme).toContain("test-node/");
      expect(readme).not.toContain("tray_launcher.py");
    }
  });

  it("links the migration rehearsal and rollback procedures", async () => {
    for (const name of ["README.md", "README.cn.md"]) {
      const readme = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
      expect(readme).toContain("docs/migration-rehearsal-report.md");
      expect(readme).toContain("docs/migration-rollback.md");
      expect(readme).toContain("validate:migration");
    }
  });
});
