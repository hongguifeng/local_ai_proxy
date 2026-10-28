import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import { PNG } from "pngjs";
import { UI_TEST_TIMEOUT_MS, pairs, visualPairs } from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import {
  loadAdminPage,
  loadLbBaseline,
  loadStatisticsBaseline,
  loadTaskDetailBaseline,
  moveRowSplitterTo,
  openRecordDetail,
  requiredBox,
  screenshotContentRatio,
  screenshotDifference,
} from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

describe("admin UI visual regression", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("matches the Chinese proxy page baseline", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 1278, height: 1215 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("#saveProxies")).toHaveText("保存配置");

    expect(await screenshotDifference("doc/ui_proxy_cn.png")).toBeLessThan(0.12);
  });

  it("matches the English proxy page baseline", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 1278, height: 1208 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator("#saveProxies")).toHaveText("Save config");

    expect(await screenshotDifference("doc/ui_proxy_en.png")).toBeLessThan(0.12);
  });

  it("matches the Chinese load balancing baseline", async () => {
    await loadLbBaseline("zh");
    await expectPage(page.locator(".lb-card").nth(1).locator(".lb-member-row")).toHaveCount(2);

    expect(await screenshotDifference("doc/ui_lb_cn.png")).toBeLessThan(0.12);
  });

  it("matches the English load balancing baseline", async () => {
    await loadLbBaseline("en");
    await expectPage(page.locator(".lb-card").nth(1).locator(".lb-member-row")).toHaveCount(2);

    expect(await screenshotDifference("doc/ui_lb_en.png")).toBeLessThan(0.12);
  });

  it("matches the Chinese history page baseline", async () => {
    await page.setViewportSize({ width: 1384, height: 1212 });
    await openRecordDetail("record-two");
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator('[data-i18n="request"]')).toHaveText("请求");
    await page.locator("#requestJson .json-str-detail summary").click();
    await moveRowSplitterTo(875);

    expect(await screenshotDifference("doc/ui_logs_cn.png")).toBeLessThan(0.25);
  });

  it("matches the English history page baseline", async () => {
    await page.setViewportSize({ width: 1384, height: 1224 });
    await openRecordDetail("record-two");
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator('[data-i18n="request"]')).toHaveText("Request");
    await page.locator("#requestJson .json-str-detail summary").click();
    await moveRowSplitterTo(883);

    expect(await screenshotDifference("doc/ui_logs_en.png")).toBeLessThan(0.25);
  });

  it("matches the Chinese statistics page baseline", async () => {
    await loadStatisticsBaseline("zh");
    expect(await screenshotDifference("doc/ui_stats_cn.png")).toBeLessThan(0.25);
  });

  it("matches the English statistics page baseline", async () => {
    await loadStatisticsBaseline("en");
    expect(await screenshotDifference("doc/ui_stats_en.png")).toBeLessThan(0.25);
  });

  it("matches the Chinese task-detail panel baseline", async () => {
    await loadTaskDetailBaseline("zh");
    expect(await screenshotDifference("doc/ui_task_detail_cn.png")).toBeLessThan(0.25);
  });

  it("matches the English task-detail panel baseline", async () => {
    await loadTaskDetailBaseline("en");
    expect(await screenshotDifference("doc/ui_task_detail_en.png")).toBeLessThan(0.25);
  });

  it("renders and operates at the 760 px responsive breakpoint", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 760, height: 1000 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator(".app > header")).toHaveCSS("flex-direction", "column");
    await expectPage(page.locator(".proxy-head").first()).toHaveCSS(
      "grid-template-columns",
      "698px",
    );
    const mobileTargets = page.locator(".target-card");
    const firstMobileTarget = await requiredBox(mobileTargets.nth(0));
    const secondMobileTarget = await requiredBox(mobileTargets.nth(1));
    expect(secondMobileTarget.y).toBeGreaterThan(
      firstMobileTarget.y + firstMobileTarget.height / 2,
    );
    expect(
      screenshotContentRatio(await page.screenshot({ animations: "disabled" })),
    ).toBeGreaterThan(0.05);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-list")).toHaveCSS("border-right-width", "0px");
    await expectPage(page.locator(".log-list")).toHaveCSS("border-bottom-width", "1px");
    const screenshot = PNG.sync.read(await page.screenshot({ animations: "disabled" }));
    expect({ width: screenshot.width, height: screenshot.height }).toEqual({
      width: 760,
      height: 1000,
    });
  });
});
