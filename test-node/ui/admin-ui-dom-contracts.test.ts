import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  baseUrl,
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
  unhandledPageErrors,
} from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

async function installDomContracts(): Promise<void> {
  const result = await build({
    entryPoints: ["src/admin/static/modules/dom.js"],
    bundle: true,
    format: "iife",
    globalName: "domContractsUnderTest",
    write: false,
  });
  const script = result.outputFiles[0];
  if (script === undefined) throw new Error("DOM contract bundle was not produced");
  await page.addScriptTag({ content: script.text });
}

async function expectInitializationError(message: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect.poll(() => unhandledPageErrors().map((error) => error.message)).toContain(message);
  await expect(closeTestPage()).rejects.toThrow(message);
}

describe("DOM lookup runtime contracts", () => {
  it("distinguishes missing optional nodes and required nodes, and checks concrete classes", async () => {
    await loadAdminPage();
    await installDomContracts();
    const result: unknown = await page.evaluate(`(() => {
      const dom = domContractsUnderTest;
      const root = document.createElement('section');
      root.innerHTML = '<input id="contract-input"><div id="contract-wrong"></div><dialog id="contract-dialog"></dialog><details id="contract-details"></details>';
      const errors = [];
      for (const lookup of [
        () => dom.requiredTyped('#contract-missing', HTMLInputElement, root),
        () => dom.requiredTyped('#contract-wrong', HTMLInputElement, root),
        () => dom.optionalTyped('#contract-wrong', HTMLDialogElement, root),
      ]) {
        try { lookup(); } catch (error) { errors.push(error.message); }
      }
      return {
        missingOptional: dom.optionalTyped('#contract-missing', HTMLInputElement, root),
        input: dom.requiredTyped('#contract-input', HTMLInputElement, root).tagName,
        dialog: dom.requiredTyped('#contract-dialog', HTMLDialogElement, root).tagName,
        details: dom.requiredTyped('#contract-details', HTMLDetailsElement, root).tagName,
        errors,
      };
    })()`);
    expect(result).toEqual({
      missingOptional: null,
      input: "INPUT",
      dialog: "DIALOG",
      details: "DETAILS",
      errors: [
        "Required UI element not found: #contract-missing",
        "UI element has wrong element type: #contract-wrong (expected HTMLInputElement)",
        "UI element has wrong element type: #contract-wrong (expected HTMLDialogElement)",
      ],
    });
  });

  it("keeps API errors typed when the server returns malformed error details", async () => {
    await loadAdminPage();
    const result = await build({
      entryPoints: ["src/admin/static/modules/core.js"],
      bundle: true,
      format: "iife",
      globalName: "coreContractsUnderTest",
      write: false,
    });
    const script = result.outputFiles[0];
    if (script === undefined) throw new Error("API contract bundle was not produced");
    await page.addScriptTag({ content: script.text });
    await page.route("**/api/pairs", (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: "invalid_config",
            message: "Invalid field",
            issues: [
              { code: "invalid_type", path: "pairs.0.name", message: "Expected a string" },
              null,
              { code: 5, path: "bad", message: "Invalid issue" },
            ],
          },
        },
      }),
    );
    const error: unknown = await page.evaluate(`(async () => {
      try { await coreContractsUnderTest.api('/api/pairs'); }
      catch (error) { return {message: error.message, code: error.code, issues: error.issues}; }
    })()`);
    expect(error).toEqual({
      message: "Invalid field",
      code: "invalid_config",
      issues: [{ code: "invalid_type", path: "pairs.0.name", message: "Expected a string" }],
    });
    await page.route("**/api/pairs", (route) => route.fulfill({ status: 502, json: null }));
    const fallback: unknown = await page.evaluate(`(async () => {
      try { await coreContractsUnderTest.api('/api/pairs'); }
      catch (error) { return error.message; }
    })()`);
    expect(fallback).toBe("Bad Gateway");
  });

  it("reports a missing required control during real page initialization", async () => {
    const html = await readFile("src/admin/static/index.html", "utf8");
    await page.route(baseUrl + "/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html.replace('id="targetCheckModel"', 'id="removed-targetCheckModel"'),
      }),
    );
    await expectInitializationError("Required UI element not found: #targetCheckModel");
  });

  it("reports a wrong required control class during real page initialization", async () => {
    const html = await readFile("src/admin/static/index.html", "utf8");
    await page.route(baseUrl + "/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: html.replace(
          'id="targetCheckModel"',
          'id="removed-targetCheckModel"><div id="targetCheckModel"></div><input',
        ),
      }),
    );
    await expectInitializationError(
      "UI element has wrong element type: #targetCheckModel (expected HTMLInputElement)",
    );
  });

  it("initializes statistics with its optional controls absent and recovers from an error", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    let fail = false;
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        status: fail ? 503 : 200,
        json: fail ? {} : { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await expectPage(
      page.locator("#applyStatsFilters, #resetStatsFilters, #statsBreakdown"),
    ).toHaveCount(0);
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsOverview .stat-card")).toHaveCount(4);
    fail = true;
    await page.locator("#refreshStatistics").click();
    await expectPage(page.locator("#retryStatistics")).toBeVisible();
    fail = false;
    await page.locator("#retryStatistics").click();
    await expectPage(page.locator("#statsOverview .stat-card")).toHaveCount(4);
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator("#statsOverview .stat-card")).toHaveCount(4);
  });
});
