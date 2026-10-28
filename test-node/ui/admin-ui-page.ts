import { expect } from "vitest";
import pixelmatch from "pixelmatch";
import type { Locator } from "@playwright/test";
import { expect as expectPage } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { PNG } from "pngjs";
import {
  lbBindingBaselineRows,
  lbStatusReads,
  pairs,
  setLbBindingVisualRows,
  setTaskBriefCopy,
  setTaskBriefFixture,
  statisticsBaselineFixtures,
  UI_TEST_TIMEOUT_MS,
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
  // The baseline shows a generated brief, in the page's own language: its overview, its
  // stages and its gap all read in the language the capture is taken in.
  setTaskBriefCopy(language);
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

/**
 * The load-balancing baseline, with one node's binding list actually open.
 *
 * The page is captured at the full page height, so the list is capped to the representative
 * rows `lbBindingBaselineRows` says instead of every row the fixture can build: a capture of
 * all 25 rows would only make the image taller without showing anything the five do not show.
 * The group cards, their member rows and the node-state rows are all still in the picture, so
 * the original configuration and layout coverage is kept alongside the new list.
 */
/**
 * Blank space kept under the load-balancing capture.
 *
 * `compareCapture` allows the two captures to end at different heights and checks that the
 * rows one of them has and the other lacks are blank. That held while the tail was empty
 * space; it stopped holding when the binding list became the last thing on the page. With
 * the 52 px pad the blank tail measured 31 px on both sides, while the same page rendered
 * 32 px shorter on the Linux runner in Chinese, 32 px taller there in English and 54 px
 * shorter on the windows runner in English, so the last ink rows of the taller capture fell
 * outside the compared band and the blank-row check failed on text that had not moved.
 * The pad is therefore set above the largest drift seen: the tail below the last ink row is
 * the tolerance, and 150 px leaves about 129 px of it.
 */
const LB_CAPTURE_PAD = 150;

export async function loadLbBaseline(language: "zh" | "en"): Promise<void> {
  setLbBindingVisualRows(lbBindingBaselineRows);
  pairs.splice(0, pairs.length, ...visualLbPairs());
  await page.setViewportSize({ width: 1278, height: 900 });
  await loadAdminPage();
  await page.locator("#languageSelect").selectOption(language);
  await expectPage(page.locator(".lb-card")).toHaveCount(2);
  await expectPage(page.locator(".lb-member-row")).toHaveCount(4);
  await expectPage(page.locator(".lb-picker-pop").first()).toBeHidden();
  const firstCard = page.locator(".lb-card").first();
  const firstNodeState = firstCard.locator(".lb-node-state").nth(0);
  await firstCard.locator(".lb-status > summary").click();
  await expectPage(firstCard.locator(".lb-node-state")).toHaveCount(2);
  await firstNodeState.locator("[data-lb-bindings-toggle]").click();
  const bindingPanel = firstNodeState.locator(".lb-binding-panel");
  await expectPage(bindingPanel.locator(".lb-binding")).toHaveCount(lbBindingBaselineRows);
  await expectPage(bindingPanel.locator("[data-lb-binding-loading]")).toHaveCount(0);
  // The node's own numbers arrive with a status read, so the capture waits for one: taken
  // before that tick the picture would show the placeholders the card writes before any
  // answer, including "Bindings: 0" above a list that is plainly not empty.
  const seenStatusReads = lbStatusReads.length;
  await expect
    .poll(() => lbStatusReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
    .toBeGreaterThan(seenStatusReads);
  await expectPage(firstNodeState.locator('[data-lb-fact="bindings"]')).toHaveText(
    new RegExp(`: ${lbBindingBaselineRows}$`),
  );
  const height = await page.evaluate(() => {
    const el = document.querySelector("#proxies");
    return el ? el.scrollHeight : 0;
  });
  await page.setViewportSize({
    width: 1278,
    height: Math.min(Math.max(height + LB_CAPTURE_PAD, 900), 4200),
  });
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
  try {
    return compareCapture(actual, baseline);
  } catch (error: unknown) {
    // A mismatch is unreadable from a CI log alone: it names the two numbers but not
    // which block moved. Keep the capture the runner produced so it can be diffed
    // against the committed baseline, and keep the original assertion as the failure.
    const failed = `test-results/ui-visual/${basename(baselinePath)}`;
    await mkdir(dirname(failed), { recursive: true });
    await writeFile(failed, actualBuffer);
    console.error(`[visual] wrote the ${baselinePath} capture to ${failed}`);
    throw error;
  }
}

function compareCapture(
  actual: { readonly width: number; readonly height: number; readonly data: Buffer },
  baseline: { readonly width: number; readonly height: number; readonly data: Buffer },
): number {
  expect(actual.width).toBe(baseline.width);
  // The capture height is derived from the document, so it follows how the installed
  // fonts wrapped the text: on the Linux runner the same load-balancing page is 17 px
  // shorter in Chinese and 16 px taller in English than on Windows, while every extra
  // row on either side is blank. Asserting the height therefore failed for a difference
  // no content change could explain. What matters is that the rows one capture has and
  // the other lacks are blank, which the loop below checks: real content loss grows
  // those rows with ink, and content that moved shows up in the pixel ratio.
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
