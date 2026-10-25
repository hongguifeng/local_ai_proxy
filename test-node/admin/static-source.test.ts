import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { ADMIN_SCRIPT_PARTS, buildAdminAppJsTemplate } from "../../src/admin/static-assets.js";

const SCRIPT_DIR = path.resolve("src/admin/static");

/**
 * The admin UI is authored as numbered classic-script parts that the server
 * concatenates into one /static/app.js. Reading them in name order mirrors the
 * load order, so a renamed or reordered part shows up here.
 */
async function readScriptParts(): Promise<string[]> {
  const names = (await readdir(SCRIPT_DIR)).filter((name) => /^\d.*\.js$/.test(name)).sort();
  return Promise.all(names.map((name) => readFile(path.join(SCRIPT_DIR, name), "utf8")));
}

/**
 * What the browser actually runs: the assembled script the server hands to
 * `/static/app.js`, placeholder still to be substituted. The guard checks this
 * text rather than a hand-made concatenation of the parts, so it cannot drift
 * away from the payload: it is produced by `buildAdminAppJsTemplate()`, the same
 * function `loadAdminStaticAssets()` uses, and `npm run lint` writes the same
 * bytes to `.ui-check/app.js` for ESLint.
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

  it("keeps every browser script part canonically formatted", async () => {
    const parts = await readScriptParts();
    expect(parts.length).toBeGreaterThan(1);
    for (const source of parts) {
      expect(source).toBe(await format(source, { parser: "babel", printWidth: 100 }));
    }
  });

  it("keeps the module entry and every module canonically formatted", async () => {
    const moduleNames = (await readdir(path.join(SCRIPT_DIR, "modules"))).filter((name) =>
      name.endsWith(".js"),
    );
    expect(moduleNames.length).toBeGreaterThan(1);
    for (const name of ["entry.js", ...moduleNames.map((entry) => path.join("modules", entry))]) {
      const source = await readFile(path.join(SCRIPT_DIR, name), "utf8");
      expect(source).toBe(await format(source, { parser: "babel", printWidth: 100 }));
    }
  });

  it("concatenates into a single script that still declares every part once", async () => {
    const names = (await readdir(SCRIPT_DIR)).filter((name) => /^\d.*\.js$/.test(name)).sort();
    // The server concatenates by this explicit list, so the authored order and the
    // load order must agree; a renamed or renumbered part would otherwise pass here.
    expect(names).toEqual([...ADMIN_SCRIPT_PARTS]);
    const script = await readAdminScript();
    // The bundled modules run before every part, so the bridge they publish exists
    // before the first top-level statement in 09-wiring.js. The generated chunk is the
    // first thing in the payload and the first numbered part follows it.
    expect(script.startsWith("// GENERATED FILE - DO NOT EDIT.")).toBe(true);
    expect(script.indexOf("// LLM Proxy admin UI -- shared bootstrap")).toBeGreaterThan(
      script.indexOf("// Bundled from src/admin/static/entry.js"),
    );
    // static-assets.ts replaces this placeholder once at serve time; a second use
    // anywhere would silently ship an unresolved identifier to the browser.
    expect(script.match(/__SUGGESTED_STRIP_REQUEST_FIELDS__/g)).toHaveLength(1);
    const declared = new Map<string, number>();
    for (const match of script.matchAll(
      /^(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/gm,
    )) {
      const name = match[1];
      if (name === undefined) continue;
      declared.set(name, (declared.get(name) ?? 0) + 1);
    }
    const duplicated = [...declared].filter(([, count]) => count > 1);
    // Two classic scripts redeclaring the same top-level name is a load-time SyntaxError.
    expect(duplicated).toEqual([]);
  });

  it("keeps the language switch driven by panels that register themselves", async () => {
    const script = await readAdminScript();
    // The switch used to carry a hand-written call list, which silently left a new
    // panel in the old language. The pinned ids and sequences reproduce the order
    // that list ran in, so reordering is a deliberate edit of this table.
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
    const registered = [...script.matchAll(/^registerLanguagePanel\(\s*"([a-zA-Z]+)",\s*(\d+),/gm)]
      .map((match) => [match[1], Number(match[2])])
      .filter((entry): entry is [string, number] => entry[0] !== undefined)
      .sort((left, right) => left[1] - right[1]);
    expect(registered).toEqual([...pinned]);

    const start = script.indexOf("function setLanguage(language) {");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, script.indexOf("\n}", start));
    expect(body).toContain("rerenderLanguagePanels();");
    // A render call put back in the switch would double up with the panel that
    // already registers itself, which is how the list used to grow.
    expect(body.match(/(?<!re)render[A-Za-z]*\(/g)).toBeNull();
    // The panels are registered by their own files, so no feature file may be
    // allowed to register twice under one id.
    const ids = registered.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves Chinese, English, and the existing language preference key", async () => {
    const [html, script] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readAdminScript(),
    ]);
    expect(html).toContain('<option value="zh">');
    expect(html).toContain('<option value="en">');
    expect(script).toContain("zh: {");
    expect(script).toContain("en: {");
    expect(script).toContain('localStorage.getItem("llmProxyLanguage")');
    expect(script).toContain('localStorage.setItem("llmProxyLanguage", language)');
    expect(script).toContain('(navigator.language || "").toLowerCase().startsWith("zh")');
    expect(script).toContain("pie-legend");
    expect(script).toContain("retryStatistics");
  });

  it("preserves the DOM IDs and data attributes used by browser logic", async () => {
    const [html, script] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readAdminScript(),
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
      expect(script).toContain(generatedAttribute);
    }
  });
});
