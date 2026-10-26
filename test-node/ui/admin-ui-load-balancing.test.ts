import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Locator } from "@playwright/test";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbBindingReads,
  lbStatusReads,
  pairs,
  setLbBindingFailure,
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

  it("[TRI-06] keeps every move button disabled with the reason the server gave", async () => {
    const requested: { method: string; url: string }[] = [];
    page.on("request", (request) => {
      requested.push({ method: request.method(), url: request.url() });
    });
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const buttons = panel.locator(".lb-binding-move");
    expect(await buttons.count()).toBe(20);
    for (let index = 0; index < (await buttons.count()); index += 1) {
      await expectPage(buttons.nth(index)).toBeDisabled();
    }
    const busyRow = bindingRow(panel, 7);
    await expectPage(busyRow.locator("[data-lb-binding-move-reasons]")).toHaveText(
      "the migration service is not wired yet · a request is still in flight on this binding",
    );
    await expectPage(bindingRow(panel, 9).locator("[data-lb-binding-move-reasons]")).toHaveText(
      "the migration service is not wired yet",
    );
    await expectPage(busyRow.locator(".lb-binding-move")).toHaveAttribute(
      "title",
      /^A move affects the next request only/,
    );

    // A disabled button carries no submit path: dispatching its click reaches no route.
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
      "迁移服务尚未接入 · 这个绑定还有请求在途",
    );
    await expectPage(busyRow.locator(".lb-binding-move")).toHaveText("迁移此绑定");
    await expectPage(busyRow.locator(".lb-binding-move")).toBeDisabled();
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
