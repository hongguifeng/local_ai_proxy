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
});
