import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  TASK_BRIEF_GENERATED_TEXT,
  TASK_BRIEF_TIMELINE_STEPS,
  UI_TEST_TIMEOUT_MS,
  deletedLogGroups,
  detailReads,
  groupLogQueries,
  logQueries,
  setTaskBriefFixture,
  setTaskBriefStale,
  setTaskBriefTimeline,
  setUseLargeGroupLogFixture,
  setUseLargeLogFixture,
  setUseLargeLogRequestCount,
  setUseSummarizedLogFixture,
  taskBriefPosts,
} from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import {
  loadAdminPage,
  openRecordDetail,
  requiredBox,
  scrollTop,
  setScrollTop,
} from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

describe("admin UI history page", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("[AI-21] preserves unchanged section nodes and rebuilds displayed fields and language", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await expectPage(page.locator(".log-group")).toHaveCount(4);
    await page.locator("#autoRefreshLogs").uncheck();
    const section = page.locator('.log-group:has([data-group-id="task-one"])');
    const original = await section.elementHandle();
    const neighbor = await page.locator(".log-group").nth(1).elementHandle();
    const refresh = async () => {
      await page.locator("#refreshLogs").click();
      await expectPage(page.locator("#logListProgress")).toBeHidden();
    };
    await refresh();
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { groups: Record<string, unknown>[] };
      data.groups = data.groups.map((group) =>
        group["id"] === "task-one" ? { ...group, decode_speed_tps: 17.5 } : group,
      );
      await route.fulfill({ response, json: data });
    });
    await refresh();
    await expectPage(section.locator(".log-group-decode-speed")).toHaveText("17.5t/s");
    expect(await original.evaluate((node) => node.isConnected)).toBe(false);
    expect(await neighbor.evaluate((node) => node.isConnected)).toBe(true);
    await section.locator("[data-select-group]").check();
    const beforeLanguage = await section.elementHandle();
    await page.locator("#languageSelect").selectOption("zh");
    expect(await beforeLanguage.evaluate((node) => node.isConnected)).toBe(false);
    await expectPage(section.locator("[data-select-group]")).toBeChecked();
    await expectPage(section.locator(".log-request-count")).not.toContainText("requests");
  });

  it("[AI-21] keeps task DOM on equal refresh and rebuilds data while preserving model expansion", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await page.locator("#autoRefreshLogs").uncheck();
    await page.locator('[data-group-id="task-one"]').click();
    const panel = page.locator("#pricingPanel");
    await expectPage(panel.locator(".output-token-chart .token-chart-dot")).toHaveCount(3);
    const model = panel.locator("details[data-price-group-model]");
    await model.locator("summary").click();
    await expectPage(model).toHaveJSProperty("open", true);
    // The first refresh records the newly opened group in the render snapshot.
    const refresh = async () => {
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/task-one/pricing/output-tokens"),
        ),
        page.locator("#refreshLogs").click(),
      ]);
      await expectPage(page.locator("#logListProgress")).toBeHidden();
      // All three independent series must have settled before taking node identity.
      await expectPage(panel.locator(".token-chart .token-chart-dot")).toHaveCount(5);
      await expectPage(panel.locator(".cost-chart .token-chart-dot")).toHaveCount(3);
    };
    await refresh();
    const original = await panel.locator(".task-summary").elementHandle();
    await refresh();
    expect(await original.evaluate((node) => node.isConnected)).toBe(true);
    await page.route("**/api/log-groups/task-one/pricing", async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...data, active_request_ms: 30_000 } });
    });
    await refresh();
    // The card grid shows the changed request total, and the title line keeps
    // naming the same task by its id across the rebuild.
    await expectPage(panel.locator(".stat-card.task-stat-time")).toContainText("00:30");
    await expectPage(panel.locator(".pricing-panel-task-id")).toHaveText("task-one");
    expect(await original.evaluate((node) => node.isConnected)).toBe(false);
    await expectPage(model).toHaveJSProperty("open", true);
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator(".pricing-panel-head")).not.toContainText("Task details");
    await expectPage(model).toHaveJSProperty("open", true);
  });

  it("[AI-21] invalidates changed lazy JSON, retains equal input, and fills without reading pane width", async () => {
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await page.evaluate(`
      const stringLength = Math.floor(document.getElementById('requestJson').clientWidth / 9);
      window.__ai21Apply = (text) => {
        const children = Object.fromEntries(Array.from({length: 1600}, (_, i) => ['key' + i, text.padEnd(stringLength, 'x')]));
        window.__adminUiTest.applySelectedLogDetail(
          {request: {branch: {leaf: children}}, response: null}, {resetView: false});
      };
      window.__ai21Apply('first-value');
    `);
    const lazy = page.locator('#requestJson [data-json-lazy="1"]').first();
    await expectPage(lazy).toHaveCount(1);
    await page.evaluate(`
      window.__ai21WidthReads = [];
      window.__ai21LateMeasurements = [];
      let childrenWritten = false;
      const children = document.querySelector('#requestJson [data-json-lazy] > .json-children');
      const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(children, 'innerHTML', {configurable: true, get() { return html.get.call(this); }, set(value) {
        html.set.call(this, value);
        childrenWritten = true;
      }});
      const offsets = ['offsetWidth', 'offsetHeight'].map((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
        Object.defineProperty(HTMLElement.prototype, name, {...descriptor, get() {
          if (childrenWritten && new Error().stack.includes('materializeJsonNode'))
            window.__ai21LateMeasurements.push(name);
          return descriptor.get.call(this);
        }});
        return [name, descriptor];
      });
      window.__ai21RestoreOffsets = () => offsets.forEach(([name, descriptor]) =>
        Object.defineProperty(HTMLElement.prototype, name, descriptor));
      const pane = document.getElementById('requestJson');
      const getter = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth').get;
      Object.defineProperty(pane, 'clientWidth', {configurable: true, get() {
        window.__ai21WidthReads.push(new Error().stack);
        return getter.call(this);
      }});
      pane.querySelector('[data-json-lazy="1"]').open = true;
    `);
    await expectPage(lazy).toHaveAttribute("data-json-lazy-done", "1");
    await expectPage(page.locator("#requestJson")).toContainText("first-value");
    expect(
      await page.evaluate(
        `window.__ai21WidthReads.filter((stack) => stack.includes('materializeJsonNode')).length`,
      ),
    ).toBe(0);
    expect(await page.evaluate("window.__ai21LateMeasurements")).toEqual([]);
    await page.evaluate("window.__ai21RestoreOffsets()");
    const filled = await lazy.elementHandle();
    await page.evaluate(`window.__ai21Apply('first-value')`);
    expect(await filled.evaluate((node) => node.isConnected)).toBe(true);
    await expectPage(lazy).toHaveJSProperty("open", true);
    // Only a hidden leaf changes: initial lazy markup is otherwise byte-identical.
    await page.evaluate(`window.__ai21Apply('second-value')`);
    await expectPage(page.locator("#requestJson")).toContainText("second-value");
    await expectPage(page.locator("#requestJson")).not.toContainText("first-value");
    expect(await filled.evaluate((node) => node.isConnected)).toBe(false);
    await expectPage(page.locator("#requestJson [data-json-lazy]").first()).toHaveJSProperty(
      "open",
      true,
    );
    await page.evaluate(`delete document.getElementById('requestJson').clientWidth`);
    const beforeResize = await lazy.elementHandle();
    await page.evaluate(`document.getElementById('requestJson').style.width = '100px'`);
    await page.evaluate(`window.__ai21Apply('second-value')`);
    expect(await beforeResize.evaluate((node) => node.isConnected)).toBe(false);
    await expectPage(page.locator("#requestJson .json-str-detail").first()).toBeAttached();
    await expectPage(page.locator("#requestJson [data-json-lazy]").first()).toHaveJSProperty(
      "open",
      true,
    );
  });

  it("[AI-21] ignores a delayed detail response after a different record is selected", async () => {
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route("**/api/logs/record-one", async (route) => {
      requested?.();
      await gate;
      await route.fulfill({ json: { request: { model: "stale-response" }, response: null } });
    });
    await page.locator('[data-log-id="record-one"]').click();
    await started;
    await page.locator('[data-log-id="record-two"]').click();
    await expectPage(page.locator('[data-log-id="record-two"]')).toHaveClass(/active/);
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith("/api/logs/record-one"),
    );
    release?.();
    await delivered;
    // Drain the response continuation before checking that it cannot replace the pane.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expectPage(page.locator("#requestJson")).not.toContainText("stale-response");
    await expectPage(page.locator('[data-log-id="record-two"]')).toHaveClass(/active/);
  });

  it("[AI-21] expires an open task when its group disappears and keeps late responses out", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await page.locator("#autoRefreshLogs").uncheck();
    await page.locator('[data-group-id="task-one"]').click();
    const panel = page.locator("#pricingPanel");
    await expectPage(panel.locator(".output-token-chart .token-chart-dot")).toHaveCount(3);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let handled: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      handled = resolve;
    });
    await page.route("**/api/log-groups/task-one/pricing", async (route) => {
      requested?.();
      await gate;
      await route.fulfill({ json: { target: "expired-target" } }).catch(() => undefined);
      handled?.();
    });
    await page.locator("#refreshLogs").click();
    await started;
    deletedLogGroups.add("task-one");
    await page.locator("#refreshLogs").click();
    await expectPage(panel).toContainText("deleted");
    const expired = await panel.locator("p").elementHandle();
    release?.();
    await completed;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expectPage(panel).not.toContainText("expired-target");
    expect(await expired.evaluate((node) => node.isConnected)).toBe(true);
    await panel.locator("[data-close-pricing]").click();
    await expectPage(panel).toBeHidden();
  });

  it("searches only after the search button is clicked", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);

    await page.locator("#logSearch").fill("needle");
    await page.waitForTimeout(250);
    expect(logQueries).toEqual([]);

    await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/api/logs?q=")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(logQueries).toEqual([""]);

    logQueries.splice(0);
    const response = page.waitForResponse((candidate) => candidate.url().includes("q=needle"));
    await page.locator("#searchLogs").click();
    await response;
    expect(logQueries).toEqual(["needle"]);
    await expectPage(page.locator("#autoRefreshLogs")).toBeDisabled();
    await expectPage(page.locator(".log-model")).toHaveCount(1);
    await expectPage(page.locator(".log-model")).toHaveText("claude");

    const clearResponse = page.waitForResponse((candidate) => candidate.url().includes("q="));
    await page.locator("#logSearch").fill("");
    await page.locator("#searchLogs").click();
    await clearResponse;
    await expectPage(page.locator("#autoRefreshLogs")).toBeEnabled();
  });

  it("searches when Enter is pressed in the search box", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);
    await expectPage(page.locator(".log-model")).toHaveCount(4, {
      timeout: UI_TEST_TIMEOUT_MS,
    });

    const response = page.waitForResponse((candidate) => candidate.url().includes("q=needle"));
    await page.locator("#logSearch").fill("needle");
    await page.locator("#logSearch").press("Enter");
    await response;
    expect(logQueries).toEqual(["needle"]);
    await expectPage(page.locator("#autoRefreshLogs")).toBeDisabled();
    await expectPage(page.locator(".log-model")).toHaveCount(1);
    await expectPage(page.locator(".log-model")).toHaveText("claude");
  });

  it("shows a progress bar below the search box while a search is running", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const progress = page.locator("#logListProgress");
    await expectPage(progress).toBeHidden();

    let releaseSearch: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    await page.route("**/api/logs**", async (route) => {
      // The request can be aborted (page teardown/navigation) while the mock
      // is in flight; "Route is already handled!" must not escape into vitest.
      if (route.request().method() !== "GET") return route.continue().catch(() => undefined);
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      await release;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.locator("#searchLogs").click();
    await expectPage(progress).toBeVisible();
    releaseSearch?.();
    await expectPage(progress).toBeHidden();
    await page.unroute("**/api/logs**");
  });

  it("supports manual and automatic history refresh", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(logQueries).toEqual([""]);

    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    logQueries.splice(0);
    const automaticResponse = page.waitForResponse((response) =>
      response.url().includes("/api/logs?"),
    );
    const startedAt = Date.now();
    await autoRefresh.check();
    await automaticResponse;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(logQueries).toEqual([""]);
    await autoRefresh.uncheck();
  });

  it("refreshes a pending list item when its response finishes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-toggle="task-one"]').click(),
    ]);
    const pendingItem = page.locator('[data-log-id="record-one"]');
    await expectPage(pendingItem).toContainText("pending");

    detailReads.set("record-one", 1);
    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    // The sweep now reads finished rows in one batched body-free request; the
    // per-record detail endpoint is only used for the selected record.
    const batchSweep = page.waitForResponse((response) =>
      response.url().includes("/api/logs/records?"),
    );
    await autoRefresh.check();
    await batchSweep;

    await expectPage(pendingItem.locator(".request-tokens .log-metric-value")).toHaveText("8");
    await expectPage(pendingItem.locator(".response-tokens .log-metric-value")).toHaveText("4");
    await expectPage(pendingItem.locator(".cost .log-metric-value")).toHaveText("$0.0411");
    await expectPage(pendingItem.locator(".log-status")).toHaveCount(0);
    await expectPage(pendingItem).not.toContainText("pending");
    await autoRefresh.uncheck();

    const completedReads = detailReads.get("record-one");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(detailReads.get("record-one")).toBe(completedReads);
  });

  it("refreshes a visible task total when only its pricing summary changes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      const data = (await response.json()) as { groups: { id: string; cost?: unknown }[] };
      data.groups = data.groups.map((group) =>
        group.id === "task-one"
          ? {
              ...group,
              cost: {
                currency: "CNY",
                known_amount: "5",
                priced_request_count: 5,
                unpriced_request_count: 0,
                pending_request_count: 0,
              },
            }
          : group,
      );
      await route.fulfill({ response, json: data }).catch(() => undefined);
    });
    await page.locator("#refreshLogs").click();
    await expectPage(
      page.locator('.log-group:has([data-group-id="task-one"]) .log-group-cost'),
    ).toHaveText("$5");
    await page.unroute("**/api/logs?**");
  });

  it("marks a task whose request is still open and drops the mark when it is not", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    // The fixture keeps one open request on task-one and none on the other three, so one
    // mark proves both halves: a task with an open request shows it, a task without one
    // renders nothing.
    const task = page.locator('.log-group:has([data-group-id="task-one"])');
    const mark = task.locator(".log-group-live");
    await expectPage(page.locator(".log-group-live")).toHaveCount(1);
    await expectPage(mark).toHaveAttribute("title", "Requests in progress: 1");

    // The mark hangs on the header's shared control column: it shares the checkbox and the
    // caret's axis and centers on the fact-line row, and it never widens the column the
    // caret sizes. An alignment claim needs this probe, not a screenshot read by eye.
    const markBox = await requiredBox(mark);
    const checkbox = await requiredBox(task.locator(".log-group-select"));
    const caret = await requiredBox(task.locator(".log-group-caret"));
    const factLine = await requiredBox(task.locator(".log-group-fact-line").first());
    const markCenterX = markBox.x + markBox.width / 2;
    expect(markCenterX).toBeCloseTo(checkbox.x + checkbox.width / 2, 0);
    expect(markCenterX).toBeCloseTo(caret.x + caret.width / 2, 0);
    expect(markBox.y + markBox.height / 2).toBeCloseTo(factLine.y + factLine.height / 2, 0);
    const columnWidths = await page
      .locator(".log-group-controls")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(Math.max(...columnWidths) - Math.min(...columnWidths)).toBeLessThan(1);

    // The mark is a plain span, not a control: a click that lands on it has to reach the
    // header the way any other click on the row does, and the header opens the task detail.
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      mark.click(),
    ]);
    await expectPage(page.locator("#pricingPanel")).toBeVisible();
    await page.locator("#pricingPanel [data-close-pricing]").click();
    await expectPage(page.locator("#pricingPanel")).toBeHidden();

    // The tooltip is a dictionary label, so the language pass has to rebuild it.
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(mark).toHaveAttribute("title", "进行中的请求: 1");
    await page.locator("#languageSelect").selectOption("en");

    // The same list read with the count back to zero has to drop the mark, which is what
    // the automatic refresh does while a request is open.
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      const data = (await response.json()) as {
        groups: { id: string; cost?: Record<string, unknown> }[];
      };
      data.groups = data.groups.map((group) =>
        group.id === "task-one" && group.cost !== undefined
          ? { ...group, cost: { ...group.cost, pending_request_count: 0 } }
          : group,
      );
      await route.fulfill({ response, json: data }).catch(() => undefined);
    });
    await page.locator("#refreshLogs").click();
    await expectPage(page.locator(".log-group-live")).toHaveCount(0);
    await page.unroute("**/api/logs?**");
  });

  it("keeps an open task detail panel in step with a running task", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const group = page.locator('[data-group-id="task-one"]');
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.click(),
    ]);
    const panel = page.locator("#pricingPanel");
    // The summary card repeats the list facts for the same task.
    await expectPage(panel.locator(".task-stat-count strong")).toHaveText("6");
    await expectPage(panel.locator(".task-stat-time .task-time-end")).toHaveText("12:00:05");
    await expectPage(panel.locator(".task-stat-speed strong")).toHaveText("2.5t/s");

    // The task keeps running while the panel stays open: only the group summary
    // (request count / last activity / decode speed) moves and the pricing
    // payload is unchanged, yet the panel has to follow the task.
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      const data = (await response.json()) as { groups: Record<string, unknown>[] };
      data.groups = data.groups.map((item) =>
        item["id"] === "task-one"
          ? {
              ...item,
              request_count: 9,
              last_activity_at: "2026-07-18 12:00:41",
              decode_speed_tps: 8.5,
            }
          : item,
      );
      await route.fulfill({ response, json: data }).catch(() => undefined);
    });
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    await expectPage(panel.locator(".task-stat-count strong")).toHaveText("9");
    await expectPage(panel.locator(".task-stat-time .task-time-end")).toHaveText("12:00:41");
    await expectPage(panel.locator(".task-stat-speed strong")).toHaveText("8.5t/s");
    // Re-opening the same task re-reads the list facts instead of restoring the
    // snapshot taken on the first visit.
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.press("Enter"),
    ]);
    await expectPage(panel.locator(".task-stat-count strong")).toHaveText("9");
    await page.unroute("**/api/logs?**");
  });

  it("loads task records only when a group is expanded", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-item")).toHaveCount(0);
    expect(groupLogQueries).toEqual([]);

    // Expanding through the caret button fetches the group's records once.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-toggle="task-one"]').click(),
    ]);
    expect(groupLogQueries).toEqual(["task-one:"]);
    const completedItem = page.locator('[data-log-id="record-two"]');
    await expectPage(completedItem.locator(".request-tokens .log-metric-value")).toHaveText("8");
    await expectPage(completedItem.locator(".response-tokens .log-metric-value")).toHaveText("4");
    await expectPage(
      page.locator('[data-log-id="record-one"] .messages .log-metric-value'),
    ).toHaveText("1");
  });

  it("formats pricing precisely and keeps the two-level history layout compact", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);

    await expect(
      page.evaluate(
        (amounts) => {
          // The module graph publishes exactly this surface for the browser tests.
          const formatter = (
            window as unknown as Window & {
              __adminUiTest: { formatCurrencyAmount: (amount: string | null) => string };
            }
          ).__adminUiTest.formatCurrencyAmount;
          return amounts.map((amount) => formatter(amount));
        },
        ["5", "0.03", "0.041125", "0.042750", "0.00001", "0", null],
      ),
    ).resolves.toEqual(["$5", "$0.03", "$0.0411", "$0.0428", "< $0.0001", "$0", "—"]);

    const group = page.locator(".log-group").first();
    const summary = group.locator(".log-group-summary");
    await expectPage(summary.locator(".log-group-time")).toHaveCount(1);
    await expectPage(summary.locator(".log-group-fact-line")).toHaveCount(2);
    await expectPage(summary.locator(".log-group-fact-line").first()).toContainText("gpt-5");
    await expectPage(summary.locator(".log-group-fact-line").first()).toContainText("6 requests");
    await expectPage(summary.locator(".log-group-cost")).toHaveText("$0.0428");
    await expectPage(summary.locator(".log-group-decode-speed")).toHaveText("2.5t/s");
    await expectPage(summary.locator(".log-target")).toHaveText("fixture-target");
    await expectPage(group.locator("button button")).toHaveCount(0);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      group.locator(".log-group-caret").click(),
    ]);
    const priced = page.locator('[data-log-id="record-three"]');
    await expectPage(priced.locator(".decode-speed .log-metric-label")).toHaveText("Speed");
    await expectPage(priced.locator(".decode-speed .log-metric-value")).toHaveText("30.1t/s");
    expect(await priced.locator(".log-item-metrics .log-metric-label").allTextContents()).toEqual([
      "messages",
      "Request",
      "Response",
      "Speed",
      "Cost",
    ]);
    await expectPage(page.locator('[data-log-id="record-two"] .decode-speed')).toHaveCount(0);
    await expectPage(page.locator('[data-log-id="record-one"] .decode-speed')).toHaveCount(0);
    // The tool-call-only request has no measured first-token time, so the
    // detail falls back to a full-duration decode estimate and skips prefill.
    await expectPage(
      page.locator('[data-log-id="record-six"] .end-to-end-speed .log-metric-value'),
    ).toHaveText("50.0t/s");
    await page.locator('[data-log-id="record-six"]').click();
    await expectPage(page.locator("#responseTiming")).toContainText("End-to-end 50.0 tok/s");
    await expectPage(page.locator("#responseTiming")).not.toContainText("Decode");
    await expectPage(page.locator("#responseTiming")).not.toContainText("Prefill");
    await expectPage(priced.locator(".cost .log-metric-label")).toHaveText("Cost");
    await expectPage(priced.locator(".cost .log-metric-value")).toHaveText("$0.0411");
    await expectPage(page.locator('[data-log-id="record-two"] .cost .log-metric-value')).toHaveText(
      "< $0.0001",
    );
    await expectPage(page.locator('[data-log-id="record-one"] .cost .log-metric-value')).toHaveText(
      "Calculating…",
    );
    await expectPage(
      page.locator('[data-log-id="record-four"] .cost .log-metric-value'),
    ).toHaveText("—");

    // Keyboard: Enter/Space on the header only opens the task detail panel;
    // the caret button is the toggle for the second level.
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.locator(".log-group-head").press("Enter"),
    ]);
    await expectPage(page.locator("#pricingPanel")).toBeVisible();
    await expectPage(group.locator(".log-group-body")).toHaveCount(1);
    await group.locator(".log-group-caret").press(" ");
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await group.locator(".log-group-caret").press("Enter");
    await expectPage(group.locator(".log-group-body")).toHaveCount(1);
  });

  it("marks records with a generated intelligent summary with a star", async () => {
    setUseSummarizedLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-toggle="task-one"]').click(),
    ]);
    const starred = page.locator('[data-log-id="record-five"] .log-summary-star');
    await expectPage(starred).toHaveCount(1);
    await expectPage(starred).toHaveText("★");
    await expectPage(page.locator(".log-summary-star")).toHaveCount(1);
  });

  it("opens task and request pricing details without changing task selection or expansion", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const group = page.locator(".log-group").first();
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await expectPage(group.locator('[data-select-group="task-one"]')).not.toBeChecked();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.locator(".log-group-head").press("Enter"),
    ]);
    const panel = page.locator("#pricingPanel");
    await expectPage(panel).toBeVisible();
    await expectPage(panel).toContainText("Task details");
    await expectPage(panel).toContainText("$0.0428");
    await expectPage(panel).toContainText("Task time");
    await expectPage(panel).toContainText("00:05");
    await expectPage(panel).toContainText("Request time");
    await expectPage(panel).toContainText("00:25");
    // The title line names the task by its id, and the summary is the card
    // grid alone: the id is the panel's identity, not a fact cell, and the
    // target address the task used is the list header's third row.
    await expectPage(panel.locator(".pricing-panel-task-id")).toHaveText("task-one");
    await expectPage(panel.locator(".pricing-panel-task-id")).toHaveAttribute(
      "aria-label",
      "Task ID",
    );
    // Where the id sits is an alignment claim, so measure it instead of reading
    // a screenshot: the id starts one head gap after the title ends, and the
    // free space lies between the id and the close button rather than between
    // the title and the id.
    const geometry = await panel.locator(".pricing-panel-head").evaluate((head) => {
      const read = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          left: Math.round(box.left),
          right: Math.round(box.right),
        };
      };
      const title = head.firstElementChild;
      const id = title?.nextElementSibling;
      const button = id?.nextElementSibling;
      if (
        !(title instanceof HTMLElement) ||
        !(id instanceof HTMLElement) ||
        !(button instanceof HTMLElement)
      ) {
        throw new Error(`the head holds ${head.children.length} children, not three`);
      }
      return {
        tags: [read(title), read(id), read(button)].map((box) => box.tag),
        titleToId: read(id).left - read(title).right,
        idToButton: read(button).left - read(id).right,
      };
    });
    expect(geometry.tags).toEqual(["strong", "span", "button"]);
    expect(geometry.titleToId).toBeGreaterThanOrEqual(11);
    expect(geometry.titleToId).toBeLessThanOrEqual(13);
    expect(geometry.idToButton).toBeGreaterThan(40);
    await expectPage(panel.locator(".task-summary-target")).toHaveCount(0);
    await expectPage(panel.locator(".task-summary > .task-stat-cards")).toHaveCount(1);
    await expectPage(panel.locator(".stat-card.task-stat-model")).toContainText("gpt-5");
    await expectPage(panel.locator(".stat-card.task-stat-time .task-time-range")).toContainText(
      "12:00:00",
    );
    await expectPage(panel.locator(".stat-card.task-stat-time .task-time-range")).toContainText(
      "12:00:05",
    );
    await expectPage(panel.locator(".stat-card.task-stat-time")).toContainText("00:05");
    await expectPage(panel.locator(".stat-card.task-stat-time")).toContainText("00:25");
    await expectPage(panel).toContainText("gpt-5 · 3 requests · $0.0428");
    const groupDetails = panel.locator("details");
    await expectPage(groupDetails).toBeVisible();
    await expectPage(groupDetails.locator("summary")).toContainText("gpt-5 · 3 requests · $0.0428");
    const groupBreakdown = groupDetails.locator(".task-breakdown");
    await expectPage(groupBreakdown.locator("thead")).toContainText("Price ($/M tokens)");
    await expectPage(groupBreakdown.locator("thead")).toContainText("Billed tokens");
    // Model/price groups default to collapsed and keep the manual state across panel re-renders.
    await expectPage(groupBreakdown).toBeHidden();
    await groupDetails.locator("summary").click();
    await expectPage(groupBreakdown).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.locator(".log-group-head").press("Enter"),
    ]);
    await expectPage(groupBreakdown).toBeVisible();
    await groupDetails.locator("summary").click();
    await expectPage(groupBreakdown).toBeHidden();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.locator(".log-group-head").press("Enter"),
    ]);
    await expectPage(groupBreakdown).toBeHidden();
    // The breakdown table is its own section: the "Task cost" heading sits
    // directly above it and shares the cost-green dot with the cost trend.
    await expectPage(panel.locator("h3.section-cost").first()).toHaveText("Task cost");
    // Each section states its scope right under the title, before the picture.
    // The CSS that spaces this line hangs on the same sibling adjacency.
    await expectPage(panel.locator("h3.section-cost + .pricing-note").first()).toHaveText(
      "Whole-task cost, including requests outside this list.",
    );
    const taskBreakdown = panel.locator(".task-breakdown").first();
    await expectPage(taskBreakdown.locator("thead")).toContainText("Share");
    await expectPage(taskBreakdown.locator("tbody tr").first()).toContainText("17.54%");
    await expectPage(taskBreakdown.locator("tfoot")).toContainText("Total");
    await expectPage(taskBreakdown.locator("tfoot")).toContainText("4,250");
    await expectPage(taskBreakdown.locator("tfoot")).not.toContainText("%");
    await expectPage(taskBreakdown.locator("tbody tr").nth(1)).toContainText("1,250");
    // Per-request token count trend line chart: one dot per request with a known
    // token total (request + response). The chart series requests fire with the
    // panel re-open; no response wait here because waitForResponse can miss
    // responses that already delivered in this re-render.
    // The expectPage assertions below retry until the chart renders.
    await expectPage(panel).toContainText("Per-request token count trend");
    const tokenChart = panel.locator(".token-chart svg");
    await expectPage(tokenChart).toBeVisible();
    await expectPage(tokenChart.locator(".token-chart-dot")).toHaveCount(5);
    await expectPage(tokenChart.locator(".token-chart-dot").first().locator("title")).toHaveText(
      "Request #1: 14 tokens",
    );
    await expectPage(tokenChart.locator(".token-chart-dot").last().locator("title")).toHaveText(
      "Request #5: 258 tokens",
    );
    // The highest point is labeled with its exact value (request #5 here).
    await expectPage(tokenChart.locator(".token-chart-peak")).toHaveText("258");
    // Per-request cost trend line chart: one dot per priced request with its own cost;
    // the priced per-request costs sum to the task total in the panel header.
    await expectPage(panel).toContainText("Per-request cost trend");
    const costChart = panel.locator(".cost-chart svg");
    await expectPage(costChart).toBeVisible();
    await expectPage(costChart.locator(".token-chart-dot")).toHaveCount(3);
    await expectPage(costChart.locator(".token-chart-dot").first().locator("title")).toHaveText(
      "Request #1: $0.0104",
    );
    await expectPage(costChart.locator(".token-chart-dot").last().locator("title")).toHaveText(
      "Request #5: $0.0238",
    );
    // The highest point is labeled with its exact value (request #5 here),
    // formatted like the dot tooltips (rounded to 4 decimal places).
    await expectPage(costChart.locator(".token-chart-peak")).toHaveText("$0.0238");
    // The dashed horizontal line marks the average per-request cost
    // (0.0104 + 0.0086 + 0.02375) / 3, labeled at the right edge of the plot.
    await expectPage(costChart.locator(".token-chart-mean")).toHaveCount(1);
    await expectPage(costChart.locator(".token-chart-mean-label")).toHaveText("avg $0.0143");
    // Per-request token output trend line chart: one dot per request with a known output
    // token count, each carrying that request's own (non-cumulative) count.
    await expectPage(panel).toContainText("Per-request token output trend");
    await expectPage(panel.locator("h3.section-output + .pricing-note")).toHaveText(
      "This request's own output tokens, by request sequence; requests without an output token count yet are not shown.",
    );
    const outputChart = panel.locator(".output-token-chart svg");
    await expectPage(outputChart).toBeVisible();
    await expectPage(outputChart.locator(".token-chart-dot")).toHaveCount(3);
    await expectPage(outputChart.locator(".token-chart-dot").first().locator("title")).toHaveText(
      "Request #1: 4 output tokens",
    );
    await expectPage(outputChart.locator(".token-chart-dot").last().locator("title")).toHaveText(
      "Request #5: 212 output tokens",
    );
    await expectPage(outputChart.locator(".token-chart-peak")).toHaveText("212");
    // The dashed horizontal line marks the average output token count
    // (4 + 96 + 212) / 3, labeled at the right edge of the plot.
    await expectPage(outputChart.locator(".token-chart-mean")).toHaveCount(1);
    await expectPage(outputChart.locator(".token-chart-mean-label")).toHaveText("avg 104");
    await panel.screenshot({ path: "test-results/task-pricing-panel.png" });
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await expectPage(group.locator('[data-select-group="task-one"]')).not.toBeChecked();
    await panel.locator("[data-close-pricing]").click();
    await expectPage(panel).toBeHidden();

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      group.locator(".log-group-caret").click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/logs/record-two")),
      page.locator('[data-log-id="record-two"]').click(),
    ]);
    const requestPricing = page.locator("#responsePricing");
    const pricingButton = page.locator('[data-pricing="response"]');
    await expectPage(pricingButton).toBeEnabled();
    await expectPage(requestPricing).toBeHidden();
    await pricingButton.click();
    await expectPage(requestPricing).toBeVisible();
    await expectPage(requestPricing).toContainText("Cost estimate");
    await expectPage(requestPricing).toContainText("$0.0411");
    await expectPage(requestPricing).toContainText("Billing model");
    await expectPage(requestPricing).toContainText("gpt-5");
    await expectPage(requestPricing).toContainText("1,500");
    await expectPage(requestPricing.locator(".pricing-table thead")).toContainText("Share");
    await expectPage(requestPricing.locator(".pricing-table tbody tr").first()).toContainText(
      "18.24%",
    );
    await expectPage(requestPricing.locator(".pricing-table tfoot")).toContainText("Total");
    await expectPage(requestPricing.locator(".pricing-table tfoot")).toContainText("4,000");
    await expectPage(requestPricing.locator(".pricing-table tfoot")).not.toContainText("%");
    await pricingButton.click();
    await expectPage(requestPricing).toBeHidden();
  });

  it("names the task-detail panel by its task id and keeps a clipped id readable and selectable", async () => {
    await loadAdminPage();
    const longId = "a3f15c8e9b624d07af15c8e9b624d071";
    // A real task id is 32 hex characters. The fixture's is eight, so rename
    // the group this list reports to see what the title line does with a long
    // one: the id is what the panel asks the server about, not a display field.
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      const data = (await response.json()) as { groups: Record<string, unknown>[] };
      data.groups = data.groups.map((group) =>
        group["id"] === "task-one" ? { ...group, id: longId } : group,
      );
      await route.fulfill({ response, json: data }).catch(() => undefined);
    });
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(`[data-group-id="${longId}"]`)).toBeVisible();
    // The stub only answers pricing for task-one, so this task's panel lands on
    // its load-error state; the title line still names the task the user opened.
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith(`/api/log-groups/${longId}/pricing`),
      ),
      page.locator(`[data-group-id="${longId}"]`).click(),
    ]);
    const panel = page.locator("#pricingPanel");
    await expectPage(panel).toBeVisible();
    await expectPage(panel).toContainText("Could not load task details");
    const idLine = panel.locator(".pricing-panel-task-id");
    await expectPage(idLine).toHaveText(longId);
    await expectPage(idLine).toHaveAttribute("title", longId);
    await expectPage(idLine).toHaveAttribute("aria-label", "Task ID");
    // A user who drags the log splitter wide leaves the detail pane narrow, and
    // the drag commits exactly this custom property, so setting it reproduces
    // that layout without a mouse. The id then runs out of room on the title
    // line and clips to an ellipsis while the hover text keeps the whole value,
    // and one click selects all of it - which is how a 32-character id gets
    // copied out.
    await page.evaluate(() => {
      const logs = document.getElementById("logs");
      if (logs instanceof HTMLElement) logs.style.setProperty("--sidebar-w", "1000px");
    });
    await expectPage(idLine).toBeVisible();
    const widths = await idLine.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(widths.scrollWidth).toBeGreaterThan(widths.clientWidth);
    // The title keeps its room and the id is the one that clips: the panel still
    // says which kind of panel this is even in a narrow pane, and the long id
    // that gets clipped is the one whose whole value stays in the hover text.
    const titleWidths = await panel.locator(".pricing-panel-head strong").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(titleWidths.scrollWidth).toBe(titleWidths.clientWidth);
    await idLine.click();
    const selected = await page.evaluate(() => String(window.getSelection()));
    expect(selected).toBe(longId);
  });

  it("generates the task brief on demand and keeps it across panel re-opens", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      page.waitForResponse((response) => response.url().endsWith("/api/log-groups/task-one/brief")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    const panel = page.locator("#pricingPanel");
    const brief = panel.locator(".task-brief");
    // Opening a panel never calls the model: the card starts with its hint and
    // an enabled button, and no POST went out.
    await expectPage(brief.locator(".task-brief-empty")).toBeVisible();
    await expectPage(brief.locator("[data-generate-brief]")).toHaveText("Generate brief");
    // No record, no window: the button that opens one is not offered until there is a
    // timeline to put in it.
    await expectPage(brief.locator("[data-brief-timeline]")).toHaveCount(0);
    expect(taskBriefPosts).toEqual([]);

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/log-groups/task-one/brief") &&
          response.request().method() === "POST",
      ),
      brief.locator("[data-generate-brief]").click(),
    ]);
    await expectPage(brief.locator(".task-brief-text")).toHaveText(TASK_BRIEF_GENERATED_TEXT);
    // The environment facts the model extracted are shown as pills above the
    // paragraph, with the page's own labels and the raw values.
    await expectPage(brief.locator(".task-brief-fact")).toHaveCount(4);
    await expectPage(
      brief
        .locator(".task-brief-fact")
        .filter({ hasText: "Client" })
        .locator(".task-brief-fact-value"),
    ).toHaveText("pi 0.39 (win32 10.0.26100; x64)");
    await expectPage(
      brief
        .locator(".task-brief-fact")
        .filter({ hasText: "Working dir" })
        .locator(".task-brief-fact-value"),
    ).toHaveText("d:/code/local_ai_proxy");
    // The button becomes a regenerate affordance and the card credits the model.
    await expectPage(brief.locator("[data-generate-brief]")).toHaveText("Regenerate");
    await expectPage(brief.locator(".task-brief-meta")).toContainText("summary-model");
    // The card keeps only the overview: the stages, the gaps and the events are the execution
    // record, and none of it is on the screen until the card's own button opens it. The card
    // still says which request the answer describes and how many events it had.
    await expectPage(brief.locator(".task-brief-step")).toHaveCount(0);
    await expectPage(brief.locator(".task-brief-gaps")).toHaveCount(0);
    await expectPage(brief.locator(".task-brief-evidence")).toHaveCount(0);
    await expectPage(brief.locator(".task-brief-meta")).toContainText("#record-six");
    await expectPage(brief.locator(".task-brief-meta")).toContainText("4 events");
    await expectPage(brief.locator("[data-brief-stale]")).toBeHidden();
    await expectPage(page.locator("#taskBriefTimelineDialog")).toBeHidden();
    await expectPage(brief.locator("[data-brief-timeline]")).toHaveText("Execution timeline");

    // The button opens that record in a window of its own: the stages in the order the server
    // numbered them, each labelled with how its claim is grounded.
    await brief.locator("[data-brief-timeline]").click();
    const dialog = page.locator("#taskBriefTimelineDialog");
    const record = dialog.locator("#taskBriefTimelineBody");
    await expectPage(dialog).toBeVisible();
    await expectPage(dialog.locator(".task-brief-timeline-head strong")).toHaveText(
      "Execution timeline",
    );
    await expectPage(record.locator(".task-brief-step")).toHaveCount(
      TASK_BRIEF_TIMELINE_STEPS.length,
    );
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-step-order"),
    ).toHaveText("1");
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-step-basis"),
    ).toHaveText("observed");
    await expectPage(
      record.locator(".task-brief-step").nth(1).locator(".task-brief-step-basis"),
    ).toHaveText("inferred");
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-step-operation"),
    ).toHaveText("Read the config loader");
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-step-purpose"),
    ).toContainText("Confirm how paths resolve");
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-step-result"),
    ).toContainText("Found a mismatch with the tests");
    // A stage that cites evidence shows the numbers the server handed out, not ones the
    // model made up.
    await expectPage(
      record.locator(".task-brief-step").nth(0).locator(".task-brief-evidence-ref"),
    ).toHaveCount(2);
    // What the log could not answer is said separately, with the events that show the hole.
    await expectPage(record.locator(".task-brief-gaps")).toBeVisible();
    await expectPage(record.locator(".task-brief-gaps li")).toContainText(
      "The log has no result for the second call.",
    );
    await expectPage(record.locator(".task-brief-gap-refs .task-brief-evidence-ref")).toHaveText(
      "3",
    );
    // The events are the evidence, not the reading, so they start collapsed in here too.
    await expectPage(record.locator(".task-brief-evidence")).not.toHaveAttribute("open", "");

    // Clicking a stage's number opens the event list and lands on that event, inside the same
    // window: the number is the one the server assigned, so this is a lookup.
    await record.locator(".task-brief-step").nth(1).locator('[data-brief-evidence="3"]').click();
    await expectPage(record.locator(".task-brief-evidence")).toHaveAttribute("open", "");
    await expectPage(record.locator('.task-brief-event[data-event-no="3"]')).toBeVisible();
    await expectPage(record.locator('.task-brief-event[data-event-no="4"]')).toBeVisible();
    await expectPage(
      record.locator('.task-brief-event[data-event-no="3"] .task-brief-event-call'),
    ).toHaveText("call-1");
    await expectPage(
      record.locator('.task-brief-event[data-event-no="4"] .task-brief-event-call'),
    ).toHaveText("call-1");
    // The window closes on its own button and leaves the card showing the overview.
    await dialog.locator("#taskBriefTimelineClose").click();
    await expectPage(dialog).toBeHidden();
    await expectPage(brief.locator(".task-brief-text")).toHaveText(TASK_BRIEF_GENERATED_TEXT);
    // The brief card sits above the fact grid, so it is the first block under
    // the panel title.
    const tops = await panel.evaluate((root) =>
      [...root.querySelectorAll(".task-brief, .task-summary")].map((element) =>
        Math.round((element as HTMLElement).getBoundingClientRect().top),
      ),
    );
    expect(tops[0]).toBeLessThan(tops[1] ?? Number.POSITIVE_INFINITY);

    // Closing and re-opening reads the stored brief back instead of regenerating.
    await panel.locator("[data-close-pricing]").click();
    await expectPage(panel).toBeHidden();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      page.waitForResponse((response) => response.url().endsWith("/api/log-groups/task-one/brief")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    await expectPage(panel.locator(".task-brief-text")).toHaveText(TASK_BRIEF_GENERATED_TEXT);
    // Re-opening reads the stored answer back: the card shows the overview only, and the
    // window stays off the screen until its button is clicked again.
    await expectPage(panel.locator(".task-brief-step")).toHaveCount(0);
    await expectPage(page.locator("#taskBriefTimelineDialog")).toBeHidden();
    await expectPage(panel.locator("[data-brief-timeline]")).toBeVisible();
    expect(taskBriefPosts).toEqual(["task-one"]);
  });

  it("shows a brief stored before timelines existed as its paragraph alone", async () => {
    // A cache row written by the old generation has the overview and the facts but no
    // steps and no events; the card must not invent either of them.
    setTaskBriefTimeline(false);
    setTaskBriefFixture("A paragraph written before timelines existed.");
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator("#languageSelect").selectOption("en");
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      page.waitForResponse((response) => response.url().endsWith("/api/log-groups/task-one/brief")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    const brief = page.locator("#pricingPanel .task-brief");
    await expectPage(brief.locator(".task-brief-text")).toHaveText(
      "A paragraph written before timelines existed.",
    );
    await expectPage(brief.locator(".task-brief-fact")).toHaveCount(4);
    await expectPage(brief.locator(".task-brief-steps")).toHaveCount(0);
    await expectPage(brief.locator(".task-brief-evidence")).toHaveCount(0);
    await expectPage(brief.locator(".task-brief-gaps")).toHaveCount(0);
    // A paragraph with no record behind it gets no window to open.
    await expectPage(brief.locator("[data-brief-timeline]")).toHaveCount(0);
    // Reading a stored brief never calls the model, whatever shape it was stored in.
    expect(taskBriefPosts).toEqual([]);
  });

  it("labels a brief whose source request has moved on", async () => {
    setTaskBriefStale(true);
    setTaskBriefFixture("An answer the newest request has gone past.");
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator("#languageSelect").selectOption("en");
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      page.waitForResponse((response) => response.url().endsWith("/api/log-groups/task-one/brief")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    const brief = page.locator("#pricingPanel .task-brief");
    await expectPage(brief.locator("[data-brief-stale]")).toBeVisible();
    await expectPage(brief.locator(".task-brief-meta")).toContainText("Older answer");
    // A stale answer is still readable and still carries its stages; only its label changes.
    // The card shows none of those stages now, so the check goes through its window.
    await expectPage(brief.locator(".task-brief-step")).toHaveCount(0);
    await brief.locator("[data-brief-timeline]").click();
    await expectPage(page.locator("#taskBriefTimelineDialog")).toBeVisible();
    await expectPage(
      page.locator("#taskBriefTimelineBody").locator(".task-brief-step"),
    ).toHaveCount(TASK_BRIEF_TIMELINE_STEPS.length);
    // The "older answer" mark belongs to the card, not to the window: the window holds the
    // same record whether or not the source has moved on.
    await expectPage(brief.locator("[data-brief-stale]")).toBeVisible();
    expect(taskBriefPosts).toEqual([]);
  });

  it("opens the task detail panel on a header click and toggles the list on the caret button", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const section = page.locator('.log-group:has([data-group-id="task-one"])');
    const head = page.locator('[data-group-id="task-one"]');
    const caret = page.locator('[data-group-toggle="task-one"]');
    await expectPage(section.locator(".log-group-body")).toHaveCount(0);

    // A header click only opens the task detail panel; unlike the old
    // one-gesture behavior the second level stays collapsed.
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      head.click(),
    ]);
    const panel = page.locator("#pricingPanel");
    await expectPage(panel).toBeVisible();
    await expectPage(panel).toContainText("Task details");
    await expectPage(section.locator(".log-group-body")).toHaveCount(0);
    await expectPage(caret).toHaveAttribute("aria-expanded", "false");

    // The caret button expands the list and fetches its records; pressing it
    // again collapses the list while the detail panel stays open.
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      caret.click(),
    ]);
    await expectPage(section.locator(".log-group-body")).toHaveCount(1);
    await expectPage(caret).toHaveAttribute("aria-expanded", "true");
    await caret.click();
    await expectPage(section.locator(".log-group-body")).toHaveCount(0);
    await expectPage(caret).toHaveAttribute("aria-expanded", "false");
    await expectPage(panel).toBeVisible();
  });

  it("expands search previews without a second request and replaces them on query changes", async () => {
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      const data = (await response.json()) as { groups: { id: string }[] };
      const query = new URL(route.request().url()).searchParams.get("q");
      if (query) {
        data.groups = data.groups.map((group: { id: string }) => ({
          ...group,
          preview: {
            id: group.id,
            total: 21,
            limit: 20,
            offset: 0,
            next_offset: 20,
            has_more: true,
            logs: [
              {
                id: `preview-${query}`,
                sequence: "21",
                timestamp: "2026-07-18 12:00:00",
                method: "POST",
                path: "/v1/responses",
                status: 200,
              },
            ],
          },
        }));
      }
      await route.fulfill({ response, json: data }).catch(() => undefined);
    });
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await expectPage(page.locator('[data-group-id="task-one"]')).toBeVisible();
    await page.locator("#logSearch").fill("task");
    await page.locator("#searchLogs").click();
    await expectPage(page.locator("#logListProgress")).toBeHidden();
    await page.locator('[data-group-toggle="task-one"]').click();
    await expectPage(page.locator('[data-log-id="preview-task"]')).toBeVisible();
    expect(groupLogQueries).toEqual([]);
    await page.locator("#logSearch").fill("task-one");
    await page.locator("#searchLogs").click();
    await expectPage(page.locator('[data-log-id="preview-task-one"]')).toBeVisible();
    await expectPage(page.locator('[data-log-id="preview-task"]')).toHaveCount(0);
    expect(groupLogQueries).toEqual([]);
    const more = page.waitForRequest((request) => request.url().includes("limit=100&offset=20"));
    await page.locator('[data-load-more-records="task-one"]').click();
    await more;
  });

  it("refetches an expanded group's records when the search query changes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-toggle="task-one"]').click(),
    ]);
    expect(groupLogQueries).toEqual(["task-one:"]);

    // The term matches every fixture group, so the expanded group remains in
    // the list and must be refetched under the new query.
    const refetch = page.waitForResponse((response) =>
      response.url().includes("/api/log-groups/task-one/logs?q=task"),
    );
    await page.locator("#logSearch").fill("task");
    await page.locator("#searchLogs").click();
    await refetch;
    expect(groupLogQueries).toEqual(["task-one:", "task-one:task"]);
  });

  it("shows a placeholder when an expanded group has no matching records", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator("#logSearch").fill("task-needle");
    const searchResponse = page.waitForResponse((response) =>
      response.url().includes("q=task-needle"),
    );
    await page.locator("#searchLogs").click();
    await searchResponse;
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-needle/logs"),
      ),
      page.locator('[data-group-toggle="task-needle"]').click(),
    ]);
    const placeholder = page.locator(".log-group-empty");
    await expectPage(placeholder).toHaveCount(1);
    await expectPage(placeholder).toHaveText("No matching records in this group");
  });

  it("keeps the second level below a header pinned to the top of the list", async () => {
    setUseLargeLogFixture(true);
    setUseLargeGroupLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=0")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(100);
    const logItems = page.locator("#logItems");
    // A single pixel of scroll puts the first header exactly on the scrollport's
    // content top. Chromium ignores a node inside that top gap as a scroll
    // anchor, so it used to compensate the inserted body by scrolling down by
    // its full height and throw the whole second level above the viewport.
    expect(await setScrollTop(logItems, 1)).toBe(1);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-1/logs?q=&limit=200&offset=0"),
      ),
      page.locator('[data-group-toggle="task-1"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(200);
    expect(await scrollTop(logItems)).toBe(1);
    const firstRow = await requiredBox(
      page.locator('.log-group:has([data-group-id="task-1"]) .log-item').first(),
    );
    const itemsBox = await requiredBox(logItems);
    expect(firstRow.y).toBeGreaterThanOrEqual(itemsBox.y);
    expect(firstRow.y).toBeLessThan(itemsBox.y + itemsBox.height);
  });

  it("keeps the first record below the header when a half-scrolled task expands", async () => {
    setUseLargeLogFixture(true);
    setUseLargeGroupLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=0")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(100);
    const logItems = page.locator("#logItems");
    // Half of the first header sits above the scrollport. A collapsed section is
    // too short for the sticky constraint, so the header is simply clipped - but
    // the body it grows makes it stick at the top, and it used to paint over the
    // first record by the height it had been clipped.
    const halfOutScroll = await logItems.evaluate((element) => {
      const head = element.querySelector(".log-group-head[data-group-id]");
      if (head === null) throw new Error("no task header");
      const contentTop =
        element.getBoundingClientRect().top +
        element.clientTop +
        parseFloat(getComputedStyle(element).paddingTop);
      return (
        element.scrollTop +
        head.getBoundingClientRect().top -
        contentTop +
        Math.round(head.getBoundingClientRect().height / 2)
      );
    });
    expect(await setScrollTop(logItems, halfOutScroll)).toBe(halfOutScroll);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-1/logs?q=&limit=200&offset=0"),
      ),
      page.locator('[data-group-toggle="task-1"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(200);
    const headerBox = await requiredBox(
      page.locator('.log-group:has([data-group-id="task-1"]) .log-group-head'),
    );
    const firstRow = await requiredBox(
      page.locator('.log-group:has([data-group-id="task-1"]) .log-item').first(),
    );
    const itemsBox = await requiredBox(logItems);
    // The header sticks at the content top, so the first record has to start
    // below it instead of being hidden behind it.
    expect(firstRow.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
    expect(firstRow.y).toBeLessThan(itemsBox.y + itemsBox.height);
  });

  it("loads 100 more records within an expanded task", async () => {
    setUseLargeGroupLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-one/logs?q=&limit=200&offset=0"),
      ),
      page.locator('[data-group-toggle="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(200);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toContainText("200/301");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("limit=100&offset=200")),
      page.locator('[data-load-more-records="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(300);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toContainText("300/301");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("limit=100&offset=300")),
      page.locator('[data-load-more-records="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(301);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toHaveCount(0);
  });

  it("loads and merges the next page of task groups", async () => {
    setUseLargeLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=0")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(100);
    await expectPage(page.locator("[data-load-more]")).toContainText("100/101");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=100")),
      page.locator("[data-load-more]").click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(101);
    await expectPage(page.locator("[data-load-more]")).toHaveCount(0);
    await expectPage(page.locator('[data-group-id="task-101"]')).toHaveCount(1);
  });

  it("cleans selected task groups and refreshes the list", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator('[data-select-group="task-one"]').check();

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/logs/cleanup") && response.request().method() === "POST",
      ),
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#cleanupLogs").click(),
    ]);
    expect(deletedLogGroups).toEqual(new Set(["task-one"]));
    await expectPage(page.locator('[data-group-id="task-one"]')).toHaveCount(0);
    await expectPage(page.locator('[data-group-id="task-needle"]')).toHaveCount(1);
    await expectPage(page.locator("#toast")).toContainText("Logs cleaned: 1");
  });

  it("cleans every single-request task across all pages of the list", async () => {
    setUseLargeLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator("#cleanupSingleRequestLogs")).toHaveText("Clean single-request");
    const cleanupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/logs/cleanup") && response.request().method() === "POST",
    );
    await page.locator("#cleanupSingleRequestLogs").click();
    const body = (await cleanupResponse).request().postDataJSON() as { group_ids: string[] } | null;
    if (body === null) throw new Error("cleanup request has no POST body");
    expect(body.group_ids).toEqual(Array.from({ length: 101 }, (_, index) => `task-${index + 1}`));
    expect(deletedLogGroups.size).toBe(101);
    await expectPage(page.locator("#toast")).toContainText("Logs cleaned: 101");
    await expectPage(page.locator(".log-group")).toHaveCount(0);
  });

  it("cleans only the tasks whose group holds exactly one request", async () => {
    setUseLargeLogFixture(true);
    setUseLargeLogRequestCount((index) => (index % 2 === 0 ? 1 : 3));
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const cleanupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/logs/cleanup") && response.request().method() === "POST",
    );
    await page.locator("#cleanupSingleRequestLogs").click();
    const body = (await cleanupResponse).request().postDataJSON() as { group_ids: string[] } | null;
    if (body === null) throw new Error("cleanup request has no POST body");
    expect(body.group_ids).toEqual(
      Array.from({ length: 51 }, (_, index) => `task-${index * 2 + 1}`),
    );
    expect(deletedLogGroups.size).toBe(51);
    await expectPage(page.locator("#toast")).toContainText("Logs cleaned: 51");
    await expectPage(page.locator(".log-group")).toHaveCount(50);
  });

  it("reports when no task contains a single request", async () => {
    setUseLargeLogFixture(true);
    setUseLargeLogRequestCount(() => 3);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator("#cleanupSingleRequestLogs").click();
    await expectPage(page.locator("#toast")).toContainText("No single-request tasks");
    expect(deletedLogGroups.size).toBe(0);
    await expectPage(page.locator(".log-group")).toHaveCount(100);
  });

  it("shows the progress bar and a busy button while single-request cleanup is running", async () => {
    setUseLargeLogFixture(true);
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);

    let releaseCleanup: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    await page.route("**/api/logs**", async (route) => {
      if (route.request().method() !== "GET") return route.continue().catch(() => undefined);
      const response = await route.fetch().catch(() => undefined);
      if (response === undefined) return;
      await release;
      await route.fulfill({ response }).catch(() => undefined);
    });

    const button = page.locator("#cleanupSingleRequestLogs");
    const progress = page.locator("#logListProgress");
    await button.click();
    await expectPage(button).toBeDisabled();
    await expectPage(button).toHaveText("Cleaning…");
    await expectPage(progress).toBeVisible();

    releaseCleanup?.();
    await expectPage(button).toBeEnabled();
    await expectPage(button).toHaveText("Clean single-request");
    await expectPage(progress).toBeHidden();
    await expectPage(page.locator("#toast")).toContainText("Logs cleaned: 101");
    await page.unroute("**/api/logs**");
  });

  it("downloads the log ZIP archive", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportLogs").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("llm-proxy-logs.zip");
    const downloadPath = await download.path();
    expect(await readFile(downloadPath)).toEqual(Buffer.from("zip-fixture"));
    await expectPage(page.locator("#toast")).toContainText("Logs exported");
  });

  it("loads record detail and refreshes a pending response to finished", async () => {
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
      page.waitForResponse((response) => response.url().endsWith("/api/logs/record-one")),
      page.locator('[data-log-id="record-one"]').click(),
    ]);
    await expectPage(page.locator("#requestJson")).toContainText("gpt-5");
    await expectPage(page.locator("#responseJson")).toContainText("null");
    await expectPage(page.locator("#responseTiming")).toBeHidden();
    expect(detailReads.get("record-one")).toBe(1);
    const formattedString = page.locator("#requestJson .json-str-detail");
    await expectPage(formattedString).toHaveJSProperty("open", false);
    await formattedString.locator("summary").click();
    await expectPage(formattedString).toHaveJSProperty("open", true);
    const requestJson = page.locator("#requestJson");
    const formattedBody = formattedString.locator(".json-str-body");
    const scrollPositions = {
      pane: await setScrollTop(requestJson, 40),
      body: await setScrollTop(formattedBody, 120),
    };
    expect(scrollPositions.pane).toBeGreaterThan(0);
    expect(scrollPositions.body).toBeGreaterThan(0);

    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    const finishedDetail = page.waitForResponse((response) =>
      response.url().endsWith("/api/logs/record-one"),
    );
    await autoRefresh.check();
    await finishedDetail;
    await expectPage(page.locator("#responseJson")).toContainText("completed");
    await expectPage(page.locator("#responseMeta")).toBeHidden();
    await expectPage(page.locator("#responseTiming")).toHaveText(
      "First token 00:02 · Total 01:06 · Prefill 1.7 tok/s · Decode 0.1 tok/s",
    );
    await expectPage(formattedString).toHaveJSProperty("open", true);
    await expect.poll(() => scrollTop(requestJson)).toBe(scrollPositions.pane);
    await expect.poll(() => scrollTop(formattedBody)).toBe(scrollPositions.body);
    expect(detailReads.get("record-one")).toBe(2);
    await autoRefresh.uncheck();
  });

  it("expands nested JSON trees one level at a time", async () => {
    await openRecordDetail("record-two");
    const details = page.locator("#requestJson details[data-json-node-path]:not(.json-str-detail)");
    const formattedString = page.locator("#requestJson .json-str-detail");
    const expandButton = page.locator('[data-expand="request"]');
    await expectPage(details).toHaveCount(4);
    await expectPage(details.nth(2)).toHaveJSProperty("open", false);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    await expectPage(expandButton).toHaveAttribute("title", "Expand one level");

    await expandButton.click();
    await expectPage(details.nth(2)).toHaveJSProperty("open", true);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    // The expand button only walks JSON structure levels; formatted string blocks
    // stay collapsed until the user opens them manually.
    await expectPage(formattedString).toHaveJSProperty("open", false);

    await expandButton.click();
    await expectPage(details.nth(3)).toHaveJSProperty("open", true);
    await expectPage(expandButton).toHaveAttribute("title", "Collapse JSON");

    await expandButton.click();
    await expectPage(details.nth(0)).toHaveJSProperty("open", true);
    await expectPage(details.nth(1)).toHaveJSProperty("open", true);
    await expectPage(details.nth(2)).toHaveJSProperty("open", false);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    await expectPage(formattedString).toHaveJSProperty("open", false);
  });

  it("keeps JSON parent summaries sticky while scrolling", async () => {
    await openRecordDetail("record-two");
    const requestJson = page.locator("#requestJson");
    const root = requestJson.locator('details[data-json-depth="0"] > summary');
    const firstLevelParent = requestJson.locator('details[data-json-depth="1"] > summary').first();

    await expectPage(root).toHaveCSS("position", "sticky");
    await expectPage(firstLevelParent).toHaveCSS("position", "sticky");
    await expectPage(
      firstLevelParent.locator(".."),
      "first-level parent should be open",
    ).toHaveJSProperty("open", true);
    await requestJson.locator(".json-str-detail summary").click();

    const initialTop = (await requiredBox(root)).y;
    const scrollPosition = await setScrollTop(requestJson, 100);
    expect(scrollPosition).toBeGreaterThan(0);
    const paneBox = await requiredBox(requestJson);
    const rootBox = await requiredBox(root);
    const firstLevelBox = await requiredBox(firstLevelParent);

    expect(rootBox.y).toBeGreaterThanOrEqual(paneBox.y);
    expect(rootBox.y).toBeLessThanOrEqual(initialTop + 1);
    expect(firstLevelBox.y).toBeGreaterThan(rootBox.y);

    await root.click();
    await expectPage.poll(async () => await scrollTop(requestJson)).toBeLessThan(2);
    await expectPage(
      requestJson.locator('details[data-json-depth="0"]'),
      "jump must not toggle the node",
    ).toHaveJSProperty("open", true);

    const nestedNaturalTop = await requestJson.evaluate((container) => {
      const detail = container.querySelector<HTMLElement>('details[data-json-depth="1"]');
      if (detail === null) throw new Error("Expected nested JSON detail");
      let top = 0;
      let node: HTMLElement | null = detail;
      while (node !== null && node !== container) {
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      return top;
    });
    await requestJson.evaluate((container) => {
      const detail = container.querySelector<HTMLElement>('details[data-json-depth="1"]');
      if (detail === null) throw new Error("Expected nested JSON detail");
      const spacer = container.ownerDocument.createElement("div");
      spacer.style.height = "1500px";
      detail.appendChild(spacer);
    });
    await setScrollTop(requestJson, Math.max(1, nestedNaturalTop - 8));

    await firstLevelParent.click();
    await expectPage
      .poll(async () => Math.abs((await scrollTop(requestJson)) - (nestedNaturalTop - 18)))
      .toBeLessThan(3);
    await expectPage(firstLevelParent.locator(".."), "band click must not toggle").toHaveJSProperty(
      "open",
      true,
    );
  });

  it("realizes the JSON rows a fast scroll lands on", async () => {
    await openRecordDetail("record-two");
    // The synthetic tree is not what the stub service returns, so a refresh tick
    // would replace it and the scroll would land on the wrong rows.
    await page.locator("#autoRefreshLogs").uncheck();
    // A tree big enough that one scroll jumps over hundreds of rows: the walker
    // that pre-realizes rows has to reach the rows it skipped, not only the ones
    // beside where it last stopped, otherwise a fast scroll shows blank rows
    // until the browser realizes them on its own.
    await page.evaluate(`
      const leaf = { text: "x".repeat(40) };
      const children = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => ["child" + index, leaf]),
      );
      const branches = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => ["branch" + index, children]),
      );
      const sections = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => ["section" + index, branches]),
      );
      window.__adminUiTest.applySelectedLogDetail(
        { request: sections, response: null, request_meta: {}, response_meta: {}, pricing: null },
        { resetView: true },
      );
    `);
    const rows = page.locator("#requestJson .json-row");
    await expectPage(rows).toHaveCount(157);
    await page.locator('[data-expand="request"]').click();
    await expectPage(rows).toHaveCount(1885);

    const blankRowsInView = async (scrollValue: number): Promise<number> => {
      await page.evaluate(`document.getElementById("requestJson").scrollTop = ${scrollValue};`);
      // Scroll events are dispatched after the frame's animation frame callbacks,
      // so the pre-realization walk runs a frame after the jump lands.
      await page.waitForTimeout(150);
      return page.evaluate(`
        (() => {
          const pane = document.getElementById("requestJson");
          const bounds = pane.getBoundingClientRect();
          const onScreen = Array.from(pane.querySelectorAll(".json-row")).filter((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > bounds.top && box.top < bounds.bottom;
          });
          // A row that spans the whole document is never off screen, so the
          // browser always realizes it and the walker does not have to mark it.
          return onScreen.filter(
            (row) =>
              row.getBoundingClientRect().height <= bounds.height &&
              row.style.contentVisibility !== "visible",
          ).length;
        })()
      `);
    };

    await expectPage
      .poll(
        async () => await blankRowsInView(15000),
        "a deep jump must realize the rows it landed on",
      )
      .toBe(0);
    await expectPage
      .poll(
        async () => await blankRowsInView(0),
        "scrolling back to the top must realize them again",
      )
      .toBe(0);
  });

  it("wraps, formats, copies, and shows JSON metadata", async () => {
    await openRecordDetail("record-two");
    const requestJson = page.locator("#requestJson");
    await expectPage(requestJson).toHaveClass(/nowrap/);
    await page.locator('[data-wrap="request"]').click();
    await expectPage(requestJson).toHaveClass(/wrap/);

    await expectPage(requestJson.locator(".json-str-body")).toContainText("Stage canary");
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toHaveCount(0);
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toContainText("Stage canary");

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            Reflect.set(globalThis, "__copiedJson", text);
            return Promise.resolve();
          },
        },
      });
    });
    await page.locator('[data-copy="request"]').click();
    await expectPage(page.locator("#toast")).toContainText("Copied JSON");
    expect(
      await page.evaluate(() => {
        const value: unknown = Reflect.get(globalThis, "__copiedJson");
        return typeof value === "string" ? value : "";
      }),
    ).toContain('"model": "gpt-5"');

    const metadata = page.locator("#requestMeta");
    await expectPage(metadata).toBeHidden();
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeVisible();
    await expectPage(metadata).toContainText("/v1/responses");
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeHidden();
  });

  it("drags the column and row splitters without rebuilding the JSON panes", async () => {
    await openRecordDetail("record-two");
    await page.evaluate(`
      window.__jsonPaneMutationCount = 0;
      const observer = new MutationObserver((records) => {
        window.__jsonPaneMutationCount += records.length;
      });
      observer.observe(document.querySelector("#requestJson"), { childList: true, subtree: true });
      observer.observe(document.querySelector("#responseJson"), { childList: true, subtree: true });
    `);
    const logSplitter = page.locator("#logSplitter");
    const logBox = await requiredBox(logSplitter);
    await page.mouse.move(logBox.x + logBox.width / 2, logBox.y + logBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(logBox.x + 120, logBox.y + logBox.height / 2);
    await expectPage(logSplitter).toHaveClass(/dragging/);
    await expectPage(logSplitter).toHaveAttribute("style", /--splitter-preview-x:/);
    await expectPage(page.locator("#logs")).not.toHaveAttribute("style", /--sidebar-w:/);
    await page.mouse.up();
    await expectPage(page.locator("#logs")).toHaveAttribute("style", /--sidebar-w: \d+(\.\d+)?px/);

    const rowSplitter = page.locator("#splitter");
    const rowBox = await requiredBox(rowSplitter);
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + 80);
    await expectPage(rowSplitter).toHaveClass(/dragging/);
    await expectPage(rowSplitter).toHaveAttribute("style", /--splitter-preview-y:/);
    await expectPage(page.locator("#detail")).not.toHaveAttribute("style", /--request-fr:/);
    await page.mouse.up();
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--request-fr: \d+(\.\d+)?px/,
    );
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--response-fr: \d+(\.\d+)?px/,
    );
    expect(await page.evaluate("window.__jsonPaneMutationCount")).toBe(0);
  });

  it("keeps the log toolbar on one row, clipping auto refresh when narrow", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const span = page.locator(".auto-refresh span");
    const order = await page
      .locator(".log-actions")
      .evaluate((actions) =>
        [...actions.children].map((el) => (el as HTMLElement).id || el.className),
      );
    expect(order).toEqual([
      "selectAllLogs",
      "cleanupLogs",
      "cleanupSingleRequestLogs",
      "exportLogs",
      "summaryModelSettings",
      "refreshLogs",
      "auto-refresh",
    ]);

    const row = page.locator(".log-actions");
    const refresh = page.locator("#refreshLogs");
    const measure = async () => {
      const box = await requiredBox(span);
      const actions = await requiredBox(row);
      const refreshBox = await requiredBox(refresh);
      return { box, actions, refreshBox };
    };
    const full = await measure();
    await page.evaluate(
      'document.querySelector("#logs").style.setProperty("--sidebar-w", "260px")',
    );
    const narrow = await measure();
    expect(narrow.actions.height).toBeCloseTo(full.actions.height, 0);
    expect(narrow.box.y).toBeCloseTo(full.box.y, 0);
    expect(narrow.box.width).toBeCloseTo(full.box.width, 0);
    expect(narrow.box.height).toBeLessThanOrEqual(20);
    expect(narrow.box.x).toBeGreaterThanOrEqual(narrow.refreshBox.x + narrow.refreshBox.width - 1);
  });
});
