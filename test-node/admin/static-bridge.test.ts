import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ADMIN_BUNDLE_DIRECTORY,
  ADMIN_BUNDLE_FILE,
  GENERATED_ASSET_MARKER,
  buildAdminAppJsTemplate,
  loadAdminStaticAssets,
  readAdminAppScript,
} from "../../src/admin/static-assets.js";
import { applicationHealth, createAdminServer } from "../../src/admin/index.js";
import { SUGGESTED_STRIP_REQUEST_FIELDS } from "../../src/config/index.js";

const STATIC_DIR = path.resolve("src/admin/static");
const MODULE_DIR = path.join(STATIC_DIR, "modules");
const ENTRY_FILE = path.join(STATIC_DIR, "entry.js");

/**
 * What the browser tests cannot drive through the DOM: applying a synthetic multi-megabyte
 * body, the exact currency formatter, and the lifecycle of the two config surfaces. That is
 * the whole test adapter, so widening it has to be a deliberate edit of this list.
 */
const TEST_ADAPTER_SURFACE = [
  "applySelectedLogDetail",
  "formatCurrencyAmount",
  "loadBalancing",
  "proxyConfig",
] as const;

const STRIP_FIELDS_PLACEHOLDER = "__SUGGESTED_STRIP_REQUEST_FIELDS__";

/** Pure display helpers: arguments in, text out, no page and no shared state. */
const DISPLAY_HELPERS = [
  "chart.js",
  "display-locale.js",
  "numbers.js",
  "request.js",
  "text.js",
  "time.js",
];

const servers: ReturnType<typeof createAdminServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

/** Sources are read as text: importing them would need declarations this project does not have. */
async function readModuleSources(): Promise<Map<string, string>> {
  const names = (await readdir(MODULE_DIR)).filter((name) => name.endsWith(".js")).sort();
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(path.join(MODULE_DIR, name), "utf8")] as const),
  );
  return new Map(entries);
}

/** Drops comment lines: the guards below are about the code, not about what it says. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

function relativeImports(source: string): string[] {
  return [...source.matchAll(/from "(\.[^"]+)"/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/** Every module the entry can reach through its relative imports, as module file names. */
async function reachableModules(): Promise<Set<string>> {
  const modules = await readModuleSources();
  const reached = new Set<string>();
  const queue = [ENTRY_FILE];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) continue;
    const source = await readFile(file, "utf8");
    for (const specifier of relativeImports(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  const names = new Set(
    [...reached]
      .filter((file) => path.dirname(file) === MODULE_DIR)
      .map((file) => path.basename(file)),
  );
  expect(names.size).toBeGreaterThan(1);
  expect(modules.size).toBe(names.size);
  return names;
}

describe("[AI-19] admin UI module graph", () => {
  it("publishes nothing on a global except the test adapter's namespace", async () => {
    const entry = await readFile(ENTRY_FILE, "utf8");
    const modules = await readModuleSources();
    const globals: string[] = [];
    for (const [name, source] of [["entry.js", entry] as const, ...modules]) {
      for (const match of codeOnly(source).matchAll(
        /\b(?:globalThis|window)\.([A-Za-z0-9_$]+)\s*=/g,
      )) {
        globals.push(`${name}:${match[1] ?? ""}`);
      }
    }
    // The AI-17 bridge published nineteen business functions here; the test adapter is the
    // only thing left, and a new global has to be a deliberate edit of this assertion.
    expect(globals).toEqual(["test-adapter.js:__adminUiTest"]);

    const adapter = codeOnly(modules.get("test-adapter.js") ?? "");
    expect(adapter).toContain("export function installAdminUiTestAdapter({");
    const parameters = [
      ...adapter.matchAll(/export function installAdminUiTestAdapter\(\{([^}]*)\}/g),
    ]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((part) => part.trim())
      .filter((name) => name.length > 0)
      .sort();
    expect(parameters).toEqual([...TEST_ADAPTER_SURFACE]);
    expect(adapter).toContain("globalThis.__adminUiTest = Object.freeze({");
    // The adapter is a function call from the composition root, never a module-level
    // assignment, so importing the module graph runs nothing on its own.
    expect(adapter).not.toMatch(/^globalThis\./m);
  });

  it("keeps the test adapter out of every production module", async () => {
    const modules = await readModuleSources();
    for (const [name, source] of modules) {
      if (name === "test-adapter.js") continue;
      expect(codeOnly(source), name).not.toContain("__adminUiTest");
    }
    // Wiring is the one importer: the composition root is where the surface is published.
    expect(codeOnly(modules.get("wiring.js") ?? "")).toContain(
      'import { installAdminUiTestAdapter } from "./test-adapter.js";',
    );
  });

  it("leaves no numbered classic script behind", async () => {
    const names = await readdir(STATIC_DIR);
    expect(names.filter((name) => /^\d.*\.js$/.test(name))).toEqual([]);
    const assets = await readFile(path.resolve("src/admin/static-assets.ts"), "utf8");
    expect(assets).not.toContain("ADMIN_SCRIPT_PARTS");
    const entry = await readFile(ENTRY_FILE, "utf8");
    // The entry used to also publish the module graph as globals; now it only starts the page.
    expect(codeOnly(entry)).not.toContain("globalThis.");
    expect(codeOnly(entry)).toContain('import { startAdminUi } from "./modules/wiring.js";');
  });

  it("reaches every feature module from the entry through imports", async () => {
    const names = await reachableModules();
    // An orphaned module would be a duplicate implementation nobody runs.
    for (const name of [
      "core.js",
      "history.js",
      "json-pane.js",
      "metrics.js",
      "statistics.js",
      "task-detail.js",
      "wiring.js",
    ]) {
      expect(names.has(name), `${name} is not reachable from entry.js`).toBe(true);
    }
  });

  it("keeps every feature module on the module graph, not on a script scope", async () => {
    const modules = await readModuleSources();
    for (const [name, source] of modules) {
      if (DISPLAY_HELPERS.includes(name) || name === "test-adapter.js") continue;
      const code = codeOnly(source);
      // A feature module takes nothing from a global: shared state, i18n and the DOM
      // helpers all arrive through ./core.js, which owns the dictionary and is therefore
      // the one module allowed to declare it.
      if (name === "core.js") continue;
      expect(code, name).not.toMatch(/^(?:async )?(?:function|const|let) translations\b/m);
      // The two config surfaces are the documented dependency-injection seam: the
      // composition root hands them every shared service, so they import none of it.
      if (name === "proxy-config.js" || name === "load-balancing.js") {
        expect(code, name).toContain("export function create");
        continue;
      }
      expect(relativeImports(code), name).toContain("./core.js");
    }
  });

  it("keeps display helpers free of the page and of shared state", async () => {
    const modules = await readModuleSources();
    for (const name of DISPLAY_HELPERS) {
      const source = modules.get(name);
      expect(source, `${name} is missing`).toBeDefined();
      expect(codeOnly(source ?? ""), name).not.toMatch(
        /\b(state|translations|localStorage|document|window|navigator|globalThis)\b/,
      );
    }
  });

  it("keeps proxy drafts and load-balancing operations inside their feature modules", async () => {
    const modules = await readModuleSources();
    const proxy = modules.get("proxy-config.js") ?? "";
    const balancing = modules.get("load-balancing.js") ?? "";
    expect(proxy).toContain("getPairs: () => structuredClone(state.pairs)");
    expect(proxy).toContain("loadBalancing.collectGroups(");
    expect(balancing).toContain("operations.addGroup(");
    expect(balancing).toContain("operations.removeGroup(");
    expect(codeOnly(balancing)).not.toMatch(/\bstate\./);
  });

  it("resolves the generated script beside the compiled static assets", async () => {
    const generated = path.resolve(...ADMIN_BUNDLE_DIRECTORY, ADMIN_BUNDLE_FILE);
    expect(generated.endsWith(path.join("static-bundle", ADMIN_BUNDLE_FILE))).toBe(true);
    // Running from source the walk-up rule has to land on this file. The same rule is
    // what finds it under `dist-node` inside the packaged asar.
    const fromDisk = await readFile(generated, "utf8");
    expect(fromDisk.includes(GENERATED_ASSET_MARKER)).toBe(true);
    expect(await readAdminAppScript()).toBe(fromDisk);
    expect(await buildAdminAppJsTemplate()).toBe(fromDisk);
  });

  it("serves the generated module graph as the whole of /static/app.js", async () => {
    const template = await buildAdminAppJsTemplate();
    const server = createAdminServer({
      getHealth: () => applicationHealth("running"),
      staticAssets: await loadAdminStaticAssets(),
    });
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/static/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body.startsWith(`// ${GENERATED_ASSET_MARKER}.`)).toBe(true);
    // Byte-identical to the bundle once the one served substitution has been applied.
    const expected = template.replaceAll(
      STRIP_FIELDS_PLACEHOLDER,
      JSON.stringify(SUGGESTED_STRIP_REQUEST_FIELDS.join(",")),
    );
    expect(template).toContain(STRIP_FIELDS_PLACEHOLDER);
    expect(response.body).toBe(expected);
    expect(response.body).toContain("startAdminUi");
    // Nothing from the retired classic scope is left in the payload.
    for (const name of ["globalThis.escapeHtml", "globalThis.createProxyConfig", "01-core"]) {
      expect(response.body, `${name} is still in the served script`).not.toContain(name);
    }
  });
});
