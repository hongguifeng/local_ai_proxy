import { readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";

describe("admin UI source migration", () => {
  it("keeps the HTML source canonically formatted", async () => {
    const source = await readFile(path.resolve("src/admin/static/index.html"), "utf8");
    expect(source).toBe(await format(source, { parser: "html", printWidth: 100 }));
  });

  it("keeps the CSS source canonically formatted", async () => {
    const source = await readFile(path.resolve("src/admin/static/app.css"), "utf8");
    expect(source).toBe(await format(source, { parser: "css", printWidth: 100 }));
  });

  it("keeps the browser source canonically formatted", async () => {
    const source = await readFile(path.resolve("src/admin/static/app.js"), "utf8");
    expect(source).toBe(await format(source, { parser: "babel", printWidth: 100 }));
  });

  it("preserves Chinese, English, and the existing language preference key", async () => {
    const [html, script] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readFile(path.resolve("src/admin/static/app.js"), "utf8"),
    ]);
    expect(html).toContain('<option value="zh">');
    expect(html).toContain('<option value="en">');
    expect(script).toContain("zh: {");
    expect(script).toContain("en: {");
    expect(script).toContain('localStorage.getItem("llmProxyLanguage")');
    expect(script).toContain('localStorage.setItem("llmProxyLanguage", language)');
    expect(script).toContain('(navigator.language || "").toLowerCase().startsWith("zh")');
  });

  it("preserves the DOM IDs and data attributes used by browser logic", async () => {
    const [html, script] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readFile(path.resolve("src/admin/static/app.js"), "utf8"),
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
