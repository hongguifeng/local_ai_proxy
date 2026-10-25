import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADMIN_SCRIPT_PARTS,
  BRIDGE_DIRECTORY,
  BRIDGE_FILE,
  GENERATED_ASSET_MARKER,
  buildAdminAppJsTemplate,
  loadAdminStaticAssets,
  readAdminModuleBridge,
} from "../../src/admin/static-assets.js";
import { applicationHealth, createAdminServer } from "../../src/admin/index.js";

const STATIC_DIR = path.resolve("src/admin/static");
const MODULE_DIR = path.join(STATIC_DIR, "modules");

/**
 * The capabilities the AI-17 transition bridge publishes. This list is the whole
 * contract and the thing AI-18 and AI-19 shrink: a migrated part imports what it needs
 * and drops its line from `entry.js`, until AI-19 removes the block together with the
 * numbered-script load order. Keeping it here means a new global has to be a deliberate
 * edit of this table.
 */
const BRIDGE_CAPABILITIES = [
  "chartMeanLine",
  "chartPeakLabel",
  "compactNumber",
  "configureDisplayLanguage",
  "costAxisLabel",
  "createLoadBalancing",
  "createProxyConfig",
  "displayTimestampParts",
  "escapeHtml",
  "formatDuration",
  "formatIntegerValue",
  "formatString",
  "formatTokenCount",
  "formatTokensPerSecond",
  "fullNumber",
  "niceAxisScale",
  "optionalFiniteNumber",
  "positiveNumber",
  "pricingDecimalFromNano",
] as const;

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

/** The bridge is read as text: importing it would need declarations this project does not have. */
async function readBridgeEntry(): Promise<string> {
  return readFile(path.join(STATIC_DIR, "entry.js"), "utf8");
}

function publishedNames(entrySource: string): string[] {
  return [...entrySource.matchAll(/^globalThis\.([A-Za-z0-9_$]+) = [A-Za-z0-9_$]+;$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

function exportedNames(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?(?:function|const|let) ([A-Za-z0-9_$]+)/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** Drops comment lines: the guard below is about the code, not about what it says. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

async function readModuleSources(): Promise<Map<string, string>> {
  const names = (await readdir(MODULE_DIR)).filter((name) => name.endsWith(".js")).sort();
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(path.join(MODULE_DIR, name), "utf8")] as const),
  );
  return new Map(entries);
}

async function readParts(): Promise<Map<string, string>> {
  const entries = await Promise.all(
    ADMIN_SCRIPT_PARTS.map(
      async (name) => [name, await readFile(path.join(STATIC_DIR, name), "utf8")] as const,
    ),
  );
  return new Map(entries);
}

describe("[AI-17] admin UI module bridge", () => {
  it("publishes exactly the capabilities this lane lists", async () => {
    const published = publishedNames(await readBridgeEntry());
    expect(published).toEqual([...BRIDGE_CAPABILITIES].sort());
  });

  it("reaches every capability through an import of a module that exports it", async () => {
    const entrySource = await readBridgeEntry();
    const importedNames = new Set(
      [...entrySource.matchAll(/^import \{([^}]*)\} from "\.\/modules\/[A-Za-z0-9.$-]+\.js";$/gm)]
        .flatMap((match) => (match[1] ?? "").split(","))
        .map((part) => part.trim())
        .filter((name) => name.length > 0),
    );
    const modules = await readModuleSources();
    const exported = new Set([...modules.values()].flatMap((source) => exportedNames(source)));
    for (const name of publishedNames(entrySource)) {
      expect(exported.has(name), `${name} is not exported by any module`).toBe(true);
      expect(importedNames.has(name), `${name} never reaches entry.js through an import`).toBe(
        true,
      );
    }
  });

  it("keeps display helpers free of the classic scope and of the DOM", async () => {
    const modules = await readModuleSources();
    expect(modules.size).toBeGreaterThan(1);
    for (const [name, source] of modules) {
      if (name === "proxy-config.js" || name === "load-balancing.js") {
        expect(codeOnly(source), name).not.toMatch(/\b(translations|globalThis)\b/);
        continue;
      }
      // Nothing in the display helper graph may read the shared script scope or touch the page:
      // these helpers take arguments and return text.
      expect(codeOnly(source), name).not.toMatch(
        /\b(state|translations|localStorage|document|window|navigator)\b/,
      );
    }
  });

  it("keeps proxy drafts and load-balancing operations inside their feature modules", async () => {
    const parts = await readParts();
    for (const [name, source] of parts) {
      expect(codeOnly(source), name).not.toMatch(/\bstate\.(pairs|targetCheck[A-Za-z]*)\b/);
      expect(codeOnly(source), name).not.toMatch(
        /function (collectPairs|savePairs|refreshLoadBalancerStatus|applyLoadBalancerStatus)\b/,
      );
    }
    const modules = await readModuleSources();
    const proxy = modules.get("proxy-config.js") ?? "";
    const balancing = modules.get("load-balancing.js") ?? "";
    expect(proxy).toContain("getPairs: () => structuredClone(state.pairs)");
    expect(proxy).toContain("loadBalancing.collectGroups(");
    expect(balancing).toContain("operations.addGroup(");
    expect(balancing).toContain("operations.removeGroup(");
    expect(codeOnly(balancing)).not.toMatch(/\bstate\./);
  });

  it("imports nothing outside its own directory", async () => {
    const entrySource = await readBridgeEntry();
    const specifiers = [...entrySource.matchAll(/from "([^"]+)"/g)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("./modules/"), specifier).toBe(true);
    }
  });

  it("leaves no bridged name declared inside a classic part", async () => {
    const parts = await readParts();
    for (const [name, source] of parts) {
      for (const capability of BRIDGE_CAPABILITIES) {
        const declaration = new RegExp(`^(?:async )?(?:function|const|let|var) ${capability}\\b`);
        expect(declaration.test(source), `${name} still declares ${capability}`).toBe(false);
      }
    }
  });

  it("resolves the generated chunk beside the compiled static assets", async () => {
    const generated = path.resolve(...BRIDGE_DIRECTORY, BRIDGE_FILE);
    expect(generated.endsWith(path.join("static-bundle", BRIDGE_FILE))).toBe(true);
    // Running from source the walk-up rule has to land on this file. The same rule is
    // what finds it under `dist-node` inside the packaged asar, verified in V-P.
    const fromDisk = await readFile(generated, "utf8");
    expect(fromDisk.includes(GENERATED_ASSET_MARKER)).toBe(true);
    expect(await readAdminModuleBridge()).toBe(fromDisk);
  });

  it("serves the bridge as the first thing in /static/app.js", async () => {
    const template = await buildAdminAppJsTemplate();
    expect(template.startsWith(await readAdminModuleBridge())).toBe(true);

    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      staticAssets: await loadAdminStaticAssets(),
    });
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/static/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body.startsWith(`// ${GENERATED_ASSET_MARKER}.`)).toBe(true);
    expect(response.body).toContain("globalThis.escapeHtml = escapeHtml;");
    expect(response.body).toContain(
      "globalThis.configureDisplayLanguage = configureDisplayLanguage;",
    );
    // The numbered parts follow the chunk in load order, so the wiring part is last.
    const headers = await readParts();
    let previousIndex = -1;
    for (const name of ADMIN_SCRIPT_PARTS) {
      const header = (headers.get(name) ?? "").split("\n")[0] ?? "";
      const index = response.body.indexOf(header);
      expect(index, `${name} is not in the served script`).toBeGreaterThan(-1);
      expect(index, `${name} is out of load order`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
