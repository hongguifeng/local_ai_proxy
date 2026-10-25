import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { buildAdminAppJsTemplate } from "../../src/admin/static-assets.js";

const SCRIPT_DIR = path.resolve("src/admin/static");
const MODULE_DIR = path.join(SCRIPT_DIR, "modules");

/** The authored module graph, entry first, so a source assertion below reads one string. */
async function readModuleSources(): Promise<Map<string, string>> {
  const names = (await readdir(MODULE_DIR)).filter((name) => name.endsWith(".js")).sort();
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(path.join(MODULE_DIR, name), "utf8")] as const),
  );
  return new Map([
    ["entry.js", await readFile(path.join(SCRIPT_DIR, "entry.js"), "utf8")],
    ...entries,
  ]);
}

/** Every authored script's source, for assertions about behaviour rather than bytes. */
async function readAuthoringSources(): Promise<string> {
  return [...(await readModuleSources()).values()].join("\n");
}

/**
 * What the browser actually runs: the bundled module graph the server hands to
 * `/static/app.js`, placeholder still to be substituted. It is produced by
 * `buildAdminAppJsTemplate()`, the same function `loadAdminStaticAssets()` uses, so an
 * assertion here cannot drift away from the payload.
 */
async function readAdminScript(): Promise<string> {
  return await buildAdminAppJsTemplate();
}

describe("admin UI source migration", () => {
  it("keeps the HTML source canonically formatted", async () => {
    const source = await readFile(path.resolve("src/admin/static/index.html"), "utf8");
    expect(source).toBe(await format(source, { parser: "html", printWidth: 100 }));
  });

  it("keeps the CSS source canonically formatted", async () => {
    const source = await readFile(path.resolve("src/admin/static/app.css"), "utf8");
    expect(source).toBe(await format(source, { parser: "css", printWidth: 100 }));
  });

  it("keeps the module entry and every module canonically formatted", async () => {
    const sources = await readModuleSources();
    expect(sources.size).toBeGreaterThan(1);
    for (const [name, source] of sources) {
      expect(source, name).toBe(await format(source, { parser: "babel", printWidth: 100 }));
    }
  });

  it("defines required DOM lookup contracts with runtime selector and type errors", async () => {
    const source = (await readModuleSources()).get("dom.js") ?? "";
    expect(source).toContain("Required UI element not found: ${selector}");
    expect(source).toContain("Required UI input has wrong element type");
    expect(source).toContain("Required UI dialog has wrong element type");
    expect(source).toContain("Required UI details has wrong element type");
    expect(source).toContain("HTMLInputElement");
    expect(source).toContain("HTMLDialogElement");
    expect(source).toContain("HTMLDetailsElement");
    expect(source).not.toContain("UiElement");
  });
  it("ships one generated script and nothing else for the browser to load", async () => {
    // No numbered classic part is left: the whole program is the ES module graph, so the
    // load-order convention and the script-scope rules that came with it are gone.
    const names = await readdir(SCRIPT_DIR);
    expect(names.filter((name) => /^\d.*\.js$/.test(name))).toEqual([]);
    expect(names.sort()).toEqual(["app.css", "entry.js", "index.html", "modules"]);
    const script = await readAdminScript();
    expect(script.startsWith("// GENERATED FILE - DO NOT EDIT.")).toBe(true);
    expect(script).not.toContain("Parts are concatenated in numeric order");
    // static-assets.ts replaces this placeholder once at serve time; a second use
    // anywhere would silently ship an unresolved identifier to the browser.
    expect(script.match(/__SUGGESTED_STRIP_REQUEST_FIELDS__/g)).toHaveLength(1);
  });

  it("keeps the language switch driven by panels that register themselves", async () => {
    const sources = await readModuleSources();
    // The switch used to carry a hand-written call list, which silently left a new
    // panel in the old language. The pinned ids and sequences reproduce the order that
    // list ran in, so reordering is a deliberate edit of this table.
    const pinned = [
      ["pairs", 10],
      ["logs", 20],
      ["jsonPanes", 30],
      ["metaPanes", 40],
      ["requestPricing", 50],
      ["taskPricing", 60],
      ["metricsDialog", 70],
      ["targetCheckModels", 80],
      ["statistics", 90],
    ] as const;
    const registrations: [string, number, string][] = [];
    for (const [name, source] of sources) {
      for (const match of source.matchAll(/registerLanguagePanel\(\s*"([a-zA-Z]+)",\s*(\d+),/g)) {
        registrations.push([match[1] ?? "", Number(match[2]), name]);
      }
    }
    const ordered = registrations
      .map(([id, sequence]) => [id, sequence] as const)
      .sort((left, right) => left[1] - right[1]);
    expect(ordered).toEqual([...pinned]);
    // Two files registering one id would render that surface twice per switch.
    const ids = registrations.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);

    const core = sources.get("core.js") ?? "";
    const start = core.indexOf("export function setLanguage(language) {");
    expect(start).toBeGreaterThan(-1);
    const body = core.slice(start, core.indexOf("\n}", start));
    expect(body).toContain("prepareLanguagePanels();");
    expect(body).toContain("rerenderLanguagePanels();");
    // A render call put back in the switch would double up with the panel that already
    // registers itself, which is how the list used to grow.
    expect(body.match(/(?<!re)render[A-Za-z]*\(/g)).toBeNull();
  });

  it("preserves Chinese, English, and the existing language preference key", async () => {
    const [html, sources] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readAuthoringSources(),
    ]);
    expect(html).toContain('<option value="zh">');
    expect(html).toContain('<option value="en">');
    expect(sources).toContain("zh: {");
    expect(sources).toContain("en: {");
    expect(sources).toContain('localStorage.getItem("llmProxyLanguage")');
    expect(sources).toContain('localStorage.setItem("llmProxyLanguage", language)');
    expect(sources).toContain('(navigator.language || "").toLowerCase().startsWith("zh")');
    expect(sources).toContain("pie-legend");
    expect(sources).toContain("retryStatistics");
  });

  it("preserves the DOM IDs and data attributes used by browser logic", async () => {
    const [html, sources] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readAuthoringSources(),
    ]);
    for (const id of [
      "proxies",
      "logs",
      "languageSelect",
      "addProxy",
      "saveProxies",
      "proxyGrid",
      "logSearch",
      "refreshLogs",
      "exportLogs",
      "cleanupLogs",
      "autoRefreshLogs",
      "logItems",
      "logSplitter",
      "detail",
      "requestMeta",
      "requestJson",
      "splitter",
      "responseMeta",
      "responseJson",
      "toast",
      "statsMetric",
      "statsGranularity",
      "statsTarget",
      "statsModel",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const attribute of [
      "data-tab",
      "data-i18n",
      "data-i18n-title",
      "data-i18n-placeholder",
      "data-meta",
      "data-wrap",
      "data-expand",
      "data-format",
      "data-copy",
    ]) {
      expect(html).toContain(attribute);
    }
    for (const generatedAttribute of [
      "data-toggle",
      "data-add-target",
      "data-remove-target",
      "data-group-id",
      "data-log-id",
      "data-load-more",
    ]) {
      expect(sources).toContain(generatedAttribute);
    }
  });
});
