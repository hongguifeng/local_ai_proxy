import { describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbBindingReads,
  lbStatusReads,
  setLbStatusPartialMetrics,
  setLbStatusRound,
} from "./admin-ui-fixture.js";
import { page } from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";
import {
  bindingListJson,
  bindingReadParameters,
  bindingRow,
  bindingsToggle,
  lbBindingLongTable,
  nodeState,
  openBindingList,
  openPairWithGroup,
  openTwoNodeStates,
  savedGroup,
  savedMemberIds,
  shownModels,
  taskReadQuery,
  tickMembers,
  waitForLbPoll,
} from "./admin-ui-lb-harness.js";

describe("admin UI load balancing groups", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("updates node numbers on a poll without losing the open panel, the draft, or the caret", async () => {
    // Everything this test waits for is the next status tick, so the page clock is installed
    // before the page loads and advanced by one poll interval instead of spending real time.
    await page.clock.install();
    const card = await openPairWithGroup();
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    await card.locator(".lb-status > summary").click();
    await expectPage(card.locator(".lb-node-state")).toHaveCount(2);
    await expectPage(card.locator('[data-lb-fact="source"]').nth(0)).toHaveText(
      "Metrics source: -",
    );

    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(0);
    const firstFlight = card.locator(".lb-node-state").nth(0).locator('[data-lb-fact="inFlight"]');
    await expectPage(firstFlight).toHaveText("In flight: 0");
    await expectPage(
      card.locator(".lb-node-state").nth(0).locator('[data-lb-fact="kv"]'),
    ).toHaveText("KV: 42%");
    await expectPage(
      card.locator(".lb-node-state").nth(0).locator('[data-lb-fact="source"]'),
    ).toHaveText("Metrics source: vllm");
    await expectPage(
      card.locator(".lb-node-state").nth(1).locator('[data-lb-fact="cooldown"]'),
    ).toHaveText("Cooldown: 4s");

    const patternInput = card.locator(".lb-card [data-lb-field='model_pattern']");
    await patternInput.click();
    await patternInput.press("End");
    await patternInput.pressSequentially("-plus");
    setLbStatusRound(7);
    const seen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    await expectPage(firstFlight).toHaveText("In flight: 7");
    await expectPage(patternInput).toHaveValue("Qwen3.8-Flash-Next-plus");
    await expectPage(patternInput).toBeFocused();
    await expectPage(card.locator(".lb-status")).toHaveAttribute("open");
    // A poll only rewrites numbers: the two chosen nodes keep their rows.
    await expectPage(card.locator(".lb-member-row")).toHaveCount(2);
    const stored = await page.evaluate(() => localStorage.getItem("llmProxyLbGroupOpen"));
    expect(stored).toContain("proxy-one");
    expect(stored).toContain("true");
  });

  it("[TRI-03] shows a metric the engine skipped as unknown instead of a fabricated zero", async () => {
    // Every wait here is for one more status tick, so the page clock is installed before the
    // page loads and advanced by one poll interval at a time.
    await page.clock.install();
    const card = await openPairWithGroup();
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    await card.locator(".lb-status > summary").click();
    await expectPage(card.locator(".lb-node-state")).toHaveCount(2);

    const quietWaiting = card.locator(".lb-node-state").nth(1).locator('[data-lb-fact="waiting"]');
    const quietBadge = card.locator(".lb-node-state").nth(1).locator('[data-lb-fact="enabled"]');
    const idleWaiting = card.locator(".lb-node-state").nth(0).locator('[data-lb-fact="waiting"]');

    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(0);
    await expectPage(quietWaiting).toHaveText("Waiting: 4");
    await expectPage(quietBadge).not.toContainText("incomplete");

    setLbStatusPartialMetrics(true);
    const seen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    // The second node's engine stopped answering: the row says unknown, and the badge says
    // why. Nothing here prints "0", "null" or "undefined" for a number that was never taken.
    await expectPage(quietWaiting).toHaveText("Waiting: -");
    await expectPage(quietBadge).toContainText("Metrics incomplete");
    await expectPage(idleWaiting).toHaveText("Waiting: 3");
    const rowText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-node-state")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(rowText).not.toMatch(/undefined|null/);

    await page.locator("#languageSelect").selectOption("zh");
    const zhSeen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(zhSeen);
    await expectPage(quietWaiting).toHaveText("排队: -");
    await expectPage(quietBadge).toContainText("指标不全");
    await expectPage(idleWaiting).toHaveText("排队: 3");

    await page.locator("#languageSelect").selectOption("en");
    const enSeen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(enSeen);
    await expectPage(quietWaiting).toHaveText("Waiting: -");
    setLbStatusPartialMetrics(false);
  });

  it("stops polling while the page is hidden or another tab is showing", async () => {
    // The page clock is installed before the page loads so each "no poll happened" window is
    // advanced on purpose instead of left to however long real time takes to reach a tick.
    await page.clock.install();
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-lb-group]").click();
    await tickMembers(card.locator(".lb-card"), [0]);
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(0);

    // The clock is held before the counter is read: an installed clock keeps following real time,
    // so a slow stretch between two steps can fire a tick by itself. With the clock held, the only
    // ticks that can move this counter are the ones this test advances on purpose.
    const frozenAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(frozenAt);
    const seen = lbStatusReads.length;
    try {
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
      });
      // Three poll intervals while hidden; the counter has to stay exactly where it was.
      await page.clock.runFor(6_000);
      expect(lbStatusReads.length).toBe(seen);

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { value: false, configurable: true });
      });
      await page.locator('.tab[data-tab="logs"]').click();
      // Three poll intervals on another tab; the counter has to stay exactly where it was.
      await page.clock.runFor(6_000);
      expect(lbStatusReads.length).toBe(seen);

      await page.locator('.tab[data-tab="proxies"]').click();
      await page.clock.runFor(2_000);
      await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    } finally {
      // closeTestPage drains the page with a setTimeout inside it, and a held clock never runs
      // that timer, so the clock goes back to real time before the hook can close the page.
      await page.clock.resume();
    }
  });

  it("owns one poll timer across repeated init, tab changes, visibility and disposal", async () => {
    await page.clock.install();
    await loadAdminPage();
    await expect.poll(() => lbStatusReads.length).toBe(1);
    await page.evaluate("__adminUiTest.proxyConfig.init(); __adminUiTest.proxyConfig.init();");
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBe(2);
    await page.locator('.tab[data-tab="logs"]').click();
    await page.clock.runFor(6_000);
    expect(lbStatusReads.length).toBe(2);
    await page.locator('.tab[data-tab="proxies"]').click();
    await expect.poll(() => lbStatusReads.length).toBe(3);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(6_000);
    expect(lbStatusReads.length).toBe(3);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => lbStatusReads.length).toBe(4);
    await page.evaluate(
      "__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.dispose();",
    );
    await page.clock.runFor(6_000);
    expect(lbStatusReads.length).toBe(4);
    await page.evaluate("__adminUiTest.proxyConfig.init(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbStatusReads.length).toBe(5);
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBe(6);
  });

  it("forwards caller and lifecycle cancellation through the production adapter", async () => {
    await loadAdminPage();
    await page.evaluate("__adminUiTest.proxyConfig.dispose();");
    const observed = await page.evaluate<Record<string, boolean>>(String.raw`
      (async () => {
        const originalFetch = window.fetch;
        const OriginalController = window.AbortController;
        const controllers = [];
        const polls = [];
        window.AbortController = class extends OriginalController {
          constructor() { super(); controllers.push(this); }
        };
        window.fetch = (url, options) => {
          if (url !== "/api/load-balancer/status") return originalFetch(url, options);
          // The real LB factory creates lifecycle, caller and forwarded controllers
          // before fetch; observing them here leaves production wiring intact.
          const [forwarded, caller, owner] = controllers.slice(-3).reverse();
          polls.push({ signal: options.signal, forwarded, caller, owner });
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new Error("request aborted"));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          });
        };
        try {
          // Reuse the instances the composition root built and initialized.
          __adminUiTest.proxyConfig.init();
          const first = polls[0];
          const composed = first.signal === first.forwarded.signal &&
            first.signal !== first.caller.signal && first.signal !== first.owner.signal;
          document.querySelector('[data-tab="logs"]').click();
          const callerAbort = first.signal.aborted && first.caller.signal.aborted && !first.owner.signal.aborted;
          document.querySelector('[data-tab="proxies"]').click();
          const second = polls[1];
          const pendingBeforeOwnerAbort = !second.signal.aborted;
          first.owner.abort();
          const lifecycleAbort = second.signal.aborted && !second.caller.signal.aborted;
          // Initialize the production LB owner again through proxy lifecycle init.
          __adminUiTest.proxyConfig.dispose();
          __adminUiTest.proxyConfig.init();
          const third = polls[polls.length - 1];
          const pendingBeforeDispose = !third.signal.aborted;
          __adminUiTest.loadBalancing.dispose();
          const disposalAbort = third.signal.aborted;
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { composed, callerAbort, pendingBeforeOwnerAbort, lifecycleAbort, pendingBeforeDispose, disposalAbort };
        } finally {
          __adminUiTest.proxyConfig.dispose();
          window.fetch = originalFetch;
          window.AbortController = OriginalController;
        }
      })()
    `);
    expect(observed).toEqual({
      composed: true,
      callerAbort: true,
      pendingBeforeOwnerAbort: true,
      lifecycleAbort: true,
      pendingBeforeDispose: true,
      disposalAbort: true,
    });
  });

  it(
    "[TRI-06] opens one node's bindings and keeps binding counts apart from task counts",
    async () => {
      // The only real wait in this test is one more status tick, so the page clock is installed
      // before the page loads and advanced by one poll interval.
      await page.clock.install();
      const card = await openTwoNodeStates();
      const panel = await openBindingList(card, 0);
      // The panel is never an empty box: it says it is reading before any row arrives.
      const opened = await panel.evaluate((element) => element.innerHTML);
      expect(opened).not.toBe("");
      await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
      await expectPage(panel.locator("[data-lb-binding-summary]")).toHaveText(
        "Bindings on this node: 20 / 25 · Linked tasks in the rows shown: 6",
      );
      // One move affordance per binding row, never one per linked task. The row whose three
      // tasks share one binding carries the same single button as a row with no task at all.
      await expectPage(panel.locator("[data-lb-binding-move]")).toHaveCount(
        await panel.locator(".lb-binding").count(),
      );
      await expectPage(bindingRow(panel, 7).locator("[data-lb-binding-move]")).toHaveCount(1);
      await expectPage(bindingRow(panel, 100).locator("[data-lb-binding-move]")).toHaveCount(1);
      // Three linked tasks are still one binding: the row says so with a `+2` beside the
      // task it is titled by, and the count the list reports is in that chip's hover text.
      await expectPage(bindingRow(panel, 7).locator("[data-lb-binding-tasks]")).toHaveText("+2");
      await expectPage(bindingRow(panel, 7).locator("[data-lb-binding-tasks]")).toHaveAttribute(
        "title",
        /^Linked tasks: 3 ·/,
      );

      // The node's own line keeps the numbers the status call answered. Twenty bindings on
      // screen do not rewrite the count that poll gave, and a binding's own in-flight figure
      // is a separate measure of a separate thing.
      const beforePoll = lbStatusReads.length;
      await page.clock.runFor(2_000);
      await expect.poll(() => lbStatusReads.length).toBeGreaterThan(beforePoll);
      await expectPage(nodeState(card, 0).locator('[data-lb-fact="bindings"]')).toHaveText(
        "Bindings: 0",
      );
      await expectPage(nodeState(card, 0).locator('[data-lb-fact="inFlight"]')).toHaveText(
        "In flight: 0",
      );
      await expectPage(bindingRow(panel, 7).locator(".lb-binding-line")).toHaveAttribute(
        "data-lb-hover-in-flight",
        "In flight: 1",
      );
      await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    },
    UI_TEST_TIMEOUT_MS,
  );

  it("[TRI-06] says unknown activity and unknown metrics in their own words", async () => {
    // One status tick is all the poll wait here needs, so the page clock is installed before the
    // page loads and advanced by one poll interval.
    await page.clock.install();
    const card = await openTwoNodeStates();
    const quietPanel = await openBindingList(card, 1);
    await expectPage(quietPanel.locator(".lb-binding")).toHaveCount(1);
    const unknownActivity = quietPanel.locator('[data-lb-binding-fact="activity"]');
    await expectPage(unknownActivity).toHaveText("activity unknown");
    await expectPage(unknownActivity).toHaveClass(/is-unknown/);
    await expectPage(unknownActivity).not.toHaveText("idle now");

    // The three activity states exist side by side and are never interchanged.
    const busyPanel = await openBindingList(card, 0);
    await expectPage(busyPanel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(
      bindingRow(busyPanel, 7).locator('[data-lb-binding-fact="activity"]'),
    ).toHaveText("request in flight");
    await expectPage(
      bindingRow(busyPanel, 9).locator('[data-lb-binding-fact="activity"]'),
    ).toHaveText("idle now");
    await expectPage(
      bindingRow(busyPanel, 18).locator('[data-lb-binding-fact="activity"]'),
    ).toHaveText("activity unknown");

    // The engine stops answering the second node. Its badge keeps its own sentence, and the
    // binding list's own "unknown" never bleeds into it or into a number.
    setLbStatusPartialMetrics(true);
    const seen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="enabled"]')).toContainText(
      "Metrics incomplete",
    );
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="enabled"]')).not.toContainText(
      "activity unknown",
    );
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="waiting"]')).toHaveText(
      "Waiting: -",
    );
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="bindings"]')).toHaveText(
      "Bindings: 1",
    );
    const panelText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-binding-panel")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(panelText).not.toMatch(/undefined|null/);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(unknownActivity).toHaveText("活动未知");
    await expectPage(
      bindingRow(busyPanel, 9).locator('[data-lb-binding-fact="activity"]'),
    ).toHaveText("当前空闲");
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="enabled"]')).toContainText(
      "指标不全",
    );
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="waiting"]')).toHaveText("排队: -");

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(unknownActivity).toHaveText("activity unknown");
    setLbStatusPartialMetrics(false);
  });

  it("[TRI-06] pages the list and keeps the rows the user paged to through a refresh", async () => {
    // The refresh this test checks is one status tick away, so the page clock is installed before
    // the page loads and advanced by one poll interval instead of waiting in real time.
    await page.clock.install();
    const card = await openTwoNodeStates();
    const [firstTarget, secondTarget] = savedMemberIds();
    if (firstTarget === undefined || secondTarget === undefined) {
      throw new Error("the saved group does not have two nodes");
    }
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-summary]")).toContainText("20 / 25");
    await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveCount(0);
    const more = panel.locator("[data-lb-binding-more]");
    await expectPage(more).toHaveText("Load more (20/25)");
    await more.click();
    await expectPage(panel.locator(".lb-binding")).toHaveCount(25);
    await expectPage(more).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-summary]")).toContainText("25 / 25");

    // Every read names the node it was asked about; the second node's list is its own page.
    const firstReads = () => lbBindingReads.filter((read) => read.targetId === firstTarget);
    const firstOpening = firstReads()[0];
    if (firstOpening === undefined) throw new Error("the binding list was never read");
    expect(firstOpening).toMatchObject({
      pairId: "proxy-one",
      groupId: savedGroup().id,
      limit: 20,
      offset: 0,
    });
    expect(firstReads().some((read) => read.limit === 20 && read.offset === 20)).toBe(true);

    // A refresh reads from the top with room for everything already on screen, so the rows
    // the user paged to are not dropped by a poll.
    const seen = lbStatusReads.length;
    const readsBeforeRefresh = lbBindingReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(25);
    // The read this poll caused is the one that asked for everything already on screen.
    await expect
      .poll(
        () =>
          lbBindingReads
            .slice(readsBeforeRefresh)
            .some(
              (read) => read.targetId === firstTarget && read.offset === 0 && read.limit === 25,
            ),
        { timeout: UI_TEST_TIMEOUT_MS, interval: 200 },
      )
      .toBe(true);

    // Opening the other node asks for that node alone; the first list keeps its 25 rows.
    const otherPanel = await openBindingList(card, 1);
    await expectPage(otherPanel.locator(".lb-binding")).toHaveCount(1);
    await expectPage(otherPanel.locator("[data-lb-binding-summary]")).toContainText("1 / 1");
    const secondOpening = lbBindingReads.find((read) => read.targetId === secondTarget);
    if (secondOpening === undefined) throw new Error("the second node was never read");
    expect(secondOpening).toMatchObject({ targetId: secondTarget, limit: 20, offset: 0 });
    await expectPage(panel.locator(".lb-binding")).toHaveCount(25);
    await expectPage(bindingRow(otherPanel, 21)).toHaveCount(1);

    // The rows are the binding's own address, so the same node's list is not a task list.
    await expectPage(panel.locator("[data-lb-binding-id]")).toHaveCount(25);
  });

  it("[TRI-06] never lets a late answer overwrite the newer one", async () => {
    const card = await openTwoNodeStates();
    let answered = 0;
    await page.route("**/api/load-balancer/tasks*", (route) => {
      answered += 1;
      const query = taskReadQuery(new URL(route.request().url()));
      const first = answered === 1;
      void (async () => {
        // The first answer is held back; the second is served at once.
        if (first) await new Promise((resolve) => setTimeout(resolve, 800));
        await route.fulfill({ json: bindingListJson(query, first ? 0 : 1) });
      })();
    });
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toBeVisible();
    // Close and reopen while the first answer is still on its way: the second read owns the
    // panel, and its numbers are the ones that must stay.
    await bindingsToggle(card, 0).click();
    await expectPage(panel).toBeHidden();
    await bindingsToggle(card, 0).click();
    await expectPage(panel).toBeVisible();
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(bindingRow(panel, 7).locator('[data-lb-binding-fact="requests"]')).toHaveText(
      "requests 999",
    );
    // The held-back copy arrives after the newer one. It is dropped, not merged: the row keeps
    // the newer count and the panel keeps the rows the newer read answered.
    // Real time on purpose: the held-back copy is a real fetch, and the race is the test.
    await page.waitForTimeout(1_200);
    await expectPage(bindingRow(panel, 7).locator('[data-lb-binding-fact="requests"]')).toHaveText(
      "requests 999",
    );
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);
    expect(answered).toBeGreaterThanOrEqual(2);
  });

  it("[TRI-06] drops the old runtime's rows when a later page reports another epoch", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    const asked = bindingReadParameters();
    const labels = ["OLD_RUNTIME", "NEW_RUNTIME"] as const;
    // The pair restarted between the first page and the page the user asked for. From that
    // answer on, every read names the new epoch - the read from offset 0 included, exactly
    // as a restarted pair would name it.
    let moved = false;
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      if (query.offset > 0) moved = true;
      const reply = lbBindingFixturePage(query, 0);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      const label = moved ? labels[1] : labels[0];
      void route.fulfill({
        json: {
          ...reply.response,
          runtimeEpoch: moved ? "epoch-two" : "epoch-one",
          items: reply.response.items.map((item) => ({ ...item, model: label })),
        },
      });
    });
    const panel = await openBindingList(card, 0);
    const models = shownModels(panel, labels);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expect.poll(models).toEqual(Array.from({ length: 20 }, () => labels[0]));

    await panel.locator("[data-lb-binding-more]").click();
    // The rows on screen belong to a runtime that is gone, so they are dropped rather than
    // appended to: one panel shows one generation, never half of each.
    await expect.poll(models).toEqual(Array.from({ length: 20 }, () => labels[1]));
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);
    // Not stuck: the restart is one read, and the next page is still offered.
    await expectPage(panel.locator("[data-lb-binding-more]")).toHaveText("Load more (20/25)");

    // The new generation was read from the top, not from where the old list ran out.
    await expect.poll(() => asked.map((read) => read.offset)).toEqual([0, 20, 0]);
    expect(asked.every((read) => read.limit === 20)).toBe(true);
  });

  it("[TRI-06] drops the old rows when the group revision moved under one runtime", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    const asked = bindingReadParameters();
    const labels = ["REVISION_ONE", "REVISION_TWO"] as const;
    // Same runtime, but the group's routing signature moved while the user was paging, so
    // the rows on screen carry expectations decided under the older revision.
    let moved = false;
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      if (query.offset > 0) moved = true;
      const reply = lbBindingFixturePage(query, 0);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      const label = moved ? labels[1] : labels[0];
      void route.fulfill({
        json: {
          ...reply.response,
          groupRevision: moved ? 13 : 12,
          items: reply.response.items.map((item) => ({ ...item, model: label })),
        },
      });
    });
    const panel = await openBindingList(card, 0);
    const models = shownModels(panel, labels);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expect.poll(models).toEqual(Array.from({ length: 20 }, () => labels[0]));

    await panel.locator("[data-lb-binding-more]").click();
    await expect.poll(models).toEqual(Array.from({ length: 20 }, () => labels[1]));
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);
    await expect.poll(() => asked.map((read) => read.offset)).toEqual([0, 20, 0]);
  });

  it("[TRI-06] lists one binding once when the table shifted while the user paged", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    const [firstTarget] = savedMemberIds();
    if (firstTarget === undefined) throw new Error("the saved group has no node");
    const asked = bindingReadParameters();
    const table = lbBindingLongTable(firstTarget, 45);
    const firstBinding = table[0];
    if (firstBinding === undefined) throw new Error("the long binding table is empty");
    // A new binding became the most recently seen one, so every existing row moved down one
    // place: the page the user asked for now carries a binding the panel already shows.
    const arrived = { ...firstBinding, bindingId: 600, model: "arrived-latest-binding" };
    const shifted = [arrived, ...table];
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      const ordered = query.offset === 0 ? table : shifted;
      const rows = ordered.slice(query.offset, query.offset + query.limit);
      const hasMore = query.offset + rows.length < ordered.length;
      const reply = lbBindingFixturePage(query);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      void route.fulfill({
        json: {
          ...reply.response,
          items: rows,
          totalBindings: ordered.length,
          hasMore,
          nextOffset: hasMore ? query.offset + rows.length : query.offset,
          nodes: reply.response.nodes.map((node) =>
            node.targetId === firstTarget ? { ...node, bindings: ordered.length } : node,
          ),
        },
      });
    });
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const more = panel.locator("[data-lb-binding-more]");
    await more.click();
    // 20 rows were on screen and the page carried 20, of which one was already shown: the
    // panel ends with 39 rows, with that binding listed once.
    await expectPage(panel.locator(".lb-binding")).toHaveCount(39);
    await expectPage(bindingRow(panel, 519)).toHaveCount(1);
    const listed = await panel
      .locator(".lb-binding")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-lb-binding-id") ?? ""),
      );
    expect(new Set(listed).size).toBe(listed.length);
    // The panel holds 39 rows while the server's progress is 40 - the two are not the same
    // number, and it is the server's that the next read has to ask with.
    await expectPage(more).toHaveText("Load more (39/46)");
    await more.click();
    await expect.poll(() => asked.at(-1)).toEqual({ offset: 40, limit: 20 });
    // The last page answers the rest, so the list ends on its own instead of asking for the
    // same page over and over.
    await expectPage(panel.locator(".lb-binding")).toHaveCount(45);
    await expectPage(more).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    const listedAgain = await panel
      .locator(".lb-binding")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-lb-binding-id") ?? ""),
      );
    expect(new Set(listedAgain).size).toBe(listedAgain.length);
    expect(listedAgain.filter((id) => id === "519")).toHaveLength(1);
  });

  it("[TRI-06] stops paging at the row cap and keeps the cap on a refresh", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    const [firstTarget] = savedMemberIds();
    if (firstTarget === undefined) throw new Error("the saved group has no node");
    const asked = bindingReadParameters();
    const table = lbBindingLongTable(firstTarget, 260);
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      const rows = table.slice(query.offset, query.offset + query.limit);
      const hasMore = query.offset + rows.length < table.length;
      const reply = lbBindingFixturePage(query);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      void route.fulfill({
        json: {
          ...reply.response,
          items: rows,
          totalBindings: table.length,
          hasMore,
          nextOffset: hasMore ? query.offset + rows.length : query.offset,
          nodes: reply.response.nodes.map((node) =>
            node.targetId === firstTarget ? { ...node, bindings: table.length } : node,
          ),
        },
      });
    });
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    for (let shown = 20; shown < 200; shown += 20) {
      await panel.locator("[data-lb-binding-more]").click();
      await expectPage(panel.locator(".lb-binding")).toHaveCount(shown + 20);
      // Until the cap is reached the pager keeps offering the next page and says nothing
      // about a limit.
      if (shown + 20 < 200) {
        await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveCount(0);
      }
    }
    // The row cap is a stated limit, not a silent truncation, and it hides the pager.
    await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveText(
      "Reached the cap of one read",
    );
    await expectPage(panel.locator("[data-lb-binding-more]")).toHaveCount(0);
    expect(asked.every((read) => read.limit <= 200)).toBe(true);

    // The poll that refreshes this panel reads from the top with the cap, never more, and the
    // rows the user paged to stay on screen.
    const seen = lbStatusReads.length;
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    await expect
      .poll(() => asked.some((read) => read.offset === 0 && read.limit === 200), {
        timeout: UI_TEST_TIMEOUT_MS,
        interval: 200,
      })
      .toBe(true);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(200);
    await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveText(
      "Reached the cap of one read",
    );
  });

  it("[TRI-06] stops at the row cap when pages repeat shown bindings", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    const [firstTarget] = savedMemberIds();
    if (firstTarget === undefined) throw new Error("the saved group has no node");
    // Paging is driven by the clicks alone, so the two-second status poll must not answer in
    // the middle of them. The read the page made when it loaded is applied first, and then the
    // clock is held at the time the page reports. An accepted poll refills every open panel from
    // offset 0, which replaces the deduped rows with the contiguous top window, so an append
    // that followed one would ask at that window's own progress instead of the progress the
    // pages left behind. Holding the clock keeps the poll still until the test advances it on
    // purpose, which is the one refresh this test checks at the end.
    await expectPage(nodeState(card, 1).locator('[data-lb-fact="cooldown"]')).toHaveText(
      "Cooldown: 4s",
    );
    const frozenAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(frozenAt);
    try {
      const asked = bindingReadParameters();
      const table = lbBindingLongTable(firstTarget, 300);
      // The cap and the dedup together: a table longer than one read's cap whose order keeps
      // shifting while the user pages, so each page carries a binding the panel already holds
      // and the rows on screen never line up with the pages. A new binding became the most
      // recently seen one before each of the first nine appends, which moved every existing row
      // down one place; after the ninth shift the arrivals stop, so the table settles and the
      // page that fills the room left under the cap carries nothing already shown.
      const shiftsWhilePaging = 9;
      let appends = 0;
      await page.route("**/api/load-balancer/tasks*", (route) => {
        const query = taskReadQuery(new URL(route.request().url()));
        const reply = lbBindingFixturePage(query);
        if (!("response" in reply)) throw new Error("the stub refused the binding list");
        const rows = table.slice(query.offset, query.offset + query.limit);
        if (query.offset > 0) {
          appends += 1;
          const boundary = table[query.offset - 1];
          if (boundary === undefined) throw new Error("the long binding table has no boundary row");
          if (appends <= shiftsWhilePaging) rows[0] = boundary;
        }
        const hasMore = query.offset + rows.length < table.length;
        void route.fulfill({
          json: {
            ...reply.response,
            items: rows,
            totalBindings: table.length,
            hasMore,
            nextOffset: hasMore ? query.offset + rows.length : query.offset,
            nodes: reply.response.nodes.map((node) =>
              node.targetId === firstTarget ? { ...node, bindings: table.length } : node,
            ),
          },
        });
      });
      const panel = await openBindingList(card, 0);
      const listedIds = async (): Promise<string[]> =>
        panel
          .locator(".lb-binding")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-lb-binding-id") ?? ""),
          );
      await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
      const more = panel.locator("[data-lb-binding-more]");
      const shownCounts: number[] = [];

      // One row short of a full page every time, so the panel never sits on a round page and
      // never reaches the cap by an even stride. The next read is asked with the server's
      // progress, which runs ahead of the rows held here.
      for (let step = 1; step <= shiftsWhilePaging; step += 1) {
        await more.click();
        const held = 20 + 19 * step;
        await expectPage(panel.locator(".lb-binding")).toHaveCount(held);
        shownCounts.push(held);
        await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveCount(0);
        await expect.poll(() => asked.at(-1)).toEqual({ offset: 20 * step, limit: 20 });
        expect(new Set(await listedIds()).size).toBe(held);
      }
      // The panel holds 191 rows while the server's progress is 200: the button says the panel's
      // own number, and the room left is what the next read asks for - 9, not a whole page. Only
      // the click that opened the list read from the top, so these rows came from paging alone.
      expect(asked.filter((read) => read.offset === 0)).toHaveLength(1);
      await expectPage(more).toHaveText("Load more (191/300)");
      await more.click();
      await expectPage(panel.locator(".lb-binding")).toHaveCount(200);
      shownCounts.push(200);
      await expect.poll(() => asked.at(-1)).toEqual({ offset: 200, limit: 9 });
      // The cap is a stated limit, not a silent truncation, and it hides the pager. No row was
      // ever listed twice, and the list never passed 200 rows at any step.
      expect(shownCounts.every((held) => held <= 200)).toBe(true);
      expect(asked.every((read) => read.limit <= 200)).toBe(true);
      expect(new Set(await listedIds()).size).toBe(200);
      await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveText(
        "Reached the cap of one read",
      );
      await expectPage(more).toHaveCount(0);
      await expectPage(panel.locator("[data-lb-binding-summary]")).toContainText("200 / 300");
      // Progress is the server's: every append asked deeper than the one before it, and the
      // last one asked at 200 rather than at the 191 rows held here.
      expect(asked.filter((read) => read.offset > 0).map((read) => read.offset)).toEqual(
        Array.from({ length: shiftsWhilePaging + 1 }, (_, index) => 20 * (index + 1)),
      );

      // The poll that refreshes this panel reads from the top with the cap, never more, and the
      // list keeps its 200 rows and its stated limit.
      const seen = lbStatusReads.length;
      await page.clock.runFor(2_000);
      await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
      await expect
        .poll(() => asked.some((read) => read.offset === 0 && read.limit === 200), {
          timeout: UI_TEST_TIMEOUT_MS,
          interval: 200,
        })
        .toBe(true);
      await expectPage(panel.locator(".lb-binding")).toHaveCount(200);
      await expectPage(panel.locator("[data-lb-binding-limit]")).toHaveText(
        "Reached the cap of one read",
      );
      await expectPage(more).toHaveCount(0);
      expect(new Set(await listedIds()).size).toBe(200);
      await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);
      await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    } finally {
      // closeTestPage drains the page with a setTimeout inside it, and a held clock never runs
      // that timer, so the clock goes back to real time before the hook can close the page.
      await page.clock.resume();
    }
  });

  it("[TRI-06] does not report a cancelled read as a failure and reads again afterwards", async () => {
    await page.clock.install();
    const card = await openTwoNodeStates();
    // The first two reads of the binding list never answer: closing the list has to cancel
    // one of them and disposing the surface the other. Reads after those two go to the stub
    // as they normally would, which is what proves the panel was not poisoned.
    await page.evaluate(String.raw`
      (() => {
        const originalFetch = window.fetch;
        let remaining = 2;
        window.fetch = (input, init) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (!url.includes("/api/load-balancer/tasks")) return originalFetch(input, init);
          remaining -= 1;
          if (remaining < 0) return originalFetch(input, init);
          return new Promise((_resolve, reject) => {
            const abort = () =>
              reject(new DOMException("Cancelled by the surface", "AbortError"));
            const signal = init && init.signal;
            if (signal && signal.aborted) abort();
            else if (signal) signal.addEventListener("abort", abort, { once: true });
          });
        };
      })()
    `);
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toBeVisible();

    // Closing the list is a cancellation, not a failed query: nothing claims the read went
    // wrong, and nothing prints the cancellation's own words.
    await bindingsToggle(card, 0).click();
    await expectPage(panel).toBeHidden();
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);

    await bindingsToggle(card, 0).click();
    await expectPage(panel.locator("[data-lb-binding-loading]")).toBeVisible();
    const seen = lbStatusReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose()");
    // Disposal stops the list the same way it stops the status poll, and the panel does not
    // turn that into a query error the user never had.
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);

    // A new surface reads the same panel normally: the rows arrive from the read its own
    // status poll asks for, and the old cancelled read has no say left in them.
    await page.evaluate("__adminUiTest.proxyConfig.init()");
    await waitForLbPoll(seen);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
  });
});
