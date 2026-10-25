import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function readRepositoryFile(name: string): Promise<string> {
  return await readFile(path.join(repositoryRoot, name), "utf8");
}

interface TypeScriptConfig {
  extends?: string;
  compilerOptions?: {
    noEmit?: boolean;
    outDir?: string;
    rootDir?: string;
    moduleDetection?: string;
    checkJs?: boolean;
    strictNullChecks?: boolean;
  };
  include?: string[];
}

async function readTypeScriptConfig(name: string): Promise<TypeScriptConfig> {
  return JSON.parse(await readRepositoryFile(name)) as TypeScriptConfig;
}

/** The first path segment of an include entry, which is the source root it covers. */
function includedRoot(entry: string): string | undefined {
  return entry.split("/")[0];
}

/** The `files:` list of the electron-builder configuration, in declaration order. */
function packagedFileList(configText: string): string[] {
  const start = configText.indexOf("files:");
  if (start < 0) return [];
  const end = configText.indexOf("\nasar:", start);
  return configText
    .slice(start, end)
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.trim().slice(2).replaceAll('"', ""));
}

// `npm run build` compiles these trees; anything else in the output directory is a
// leftover from an earlier configuration and must not be packaged.
const compiledTrees: string[] = ["src", "electron", "scripts"];
// `npm run typecheck` has to keep covering every Node source, tests included.
const typecheckedRoots: string[] = ["src", "electron", "test-node", "scripts"];

async function readBuildScripts(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

describe("[AI-15] compile entries", () => {
  it("[AI-15] builds the product and its tools without test implementations", async () => {
    const scripts = await readBuildScripts();
    const build = scripts["build"] ?? "";
    expect(build.startsWith("tsc -p tsconfig.build.json")).toBe(true);
    expect(build).toContain("node dist-node/scripts/copy_static_assets.js");
    // The all-sources configuration is the typecheck entry, never the product compile.
    expect(build).not.toContain("test-node");

    const config = await readTypeScriptConfig("tsconfig.build.json");
    expect(config.compilerOptions?.noEmit, "the build configuration must emit").toBe(false);
    expect(config.compilerOptions?.outDir).toBe("dist-node");
    expect(config.compilerOptions?.rootDir).toBe(".");
    expect(config.extends).toBe("./tsconfig.json");
    const include = config.include ?? [];
    expect(include.map(includedRoot)).toEqual(compiledTrees);
    expect(include.join(" ")).not.toContain("test-node");
  });

  it("[AI-15] still typechecks product, tests, tools and browser scripts", async () => {
    const scripts = await readBuildScripts();
    const typecheck = scripts["typecheck"] ?? "";
    expect(typecheck).toContain("tsc -p tsconfig.json");
    expect(typecheck).toContain("tsc -p tsconfig.ui.json");

    const config = await readTypeScriptConfig("tsconfig.json");
    expect(config.compilerOptions?.noEmit, "the full check must not emit build output").toBe(true);
    expect((config.include ?? []).map(includedRoot)).toEqual(typecheckedRoots);

    const uiConfig = await readTypeScriptConfig("tsconfig.ui.json");
    expect(uiConfig.compilerOptions?.moduleDetection).toBe("legacy");
    expect(uiConfig.compilerOptions?.checkJs, "the browser scripts must stay checked").toBe(true);
    expect(uiConfig.compilerOptions?.strictNullChecks, "the complete UI graph checks nullability").toBe(true);
  });

  it("[AI-15] packages only the trees the product build produces", async () => {
    const entries = packagedFileList(await readRepositoryFile("electron-builder.yml"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => entry.includes("test-node"))).toEqual([]);
    for (const entry of entries) {
      if (entry === "package.json") continue;
      expect(entry.startsWith("dist-node/"), entry).toBe(true);
      const tree = entry.split("/")[1] ?? "";
      expect(compiledTrees, entry).toContain(tree);
    }
    expect(entries).toContain("package.json");
  });
});
