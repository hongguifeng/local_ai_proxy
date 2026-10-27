import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Locator } from "@playwright/test";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbBindingMoveOperation,
  lbBindingReads,
  lbMoveCall,
  lbMoveCalls,
  lbStatusReads,
  pairs,
  setLbBindingFailure,
  setLbBindingIneligibleDestination,
  setLbBindingMigrationOperations,
  setLbBindingMoveBlocking,
  setLbBindingRound,
  setLbBindingRouteBump,
  setLbBindingRuntimeEpoch,
  setLbCancelReply,
  setLbMoveReply,
  setLbStatusPartialMetrics,
  setLbStatusRound,
  setPairsSaveIssues,
} from "./admin-ui-fixture.js";
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

describe("admin UI load balancing groups", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  /** A pair with two engine nodes plus one empty group card. */
  async function openPairWithGroup() {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(2);
    await card.locator("[data-add-lb-group]").click();
    await expectPage(card.locator(".lb-card")).toHaveCount(1);
    return card;
  }

  async function waitForLbPoll(previousCount: number) {
    await expect
      .poll(() => lbStatusReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
      .toBeGreaterThan(previousCount);
  }

  function savedGroup() {
    const group = pairs[0]?.load_balancers[0];
    if (group === undefined) throw new Error("no load balancing group was saved");
    return group;
  }

  /** The candidate nodes float over the card, so the list has to be opened before
   *  anything can be ticked. It stays open while ticking and Escape clears it. */
  async function tickMembers(group: Locator, indexes: number[]) {
    const pop = group.locator("[data-lb-picker-pop]");
    await expectPage(pop).toBeHidden();
    await group.locator("[data-lb-picker-toggle]").click();
    await expectPage(pop).toBeVisible();
    for (const index of indexes) {
      await pop.locator("[data-lb-node]").nth(index).check();
      await expectPage(pop).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expectPage(pop).toBeHidden();
  }

  it("saves a group with two nodes and brings it back after a reload", async () => {
    const card = await openPairWithGroup();
    await expectPage(card.locator(".lb-takeover-note")).toHaveCount(2);

    await card.locator(".lb-card [data-lb-field='name']").fill("Dual GPU");
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await card.locator(".lb-card [data-lb-field='strategy']").selectOption("round_robin");
    const boxes = card.locator(".lb-card [data-lb-node]");
    await expectPage(boxes).toHaveCount(2);
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    await expectPage(card.locator(".lb-card .lb-member-row-name")).toHaveText([
      "Fixture Target",
      "Target",
    ]);
    await card.locator(".lb-card [data-lb-flag='failover_enabled']").uncheck();
    await expectPage(card.locator(".lb-takeover-note")).toHaveCount(2);

    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(pairs[0]?.load_balancers ?? []).toHaveLength(1);
    expect(savedGroup()).toMatchObject({
      name: "Dual GPU",
      model_pattern: "Qwen3.8-Flash-Next",
      strategy: "round_robin",
      metrics_enabled: true,
      failover_enabled: false,
    });
    expect(savedGroup().members.map(({ target_id }) => target_id)).toHaveLength(2);

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pairs") && response.request().method() === "GET",
      ),
      page.reload({ waitUntil: "domcontentloaded" }),
    ]);
    const reloaded = page.locator('.proxy-card[data-index="0"]');
    await expectPage(reloaded.locator(".lb-card")).toHaveCount(1);
    await expectPage(reloaded.locator(".lb-card [data-lb-field='name']")).toHaveValue("Dual GPU");
    await expectPage(reloaded.locator(".lb-card [data-lb-field='model_pattern']")).toHaveValue(
      "Qwen3.8-Flash-Next",
    );
    await expectPage(reloaded.locator(".lb-card [data-lb-field='strategy']")).toHaveValue(
      "round_robin",
    );
    const reloadedBoxes = reloaded.locator(".lb-card [data-lb-node]");
    await expectPage(reloadedBoxes).toHaveCount(2);
    await expectPage(reloaded.locator(".lb-card .lb-member-row-name")).toHaveText([
      "Fixture Target",
      "Target",
    ]);
    await reloaded.locator(".lb-card [data-lb-picker-toggle]").click();
    await expectPage(reloadedBoxes.nth(0)).toBeChecked();
    await expectPage(reloadedBoxes.nth(1)).toBeChecked();
    await expectPage(reloaded.locator(".lb-card [data-lb-toggle]")).toBeChecked();
    await expectPage(
      reloaded.locator(".lb-card [data-lb-flag='failover_enabled']"),
    ).not.toBeChecked();
    await expectPage(reloaded.locator(".lb-card")).not.toHaveClass(/expanded/);
  });

  it("lists every node in a floating picker and keeps only the chosen ones on the card", async () => {
    const card = await openPairWithGroup();
    await page.setViewportSize({ width: 1278, height: 1215 });
    const group = card.locator(".lb-card");
    const pop = group.locator("[data-lb-picker-pop]");
    const toggle = group.locator("[data-lb-picker-toggle]");

    await expectPage(group.locator(".lb-member-row")).toHaveCount(0);
    await expectPage(group.locator(".lb-member-rows")).toHaveText("No nodes selected");
    await expectPage(pop).toBeHidden();
    await expectPage(toggle).toHaveAttribute("aria-expanded", "false");

    const heightBefore = await group.evaluate((element) => element.getBoundingClientRect().height);
    await toggle.click();
    await expectPage(pop).toBeVisible();
    await expectPage(toggle).toHaveAttribute("aria-expanded", "true");
    // Every forwarding address is a candidate while the member list stays empty.
    await expectPage(pop.locator(".lb-member")).toHaveCount(2);
    await expectPage(group.locator(".lb-member-row")).toHaveCount(0);
    // The list floats over the card instead of pushing its content down, so the
    // card keeps its height and the member rows sit underneath the list.
    const heightAfter = await group.evaluate((element) => element.getBoundingClientRect().height);
    expect(heightAfter).toBe(heightBefore);
    const popBox = await pop.boundingBox();
    const rowsBox = await group.locator(".lb-member-rows").boundingBox();
    if (popBox === null || rowsBox === null) throw new Error("the picker was not laid out");
    expect(popBox.y).toBeLessThan(rowsBox.y);
    expect(popBox.y + popBox.height).toBeGreaterThan(rowsBox.y);

    await pop.locator(".lb-member").nth(0).locator("input").check();
    await expectPage(pop).toBeVisible();
    await expectPage(group.locator(".lb-member-row-name")).toHaveText(["Fixture Target"]);
    await pop.locator(".lb-member").nth(1).locator("input").check();
    await expectPage(group.locator(".lb-member-row-name")).toHaveText(["Fixture Target", "Target"]);

    // A click outside the list closes it; the chosen nodes stay on the card.
    await page.mouse.click(popBox.x + popBox.width + 140, popBox.y + 12);
    await expectPage(pop).toBeHidden();
    await expectPage(toggle).toHaveAttribute("aria-expanded", "false");
    await expectPage(group.locator(".lb-member-row")).toHaveCount(2);

    await toggle.click();
    await page.keyboard.press("Escape");
    await expectPage(pop).toBeHidden();
    await toggle.click();
    await expectPage(pop.locator("[data-lb-node]").nth(0)).toBeChecked();
    await expectPage(pop.locator("[data-lb-node]").nth(1)).toBeChecked();

    // A disabled member is marked on one line, in the list and on its own row.
    await card.locator(".target-card").nth(1).locator("[data-target-enabled]").uncheck();
    await expectPage(group.locator(".lb-member-row-name .lb-off")).toHaveText("off");
    const chipMarkHeights = await group
      .locator(".lb-member-row-name .lb-off")
      .evaluateAll((marks) => marks.map((mark) => Math.round(mark.getBoundingClientRect().height)));
    expect(Math.max(...chipMarkHeights)).toBeLessThan(24);
    const rowHeights = await pop
      .locator(".lb-member")
      .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));
    expect(Math.max(...rowHeights)).toBeLessThan(34);

    // A node added later is offered in the list but never joins the card line.
    await page.keyboard.press("Escape");
    await card.locator("[data-add-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(3);
    await expectPage(group.locator(".lb-member-row")).toHaveCount(2);
    await toggle.click();
    await expectPage(pop.locator(".lb-member")).toHaveCount(3);
    await expectPage(pop.locator("[data-lb-node]").nth(2)).not.toBeChecked();
  });

  it("gives each chosen node one row with a model id box of its own", async () => {
    const card = await openPairWithGroup();
    const group = card.locator(".lb-card");
    await expectPage(group.locator(".lb-member-row")).toHaveCount(0);
    await tickMembers(group, [0, 1]);

    await expectPage(group.locator(".lb-member-row")).toHaveCount(2);
    await expectPage(group.locator(".lb-member-row-name")).toHaveText(["Fixture Target", "Target"]);
    // An empty box means no mapping, and the card says so out loud.
    await expectPage(group.locator(".lb-member-row-model").nth(0)).toHaveValue("");
    await expectPage(group.locator(".lb-member-row-model").nth(1)).toHaveValue("");
    await expectPage(group.locator(".lb-member-hint")).toBeVisible();
    await expectPage(group.locator(".lb-member-hint")).toContainText(
      "forwards the requested model",
    );

    // The two columns are fixed shares, so both rows line up on the same pixels.
    const columns = await group.locator(".lb-member-row").evaluateAll((rows) =>
      rows.map((row) => {
        const name = row.querySelector(".lb-member-row-name")?.getBoundingClientRect();
        const box = row.querySelector(".lb-member-row-model")?.getBoundingClientRect();
        return {
          nameX: Math.round(name?.left ?? 0),
          nameW: Math.round(name?.width ?? 0),
          boxX: Math.round(box?.left ?? 0),
          boxW: Math.round(box?.width ?? 0),
        };
      }),
    );
    expect(columns[1]).toEqual(columns[0]);

    await group.locator(".lb-member-row-model").nth(1).fill("Qwen3.8-Flash-Next-WIN2");
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");

    const members = savedGroup().members;
    expect(members[0]).toEqual({ target_id: "target-one", model_id: "" });
    expect(members[1]?.target_id).not.toBe("target-one");
    expect(members[1]?.model_id).toBe("Qwen3.8-Flash-Next-WIN2");
  });

  it("drops a model box and its typed mapping when the node is unticked", async () => {
    const card = await openPairWithGroup();
    const group = card.locator(".lb-card");
    await tickMembers(group, [0, 1]);
    await group.locator(".lb-member-row-model").nth(1).fill("Qwen3.8-Flash-Next-WIN2");
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(savedGroup().members[1]?.model_id).toBe("Qwen3.8-Flash-Next-WIN2");

    await group.locator("[data-lb-picker-toggle]").click();
    await group.locator("[data-lb-node]").nth(1).uncheck();
    await expectPage(group.locator(".lb-member-row")).toHaveCount(1);
    await expectPage(group.locator(".lb-member-row-name")).toHaveText(["Fixture Target"]);
    await page.keyboard.press("Escape");

    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(savedGroup().members).toEqual([{ target_id: "target-one", model_id: "" }]);
  });

  it("warns about a single node, a disabled member, and an overlapping pattern", async () => {
    const card = await openPairWithGroup();
    const first = card.locator(".lb-card").first();
    await first.locator("[data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    const firstWarning = first.locator("[data-lb-warning]");
    await tickMembers(first, [0]);
    await expectPage(firstWarning).toBeVisible();
    await expectPage(firstWarning).toContainText("one node");

    await tickMembers(first, [1]);
    await expectPage(firstWarning).toBeHidden();

    await card.locator(".target-card").nth(1).locator("[data-target-enabled]").uncheck();
    await expectPage(firstWarning).toContainText("disabled");

    await card.locator("[data-add-lb-group]").click();
    const second = card.locator(".lb-card").nth(1);
    await second.locator("[data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(second, [0]);
    await expectPage(second.locator("[data-lb-warning]")).toContainText("overlaps");
    await expectPage(firstWarning).toContainText("overlaps");

    await second.locator("[data-lb-field='model_pattern']").fill("other-model");
    await expectPage(second.locator("[data-lb-warning]")).toContainText("one node");
    await expectPage(second.locator("[data-lb-warning]")).not.toContainText("overlaps");
    await expectPage(firstWarning).not.toContainText("overlaps");
  });

  it("points at the rejected field when the server refuses the configuration", async () => {
    const card = await openPairWithGroup();
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    setPairsSaveIssues([
      {
        code: "custom",
        message: "Load balancing group members must share the same normalized model_prices.",
        path: "pairs.0.load_balancers.0",
      },
      {
        code: "custom",
        message: "Load balancing group members must resolve to the same log root.",
        path: "pairs.0.load_balancers.0.node_target_ids",
      },
    ]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText(
      "Load balancing group members must share the same normalized model_prices.",
    );
    await expectPage(page.locator("#toast")).toContainText("node_target_ids");
    await expectPage(page.locator(".lb-card")).toHaveCount(1);
    setPairsSaveIssues(null);
  });

  it("drops a deleted node from every group of the same pair", async () => {
    const card = await openPairWithGroup();
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(savedGroup().members.map(({ target_id }) => target_id)).toHaveLength(2);

    await card.locator(".target-card").nth(1).locator("[data-remove-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(1);
    await expectPage(card.locator(".lb-card [data-lb-node]")).toHaveCount(1);
    // The saved configuration still names the removed node until the next save, so
    // the server has to catch a stale reference even though the UI already purged it.
    expect(savedGroup().members.map(({ target_id }) => target_id)).toHaveLength(2);
    const warning = card.locator(".lb-card [data-lb-warning]");
    await expectPage(warning).toBeVisible();
    await expectPage(warning).toContainText("one node");

    setPairsSaveIssues([
      {
        code: "custom",
        message: "Load balancing group node_target_ids must reference targets in this pair.",
        path: "pairs.0.load_balancers.0.node_target_ids.1",
      },
    ]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText(
      "Load balancing group node_target_ids must reference targets in this pair.",
    );
    await expectPage(page.locator("#toast")).toContainText(
      "pairs.0.load_balancers.0.node_target_ids.1",
    );
    setPairsSaveIssues(null);
  });

  it("updates node numbers on a poll without losing the open panel, the draft, or the caret", async () => {
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

    await waitForLbPoll(0);
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
    await waitForLbPoll(seen);
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

    await waitForLbPoll(0);
    await expectPage(quietWaiting).toHaveText("Waiting: 4");
    await expectPage(quietBadge).not.toContainText("incomplete");

    setLbStatusPartialMetrics(true);
    const seen = lbStatusReads.length;
    await waitForLbPoll(seen);
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
    await waitForLbPoll(zhSeen);
    await expectPage(quietWaiting).toHaveText("排队: -");
    await expectPage(quietBadge).toContainText("指标不全");
    await expectPage(idleWaiting).toHaveText("排队: 3");

    await page.locator("#languageSelect").selectOption("en");
    await waitForLbPoll(lbStatusReads.length);
    await expectPage(quietWaiting).toHaveText("Waiting: -");
    setLbStatusPartialMetrics(false);
  });

  it("stops polling while the page is hidden or another tab is showing", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-lb-group]").click();
    await tickMembers(card.locator(".lb-card"), [0]);
    await waitForLbPoll(0);
    const seen = lbStatusReads.length;

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
    });
    await page.waitForTimeout(2_500);
    expect(lbStatusReads.length).toBe(seen);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    });
    await page.locator('.tab[data-tab="logs"]').click();
    await page.waitForTimeout(2_500);
    expect(lbStatusReads.length).toBe(seen);

    await page.locator('.tab[data-tab="proxies"]').click();
    await waitForLbPoll(seen);
  });

  it("translates every group control and stays readable in a narrow layout", async () => {
    const card = await openPairWithGroup();
    const group = card.locator(".lb-card");
    await group.locator("[data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(group, [0]);
    await group.locator(".lb-status > summary").click();
    await expectPage(card.locator('.lb-node-fact[data-lb-fact="inFlight"]')).toHaveText(
      "In flight: 0",
    );
    await expectPage(card.locator('.lb-node-fact[data-lb-fact="bindings"]')).toHaveText(
      "Bindings: 0",
    );

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(card.locator(".lb-section-head > strong")).toHaveText("负载均衡组");
    await expectPage(card.locator("[data-add-lb-group]")).toHaveText("添加负载均衡组");
    await expectPage(card.locator("option[value='least_load']")).toHaveText("最少负载");
    await expectPage(card.locator("option[value='round_robin']")).toHaveText("轮转");
    await expectPage(card.locator('.lb-node-fact[data-lb-fact="inFlight"]')).toHaveText(
      "进行中: 0",
    );
    await expectPage(card.locator('.lb-node-fact[data-lb-fact="bindings"]')).toHaveText("绑定: 0");
    const chineseText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-section, .lb-card, .lb-node-state")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(chineseText).toContain("参与节点");
    expect(chineseText).toContain("绑定");
    expect(chineseText).toContain("指标来源");

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(card.locator(".lb-section-head > strong")).toHaveText("Load balancing groups");
    await expectPage(card.locator("[data-add-lb-group]")).toHaveText("Add load balancing group");
    await expectPage(card.locator("option[value='least_load']")).toHaveText("Least load");
    await expectPage(card.locator("option[value='round_robin']")).toHaveText("Round robin");
    await expectPage(card.locator('.lb-node-fact[data-lb-fact="inFlight"]')).toHaveText(
      "In flight: 0",
    );
    const englishText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-section, .lb-card, .lb-node-state, .lb-member span")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(englishText).not.toMatch(/[\u3400-\u9fff]/);

    await page.setViewportSize({ width: 380, height: 900 });
    await card.locator("[data-add-lb-group]").click();
    const second = card.locator(".lb-card").nth(1);
    await second.locator("[data-lb-field='name']").fill("Very Long Group Name For Width Testing");
    await tickMembers(second, [0]);
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-groups > .lb-card")].map((element) => {
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left), width: Math.round(box.width) };
      }),
    );
    const firstBox = boxes[0];
    if (firstBox === undefined) throw new Error("no group cards were rendered");
    expect(boxes.every((box) => box.left === firstBox.left)).toBe(true);
    expect(boxes.every((box) => box.width === firstBox.width)).toBe(true);
    const clipped = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".lb-card, .lb-node-state, .lb-head, .lb-member, .lb-node-name, .lb-members-field, .lb-member-rows, .lb-member-row, .lb-member-row-name, .lb-picker, .lb-picker-toggle",
        ),
      ].map((element) => ({
        clipped: element.scrollWidth > element.clientWidth + 1,
        name: element.className,
      })),
    );
    expect(clipped.filter((item) => item.clipped)).toEqual([]);
  });

  it("deletes a group with the keyboard and forgets its stored open state", async () => {
    const card = await openPairWithGroup();
    const group = card.locator(".lb-card");
    await group.locator("[data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(group, [0]);
    await group.locator(".lb-status > summary").click();
    await expectPage(group.locator(".lb-status")).toHaveAttribute("open");
    // The toggle event is a queued task, so the write lands a moment after the click.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("llmProxyLbGroupOpen")), {
        timeout: 5_000,
        interval: 100,
      })
      .toContain("true");

    await group.locator("[data-remove-lb]").focus();
    await page.keyboard.press("Enter");
    await expectPage(card.locator(".lb-card")).toHaveCount(0);
    await expectPage(card.locator(".lb-takeover-note")).toHaveCount(0);
    const stored = await page.evaluate(() => localStorage.getItem("llmProxyLbGroupOpen"));
    expect(stored).toBe("{}");
  });
  it("preserves member mappings and selections through language and status refreshes", async () => {
    const card = await openPairWithGroup();
    const group = card.locator(".lb-card");
    await tickMembers(group, [0, 1]);
    const model = group.locator("[data-lb-member-model]").first();
    await group.locator('[data-lb-field="name"]').fill("Unsaved group");
    await model.fill("  unsaved-upstream  ");
    await model.focus();
    await page.evaluate(`
      const select = document.getElementById("languageSelect");
      select.value = "zh";
      select.dispatchEvent(new Event("change"));
    `);
    await expectPage(model).toBeFocused();
    await expectPage(model).toHaveValue("  unsaved-upstream  ");
    const seen = lbStatusReads.length;
    await waitForLbPoll(seen);
    await expectPage(model).toHaveValue("  unsaved-upstream  ");
    await expectPage(group.locator("[data-lb-member-model]")).toHaveCount(2);
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(group.locator('[data-lb-field="name"]')).toHaveValue("Unsaved group");
    await expectPage(model).toHaveValue("  unsaved-upstream  ");
    await group.locator("[data-lb-picker-toggle]").click();
    await expectPage(group.locator("[data-lb-node]").nth(0)).toBeChecked();
    await expectPage(group.locator("[data-lb-node]").nth(1)).toBeChecked();
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

  // ------------------------------------------------------------ [TRI-06] the binding list

  /** Save the group over both engine nodes and open the section that holds their rows. */
  async function openTwoNodeStates(): Promise<Locator> {
    const card = await openPairWithGroup();
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    await card.locator(".lb-status > summary").click();
    await expectPage(card.locator(".lb-node-state")).toHaveCount(2);
    return card;
  }

  /** The same pair with three engine nodes, so a move can be offered one candidate it accepts
   *  and one it refuses at the same time. */
  async function openThreeNodeStates(): Promise<Locator> {
    const card = await openPairWithGroup();
    await card.locator("[data-add-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(3);
    await card
      .locator('.target-card[data-target-index="2"] [data-target-field="name"]')
      .fill("Third Node");
    await card.locator(".lb-card [data-lb-field='model_pattern']").fill("Qwen3.8-Flash-Next");
    await tickMembers(card.locator(".lb-card"), [0, 1, 2]);
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    await card.locator(".lb-status > summary").click();
    await expectPage(card.locator(".lb-node-state")).toHaveCount(3);
    return card;
  }

  function nodeState(card: Locator, nodeIndex: number): Locator {
    return card.locator(".lb-node-state").nth(nodeIndex);
  }

  function bindingsToggle(card: Locator, nodeIndex: number): Locator {
    return nodeState(card, nodeIndex).locator("[data-lb-bindings-toggle]");
  }

  function bindingPanel(card: Locator, nodeIndex: number): Locator {
    return nodeState(card, nodeIndex).locator(".lb-binding-panel");
  }

  /** The list is asked for, never pushed: closed until its button is pressed, then read once
   *  by the click that opened it. */
  async function openBindingList(card: Locator, nodeIndex: number): Promise<Locator> {
    const panel = bindingPanel(card, nodeIndex);
    await expectPage(panel).toBeHidden();
    await expectPage(bindingsToggle(card, nodeIndex)).toHaveAttribute("aria-expanded", "false");
    await bindingsToggle(card, nodeIndex).click();
    await expectPage(panel).toBeVisible();
    await expectPage(bindingsToggle(card, nodeIndex)).toHaveAttribute("aria-expanded", "true");
    return panel;
  }

  function bindingRow(panel: Locator, bindingId: number): Locator {
    return panel.locator(`.lb-binding[data-lb-binding-id="${bindingId}"]`);
  }

  /** The node ids the saved group was configured with, in order. */
  function savedMemberIds(): string[] {
    return savedGroup().members.map((member) => member.target_id);
  }

  function taskReadQuery(url: URL) {
    return {
      pairId: url.searchParams.get("pairId") ?? "",
      groupId: url.searchParams.get("groupId") ?? "",
      targetId: url.searchParams.get("targetId") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? "0"),
      offset: Number(url.searchParams.get("offset") ?? "0"),
    };
  }

  /** The page the stub would answer, with one visible number moved so a late copy is
   *  distinguishable from the newer one. */
  function bindingListJson(query: ReturnType<typeof taskReadQuery>, round: number): unknown {
    const reply = lbBindingFixturePage(query, round);
    if (!("response" in reply)) throw new Error("the stub refused the binding list");
    return reply.response;
  }

  /** The reads the browser made of the binding list, in the order they were made. A page
   *  answered by a route never reaches the stub, so the parameters are read back from the
   *  requests themselves. */
  function bindingReadParameters(): { offset: number; limit: number }[] {
    const asked: { offset: number; limit: number }[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/api/load-balancer/tasks")) return;
      const query = taskReadQuery(new URL(request.url()));
      asked.push({ offset: query.offset, limit: query.limit });
    });
    return asked;
  }

  /** The models of the rows a panel shows, once every row of a page has been relabelled to
   *  one of two names. Reading the rows back this way is what tells two generations of one
   *  list apart, and how many of each are on screen. */
  function shownModels(
    panel: Locator,
    labels: readonly string[],
  ): () => Promise<readonly string[]> {
    return async () =>
      (await panel.locator("[data-lb-binding-model]").allTextContents()).filter((model) =>
        labels.includes(model),
      );
  }

  /** More rows than the fixture's 25, built by cloning a quiet row under a fresh number and
   *  model. The shape is the one the service answers with - only the table is longer. */
  function lbBindingLongTable(targetId: string, rows: number) {
    const reply = lbBindingFixturePage({
      pairId: "proxy-one",
      groupId: savedGroup().id,
      targetId,
      limit: 20,
      offset: 0,
    });
    if (!("response" in reply)) throw new Error("the stub refused the binding list");
    const quiet = reply.response.items.at(-1);
    if (quiet === undefined) throw new Error("the binding fixture has no rows to clone");
    return Array.from({ length: rows }, (_, index) => ({
      ...quiet,
      bindingId: 500 + index,
      model: `table-model-${index + 1}`,
    }));
  }

  it(
    "[TRI-06] opens one node's bindings and keeps binding counts apart from task counts",
    async () => {
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
      await expectPage(bindingRow(panel, 7).locator("[data-lb-binding-tasks]")).toContainText(
        "Linked tasks: 3",
      );

      // The node's own line keeps the numbers the status call answered. Twenty bindings on
      // screen do not rewrite the count that poll gave, and a binding's own in-flight figure
      // is a separate measure of a separate thing.
      const beforePoll = lbStatusReads.length;
      await waitForLbPoll(beforePoll);
      await expectPage(nodeState(card, 0).locator('[data-lb-fact="bindings"]')).toHaveText(
        "Bindings: 0",
      );
      await expectPage(nodeState(card, 0).locator('[data-lb-fact="inFlight"]')).toHaveText(
        "In flight: 0",
      );
      await expectPage(
        bindingRow(panel, 7).locator('[data-lb-binding-fact="inFlight"]'),
      ).toHaveText("In flight: 1");
      await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    },
    UI_TEST_TIMEOUT_MS,
  );

  it("[TRI-06] says unknown activity and unknown metrics in their own words", async () => {
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
    await waitForLbPoll(seen);
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

  it("[TRI-06] shows one binding row and one move entry for three linked tasks", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const row = bindingRow(panel, 7);
    await expectPage(row).toHaveCount(1);
    await expectPage(row.locator("[data-lb-task-id]")).toHaveCount(3);
    await expectPage(row.locator(".lb-binding-task-id")).toHaveText([
      "task-alpha",
      "task-beta",
      "task-gamma",
    ]);
    await expectPage(row.locator("[data-lb-binding-tasks]")).toContainText("Linked tasks: 3");
    await expectPage(row.locator("[data-lb-binding-confidence]")).toHaveText("high confidence");
    await expectPage(row.locator("[data-lb-binding-ambiguous]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-ambiguous]")).toHaveText("several candidates");
    await expectPage(row.locator(".lb-binding-reason")).toHaveText([
      "exact key links",
      "several linked tasks",
    ]);
    // One row, one move button, and no invented representative: the address line names the
    // binding, never one of the tasks that share it.
    await expectPage(row.locator("[data-lb-binding-move]")).toHaveCount(1);
    await expectPage(row.locator(".lb-binding-head")).not.toContainText("task-");
    await expectPage(row.locator("[data-lb-binding-key]")).toHaveText("#7");
    // Where a linked task was served has three answers and all three are shown apart.
    await expectPage(row.locator(".lb-binding-task-node")).toHaveText([
      "same node",
      "a different node",
      "history target unknown",
    ]);
    await expectPage(
      row.locator("[data-lb-task-id]").nth(2).locator(".lb-binding-task-pending"),
    ).toBeVisible();

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator(".lb-binding-task-node")).toHaveText([
      "同一节点",
      "别的节点",
      "历史落点未知",
    ]);
    await expectPage(row.locator("[data-lb-binding-tasks]")).toContainText("关联 task: 3");
    await expectPage(row.locator("[data-lb-binding-confidence]")).toHaveText("高置信");
    await expectPage(row.locator(".lb-binding-reason")).toHaveText([
      "精确 key 命中",
      "一个绑定连到多个 task",
    ]);

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(row.locator(".lb-binding-task-node")).toHaveText([
      "same node",
      "a different node",
      "history target unknown",
    ]);
  });

  /** The destination a row on the first node can be moved to: the group's second member. */
  function moveDestinationId(): string {
    return savedMemberIds()[1] ?? "";
  }

  /** The node a panel was opened on, which is the source a move names. */
  function moveSourceId(): string {
    return savedMemberIds()[0] ?? "";
  }

  /** Every migration call the page made, in the order the browser made them. */
  function moveWrites(): string[] {
    return lbMoveCalls.map((call) => `${call.method} ${call.url}`);
  }

  /**
   * Every migration write the browser put on the wire, with the body it sent. A write the route
   * never let reach the server is still recorded here, which is the point: an unknown outcome has
   * to be compared with the request that never got an answer, not with what the stub happened to
   * be asked for.
   */
  function browserMoveWrites() {
    const sent: { method: string; path: string; body: unknown }[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/api/load-balancer/task-moves")) return;
      sent.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
    });
    return sent;
  }

  /** The route each browser write took, in the order the browser put it on the wire. */
  function writeRoutes(sent: { method: string; path: string }[]) {
    return sent.map((write) => `${write.method} ${write.path}`);
  }

  /** Put the browser's own clicks on every button of a row, whatever it thinks is clickable. A
   *  frozen row that is waiting for its own answer offers nothing clickable, so this reaches the
   *  handlers directly; a row whose outcome stayed unknown does offer its retry, and that is the
   *  instruction's own legitimate send, not a way around the submit. */
  async function dispatchRowButtons(bindingId: number): Promise<void> {
    await page.evaluate(`(() => {
      const row = document.querySelector('.lb-binding[data-lb-binding-id="${bindingId}"]');
      if (!(row instanceof HTMLElement)) throw new Error("the binding row is not on the page");
      row.querySelectorAll("button").forEach((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    })()`);
  }

  /** Force a click on the row's submit button and nothing else, whatever the browser thinks is
   *  clickable. Whether a submit may drive around an unknown outcome has to be asked of the
   *  submit alone: dispatching the whole row would also fire the retry, which is allowed. */
  async function dispatchRowSubmit(bindingId: number): Promise<void> {
    await page.evaluate(`(() => {
      const row = document.querySelector('.lb-binding[data-lb-binding-id="${bindingId}"]');
      if (!(row instanceof HTMLElement)) throw new Error("the binding row is not on the page");
      const submit = row.querySelector("[data-lb-binding-move]");
      if (!(submit instanceof HTMLElement)) throw new Error("the row has no submit button");
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    })()`);
  }

  /** Change a row's destination picker by force, the way a script would, leaving the page to
   *  answer with what it ends up showing. */
  async function forcePickerChange(bindingId: number, value: string): Promise<void> {
    await page.evaluate(`(() => {
      const select = document.querySelector(
        '.lb-binding[data-lb-binding-id="${bindingId}"] [data-lb-binding-move-target]',
      );
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("the row has no destination picker");
      }
      select.disabled = false;
      select.value = "${value}";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  }

  /** The text one affordance carries, or nothing at all when it is not on the page. A locator
   *  that waits for an element that never arrives would hang, and "no notice" is a state worth
   *  reading back rather than an error worth failing on. */
  async function textOrEmpty(locator: Locator): Promise<string> {
    return (await locator.count()) === 0 ? "" : ((await locator.textContent()) ?? "");
  }

  /**
   * Everything a row can say about the instruction it is holding: the sentence and its detail,
   * the retry, the destination picker and the submit, and what the picker holds. Reading a row
   * back as one value is what proves an obsolete answer changed nothing - a callback that rewrote
   * the draft would move one of these fields, and a repaint it forced would show even with the
   * status poll stopped, because nothing else is left that can touch the row.
   */
  async function rowMoveState(row: Locator): Promise<{
    notice: string;
    noticeDetail: string;
    retry: number;
    pickerValue: string;
    pickerEnabled: boolean;
    submitEnabled: boolean;
  }> {
    return {
      notice: await textOrEmpty(row.locator("[data-lb-binding-move-notice]")),
      noticeDetail: await textOrEmpty(row.locator("[data-lb-binding-move-notice-detail]")),
      retry: await row.locator("[data-lb-binding-move-retry]").count(),
      pickerValue: await row.locator("[data-lb-binding-move-target]").inputValue(),
      pickerEnabled: await row.locator("[data-lb-binding-move-target]").isEnabled(),
      submitEnabled: await row.locator("[data-lb-binding-move]").isEnabled(),
    };
  }

  /** The same for the operation block a cancel answers into: the sentence the cancel left, the
   *  state the live read reports, and whether the button is free to click again. */
  async function panelCancelState(panel: Locator): Promise<{
    notice: string;
    noticeDetail: string;
    operationState: string;
    cancelEnabled: boolean;
  }> {
    return {
      notice: await textOrEmpty(panel.locator("[data-lb-binding-cancel-notice]")),
      noticeDetail: await textOrEmpty(panel.locator("[data-lb-binding-cancel-notice-detail]")),
      operationState: await textOrEmpty(panel.locator(".lb-binding-operation-state")),
      cancelEnabled: await panel.locator("[data-lb-binding-move-cancel]").isEnabled(),
    };
  }

  /** Take the status poll away without disposing the surface, so a held answer is the only
   *  thing left that can move the row: every change that follows has a named author. */
  async function hideThePage(): Promise<void> {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  async function showThePage(): Promise<void> {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  it("[TRI-09] freezes an outcome that stayed unknown so only its own retry may send it", async () => {
    const sent = browserMoveWrites();
    await page.route("**/api/load-balancer/task-moves", (route) => route.abort("failed"));
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();

    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    expect(writeRoutes(sent)).toEqual(["POST /api/load-balancer/task-moves"]);

    // An outcome the browser could not tell is not something the user may decide over: the row is
    // frozen, so the destination cannot be edited into another instruction and the primary button
    // cannot stamp a newer key onto the same unknown intent.
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    expect(moveWrites()).toEqual([]);

    // A dispatch reaches the submit button whatever the browser thinks is clickable, so the
    // handler is what stops it: no second write, and no newer revision stamped onto an older key.
    await dispatchRowSubmit(7);
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(1);
    expect(lbMoveCalls).toEqual([]);

    // The unknown intent cannot be wiped out of the panel's state either: a forced change of the
    // picker is refused, and the rebuilt row shows the frozen destination.
    await forcePickerChange(7, "");
    await expectPage(picker).toHaveValue(destinationId);
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();

    // The only thing that may send that instruction again is its own retry, and it sends the very
    // bytes the first attempt put on the wire.
    await page.unroute("**/api/load-balancer/task-moves");
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 1,
        operationId: "op-7",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    // The answer settled the outcome, so the row is open to a decision again.
    await expectPage(picker).toHaveJSProperty("disabled", false);
    expect(writeRoutes(sent)).toEqual([
      "POST /api/load-balancer/task-moves",
      "POST /api/load-balancer/task-moves",
    ]);
    const lost = sent[0]?.body;
    const repeated = sent[1]?.body;
    if (lost === null || repeated === null) throw new Error("a submit was sent with no body");
    // The request that never got an answer and the retry are one and the same instruction, the
    // idempotency key included - not a key string the page merely claims it kept.
    expect(repeated).toEqual(lost);
    expect(lbMoveCall(0).body).toEqual(lost);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "已登记，等当前请求结束后才会改路由",
    );
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
  });

  it("[TRI-09] keeps the instruction a write is sending out of reach of an edit made while it was on its way", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.abort("failed");
    });
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => requested).toBe(true);

    // A write on its way is frozen the same way: one intent cannot be turned into two writes, and
    // the instruction being sent cannot be edited into a different one.
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await dispatchRowButtons(7);
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(1);

    await forcePickerChange(7, "");
    await expectPage(picker).toHaveValue(destinationId);

    release();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    // The edit did not take the instruction away: the retry still has the payload it was built
    // with, and it sends exactly that.
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await page.unroute("**/api/load-balancer/task-moves");
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 1,
        operationId: "op-7",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    expect(sent).toHaveLength(2);
    const first = sent[0]?.body;
    const retried = sent[1]?.body;
    if (first === null || retried === null) throw new Error("a submit was sent with no body");
    expect(retried).toEqual(first);
  });

  it("[TRI-09] shows the server's refusal where it will not offer a destination", async () => {
    const requested: { method: string; url: string }[] = [];
    page.on("request", (request) => {
      requested.push({ method: request.method(), url: request.url() });
    });
    setLbBindingMoveBlocking("state_unknown");
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const buttons = panel.locator(".lb-binding-move");
    expect(await buttons.count()).toBe(20);
    for (let index = 0; index < (await buttons.count()); index += 1) {
      await expectPage(buttons.nth(index)).toBeDisabled();
    }
    // A row the server refused shows the refusal, not a picker the user would have to judge.
    await expectPage(panel.locator("[data-lb-binding-move-target]")).toHaveCount(0);

    const busyRow = bindingRow(panel, 7);
    await expectPage(busyRow.locator("[data-lb-binding-move-reasons]")).toHaveText(
      "this runtime cannot prove the destination can reach the state this task may use",
    );
    // A refused button still says what a move would touch, so the hint is not lost with the gate.
    await expectPage(busyRow.locator(".lb-binding-move")).toHaveAttribute(
      "title",
      /^A move affects the next request only/,
    );

    // A refused row carries no submit path: dispatching its click reaches no route.
    await page.evaluate(() => {
      document.querySelectorAll(".lb-binding-move").forEach((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    });
    await page.waitForTimeout(300);
    expect(requested.filter((item) => item.url.includes("task-moves"))).toEqual([]);
    const listReads = requested.filter((item) => item.url.includes("/api/load-balancer/tasks"));
    expect(listReads.length).toBeGreaterThan(0);
    expect(new Set(listReads.map((item) => item.method))).toEqual(new Set(["GET"]));
    expect(
      requested
        .filter((item) => item.method !== "GET")
        .map((item) => item.url.replace(/^https?:\/\/[^/]+/, "")),
    ).toEqual(["/api/pairs"]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(busyRow.locator("[data-lb-binding-move-reasons]")).toHaveText(
      "这个运行时无法证明目标能访问这条任务可能用到的服务端状态",
    );
    await expectPage(busyRow.locator(".lb-binding-move")).toHaveText("迁移此绑定");
    await expectPage(busyRow.locator(".lb-binding-move")).toBeDisabled();
  });

  it("[TRI-09] names a refused candidate with the reason the server gave", async () => {
    const card = await openThreeNodeStates();
    setLbBindingIneligibleDestination(savedMemberIds()[2] ?? "", "target_cooldown");
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await expectPage(picker.locator("option")).toHaveText([
      "Choose a destination node",
      "Target",
      "Third Node (that destination is still cooling down)",
    ]);
    await expectPage(
      picker.locator(`option[value="${savedMemberIds()[2] ?? ""}"]`),
    ).toHaveJSProperty("disabled", true);
    // A candidate the server refused cannot be chosen, so nothing is offered under a judgement
    // the page made up, and the submit stays locked until an accepted one is named.
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveCount(0);
    await picker.selectOption(savedMemberIds()[1] ?? "");
    await expectPage(row.locator("[data-lb-binding-move]")).toBeEnabled();

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(picker.locator("option").nth(2)).toHaveText("Third Node (这个目标还在冷却)");
    await expectPage(row.locator("[data-lb-binding-move]")).toHaveText("迁移此绑定");
    await expectPage(picker.locator("option").nth(0)).toHaveText("选择目标节点");
  });

  it("[TRI-09] will not open the submit until an unknown destination is confirmed", async () => {
    setLbStatusPartialMetrics(true);
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await expectPage(picker.locator("option").nth(1)).toContainText("destination metrics unknown");
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();

    await picker.selectOption(destinationId);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveCount(0);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toBeVisible();
    await row.locator("[data-lb-binding-move-confirm]").check();
    await expectPage(row.locator("[data-lb-binding-move]")).toBeEnabled();

    // A different choice is a different instruction, so the warning has to be accepted again.
    await picker.selectOption("");
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toHaveCount(0);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await picker.selectOption(destinationId);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toBeVisible();

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toBeVisible();
    await expectPage(row.locator(".lb-binding-move-pick-label")).toHaveText("选择目标节点");
    await expectPage(row.locator("[data-lb-binding-move]")).toHaveText("迁移此绑定");
    await expectPage(picker.locator("option").nth(1)).toContainText("目标指标未知");
  });

  it("[TRI-09] submits one move built from what the list read and keeps it through a poll", async () => {
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        // The submit proved one request was on this binding, so the answer says so, and the
        // state it reports belongs to the boundary, not to this moment.
        inFlightAtRequest: 1,
        operationId: "op-7",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeEnabled();
    await row.locator("[data-lb-binding-move]").click();

    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    expect(moveWrites()).toEqual(["POST /api/load-balancer/task-moves"]);
    // The instruction carries the versions the list handed out, not ones the page invented.
    const sent = lbMoveCall(0).body;
    if (sent === null) throw new Error("the page sent a submit with no body");
    const { idempotencyKey, ...instruction } = sent;
    expect(idempotencyKey).toBeTypeOf("string");
    expect(instruction).toEqual({
      bindingId: 7,
      destinationTargetId: destinationId,
      expectedRoutingRevision: 3,
      expectedSourceTargetId: sourceId,
      groupId: savedGroup().id,
      groupRevision: 12,
      incarnation: 3,
      pairId: "proxy-one",
      runtimeEpoch: "stub-runtime-epoch",
    });
    // Nothing is sent without a click, and a submit never asks for a cancel.
    expect(lbMoveCalls.filter((call) => call.method === "DELETE")).toEqual([]);

    // The panel is rebuilt by the status poll, so the choice, the notice and the caret all have
    // to come back from the panel's own state rather than from the markup that was replaced.
    const seenStatusReads = lbStatusReads.length;
    await row.locator("[data-lb-binding-move-target]").focus();
    await waitForLbPoll(seenStatusReads);
    await expectPage(row.locator("[data-lb-binding-move-target]")).toBeFocused();
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "已登记，等当前请求结束后才会改路由",
    );
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
  });

  /**
   * The destination popup is anchored to the `<select>` itself, so a repaint that puts a new
   * element where the open popup sits closes it: the focus restore puts the caret back, and
   * nothing reopens a popup the element lost. The mark a test leaves on that element is
   * therefore the fact worth measuring - a rebuilt picker is a different object and cannot
   * carry it, while the row's own numbers show whether the poll reached the screen.
   */
  it("[TRI-09] does not rebuild the destination picker the user is choosing in", async () => {
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    const requests = row.locator('[data-lb-binding-fact="requests"]');

    await picker.selectOption(destinationId);
    await picker.evaluate((element) => {
      // A dataset key comes from an index signature, so it is written with brackets.
      element.dataset["lbUiPickerProbe"] = "open";
    });
    await picker.focus();
    await expectPage(requests).toHaveText("Requests: 14");

    const seenStatusReads = lbStatusReads.length;
    const readsBeforePoll = lbBindingReads.length;
    // The next page the stub answers with counts 999 requests on this binding, so a poll that
    // reached this row would print that number over the control the user is working in.
    setLbBindingRound(1);
    await waitForLbPoll(seenStatusReads);
    await expect
      .poll(() => lbBindingReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
      .toBeGreaterThan(readsBeforePoll);
    // The answer has had longer than it needs to run its own repaint by now.
    await page.waitForTimeout(400);

    await expectPage(picker).toHaveAttribute("data-lb-ui-picker-probe", "open");
    await expectPage(picker).toBeFocused();
    await expectPage(picker).toHaveValue(destinationId);
    // The poll is held, not dropped: the newer copy of the row is still waiting behind the
    // picker, which is why the number on screen is the old one.
    await expectPage(requests).toHaveText("Requests: 14");
  });

  it("[TRI-09] repaints what a poll held back once the user leaves the picker", async () => {
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    const requests = row.locator('[data-lb-binding-fact="requests"]');

    await picker.selectOption(destinationId);
    await picker.focus();
    const seenStatusReads = lbStatusReads.length;
    const readsBeforePoll = lbBindingReads.length;
    setLbBindingRound(1);
    await waitForLbPoll(seenStatusReads);
    await expect
      .poll(() => lbBindingReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
      .toBeGreaterThan(readsBeforePoll);
    await page.waitForTimeout(400);
    await expectPage(requests).toHaveText("Requests: 14");

    // Leaving the picker ends the wait: the row is redrawn with the newer answer and the
    // choice the panel holds comes back with it.
    await picker.evaluate((element) => element.blur());
    await expectPage(requests).toHaveText("Requests: 999");
    await expectPage(picker).toHaveValue(destinationId);
  });

  it("[TRI-09] keeps the choice after a stale-state refusal and never resends it by itself", async () => {
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    setLbMoveReply({
      rejection: {
        code: "stale_routing_revision",
        detail: "The binding moved on since this request was written.",
      },
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();

    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The state changed.",
    );
    await expectPage(row.locator("[data-lb-binding-move-notice-detail]")).toHaveText(
      "The binding moved on since this request was written.",
    );
    // The server said the row was stale, so the list is read again. The choice the user made
    // stays on screen and nothing is re-sent under a newer revision on its own.
    const seenBindingReads = lbBindingReads.length;
    await expect
      .poll(() => lbBindingReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
      .toBeGreaterThan(seenBindingReads);
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The state changed.",
    );
    expect(moveWrites()).toEqual(["POST /api/load-balancer/task-moves"]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "状态已变化，请核对新状态后显式重新提交",
    );
    expect(moveWrites()).toEqual(["POST /api/load-balancer/task-moves"]);
  });

  it("[TRI-09] repeats a write whose answer never arrived, under the same key", async () => {
    await page.route("**/api/load-balancer/task-moves", (route) => route.abort("failed"));
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();

    // A write the browser could not send is neither a refusal nor a cancellation: its outcome is
    // named unknown, and it is the same instruction that may be sent again.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    expect(moveWrites()).toEqual([]);

    // The route moved while the answer was missing. A page that rebuilt the instruction would
    // carry the new numbers; the retry carries the ones it was built under.
    await page.unroute("**/api/load-balancer/task-moves");
    setLbBindingRouteBump(4);
    const seenStatusReads = lbStatusReads.length;
    await waitForLbPoll(seenStatusReads);
    await expectPage(row.locator('[data-lb-binding-fact="revision"]')).toHaveText(/: 7$/);
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );

    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 16,
        inFlightAtRequest: 1,
        operationId: "op-7",
        routingRevision: 8,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    expect(moveWrites()).toEqual(["POST /api/load-balancer/task-moves"]);
    // Same key, same payload: the frozen instruction, not a newer revision stamped onto it.
    const repeated = lbMoveCall(0).body;
    if (repeated === null) throw new Error("the retry sent a submit with no body");
    const { idempotencyKey: repeatedKey, ...repeatedInstruction } = repeated;
    expect(repeatedKey).toBeTypeOf("string");
    expect(repeatedInstruction).toEqual({
      bindingId: 7,
      destinationTargetId: destinationId,
      expectedRoutingRevision: 3,
      expectedSourceTargetId: sourceId,
      groupId: savedGroup().id,
      groupRevision: 12,
      incarnation: 3,
      pairId: "proxy-one",
      runtimeEpoch: "stub-runtime-epoch",
    });
  });

  it("[TRI-09] shows the operation's state apart from the submit's answer", async () => {
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 7, incarnation: 3, routingRevision: 3, targetId: sourceId },
        destinationId,
        "observed",
        "op-observed",
        groupId,
      ),
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    const operations = panel.locator("[data-lb-binding-operations] .lb-binding-operation");
    await expectPage(operations).toHaveCount(2);
    await expectPage(operations.locator(".lb-binding-operation-state")).toHaveText([
      "a later request was seen using the destination",
      "waiting for the current request boundary",
    ]);
    // Only a record the server said is cancellable offers a cancel.
    await expectPage(panel.locator("[data-lb-binding-move-cancel]")).toHaveCount(1);
    await expectPage(panel.locator("[data-lb-binding-move-cancel]")).toHaveAttribute(
      "data-lb-binding-move-cancel",
      "op-pending",
    );
    await expectPage(panel.locator("[data-lb-binding-operation-reason]")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(operations.locator(".lb-binding-operation-state")).toHaveText([
      "已观测到后续请求使用目标节点",
      "等待当前请求边界",
    ]);
    await expectPage(panel.locator(".lb-binding-operations-title")).toHaveText("迁移操作");
  });

  it("[TRI-09] cancels a parked intent with one DELETE", async () => {
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    setLbCancelReply({
      response: {
        bindingId: 8,
        effect: "none",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 0,
        operationId: "op-pending",
        routingRevision: 1,
        runtimeEpoch: "stub-runtime-epoch",
        state: "cancelled",
        toTargetId: destinationId,
      },
    });
    const panel = await openBindingList(card, 0);
    const cancel = panel.locator("[data-lb-binding-move-cancel]");
    await expectPage(cancel).toHaveCount(1);
    await cancel.click();
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveText(
      "This registered move was cancelled.",
    );
    expect(moveWrites()).toEqual(["DELETE /api/load-balancer/task-moves/op-pending"]);
    // A cancel that landed is not answered as a move that reached its target.
    await expectPage(panel.locator("[data-lb-binding-move-notice]")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveText(
      "这次登记的迁移已取消",
    );
  });

  it("[TRI-09] offers no cancel on an applied move", async () => {
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "applied",
        "op-applied",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    // An applied record carries no cancel button at all: the route moved, so a cancel would be a
    // lie about a write that happened.
    await expectPage(panel.locator("[data-lb-binding-move-cancel]")).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "route changed, waiting for the next request",
    );
    expect(moveWrites()).toEqual([]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "路由已改，等待下一次请求",
    );
  });

  it("[TRI-09] keeps the operation of a binding that left the filtered page", async () => {
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    // The move took the binding off the node this panel lists, so the row is gone from the page
    // while the record of the move is still the thing the user has to be able to read.
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 999, incarnation: 77, routingRevision: 9, targetId: "target-gone" },
        destinationId,
        "expired_after_apply",
        "op-expired",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-operation]")).toHaveCount(1);
    await expectPage(panel.locator(".lb-binding-operation-route")).toHaveText(
      `#999 target-gone → ${destinationId}`,
    );
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "the route moved again before the next request",
    );
    await expectPage(panel.locator("[data-lb-binding-operation-reason]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-move-cancel]")).toHaveCount(0);
    // The records came with the filtered read of this node and do not depend on the row being on
    // that page.
    expect(lbBindingReads.at(-1)?.targetId).toBe(sourceId);

    // The node's whole page went empty once the binding moved away. The record still has to be
    // readable there - it is the page the user was looking at when they asked for the move - so a
    // page with no rows shows the operation rather than leaving the move looking unfinished.
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      const reply = lbBindingFixturePage(query);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      void route.fulfill({
        json: { ...reply.response, items: [], totalBindings: 0, hasMore: false, nextOffset: 0 },
      });
    });
    await expectPage(panel.locator("[data-lb-binding-empty]")).toBeVisible();
    await expectPage(panel.locator(".lb-binding")).toHaveCount(0);
    await expectPage(panel.locator('[data-lb-binding-operation="op-expired"]')).toHaveCount(1);
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "the route moved again before the next request",
    );

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator("[data-lb-binding-empty]")).toHaveText(
      "这个节点目前没有 binding",
    );
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "路由在下次请求前又被改动",
    );
  });

  it("[TRI-09] calls an expired intent expired, never observed", async () => {
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbBindingMigrationOperations([
      {
        ...lbBindingMoveOperation(
          { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
          destinationId,
          "expired",
          "op-expired",
          groupId,
        ),
        endReason: "runtime_reloaded",
        endedAt: 1_792_830_671_500,
      },
    ]);
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText("expired");
    await expectPage(panel.locator("[data-lb-binding-operation-reason]")).toHaveText(
      "runtime_reloaded",
    );
    await expectPage(panel.locator("[data-lb-binding-move-cancel]")).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding-operation")).toHaveClass(/is-expired/);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText("已失效");
  });

  it("[TRI-09] calls a submission of a generation this page no longer shows unknown", async () => {
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 1,
        operationId: "op-7",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "applied",
        toTargetId: destinationId,
      },
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The route changed; only the next request is affected.",
    );

    // The runtime this page addressed is gone, so what the submission reached is no longer
    // something the list can answer. It is named as unknown instead of being kept under the word
    // it was answered with, and no retry is offered for it.
    setLbBindingRuntimeEpoch("stub-runtime-epoch-next");
    const seenStatusReads = lbStatusReads.length;
    await waitForLbPoll(seenStatusReads);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The runtime or the group version changed; the current state of this submission cannot be confirmed.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "运行时或组版本已经更换，这次提交的最新状态无法确认",
    );
  });

  it("[TRI-09] does not let an answer that arrived after the surface was rebuilt speak for the new page", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        json: {
          bindingId: 7,
          effect: "next_request",
          fromTargetId: sourceId,
          groupRevision: 12,
          inFlightAtRequest: 1,
          operationId: "late-write",
          routingRevision: 4,
          runtimeEpoch: "stub-runtime-epoch",
          state: "pending_boundary",
          toTargetId: destinationId,
        },
      });
    });
    // The operation's own record is what the live read answers, and what the new page has to be
    // able to show instead of a receipt nobody waited for.
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 7, incarnation: 3, routingRevision: 3, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => requested).toBe(true);

    const seen = lbBindingReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbBindingReads.length).toBeGreaterThan(seen);
    // The disposal is what changed this row, before this answer is released at all: the surface
    // stopped waiting while the write was on its way, so the row carries the local answer the
    // detach wrote - the outcome is unknown, with the retry of the instruction it went out under.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The outcome of this submission is unknown; retry the same request.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();

    release();
    await page.waitForTimeout(300);

    // The receipt belongs to a surface that is gone. It is not shown on the page the new surface
    // reads, it does not rewrite the sentence the disposal already wrote, it is never reported as
    // a cancellation the disposal did not cause, and it starts no second write and no extra read.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The outcome of this submission is unknown; retry the same request.",
    );
    await expectPage(row.locator("[data-lb-binding-move-notice-detail]")).toHaveCount(0);
    await expectPage(panel.locator('[data-lb-binding-operation="late-write"]')).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    // What the new page does show is the operation the live read carries.
    await expectPage(panel.locator('[data-lb-binding-operation="op-pending"]')).toHaveCount(1);
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "waiting for the current request boundary",
    );
    expect(sent).toHaveLength(1);
    expect(moveWrites()).toEqual([]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText("等待当前请求边界");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "这次提交的结果未知，可以用同一请求重试",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
  });

  it("[TRI-09] disposal settles an unanswered write into unknown before its answer can land", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.abort("failed");
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => requested).toBe(true);
    const written = sent[0]?.body;
    if (written === null || written === undefined) {
      throw new Error("the submit put no instruction on the wire");
    }
    // Nothing has decided yet: the answer is still on its way and the row is frozen on it.
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();

    // The same runtime with a new surface: the page this write was sent from is gone, and the
    // write itself was sent without the surface's signal, so nothing can call it back.
    const seen = lbBindingReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbBindingReads.length).toBeGreaterThan(seen);
    // The disposal wrote this state, not the answer. This surface stopped waiting while the
    // instruction was still on its way, so the row says the outcome is unknown and offers only
    // the retry of the instruction it went out under; the instruction stayed frozen, so the row
    // is still frozen against an edit that would turn it into a different one.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The outcome of this submission is unknown; retry the same request.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(picker).toHaveValue(destinationId);
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    expect(sent).toHaveLength(1);

    // Take the poll away without disposing the surface, so the held answer is the only thing
    // left that can touch this row: whatever moves next has a named author.
    await hideThePage();
    const askedAfterRelease = bindingReadParameters();
    const stateBeforeRelease = await rowMoveState(row);
    const readsBeforeRelease = lbBindingReads.length;
    const statusesBeforeRelease = lbStatusReads.length;

    release();
    await page.waitForTimeout(300);

    // The failure belongs to a lifecycle that is gone, so it writes nothing at all: the row is
    // exactly what the disposal left, and the answer started neither a read nor a second write.
    expect(await rowMoveState(row)).toEqual(stateBeforeRelease);
    expect(askedAfterRelease).toEqual([]);
    expect(lbBindingReads.length).toBe(readsBeforeRelease);
    expect(lbStatusReads.length).toBe(statusesBeforeRelease);
    expect(sent).toHaveLength(1);
    expect(moveWrites()).toEqual([]);
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveCount(0);

    // The user's own retry is the only thing that may send that instruction again, and it sends
    // the very bytes the first attempt put on the wire - the idempotency key included.
    await showThePage();
    await page.unroute("**/api/load-balancer/task-moves");
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 1,
        operationId: "op-7-unknown",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(written);
    expect(lbMoveCall(0).body).toEqual(written);
    expect(lbMoveCall(0).method).toBe("POST");

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "已登记，等当前请求结束后才会改路由",
    );
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
  });

  it("[TRI-09] leaves a row the disposal settled exactly as it was when a late answer arrives", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        json: {
          bindingId: 7,
          effect: "next_request",
          fromTargetId: sourceId,
          groupRevision: 12,
          inFlightAtRequest: 1,
          operationId: "late-write",
          routingRevision: 4,
          runtimeEpoch: "stub-runtime-epoch",
          state: "applied",
          toTargetId: destinationId,
        },
      });
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => requested).toBe(true);

    const seen = lbBindingReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbBindingReads.length).toBeGreaterThan(seen);
    // What the row carries now was written by the disposal, and this answered receipt - the
    // server's own `applied` - is released only afterwards.
    const stateBeforeRelease = await rowMoveState(row);
    expect(stateBeforeRelease.notice).toBe(
      "The outcome of this submission is unknown; retry the same request.",
    );
    expect(stateBeforeRelease.retry).toBe(1);

    await hideThePage();
    const askedAfterRelease = bindingReadParameters();
    const readsBeforeRelease = lbBindingReads.length;
    const statusesBeforeRelease = lbStatusReads.length;
    release();
    await page.waitForTimeout(300);

    // A definite answer from a surface that is gone still writes nothing: the receipt is not
    // shown, the frozen instruction is not spent by it, and no read or write starts in its name.
    expect(await rowMoveState(row)).toEqual(stateBeforeRelease);
    expect(askedAfterRelease).toEqual([]);
    expect(lbBindingReads.length).toBe(readsBeforeRelease);
    expect(lbStatusReads.length).toBe(statusesBeforeRelease);
    expect(sent).toHaveLength(1);
    expect(moveWrites()).toEqual([]);
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    // The operation the new page shows is the one its own read carried, never the operation the
    // obsolete receipt named.
    await expectPage(panel.locator('[data-lb-binding-operation="stub-move-1"]')).toHaveCount(1);
    await expectPage(panel.locator('[data-lb-binding-operation="late-write"]')).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "这次提交的结果未知，可以用同一请求重试",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await showThePage();
  });

  it("[TRI-09] does not let a late cancel answer unlock the cancel a newer surface is making", async () => {
    const sent = browserMoveWrites();
    const deleteRoute = "DELETE /api/load-balancer/task-moves/op-pending";
    const releases: (() => void)[] = [];
    await page.route("**/api/load-balancer/task-moves/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      const held = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      await held;
      await route.abort("failed");
    });
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    const cancel = panel.locator('[data-lb-binding-move-cancel="op-pending"]');
    await expectPage(cancel).toHaveCount(1);
    await cancel.click();
    await expect.poll(() => releases.length).toBe(1);
    await expectPage(cancel).toBeDisabled();

    const seen = lbBindingReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbBindingReads.length).toBeGreaterThan(seen);
    // A disposal is not a cancellation the server made, and the claim the disposed attempt held
    // went with it: the new surface answers about the operation from its own read, and the
    // button is free again because nothing on this page waits for that DELETE any more.
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveCount(0);
    await expectPage(cancel).toBeEnabled();
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "waiting for the current request boundary",
    );

    // A newer claim is made on the newer surface, and it is the newer attempt that holds it.
    await cancel.click();
    await expect.poll(() => releases.length).toBe(2);
    await expectPage(cancel).toBeDisabled();

    await hideThePage();
    const askedAfterRelease = bindingReadParameters();
    const stateBeforeRelease = await panelCancelState(panel);
    const readsBeforeRelease = lbBindingReads.length;
    const statusesBeforeRelease = lbStatusReads.length;
    releases[0]?.();
    await page.waitForTimeout(300);

    // The old cancel's failure belongs to a lifecycle that is gone: it writes no sentence, asks
    // for no read, sends no second DELETE, and it cannot unlock the claim the newer attempt holds.
    expect(await panelCancelState(panel)).toEqual(stateBeforeRelease);
    expect(askedAfterRelease).toEqual([]);
    expect(lbBindingReads.length).toBe(readsBeforeRelease);
    expect(lbStatusReads.length).toBe(statusesBeforeRelease);
    expect(writeRoutes(sent)).toEqual([deleteRoute, deleteRoute]);
    expect(moveWrites()).toEqual([]);
    await expectPage(cancel).toBeDisabled();

    // The newer claim is released only by its own answer. The browser could not read that one,
    // so the outcome of this cancel is unknown - nothing here claims the request did or did not
    // arrive, and nothing reports the operation as cancelled.
    releases[1]?.();
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toContainText(
      "The outcome of this cancel is unknown",
    );
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).not.toContainText(
      "This registered move was cancelled.",
    );
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "waiting for the current request boundary",
    );
    await expectPage(cancel).toBeEnabled();
    expect(writeRoutes(sent)).toEqual([deleteRoute, deleteRoute]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toContainText(
      "取消的结果未知，操作的当前状态无法确认",
    );
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).not.toContainText(
      "这次登记的迁移已取消",
    );
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText("等待当前请求边界");
    await showThePage();
  });

  it("[TRI-09] detaches a write still on its way when the group version moves under one runtime", async () => {
    const sent = browserMoveWrites();
    const releases: (() => void)[] = [];
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      const held = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      await held;
      await route.abort("failed");
    });
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => releases.length).toBe(1);
    const written = sent[0]?.body;
    if (written === null || written === undefined) {
      throw new Error("the submit put no instruction on the wire");
    }

    // The group's routing signature moved under the same runtime, so the rows on screen now
    // carry a newer revision than the one this instruction was built under.
    setLbBindingRouteBump(1);
    const seen = lbStatusReads.length;
    await waitForLbPoll(seen);
    await expectPage(row.locator('[data-lb-binding-fact="revision"]')).toHaveText(
      "Routing revision: 4",
    );
    // A version change detaches the write exactly as a disposal does. The runtime is still the
    // one shown, so the instruction is kept whole and its retry is offered; the newer revision
    // this page now reads cannot be stamped onto it, because the row is frozen on what it sent.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The outcome of this submission is unknown; retry the same request.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(picker).toHaveValue(destinationId);
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();

    await hideThePage();
    const askedAfterRelease = bindingReadParameters();
    const stateBeforeRelease = await rowMoveState(row);
    const readsBeforeRelease = lbBindingReads.length;
    releases[0]?.();
    await page.waitForTimeout(300);

    // The late failure of a write this page no longer waits for writes nothing: the row keeps
    // the sentence the version change wrote, and it started no read and no second send.
    expect(await rowMoveState(row)).toEqual(stateBeforeRelease);
    expect(askedAfterRelease).toEqual([]);
    expect(lbBindingReads.length).toBe(readsBeforeRelease);
    expect(sent).toHaveLength(1);
    expect(lbMoveCalls).toEqual([]);

    // The user's retry replays the instruction exactly as it went out - the older group revision
    // and the older routing revision included, not the pair this page reads now.
    await showThePage();
    await page.unroute("**/api/load-balancer/task-moves");
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 13,
        inFlightAtRequest: 1,
        operationId: "op-7-bumped",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toEqual(written);
    expect(lbMoveCall(0).body).toEqual(written);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "已登记，等当前请求结束后才会改路由",
    );
    await page.locator("#languageSelect").selectOption("en");

    // A decision made now is a different instruction: a newer key built from the versions this
    // page reads, never the frozen one sent a third time.
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => lbMoveCalls.length).toBe(2);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).not.toEqual(written);
    expect(lbMoveCall(1).body).not.toEqual(written);
    setLbBindingRouteBump(0);
  });

  it("[TRI-09] does not let a late cancel answer speak for a page that was rebuilt", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      requested = true;
      await held;
      await route.fulfill({
        json: {
          bindingId: 8,
          effect: "none",
          fromTargetId: sourceId,
          groupRevision: 12,
          inFlightAtRequest: 0,
          operationId: "op-pending",
          routingRevision: 1,
          runtimeEpoch: "stub-runtime-epoch",
          state: "cancelled",
          toTargetId: destinationId,
        },
      });
    });
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    const cancel = panel.locator("[data-lb-binding-move-cancel]");
    await expectPage(cancel).toHaveCount(1);
    await cancel.click();
    await expect.poll(() => requested).toBe(true);

    const seen = lbBindingReads.length;
    await page.evaluate("__adminUiTest.proxyConfig.dispose(); __adminUiTest.proxyConfig.init();");
    await expect.poll(() => lbBindingReads.length).toBeGreaterThan(seen);
    release();
    await page.waitForTimeout(300);

    // A disposal is not a cancel the server made, and an answer to a surface that is gone is not
    // this page's sentence. The operation's state stays what the live read says.
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText(
      "waiting for the current request boundary",
    );
    await expectPage(panel.locator('[data-lb-binding-operation="op-pending"]')).toHaveCount(1);
    expect(writeRoutes(sent)).toEqual(["DELETE /api/load-balancer/task-moves/op-pending"]);
    expect(moveWrites()).toEqual([]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator(".lb-binding-operation-state")).toHaveText("等待当前请求边界");
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveCount(0);
  });

  it("[TRI-09] sends one cancel however many times its button is dispatched", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const groupId = savedGroup().id;
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      requested = true;
      await held;
      await route.fulfill({
        json: {
          bindingId: 8,
          effect: "none",
          fromTargetId: sourceId,
          groupRevision: 12,
          inFlightAtRequest: 0,
          operationId: "op-pending",
          routingRevision: 1,
          runtimeEpoch: "stub-runtime-epoch",
          state: "cancelled",
          toTargetId: destinationId,
        },
      });
    });
    setLbBindingMigrationOperations([
      lbBindingMoveOperation(
        { bindingId: 8, incarnation: 4, routingRevision: 1, targetId: sourceId },
        destinationId,
        "pending_boundary",
        "op-pending",
        groupId,
      ),
    ]);
    const panel = await openBindingList(card, 0);
    const cancel = panel.locator("[data-lb-binding-move-cancel]");
    await expectPage(cancel).toHaveCount(1);
    await cancel.click();
    await expect.poll(() => requested).toBe(true);
    await expectPage(cancel).toBeDisabled();

    // A dispatch reaches the button whatever the browser thinks is clickable, so the claim the
    // first cancel holds is what stops the second: one operation is one DELETE.
    await page.evaluate(`(() => {
      const button = document.querySelector('[data-lb-binding-move-cancel="op-pending"]');
      if (!(button instanceof HTMLElement)) throw new Error("the cancel button is not on the page");
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    })()`);
    await page.waitForTimeout(300);
    expect(writeRoutes(sent)).toEqual(["DELETE /api/load-balancer/task-moves/op-pending"]);

    release();
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveText(
      "This registered move was cancelled.",
    );
    expect(writeRoutes(sent)).toEqual(["DELETE /api/load-balancer/task-moves/op-pending"]);
    // The attempt that made the claim is the one that releases it, so the control is not left
    // disabled by a callback that came back too late.
    await expectPage(cancel).toBeEnabled();

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator("[data-lb-binding-cancel-notice]")).toHaveText(
      "这次登记的迁移已取消",
    );
    await expectPage(cancel).toBeEnabled();
  });

  it("[TRI-09] does not carry a write onto a row a new runtime reused", async () => {
    const sent = browserMoveWrites();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        json: {
          bindingId: 7,
          effect: "next_request",
          fromTargetId: sourceId,
          groupRevision: 12,
          inFlightAtRequest: 1,
          operationId: "old-runtime-write",
          routingRevision: 4,
          runtimeEpoch: "stub-runtime-epoch",
          state: "applied",
          toTargetId: destinationId,
        },
      });
    });
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => requested).toBe(true);

    // The pair restarted: the page now names another runtime, and the same binding number plus
    // incarnation come back as a different binding's row.
    setLbBindingRuntimeEpoch("stub-runtime-epoch-next");
    const seen = lbStatusReads.length;
    await waitForLbPoll(seen);
    release();
    await page.waitForTimeout(300);

    // The write belongs to a runtime this page no longer shows, so its result is named unknown
    // rather than shown as the new page's answer. Nothing of it - not the receipt, not the
    // destination, not the key - is carried onto the reused row.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The runtime or the group version changed; the current state of this submission cannot be confirmed.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    await expectPage(picker).toHaveValue("");
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    expect(sent).toHaveLength(1);
    expect(moveWrites()).toEqual([]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "运行时或组版本已经更换，这次提交的最新状态无法确认",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
  });

  it("[TRI-09] does not let a failure of a write this runtime no longer waits for disturb the write it is waiting for", async () => {
    const sent = browserMoveWrites();
    // Every write to this route is held until its own test code releases it, so the older one
    // can be answered while the newer one is still on its way.
    const releases: (() => void)[] = [];
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      const held = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      await held;
      await route.abort("failed");
    });
    const card = await openTwoNodeStates();
    const sourceId = moveSourceId();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    const picker = row.locator("[data-lb-binding-move-target]");
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => releases.length).toBe(1);

    // The pair restarted while that write was on its way, and the same binding number and
    // incarnation came back on the new page. The instruction belongs to a runtime nobody shows
    // any more, and its answer may never come; the row is not left frozen on it.
    setLbBindingRuntimeEpoch("stub-runtime-epoch-next");
    const seenStatusReads = lbStatusReads.length;
    await waitForLbPoll(seenStatusReads);
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "The runtime or the group version changed; the current state of this submission cannot be confirmed.",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    await expectPage(picker).toHaveValue("");
    await expectPage(picker).toHaveJSProperty("disabled", false);

    // A new decision is made and sent on the runtime this page shows, while the old write is
    // still held. It is a different instruction: a newer key, addressed to a newer runtime.
    await picker.selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expect.poll(() => releases.length).toBe(2);
    expect(sent).toHaveLength(2);
    const retired = sent[0]?.body;
    const current = sent[1]?.body;
    if (retired === null || current === null) throw new Error("a submit was sent with no body");
    expect(current).not.toEqual(retired);

    releases[0]?.();
    await page.waitForTimeout(300);

    // The abandoned write came back as a failure the browser could not read, which is the worst
    // case: it is not this page's sentence, it does not unlock the row, and it does not retire or
    // replace the instruction that is still on its way.
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveCount(0);
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toHaveCount(0);
    await expectPage(picker).toHaveJSProperty("disabled", true);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    expect(sent).toHaveLength(2);
    expect(lbMoveCalls).toEqual([]);

    // The instruction the page was waiting for is the one that stays unknown and gets retried,
    // byte for byte - not the one the obsolete write carried.
    releases[1]?.();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(lbMoveCalls).toEqual([]);

    await page.unroute("**/api/load-balancer/task-moves");
    setLbMoveReply({
      response: {
        bindingId: 7,
        effect: "next_request",
        fromTargetId: sourceId,
        groupRevision: 12,
        inFlightAtRequest: 1,
        operationId: "op-7-next",
        routingRevision: 4,
        runtimeEpoch: "stub-runtime-epoch-next",
        state: "pending_boundary",
        toTargetId: destinationId,
      },
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "Registered; the route changes when the current request ends.",
    );
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).toEqual(current);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toHaveText(
      "已登记，等当前请求结束后才会改路由",
    );
    await expectPage(row.locator("[data-lb-binding-move-target]")).toHaveValue(destinationId);
  });

  it("[TRI-09] sends one retry however many times its button is dispatched", async () => {
    const sent = browserMoveWrites();
    await page.route("**/api/load-balancer/task-moves", (route) => route.abort("failed"));
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    expect(sent).toHaveLength(1);

    await page.unroute("**/api/load-balancer/task-moves");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/load-balancer/task-moves", async (route) => {
      requested = true;
      await held;
      await route.abort("failed");
    });
    await row.locator("[data-lb-binding-move-retry]").click();
    await expect.poll(() => requested).toBe(true);

    // While a retry is on its way, dispatching every button of the row sends nothing: one intent
    // is one write, and a frozen row offers no way out except the retry it already made.
    await dispatchRowButtons(7);
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(2);

    release();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(lbMoveCalls).toEqual([]);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "这次提交的结果未知",
    );
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
  });

  it("[TRI-09] says what became of an unknown submission whose row left the page", async () => {
    await page.route("**/api/load-balancer/task-moves", (route) => route.abort("failed"));
    const card = await openTwoNodeStates();
    const destinationId = moveDestinationId();
    const panel = await openBindingList(card, 0);
    const row = bindingRow(panel, 7);
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationId);
    await row.locator("[data-lb-binding-move]").click();
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();

    // The list no longer carries that binding, so the row - and with it the only retry it could
    // show - is gone. The panel says so below its rows rather than leave no trace of a write the
    // user made and nobody answered.
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      const reply = lbBindingFixturePage(query);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      void route.fulfill({
        json: {
          ...reply.response,
          items: reply.response.items.filter((item) => item.bindingId !== 7),
        },
      });
    });
    const seen = lbStatusReads.length;
    await waitForLbPoll(seen);
    await expectPage(panel.locator('.lb-binding[data-lb-binding-id="7"]')).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(19);
    await expectPage(panel.locator('[data-lb-binding-unresolved="7"]')).toHaveText(
      "#7 the outcome of this submission is still unknown, and this binding is not listed on this page, so its retry is not shown here",
    );

    // The intent was kept, not forgotten: when the binding is listed again its retry is there, so
    // the explanation was only ever about the row that had nothing to sit on.
    await page.unroute("**/api/load-balancer/tasks*");
    const again = lbStatusReads.length;
    await waitForLbPoll(again);
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "The outcome of this submission is unknown",
    );
    await expectPage(panel.locator("[data-lb-binding-unresolved]")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-move-retry]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-move-notice]")).toContainText(
      "这次提交的结果未知",
    );
  });

  it("[TRI-06] does not read a failed history query as no history", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const failed = bindingRow(panel, 15);
    await expectPage(failed.locator(".lb-binding-coverage-state")).toHaveText(
      "history query failed",
    );
    await expectPage(failed.locator(".lb-binding-coverage-state")).toHaveClass(/is-failed/);
    await expectPage(failed.locator(".lb-binding-coverage-detail")).toHaveText(
      "read · SqliteError · SQLITE_BUSY · database is locked",
    );
    // The broken read is stated, not hidden behind the count it could not produce.
    await expectPage(failed.locator("[data-lb-binding-tasks]")).toContainText("Linked tasks: 0");
    await expectPage(failed.locator("[data-lb-binding-confidence]")).toHaveText("no task linked");
    await expectPage(failed.locator(".lb-binding-reason")).toHaveText(["history query failed"]);
    await expectPage(panel.locator(".lb-binding-empty")).toHaveCount(0);

    // The other two causes each keep their own sentence, and a scan that ran out of room is
    // said separately from the count.
    await expectPage(bindingRow(panel, 12).locator(".lb-binding-coverage-state")).toHaveText(
      "no traffic database yet",
    );
    await expectPage(bindingRow(panel, 18).locator(".lb-binding-coverage-state")).toHaveText(
      "no log root configured",
    );
    await expectPage(bindingRow(panel, 9).locator(".lb-binding-coverage-state")).toHaveText(
      "history available",
    );
    await expectPage(bindingRow(panel, 9).locator(".lb-binding-coverage-flag")).toHaveText([
      "history truncated",
      "the log write may still be pending",
    ]);
    await expectPage(bindingRow(panel, 9).locator("[data-lb-binding-confidence]")).toHaveText(
      "candidate",
    );
    await expectPage(bindingRow(panel, 9).locator("[data-lb-task-id]")).toHaveCount(3);

    const panelText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-binding-panel")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(panelText).not.toMatch(/undefined|null/);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(failed.locator(".lb-binding-coverage-state")).toHaveText("历史查询失败");
    await expectPage(failed.locator(".lb-binding-coverage-detail")).toHaveText(
      "read · SqliteError · SQLITE_BUSY · database is locked",
    );
    await expectPage(bindingRow(panel, 12).locator(".lb-binding-coverage-state")).toHaveText(
      "该日志根还没有 traffic.db",
    );
    await expectPage(bindingRow(panel, 18).locator(".lb-binding-coverage-state")).toHaveText(
      "该节点没有配置日志根",
    );
    await expectPage(bindingRow(panel, 9).locator(".lb-binding-coverage-flag")).toHaveText([
      "历史被截断",
      "日志可能还没写进去",
    ]);

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(failed.locator(".lb-binding-coverage-state")).toHaveText(
      "history query failed",
    );
  });

  it("[TRI-06] pages the list and keeps the rows the user paged to through a refresh", async () => {
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
    await waitForLbPoll(seen);
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
      "Requests: 999",
    );
    // The held-back copy arrives after the newer one. It is dropped, not merged: the row keeps
    // the newer count and the panel keeps the rows the newer read answered.
    await page.waitForTimeout(1_200);
    await expectPage(bindingRow(panel, 7).locator('[data-lb-binding-fact="requests"]')).toHaveText(
      "Requests: 999",
    );
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-stale]")).toHaveCount(0);
    expect(answered).toBeGreaterThanOrEqual(2);
  });

  it("[TRI-06] clips long names inside the card without moving its neighbours", async () => {
    await page.setViewportSize({ width: 1278, height: 1215 });
    const card = await openTwoNodeStates();
    const cardWidth = async (): Promise<number> => {
      const width = await card
        .locator(".lb-card")
        .first()
        .evaluate((element) => Math.round(element.getBoundingClientRect().width));
      return width;
    };
    const before = await cardWidth();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    expect(await cardWidth()).toBe(before);

    const model = bindingRow(panel, 12).locator("[data-lb-binding-model]");
    const longName = "VeryLongModelNameForCheckingThatTheCardNeverGrowsWiderThanItsNeighbours";
    await expectPage(model).toHaveText(longName);
    await expectPage(model).toHaveAttribute("title", longName);
    const clipped = await model.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      textOverflow: getComputedStyle(element).textOverflow,
      overflowWrap: getComputedStyle(element).overflowWrap,
    }));
    expect(clipped.scrollWidth).toBeGreaterThan(clipped.clientWidth);
    expect(clipped.textOverflow).toBe("ellipsis");
    expect(clipped.overflowWrap).toBe("normal");
    // The fact beside a clipped name still shows its own value in full.
    await expectPage(bindingRow(panel, 12).locator('[data-lb-binding-fact="cost"]')).toHaveText(
      "Cost: request bytes 48.3K",
    );

    await page.setViewportSize({ width: 380, height: 900 });
    const pageWidth = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.viewport);
    const panelBox = await panel.boundingBox();
    const cardBox = await card.locator(".lb-card").first().boundingBox();
    if (panelBox === null || cardBox === null) {
      throw new Error("the binding list was not laid out");
    }
    expect(Math.round(panelBox.width)).toBeLessThanOrEqual(Math.round(cardBox.width));
    const clippedContainers = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".lb-node-state, .lb-node-tools, .lb-binding-panel, .lb-binding, .lb-binding-head, .lb-binding-facts, .lb-binding-association, .lb-binding-task-list, .lb-binding-task, .lb-binding-tools",
        ),
      ]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.className),
    );
    expect(clippedContainers).toEqual([]);
    // Both ids of one task line stay readable somewhere: the row wraps instead of cutting a
    // fact away.
    await expectPage(bindingRow(panel, 7).locator(".lb-binding-task-id")).toHaveText([
      "task-alpha",
      "task-beta",
      "task-gamma",
    ]);
  });

  it("[TRI-06] prints every binding field in both languages", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const row = bindingRow(panel, 7);
    const factTexts = async (): Promise<string[]> =>
      row
        .locator(".lb-binding-fact")
        .evaluateAll((elements) => elements.map((element) => element.textContent || ""));
    await expectPage(row.locator("[data-lb-binding-model]")).toHaveText("Qwen3.8-Flash-Next");
    await expectPage(row.locator("[data-lb-binding-endpoint]")).toHaveText(
      "responses /v1/responses",
    );
    await expectPage(row.locator(".lb-binding-coverage-state")).toHaveText("history available");
    expect(await factTexts()).toEqual([
      "Target: Fixture Target",
      "Routing revision: 3",
      "Incarnation: 3",
      "Requests: 14",
      "Last request: 8s",
      "Last response: 5s",
      "In flight: 1",
      "request in flight",
      "Cost: normalized usage 18,400",
    ]);

    await page.locator("#languageSelect").selectOption("zh");
    // The language switch rebuilds the whole card. The list is redrawn from the state the
    // panel already holds - same rows, same count - and not read a second time for it.
    await expectPage(panel).toBeVisible();
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-summary]")).toContainText(
      "本节点绑定: 20 / 25",
    );
    expect(await factTexts()).toEqual([
      "落点: Fixture Target",
      "路由版本: 3",
      "编号代次: 3",
      "请求次数: 14",
      "最近请求: 8s",
      "最后响应: 5s",
      "进行中: 1",
      "请求在途",
      "成本: 归一化用量 1.8 万",
    ]);
    await expectPage(row.locator("[data-lb-binding-endpoint]")).toHaveText(
      "responses /v1/responses",
    );
    await expectPage(row.locator(".lb-binding-coverage-state")).toHaveText("历史可读");

    await page.locator("#languageSelect").selectOption("en");
    expect(await factTexts()).toEqual([
      "Target: Fixture Target",
      "Routing revision: 3",
      "Incarnation: 3",
      "Requests: 14",
      "Last request: 8s",
      "Last response: 5s",
      "In flight: 1",
      "request in flight",
      "Cost: normalized usage 18,400",
    ]);
    const englishPanel = await panel.evaluate((element) => element.textContent || "");
    expect(englishPanel).not.toMatch(/[\u3400-\u9fff]/);
    const stored = await page.evaluate(() => localStorage.getItem("llmProxyLbNodeBindings") ?? "");
    expect(stored).toContain("true");
  });

  it("[TRI-06] names the cause of a read that failed instead of an empty list", async () => {
    const card = await openTwoNodeStates();
    setLbBindingFailure("group_not_found");
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveText(
      "This load balancing group is not in that pair",
    );
    await expectPage(panel.locator(".lb-binding")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-empty]")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-loading]")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    // The cause is kept as the code the server sent, so the sentence follows the language the
    // page speaks now, not the one it spoke when the read failed.
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveText(
      "这个负载均衡组不在该 pair 里",
    );
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveText(
      "This load balancing group is not in that pair",
    );

    setLbBindingFailure(null);
    await bindingsToggle(card, 0).click();
    await expectPage(panel).toBeHidden();
    await bindingsToggle(card, 0).click();
    await expectPage(panel.locator("[data-lb-binding-error]")).toHaveCount(0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
  });

  it("[TRI-06] says a node has no bindings without inventing a row", async () => {
    const card = await openTwoNodeStates();
    const [firstTarget] = savedMemberIds();
    if (firstTarget === undefined) throw new Error("the saved group has no node");
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/load-balancer/tasks")) asked.push(request.url());
    });
    await page.route("**/api/load-balancer/tasks*", (route) => {
      const query = taskReadQuery(new URL(route.request().url()));
      const reply = lbBindingFixturePage(query);
      if (!("response" in reply)) throw new Error("the stub refused the binding list");
      void route.fulfill({
        json: { ...reply.response, items: [], totalBindings: 0, hasMore: false, nextOffset: 0 },
      });
    });
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator("[data-lb-binding-empty]")).toHaveText(
      "This node has no bindings right now",
    );
    await expectPage(panel.locator(".lb-binding")).toHaveCount(0);
    await expectPage(panel.locator("[data-lb-binding-more]")).toHaveCount(0);
    // The node's own line still carries the number the status call answered.
    await expectPage(nodeState(card, 0).locator('[data-lb-fact="bindings"]')).toHaveText(
      "Bindings: 0",
    );
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(panel.locator("[data-lb-binding-empty]")).toHaveText(
      "这个节点目前没有 binding",
    );
    await page.locator("#languageSelect").selectOption("en");
    expect(asked.some((url) => url.includes(`targetId=${encodeURIComponent(firstTarget)}`))).toBe(
      true,
    );
  });

  it("[TRI-06] keeps an open list across a reload and forgets it when the node leaves", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);

    await loadAdminPage();
    // The node-state section came back open with the group, so its rows are already there.
    await expectPage(card.locator(".lb-node-state")).toHaveCount(2);
    // The node's list comes back open, and the next status tick fills it.
    await expectPage(bindingsToggle(card, 0)).toHaveAttribute("aria-expanded", "true");
    await expectPage(bindingPanel(card, 0)).toBeVisible();
    await expectPage(bindingPanel(card, 0).locator(".lb-binding")).toHaveCount(20);
    await expectPage(bindingPanel(card, 1)).toBeHidden();

    // The node leaves the group: its list, its rows and its stored open flag all go.
    const group = card.locator(".lb-card");
    const pop = group.locator("[data-lb-picker-pop]");
    await group.locator("[data-lb-picker-toggle]").click();
    await pop.locator("[data-lb-node]").nth(0).uncheck();
    await page.keyboard.press("Escape");
    await page.locator("#saveProxies").click();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    await expectPage(card.locator(".lb-binding-panel")).toHaveCount(1);
    await expectPage(card.locator(".lb-node-state")).toHaveCount(1);
    const stored = await page.evaluate(
      () => localStorage.getItem("llmProxyLbNodeBindings") ?? "{}",
    );
    expect(JSON.parse(stored) as Record<string, unknown>).toEqual({});
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
    await waitForLbPoll(seen);
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
      await waitForLbPoll(seen);
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
