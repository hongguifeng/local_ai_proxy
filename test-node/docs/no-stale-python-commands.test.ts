import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const maintainedEntryPoints = [
  "README.md",
  "README.cn.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
] as const;

const stalePythonCommands = [
  /python3?\s+-m/i,
  /pip3?\s+install/i,
  /pytest/i,
  /pyinstaller/i,
  /pyproject\.toml/i,
  /tray_launcher\.py/i,
  /llm_proxy(?:[\\/.]|\b)/i,
] as const;

describe("maintained documentation and workflows", () => {
  it.each(maintainedEntryPoints)("contains no stale Python command in %s", async (path) => {
    const contents = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");

    for (const staleCommand of stalePythonCommands) {
      expect(contents).not.toMatch(staleCommand);
    }
  });
});
