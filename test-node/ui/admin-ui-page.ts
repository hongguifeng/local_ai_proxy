import { expect } from "vitest";
import pixelmatch from "pixelmatch";
import type { Locator } from "@playwright/test";
import { expect as expectPage } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import {
  pairs,
  setTaskBriefFixture,
  statisticsBaselineFixtures,
  visualLbPairs,
} from "./admin-ui-fixture.js";
import { baseUrl, page } from "./admin-ui-server.js";

export async function setScrollTop(locator: Locator, value: number): Promise<number> {
  return locator.evaluate((element, nextValue) => {
    Reflect.set(element, "scrollTop", nextValue);
    const actual: unknown = Reflect.get(element, "scrollTop");
    return typeof actual === "number" ? actual : 0;
  }, value);
}

export async function scrollTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const value: unknown = Reflect.get(element, "scrollTop");
    return typeof value === "number" ? value : 0;
  });
}

export async function openRecordDetail(recordId: string): Promise<void> {
  await loadAdminPage();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/logs?")),
    page.locator('[data-tab="logs"]').click(),
  ]);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
    page.locator('[data-group-toggle="task-one"]').click(),
  ]);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/logs/${recordId}`)),
    page.locator(`[data-log-id="${recordId}"]`).click(),
  ]);
}

export async function loadStatisticsBaseline(language: "zh" | "en"): Promise<void> {
  const fixtures = statisticsBaselineFixtures();
  let overviewCalls = 0;
  await page.route("**/api/usage-statistics/options*", (route) =>
    route.fulfill({ json: fixtures.options }),
  );
  await page.route("**/api/usage-statistics/overview*", (route) =>
    route.fulfill({ json: fixtures.overview[overviewCalls++ % 3] }),
  );
  await page.route("**/api/usage-statistics/trend*", (route) =>
    route.fulfill({ json: fixtures.trend }),
  );
  await page.setViewportSize({ width: 1278, height: 900 });
  await loadAdminPage();
  await page.locator("#languageSelect").selectOption(language);
  await page.locator('[data-tab="statistics"]').click();
  await page.locator("#statsFollowNow").uncheck();
  await page.locator("#statsFrom").fill("2026-01-05T18:30");
  await page.locator("#statsTo").fill("2026-01-12T18:30");
  await expectPage(page.locator("#statsOverview .stat-card")).toHaveCount(4);
  await expectPage(page.locator(".trend-card table tbody tr")).toHaveCount(7);
  const height = await page.evaluate(() => {
    const el = document.querySelector("#statistics");
    return el ? el.scrollHeight : 0;
  });
  await page.setViewportSize({ width: 1278, height: Math.min(Math.max(height + 52, 900), 4200) });
}

export async function loadTaskDetailBaseline(language: "zh" | "en"): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 1180 });
  await loadAdminPage();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/logs?")),
    page.locator('[data-tab="logs"]').click(),
  ]);
  await page.locator("#languageSelect").selectOption(language);
  // The baseline shows a generated brief, in the page's own language.
  setTaskBriefFixture(
    language === "zh"
      ? "通过多轮对话调试本地代理的流式转发与计价规则。"
      : "Debugging the local proxy's streaming relay and pricing through a multi-turn conversation.",
  );
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/log-groups/task-one/pricing")),
    page.waitForResponse((response) =>
      response.url().endsWith("/api/log-groups/task-one/pricing/tokens"),
    ),
    page.waitForResponse((response) =>
      response.url().endsWith("/api/log-groups/task-one/pricing/costs"),
    ),
    page.waitForResponse((response) =>
      response.url().endsWith("/api/log-groups/task-one/pricing/output-tokens"),
    ),
    page.locator('[data-group-id="task-one"]').click(),
  ]);
  await expectPage(page.locator("#pricingPanel")).toBeVisible();
  await expectPage(page.locator("#pricingPanel .token-chart svg")).toBeVisible();
  await expectPage(page.locator("#pricingPanel .cost-chart svg")).toBeVisible();
  await expectPage(page.locator("#pricingPanel .output-token-chart svg")).toBeVisible();
  const panelHeight = await page.evaluate(() => {
    const el = document.querySelector("#pricingPanel");
    return el ? el.scrollHeight : 0;
  });
  await page.setViewportSize({
    width: 1180,
    height: Math.min(Math.max(panelHeight + 52, 1180), 4200),
  });
}

export async function loadAdminPage(): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/api/pairs") && response.request().method() === "GET",
    ),
    page.goto(baseUrl, { waitUntil: "domcontentloaded" }),
  ]);
}

export async function requiredBox(
  locator: Locator,
): Promise<NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Expected a visible element bounding box.");
  }
  return box;
}

export async function loadLbBaseline(language: "zh" | "en"): Promise<void> {
  pairs.splice(0, pairs.length, ...visualLbPairs());
  await page.setViewportSize({ width: 1278, height: 900 });
  await loadAdminPage();
  await page.locator("#languageSelect").selectOption(language);
  await expectPage(page.locator(".lb-card")).toHaveCount(2);
  await expectPage(page.locator(".lb-member-row")).toHaveCount(4);
  await expectPage(page.locator(".lb-picker-pop").first()).toBeHidden();
  const height = await page.evaluate(() => {
    const el = document.querySelector("#proxies");
    return el ? el.scrollHeight : 0;
  });
  await page.setViewportSize({ width: 1278, height: Math.min(Math.max(height + 52, 900), 4200) });
}

export async function screenshotDifference(baselinePath: string): Promise<number> {
  if (process.env["REGEN_BASELINES"] === "1") {
    await writeFile(baselinePath, await page.screenshot({ animations: "disabled" }));
    console.log(`[regen] wrote ${baselinePath}`);
    return 0;
  }
  const [actualBuffer, baselineBuffer] = await Promise.all([
    page.screenshot({ animations: "disabled" }),
    readFile(baselinePath),
  ]);
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  expect(actual.width).toBe(baseline.width);
  // The document height can drift a few pixels between environments because of
  // fractional-pixel rounding (e.g. aspect-ratio SVGs). Treat a page as
  // unchanged when the overlap is identical and any extra rows are blank.
  expect(Math.abs(actual.height - baseline.height)).toBeLessThanOrEqual(4);
  const rows = Math.min(actual.height, baseline.height);
  const stride = actual.width * 4;
  const sliceRows = (image: { data: Buffer }) => {
    const out = Buffer.alloc(rows * stride);
    for (let y = 0; y < rows; y++) {
      Buffer.from(image.data.subarray(y * stride, (y + 1) * stride)).copy(out, y * stride);
    }
    return out;
  };
  const differentPixels = pixelmatch(
    sliceRows(actual),
    sliceRows(baseline),
    undefined,
    actual.width,
    rows,
    { threshold: 0.2 },
  );
  // Blank means "no content", which also covers the light borders that sit at the
  // bottom edge of these captures (the splitter line between the two panes renders
  // at 213,221,231). Requiring channels above 230 made every few-pixel height drift
  // on the windows runner fail here, because six border pixels per row are not
  // near-white. Dark text, chips, or buttons are still far below 200, so a capture
  // that really lost content cannot pass this check.
  for (const image of [actual, baseline]) {
    if (image.height <= rows) continue;
    for (let y = rows; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        const r = image.data[i] ?? 255,
          g = image.data[i + 1] ?? 255,
          b = image.data[i + 2] ?? 255,
          a = image.data[i + 3] ?? 255;
        expect(a < 10 || (r >= 200 && g >= 200 && b >= 200)).toBe(true);
      }
    }
  }
  return differentPixels / (baseline.width * baseline.height);
}

export async function moveRowSplitterTo(y: number): Promise<void> {
  const splitter = page.locator("#splitter");
  const box = await requiredBox(splitter);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.up();
}

export function screenshotContentRatio(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
  let nonWhitePixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      (image.data[offset] ?? 255) < 250 ||
      (image.data[offset + 1] ?? 255) < 250 ||
      (image.data[offset + 2] ?? 255) < 250
    ) {
      nonWhitePixels += 1;
    }
  }
  return nonWhitePixels / (image.width * image.height);
}
