import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

describe("statistics page visual smoke", () => {
  it("renders bounded SVG charts with mock statistics", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {
            requests: 2,
            tasks: 1,
            input: "1234567",
            output: "7654321",
            cache_read: "11223344",
            cache_write: "0",
            cost: "88.5",
          },
          byTarget: [{ id: "a", value: "10" }],
          byModel: [
            { id: "gpt-6-astra", value: "65" },
            { id: "gpt-5.6-terra", value: "25" },
            { id: "gpt-5.6-sol", value: "9" },
            { id: "gpt-5.5", value: "1" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator(".pie-chart svg").first()).toHaveAttribute(
      "viewBox",
      "0 0 600 260",
    );
    await expectPage(page.locator(".stats-empty")).toHaveCount(1);
    await page.screenshot({ path: "test-results/statistics-page-smoke.png", fullPage: true });
  });
  it("groups low-share distribution and trend categories into Other", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [{ id: "target-a", value: "96", cost: "96" }],
          byModel: [
            { id: "model-a", value: "60", cost: "60" },
            { id: "model-b", value: "25", cost: "25" },
            { id: "model-c", value: "6", cost: "6" },
            { id: "model-d", value: "2", cost: "2" },
            { id: "model-e", value: "1", cost: "1" },
            { id: "model-f", value: "1", cost: "1" },
            { id: "model-g", value: "1", cost: "1" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({
        json: {
          dataVersion: 1,
          granularity: "day",
          points: [
            {
              bucket: "2026-09-01",
              requests: 5,
              tasks: 1,
              input: "96",
              output: "0",
              cache_read: "0",
              cache_write: "0",
              cost: "96000000000",
              by_model: [
                {
                  id: "model-a",
                  input: "60",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "60000000000",
                },
                {
                  id: "model-b",
                  input: "25",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "25000000000",
                },
                {
                  id: "model-c",
                  input: "6",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "6000000000",
                },
                {
                  id: "model-d",
                  input: "2",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "2000000000",
                },
                {
                  id: "model-e",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
                {
                  id: "model-f",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
                {
                  id: "model-g",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
              ],
            },
          ],
        },
      }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    const modelPie = page.locator(".distribution-card").nth(1);
    await expectPage(modelPie.locator(".pie-segment")).toHaveCount(4);
    await expectPage(modelPie).toContainText("Other");
    await expectPage(modelPie).not.toContainText("model-d");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(4);
    await expectPage(page.locator(".trend-legend")).toContainText("Other");
    await expectPage(page.locator(".trend-legend")).not.toContainText("model-d");
  });
  it("re-renders statistics labels when the language switches", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [{ id: "a", name: "A" }], models: ["m"] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [{ id: "a", value: "10" }],
          byModel: [{ id: "m", value: "10" }],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "Target distribution",
    );
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "转发地址分布",
    );
    await expectPage(page.locator("#statsTrend .trend-card h3")).toHaveText("使用趋势");
    await expectPage(page.locator("#statsTarget option").first()).toHaveText("全部转发地址");
    await page.screenshot({ path: "test-results/statistics-page-language-zh.png", fullPage: true });
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "Target distribution",
    );
    await expectPage(page.locator("#statsTrend .trend-card h3")).toHaveText("Usage trend");
  }, 30000);
  it("serializes granularity and filter selections", async () => {
    const requests: string[] = [];
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [{ id: "a", name: "A" }], models: ["m"] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) => {
      requests.push(route.request().url());
      return route.fulfill({ json: { dataVersion: 1, granularity: "month", points: [] } });
    });
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsTarget option")).toHaveCount(2);
    await page.locator("#statsTarget").selectOption("a");
    await page.locator("#statsModel").selectOption("m");
    await page.locator("#statsGranularity").selectOption("month");
    await expectPage
      .poll(() => requests.some((url) => url.includes("granularity=month")))
      .toBe(true);
    expect(requests.some((url) => url.includes("targetId=a") && url.includes("model=m"))).toBe(
      true,
    );
  });
  it("recomputes trend scale and units when switching to cost", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({
        json: {
          dataVersion: 1,
          granularity: "day",
          points: [
            {
              bucket: "2026-09-01",
              requests: 1,
              tasks: 1,
              input: "100",
              output: "10",
              cache_read: "0",
              cache_write: "0",
              cost: "100000000",
              by_model: [
                {
                  id: "model-a",
                  input: "60",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "60000000",
                },
                {
                  id: "model-b",
                  input: "40",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "40000000",
                },
              ],
            },
            {
              bucket: "2026-09-02",
              requests: 100,
              tasks: 1,
              input: "1",
              output: "1",
              cache_read: "0",
              cache_write: "0",
              cost: "10000000",
              by_model: [
                {
                  id: "model-a",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "6000000",
                },
                {
                  id: "model-b",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "4000000",
                },
              ],
            },
          ],
        },
      }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    // Token peak is 100 tokens, so the nice tick step is 25 and the axis ends
    // on the first multiple of it above the peak (100), not a round 200 or 500.
    await expectPage(page.locator(".trend-yaxis span")).toHaveCount(5);
    await expectPage(page.locator(".trend-gridline")).toHaveCount(5);
    await expectPage(page.locator(".trend-yaxis span").last()).toHaveText(/^100$/);
    // The trend grouping defaults to the stacked by-model breakdown.
    await expectPage(page.locator("#statsBreakdown")).toHaveValue("model");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(2);
    await page.locator("#statsBreakdown").selectOption("total");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(4);
    await page.locator("#statsMetricTrend").selectOption("cost");
    await expectPage(page.locator("#statsMetricTrend")).toHaveValue("cost");
    // Cost peak is ¥0.1, so the step is ¥0.025 and the axis stops at the peak.
    await expectPage(page.locator(".trend-yaxis span")).toHaveCount(5);
    await expectPage(page.locator(".trend-gridline")).toHaveCount(5);
    await expectPage(page.locator(".trend-yaxis span").last()).toHaveText(/0\.1$/);
    // The axis must also stay clear of the old ¥1 floor, which shrank every
    // cheap task to a tenth of the plot.
    const costPeakFill = await page.evaluate(() => {
      const heights = [...document.querySelectorAll(".trend-bar")].map(
        (bar) => (bar as HTMLElement).getBoundingClientRect().height,
      );
      return Math.max(...heights) / 200;
    });
    expect(costPeakFill).toBeGreaterThan(0.9);
    await expectPage(page.locator(".trend-segment.cost")).toHaveCount(2);
    await page.locator("#statsBreakdown").selectOption("model");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(2);
    const costSegmentColors = await page
      .locator(".trend-item")
      .first()
      .locator(".trend-segment")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.backgroundColor));
    expect(new Set(costSegmentColors).size).toBe(2);
  });
  it("keeps a cost trend peak filling the plot instead of a round axis ceiling", async () => {
    // A ¥25.37 daily peak used to be rounded up to a ¥50 axis, so the tallest
    // bar covered half the chart and the statistics view looked half empty.
    const costPoint = (bucket: string, model: string, costNano: string, tokens: string) => ({
      bucket,
      requests: 10,
      tasks: 2,
      input: tokens,
      output: "0",
      cache_read: "0",
      cache_write: "0",
      cost: costNano,
      unpriced: 0,
      by_model: [
        {
          id: model,
          input: tokens,
          output: "0",
          cache_read: "0",
          cache_write: "0",
          cost: costNano,
        },
      ],
    });
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({
        json: {
          dataVersion: 1,
          granularity: "day",
          points: [
            costPoint("2026-09-27", "model-a", "8642700000", "1000"),
            costPoint("2026-09-28", "model-b", "25370506208", "2000"),
            costPoint("2026-09-29", "model-a", "18693000000", "3000"),
          ],
        },
      }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await page.locator("#statsMetricTrend").selectOption("cost");
    await expectPage(page.locator(".trend-yaxis span").last()).toHaveText(/30$/);
    await expectPage(page.locator(".trend-gridline")).toHaveCount(4);
    const peakFill = await page.evaluate(() => {
      const heights = [...document.querySelectorAll(".trend-bar")].map(
        (bar) => (bar as HTMLElement).getBoundingClientRect().height,
      );
      return Math.max(...heights) / 200;
    });
    expect(peakFill).toBeGreaterThan(0.8);
  });
  it("switches each distribution chart to cost independently with consistent controls", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [
            { id: "openrouter", value: "26189600000", cost: "26.189600000" },
            { id: "vllm", value: "7450700000", cost: "7.450700000" },
            { id: "deepseek", value: "11400000", cost: "0.011400000" },
          ],
          byModel: [
            { id: "gpt-6-astra", value: "20045700000", cost: "20.045700000" },
            { id: "gpt-5.6-terra", value: "6143900000", cost: "6.143900000" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    const targetMetric = page.locator("#statsMetricTarget");
    const modelMetric = page.locator("#statsMetricModel");
    await expectPage(targetMetric).toHaveValue("token");
    await expectPage(modelMetric).toHaveValue("token");
    const controlStyle = await targetMetric.evaluate((el) => {
      const style = getComputedStyle(el);
      return { borderRadius: style.borderRadius, width: style.width };
    });
    expect(Number.parseFloat(controlStyle.borderRadius)).toBeGreaterThan(0);
    expect(Number.parseFloat(controlStyle.width)).toBeLessThan(130);
    await targetMetric.selectOption("cost");
    await expectPage(
      page.locator(".distribution-card").first().locator(".pie-center-value"),
    ).toHaveText("$33.6517");
    await expectPage(
      page.locator(".distribution-card").nth(1).locator(".pie-center-value"),
    ).not.toHaveText("$26.1896");
    await modelMetric.selectOption("cost");
    await expectPage(
      page.locator(".distribution-card").nth(1).locator(".pie-center-value"),
    ).toHaveText("$26.1896");
  });
  it("shows an explicit warning when records are unpriced", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: { requests: 1 },
          byTarget: [],
          byModel: [],
          unpriced: { missing_usage: 2 },
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsUnpricedNote")).toHaveText("(unpriced 2)");
    await expectPage(page.locator(".stat-card-unpriced")).toHaveCount(0);
  });

  it("exports the active statistics filters", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({
        json: { targets: [{ id: "target-a", name: "Target A" }], models: ["model-a"] },
      }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {
            requests: 0,
            tasks: 0,
            input: "0",
            output: "0",
            cache_read: "0",
            cache_write: "0",
            cost: "0",
          },
          byTarget: [],
          byModel: [],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await page.locator('[data-stats-range="0"]').click();
    const todayRangeValid = await page.evaluate(() => {
      const from = document.querySelector("#statsFrom");
      const to = document.querySelector("#statsTo");
      if (from === null || to === null) return false;
      return (
        from instanceof HTMLInputElement &&
        to instanceof HTMLInputElement &&
        new Date(from.value).getTime() < new Date(to.value).getTime()
      );
    });
    expect(todayRangeValid).toBe(true);
    await page.locator('[data-stats-range="1"]').click();
    await expectPage(page.locator('[data-stats-range="1"]')).toHaveClass(/active/);
    await page.locator("#statsTarget").selectOption("target-a");
    await page.locator("#statsModel").selectOption("model-a");
    await page.locator("#statsGranularity").selectOption("month");
    const popupPromise = page.waitForEvent("popup");
    await page.locator("#exportStatistics").click();
    const popup = await popupPromise;
    await expectPage(popup).toHaveURL(
      /\/api\/usage-statistics\/export\?.*granularity=month.*targetId=target-a.*model=model-a/,
    );
    await popup.close();
  });
});
