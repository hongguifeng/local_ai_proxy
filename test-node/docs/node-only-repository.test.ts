import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist-electron",
  "dist-node",
  "node_modules",
  "release",
  "test-results",
]);

async function findPythonSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        found.push(...(await findPythonSources(path.join(directory, entry.name))));
      }
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      found.push(path.relative(repositoryRoot, path.join(directory, entry.name)));
    }
  }
  return found;
}

describe("Node-only repository", () => {
  it("contains no Python source or Python project manifest", async () => {
    await expect(access(path.join(repositoryRoot, "pyproject.toml"))).rejects.toThrow();
    await expect(findPythonSources(repositoryRoot)).resolves.toEqual([]);
  });

  it("declares Node 24 and the development lifecycle commands", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe(">=24 <25");
    for (const command of ["build", "dev", "start", "test"]) {
      expect(typeof packageJson.scripts?.[command]).toBe("string");
    }
  });
});
