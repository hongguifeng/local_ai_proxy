import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import type { ElementHandle, Locator } from "@playwright/test";
import { UI_TEST_TIMEOUT_MS } from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import { loadAdminPage, openRecordDetail, scrollTop, setScrollTop } from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

// The JSON pane on a request body big enough to render lazily. These tests keep a refresh
// honest: the newest bytes have to reach the pane, bytes that did not change must not tear
// the tree down, and the work of a refresh must not cost the user their next frame.

const messageCount = 100;
const keyCount = 300;
// A message the builder makes holds `role`, `content`, the numbered keys and one key whose
// value never changes from tick to tick, so a test can count the rows an opened message has
// to show and tell a newly opened message apart. The single-leaf test builds messages
// without that extra key, two rows fewer.
const messageChildren = keyCount + 3;
const plainMessageChildren = keyCount + 2;

/**
 * What a measured refresh reports: the work it did synchronously and the wait for the next
 * animation frame.
 */
interface PaintTimings {
  syncMs: number;
  frameMs: number;
}

interface ScrolledFrameResult {
  maxFrameGap: number;
  connected: boolean;
  done: string;
  childRows: number;
}

interface ArrayFrameResult {
  maxFrameGap: number;
  open: boolean;
}

interface ScrolledExpandResult extends ScrolledFrameResult {
  clickMs: number;
}

interface ArrayExpandResult extends ArrayFrameResult {
  clickMs: number;
}

async function count(locator: Locator): Promise<number> {
  return locator.count();
}

/**
 * Reads the state of the node the user opened from that element itself. A locator would
 * resolve to whichever node carries the lazy marker now, and after a refresh that is a
 * different, still-collapsed message; the handle keeps the identity of the node under test.
 */
async function openedState(handle: ElementHandle): Promise<{ connected: boolean; open: boolean }> {
  return handle.evaluate<{ connected: boolean; open: boolean }>((node) => {
    // The handle is always the <details> element the test opened.
    const details = node as HTMLDetailsElement;
    return { connected: details.isConnected, open: details.open };
  });
}

/**
 * Installs the refresh entry point the auto-refresh uses, measured from inside the page:
 * `syncMs` is the work the refresh does synchronously and `frameMs` is how long the user
 * waited for the animation frame after it. `marker` sits at the top of the body, so it is
 * on a row the pane shows without opening anything.
 */
async function installBodyBuilder(): Promise<void> {
  await page.evaluate(`
    window.__jsonRefresh = (messages, keys, marker) => {
      const body = {
        model: "gpt-5",
        marker: marker,
        messages: Array.from({length: messages}, (_, messageIndex) => {
          const message = {role: 'user', content: 'message ' + messageIndex};
          for (let key = 0; key < keys; key++) message['k' + messageIndex + '_' + key] = 'v' + key;
          message['k' + messageIndex + '_' + keys] = 'payload';
          return message;
        }),
      };
      const start = performance.now();
      window.__adminUiTest.applySelectedLogDetail({request: body, response: null}, {resetView: false});
      const syncMs = performance.now() - start;
      return new Promise((resolve) => requestAnimationFrame(() =>
        resolve({syncMs, frameMs: performance.now() - start})));
    };
  `);
}

/** Counts the DOM nodes the request pane adds or removes: what separates a pane that
 * reconciles from a pane that replaces its whole tree. */
async function startMutationWatch(): Promise<void> {
  await page.evaluate(`
    window.__mutations = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records)
        window.__mutations += record.addedNodes.length + record.removedNodes.length;
    });
    observer.observe(document.getElementById('requestJson'), {childList: true, subtree: true});
  `);
}

async function mutations(): Promise<number> {
  return page.evaluate("window.__mutations");
}

async function resetMutations(): Promise<void> {
  await page.evaluate("window.__mutations = 0");
}

async function paneScrollTop(): Promise<number> {
  return scrollTop(page.locator("#requestJson"));
}

/** Opens a node the first paint left empty and waits until its children are built. */
async function openLazy(lazy: ReturnType<typeof page.locator>): Promise<void> {
  await lazy.locator("summary").click();
  await expectPage(lazy).toHaveAttribute("data-json-lazy-done", "1");
  await expectPage(lazy).toHaveJSProperty("open", true);
}

describe("admin UI large JSON pane refresh", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("paints a large lazy body without blocking the next frame", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await installBodyBuilder();
    await startMutationWatch();
    const paint = await page.evaluate<PaintTimings>(
      `window.__jsonRefresh(${messageCount}, ${keyCount}, 'marker-first')`,
    );
    await expectPage(page.locator("#requestJson .json-row")).toHaveCount(messageCount + 4);
    await expectPage(page.locator("#requestJson")).toContainText("marker-first");
    // The first paint only pays for the levels the tree shows open: every message below
    // stays a summary line until the user opens it, so the paint is bounded by the visible
    // rows and not by the 30 thousand nodes the body holds.
    await expectPage(page.locator('#requestJson [data-json-lazy="1"]')).toHaveCount(messageCount);
    expect(await mutations()).toBeLessThanOrEqual(10);
    expect(paint.syncMs).toBeLessThan(100);
    expect(paint.frameMs).toBeLessThan(200);
  });

  it("shows bytes appended while a request is pending and keeps the work proportional to the change", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await installBodyBuilder();
    await startMutationWatch();
    await page.evaluate(`window.__jsonRefresh(${messageCount}, ${keyCount}, 'tick-one')`);
    const opened = page.locator('#requestJson [data-json-lazy="1"]').first();
    await openLazy(opened);
    const openedHandle = await opened.elementHandle();
    const rowsAfterOpen = await count(page.locator("#requestJson .json-row"));
    expect(rowsAfterOpen).toBe(messageCount + 4 + messageChildren);
    await setScrollTop(page.locator("#requestJson"), 240);
    await resetMutations();
    const scrollBeforeGrow = await paneScrollTop();
    // A refresh while the request is still open appends one message and rewrites the marker.
    // The pane may only touch what differs: the marker row is replaced, the array's child
    // count text is rewritten, and the new message gains one row. Five nodes for a body of
    // thirty thousand nodes; a whole-tree replace would tear down every row the user opened.
    const grown = await page.evaluate<PaintTimings>(
      `window.__jsonRefresh(${messageCount + 1}, ${keyCount}, 'tick-two')`,
    );
    await expectPage(page.locator("#requestJson")).toContainText("tick-two");
    await expectPage(page.locator("#requestJson")).not.toContainText("tick-one");
    expect(await mutations()).toBeLessThanOrEqual(6);
    expect(grown.syncMs).toBeLessThan(100);
    expect(grown.frameMs).toBeLessThan(200);
    expect(await openedState(openedHandle)).toEqual({ connected: true, open: true });
    expect(await count(page.locator("#requestJson .json-row"))).toBe(rowsAfterOpen + 1);
    await expect.poll(() => paneScrollTop()).toBe(scrollBeforeGrow);
    // The newest message is the one that was not there before opening it: opening it has to
    // build all of its children, which is what "eventually displayed completely" means for
    // a body that grew while the request was in flight.
    const newest = page.locator('#requestJson [data-json-lazy="1"]').last();
    await openLazy(newest);
    expect(await count(newest.locator(":scope > .json-children > .json-row"))).toBe(
      messageChildren,
    );
    await expectPage(newest).toContainText(`k${messageCount}_${keyCount}`);
    await expectPage(page.locator("#requestJson")).not.toContainText(
      `k${messageCount}_${keyCount + 1}`,
    );
    const rowsWithNewest = await count(page.locator("#requestJson .json-row"));
    expect(rowsWithNewest).toBe(rowsAfterOpen + 1 + messageChildren);
    await resetMutations();
    // Opening the newest message scrolled the pane to the bottom of the size hints the
    // collapsed rows carry, so the scroll is put back where the user left it before the
    // next refresh is measured.
    await setScrollTop(page.locator("#requestJson"), 240);
    const scrollBeforeTick = await paneScrollTop();
    // A tick with the same bytes is free: nothing is rebuilt, so the expansion, the rows
    // and the scroll all stay exactly where the user left them.
    const unchanged = await page.evaluate<PaintTimings>(
      `window.__jsonRefresh(${messageCount + 1}, ${keyCount}, 'tick-two')`,
    );
    expect(await mutations()).toBe(0);
    expect(unchanged.syncMs).toBeLessThan(100);
    expect(await count(page.locator("#requestJson .json-row"))).toBe(rowsWithNewest);
    await expect.poll(() => paneScrollTop()).toBe(scrollBeforeTick);
    // The request finished with a body whose every value changed: the rows are rewritten in
    // place, the opened nodes stay where they are, and the pane ends up showing the result.
    await resetMutations();
    const scrollBeforeFinish = await paneScrollTop();
    const completed = await page.evaluate<PaintTimings>(
      `window.__jsonRefresh(${messageCount + 1}, ${keyCount + 10}, 'final-marker')`,
    );
    expect(completed.syncMs).toBeLessThan(250);
    await expectPage(page.locator("#requestJson")).toContainText("final-marker");
    expect(await openedState(openedHandle)).toEqual({ connected: true, open: true });
    expect(await count(page.locator("#requestJson .json-row"))).toBe(rowsWithNewest + 2 * 10);
    await expect.poll(() => paneScrollTop()).toBe(scrollBeforeFinish);
  });

  it("rewrites only the row that changed in a large body", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await page.evaluate(`
      window.__jsonOneChange = (changedMessage, changedKey) => {
        const body = {
          model: "gpt-5",
          marker: 'unchanged-marker',
          messages: Array.from({length: ${messageCount}}, (_, messageIndex) => {
            const message = {role: 'user', content: 'message ' + messageIndex};
            for (let key = 0; key < ${keyCount}; key++) message['k' + messageIndex + '_' + key] = 'v' + key;
            if (messageIndex === changedMessage && changedKey !== undefined)
              message['k' + changedMessage + '_' + changedKey] = 'changed-' + changedKey;
            return message;
          }),
        };
        const start = performance.now();
        window.__adminUiTest.applySelectedLogDetail({request: body, response: null}, {resetView: false});
        window.__oneChangeSyncMs = performance.now() - start;
      };
      window.__jsonOneChange(0, undefined);
    `);
    await expectPage(page.locator("#requestJson .json-row")).toHaveCount(messageCount + 4);
    const opened = page.locator('#requestJson [data-json-lazy="1"]').first();
    await openLazy(opened);
    // The handle is the element itself: after a refresh this node no longer carries the lazy
    // marker, so a locator would resolve to a different, still-collapsed message.
    const openedHandle = await opened.elementHandle();
    await expectPage(opened.locator(":scope > .json-children > .json-row")).toHaveCount(
      plainMessageChildren,
    );
    await startMutationWatch();
    await resetMutations();
    // One leaf inside the node the user opened changes. Nothing else in the pane is touched:
    // a collapsed node's children are not rebuilt, and an unchanged node is not even visited
    // deeply enough to rewrite its summary.
    await page.evaluate(`window.__jsonOneChange(0, 11)`);
    await expectPage(page.locator("#requestJson")).toContainText("changed-11");
    expect(await mutations()).toBeLessThanOrEqual(2);
    expect(await page.evaluate("window.__oneChangeSyncMs")).toBeLessThan(100);
    expect(await openedState(openedHandle)).toEqual({ connected: true, open: true });
    expect(await count(page.locator("#requestJson .json-row"))).toBe(
      messageCount + 4 + plainMessageChildren,
    );
  });

  it("keeps a scrolled lazy-node expand responsive", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await page.evaluate(`
      const body = {
        model: "gpt-5",
        messages: Array.from({length: 180}, (_, messageIndex) => {
          const message = {role: "user", content: "message " + messageIndex};
          for (let key = 0; key < 400; key++) message["k" + messageIndex + "_" + key] = "v" + key;
          return message;
        }),
      };
      window.__adminUiTest.applySelectedLogDetail({request: body, response: null}, {resetView: true});
    `);
    const pane = page.locator("#requestJson");
    await expectPage(pane.locator('[data-json-lazy="1"]')).toHaveCount(180);
    await pane.evaluate((el) => {
      el.scrollTop = Math.min(5000, el.scrollHeight / 2);
      el.dispatchEvent(new Event("scroll"));
    });
    const result = await page.evaluate<ScrolledExpandResult>(() => {
      const el = document.querySelector<HTMLElement>("#requestJson");
      if (!el) throw new Error("Expected request JSON pane");
      const details = Array.from(
        el.querySelectorAll<HTMLDetailsElement>('details[data-json-lazy="1"]'),
      );
      const detail = details[90];
      if (!detail) throw new Error("Expected a lazy JSON node after scrolling");
      const summary = detail.querySelector<HTMLElement>(":scope > summary");
      if (!summary) throw new Error("Expected a lazy JSON summary");
      const resultPromise = new Promise<ScrolledFrameResult>((resolve) => {
        let last = performance.now();
        let maxFrameGap = 0;
        let frames = 0;
        const watch = (timestamp: number) => {
          maxFrameGap = Math.max(maxFrameGap, timestamp - last);
          last = timestamp;
          frames += 1;
          if (frames >= 30) {
            resolve({
              maxFrameGap,
              connected: detail.isConnected,
              done: detail.dataset["jsonLazyDone"] ?? "",
              childRows: detail.querySelectorAll(":scope > .json-children > .json-row").length,
            });
            return;
          }
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      });
      const clickStart = performance.now();
      summary.click();
      const clickMs = performance.now() - clickStart;
      return resultPromise.then((frameResult) => ({ clickMs, ...frameResult }));
    });
    expect(result.clickMs).toBeLessThan(20);
    expect(result.maxFrameGap).toBeLessThan(100);
    expect(result.connected).toBe(true);
    expect(result.done).toBe("1");
    expect(result.childRows).toBe(402);
  });

  it("keeps reopening a large rendered array responsive", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await page.evaluate(`
      const body = {
        model: "gpt-5",
        messages: Array.from({length: 2500}, (_, index) => ({role: "user", content: "message " + index})),
      };
      window.__adminUiTest.applySelectedLogDetail({request: body, response: null}, {resetView: true});
    `);
    const pane = page.locator("#requestJson");
    const messages = pane.locator('details[data-json-depth="1"]').filter({ hasText: '"messages"' });
    await expectPage(messages).toHaveCount(1);
    await expectPage(messages).toHaveJSProperty("open", true);
    await messages.locator(":scope > summary").click();
    await expectPage(messages).toHaveJSProperty("open", false);
    await pane.evaluate((el) => {
      el.scrollTop = 1000;
      el.dispatchEvent(new Event("scroll"));
    });
    const result = await page.evaluate<ArrayExpandResult>(() => {
      const details = Array.from(
        document.querySelectorAll<HTMLDetailsElement>('#requestJson details[data-json-depth="1"]'),
      );
      const detail = details.find((candidate) =>
        candidate
          .querySelector<HTMLElement>(":scope > summary")
          ?.textContent.includes('"messages"'),
      );
      if (!detail) throw new Error("Expected messages detail");
      const summary = detail.querySelector<HTMLElement>(":scope > summary");
      if (!summary) throw new Error("Expected messages summary");
      const resultPromise = new Promise<ArrayFrameResult>((resolve) => {
        let last = performance.now();
        let maxFrameGap = 0;
        let frames = 0;
        const watch = (timestamp: number) => {
          maxFrameGap = Math.max(maxFrameGap, timestamp - last);
          last = timestamp;
          frames += 1;
          if (frames >= 30) resolve({ maxFrameGap, open: detail.open });
          else requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      });
      const clickStart = performance.now();
      summary.click();
      const clickMs = performance.now() - clickStart;
      return resultPromise.then((frameResult) => ({ clickMs, ...frameResult }));
    });
    expect(result.clickMs).toBeLessThan(20);
    expect(result.maxFrameGap).toBeLessThan(100);
    expect(result.open).toBe(true);
  });

  it("shows keys that arrive in a new order without rebuilding the rows they carry", async () => {
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await openRecordDetail("record-two");
    await page.locator("#autoRefreshLogs").uncheck();
    await page.evaluate(`
      window.__jsonReorder = (reversed) => {
        const body = reversed
          ? {gamma: 3, beta: 2, alpha: 1}
          : {alpha: 1, beta: 2, gamma: 3};
        window.__adminUiTest.applySelectedLogDetail({request: body, response: null}, {resetView: false});
      };
      window.__jsonReorder(false);
    `);
    await expectPage(page.locator("#requestJson .json-row")).toHaveCount(4);
    // The marks sit on the elements themselves, so a row that was moved keeps its mark and
    // a row that was rebuilt loses it: that is what tells a move apart from a rebuild.
    await page.evaluate(`
      document.querySelectorAll('#requestJson [data-json-child-key]').forEach(
        (row, index) => {
          row.__mark = index;
        });
      window.__marksKept = () =>
        Array.from(document.querySelectorAll('#requestJson [data-json-child-key]'))
          .every((row) => row.__mark !== undefined);
      window.__keyOrder = () =>
        Array.from(document.querySelectorAll('#requestJson [data-json-child-key]'))
          .map((row) => row.dataset.jsonChildKey);
    `);
    expect(await page.evaluate("window.__keyOrder()")).toEqual(["alpha", "beta", "gamma"]);
    await startMutationWatch();
    await resetMutations();
    await page.evaluate(`window.__jsonReorder(true)`);
    await expectPage(page.locator("#requestJson")).toContainText("3");
    // The pane shows the order the new body arrived in, and only moves the rows that were
    // out of place: the rows carrying the same values are the same elements.
    expect(await page.evaluate("window.__keyOrder()")).toEqual(["gamma", "beta", "alpha"]);
    expect(await page.evaluate("window.__marksKept()")).toBe(true);
    expect(await mutations()).toBeLessThanOrEqual(4);
  });
});
