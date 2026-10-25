import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Locator } from "@playwright/test";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbStatusReads,
  pairs,
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
    await page.evaluate('setLanguage("zh");');
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
    await page.evaluate("initializeProxyConfig(); initializeProxyConfig();");
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
    await page.evaluate("proxyConfig.dispose(); proxyConfig.dispose();");
    await page.clock.runFor(6_000);
    expect(lbStatusReads.length).toBe(4);
    await page.evaluate("initializeProxyConfig(); initializeProxyConfig();");
    await expect.poll(() => lbStatusReads.length).toBe(5);
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBe(6);
  });

  it("forwards caller and lifecycle cancellation through the production adapter", async () => {
    await loadAdminPage();
    await page.evaluate("proxyConfig.dispose();");
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
          // Reuse the instances constructed by 02/03 and initialized by 09.
          initializeProxyConfig();
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
          proxyConfig.dispose();
          initializeProxyConfig();
          const third = polls[polls.length - 1];
          const pendingBeforeDispose = !third.signal.aborted;
          loadBalancing.dispose();
          const disposalAbort = third.signal.aborted;
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { composed, callerAbort, pendingBeforeOwnerAbort, lifecycleAbort, pendingBeforeDispose, disposalAbort };
        } finally {
          proxyConfig.dispose();
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
});
