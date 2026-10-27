import { describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbBindingMoveOperation,
  lbBindingReads,
  lbStatusReads,
  pairs,
  setLbBindingFailure,
  setLbBindingIneligibleDestination,
  setLbBindingMigrationOperations,
  setLbBindingMoveBlocking,
  setLbStatusPartialMetrics,
  setPairsSaveIssues,
} from "./admin-ui-fixture.js";
import { page } from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";
import {
  bindingPanel,
  bindingRow,
  bindingsToggle,
  hoverLine,
  moveDestinationId,
  moveSourceId,
  moveWrites,
  nodeState,
  openBindingList,
  openPairWithGroup,
  openThreeNodeStates,
  openTwoNodeStates,
  savedGroup,
  savedMemberIds,
  taskReadQuery,
  tickMembers,
} from "./admin-ui-lb-harness.js";

describe("admin UI load balancing groups", { timeout: UI_TEST_TIMEOUT_MS }, () => {
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
    // The refresh being checked is one status tick, so the page clock is installed before the
    // page loads and advanced by one poll interval instead of waiting in real time.
    await page.clock.install();
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
    await page.clock.runFor(2_000);
    await expect.poll(() => lbStatusReads.length).toBeGreaterThan(seen);
    await expectPage(model).toHaveValue("  unsaved-upstream  ");
    await expectPage(group.locator("[data-lb-member-model]")).toHaveCount(2);
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(group.locator('[data-lb-field="name"]')).toHaveValue("Unsaved group");
    await expectPage(model).toHaveValue("  unsaved-upstream  ");
    await group.locator("[data-lb-picker-toggle]").click();
    await expectPage(group.locator("[data-lb-node]").nth(0)).toBeChecked();
    await expectPage(group.locator("[data-lb-node]").nth(1)).toBeChecked();
  });

  it("[TRI-06] shows one binding row and one move entry for three linked tasks", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const row = bindingRow(panel, 7);
    await expectPage(row).toHaveCount(1);
    // Four values and nothing else: the row is titled by the first task the list reports, and
    // every mark the server earned - this row's several-candidates answer included - stays in
    // the hover text instead of beside the numbers.
    await expectPage(row.locator("[data-lb-task-id]")).toHaveCount(1);
    await expectPage(row.locator(".lb-binding-title")).toHaveText("task-alpha");
    await expectPage(row.locator(".lb-binding-line > span")).toHaveCount(5);
    await expectPage(row.locator("[data-lb-binding-tasks]")).toHaveText("+2");
    await expectPage(row.locator("[data-lb-binding-ambiguous]")).toHaveCount(0);
    await expectPage(row.locator("[data-lb-binding-confidence]")).toHaveCount(0);
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-tasks",
      "Linked tasks: 3 · high confidence · several candidates",
    );
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "Tasks not shown on this row: task-beta (2) · task-gamma (1)",
    );
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-reasons",
      "exact key links · several linked tasks",
    );
    // One row, one move button. The row is titled by the first task the list reports, and the
    // several-task chip says plainly that the counts on the row are the binding's own and names
    // the tasks the row does not print; the binding's address is on the line, so a shared
    // binding is never mistaken for a task.
    await expectPage(row.locator("[data-lb-binding-move]")).toHaveCount(1);
    await expectPage(hoverLine(row)).toHaveAttribute("data-lb-hover-key", "#7");
    await expectPage(row.locator("[data-lb-binding-tasks]")).toHaveAttribute(
      "title",
      /The title is the first task the list reports[\s\S]*task-beta \(2\) · task-gamma \(1\)$/,
    );
    // Where a linked task was served has three answers, and none of them is a chip: the ordinary
    // one - this node - is said in the title's hover text, and the row wears no node mark.
    await expectPage(row.locator(".lb-binding-title")).toHaveAttribute(
      "title",
      /history target: same node/,
    );
    await expectPage(row.locator(".lb-binding-task-node")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(row.locator("[data-lb-binding-tasks]")).toHaveAttribute(
      "title",
      /关联 task: 3/,
    );
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "本行未显示的 task: task-beta (2) · task-gamma (1)",
    );
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-reasons",
      "精确 key 命中 · 一个绑定连到多个 task",
    );
    await expectPage(row.locator(".lb-binding-title")).toHaveAttribute(
      "title",
      /历史落点: 同一节点/,
    );
    await expectPage(row.locator(".lb-binding-ambiguous")).toHaveCount(0);

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "Tasks not shown on this row: task-beta (2) · task-gamma (1)",
    );
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
    // Real time on purpose: this window rules out what a real answer can still do.
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
    // The picker says what it is for in its own first option and in its own accessible name,
    // so there is no label line above it to translate and no second line of height.
    await expectPage(picker).toHaveAttribute("aria-label", "选择目标节点");
    await expectPage(picker.locator("option").nth(0)).toHaveText("选择目标节点");
    await expectPage(row.locator("[data-lb-binding-move]")).toHaveText("迁移此绑定");
    await expectPage(picker.locator("option").nth(1)).toContainText("目标指标未知");
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

  it("[TRI-06] does not read a failed history query as no history", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const failed = bindingRow(panel, 15);
    // Nothing on the visible line speaks about history: the row shows its four values, and what
    // the history could not answer is carried on the line's own hover text.
    await expectPage(failed.locator(".lb-binding-coverage-state")).toHaveCount(0);
    await expectPage(hoverLine(failed)).toHaveAttribute(
      "data-lb-hover-coverage",
      "history query failed · read · SqliteError · SQLITE_BUSY · database is locked",
    );
    // The broken read is stated, not hidden behind the count it could not produce. A binding
    // with nothing linked has no several-task chip, so the count lives on the line.
    await expectPage(failed.locator("[data-lb-binding-tasks]")).toHaveCount(0);
    await expectPage(hoverLine(failed)).toHaveAttribute(
      "data-lb-hover-tasks",
      "Linked tasks: 0 · no task linked",
    );
    await expectPage(hoverLine(failed)).toHaveAttribute(
      "data-lb-hover-reasons",
      "history query failed",
    );
    await expectPage(panel.locator(".lb-binding-empty")).toHaveCount(0);

    // The other two causes each keep their own sentence, and a scan that ran out of room is
    // said separately from the count.
    await expectPage(hoverLine(bindingRow(panel, 12))).toHaveAttribute(
      "data-lb-hover-coverage",
      "no traffic database yet",
    );
    await expectPage(hoverLine(bindingRow(panel, 18))).toHaveAttribute(
      "data-lb-hover-coverage",
      "no log root configured",
    );
    // A history that answered is the ordinary case, and the two facts it grew stay separate
    // parts of the same hover sentence.
    await expectPage(hoverLine(bindingRow(panel, 9))).toHaveAttribute(
      "data-lb-hover-coverage",
      "history available · history truncated · the log write may still be pending",
    );
    await expectPage(hoverLine(bindingRow(panel, 9))).toHaveAttribute(
      "data-lb-hover-tasks",
      /^Linked tasks: 3 · candidate/,
    );
    await expectPage(hoverLine(bindingRow(panel, 9))).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "Tasks not shown on this row: task-epsilon (1) · task-zeta (4)",
    );
    await expectPage(bindingRow(panel, 9).locator("[data-lb-task-id]")).toHaveCount(1);

    const panelText = await page.evaluate(() =>
      [...document.querySelectorAll(".lb-binding-panel")]
        .map((element) => element.textContent || "")
        .join(" "),
    );
    expect(panelText).not.toMatch(/undefined|null/);

    await page.locator("#languageSelect").selectOption("zh");
    // The cause stays the server's own words whatever the page speaks.
    await expectPage(hoverLine(failed)).toHaveAttribute(
      "data-lb-hover-coverage",
      "历史查询失败 · read · SqliteError · SQLITE_BUSY · database is locked",
    );
    await expectPage(hoverLine(bindingRow(panel, 12))).toHaveAttribute(
      "data-lb-hover-coverage",
      "该日志根还没有 traffic.db",
    );
    await expectPage(hoverLine(bindingRow(panel, 18))).toHaveAttribute(
      "data-lb-hover-coverage",
      "该节点没有配置日志根",
    );
    await expectPage(hoverLine(bindingRow(panel, 9))).toHaveAttribute(
      "data-lb-hover-coverage",
      "历史可读 · 历史被截断 · 日志可能还没写进去",
    );
    await expectPage(hoverLine(bindingRow(panel, 9))).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "本行未显示的 task: task-epsilon (1) · task-zeta (4)",
    );

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(hoverLine(failed)).toHaveAttribute(
      "data-lb-hover-coverage",
      "history query failed · read · SqliteError · SQLITE_BUSY · database is locked",
    );
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

    // A binding the history linked to nothing is titled by its own address, so the long model
    // name is what has to clip. The card beside it must not move, and the whole name stays in
    // the title's hover text and in the model fact on the line.
    const title = bindingRow(panel, 12).locator(".lb-binding-title");
    const longName = "VeryLongModelNameForCheckingThatTheCardNeverGrowsWiderThanItsNeighbours";
    await expectPage(title).toHaveText(`#12 ${longName}`);
    await expectPage(title).toHaveAttribute("title", new RegExp(longName));
    await expectPage(hoverLine(bindingRow(panel, 12))).toHaveAttribute(
      "data-lb-hover-model",
      longName,
    );
    // The title is the one long thing on a compact row, so it is the one that has to clip.
    // At this width the whole name fits: the card beside it is unmoved, and the full name is
    // still in the title's hover text and in the model fact the line carries.
    const clipStyle = await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        textOverflow: style.textOverflow,
        overflow: style.overflow,
        overflowWrap: style.overflowWrap,
      };
    });
    expect(clipStyle.textOverflow).toBe("ellipsis");
    expect(clipStyle.overflow).toBe("hidden");
    expect(clipStyle.overflowWrap).toBe("normal");
    // The value beside a clipped title still shows its own figure in full.
    await expectPage(bindingRow(panel, 12).locator('[data-lb-binding-fact="cost"]')).toHaveText(
      "bytes 48.3K",
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
          ".lb-node-state, .lb-node-tools, .lb-binding-panel, .lb-binding, .lb-binding-line, .lb-binding-tools, .lb-binding-move-row",
        ),
      ]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.className),
    );
    expect(clippedContainers).toEqual([]);
    // A narrow panel has to clip that name: the ellipsis keeps the row one line instead of
    // letting a long model grow the list downwards.
    const clipped = await title.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      textOverflow: getComputedStyle(element).textOverflow,
      overflowWrap: getComputedStyle(element).overflowWrap,
    }));
    expect(clipped.scrollWidth).toBeGreaterThan(clipped.clientWidth);
    expect(clipped.textOverflow).toBe("ellipsis");
    expect(clipped.overflowWrap).toBe("normal");
    // Every id the row does not print stays readable in the hover text: a narrow panel clips the
    // title, it does not lose the rest of the answer.
    await expectPage(hoverLine(bindingRow(panel, 7))).toHaveAttribute(
      "data-lb-hover-hidden-tasks",
      "Tasks not shown on this row: task-beta (2) · task-gamma (1)",
    );
  });

  /**
   * What the compact list has to hold onto: the destination picker and the submit are one row
   * the user reads as a single decision, and one binding is visibly a block rather than the
   * next run of chips. Both claims need measured boxes - reading a screenshot by eye cannot
   * see a height difference of a few pixels, and a gap that is not there looks like one that
   * is.
   */
  it("[TRI-06] lines the destination picker up with the submit and keeps rows apart", async () => {
    await page.setViewportSize({ width: 1278, height: 1215 });
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);

    const boxes = await panel.evaluate(() =>
      [...document.querySelectorAll(".lb-binding")].slice(0, 6).map((row) => {
        const read = (selector: string) => {
          const element = row.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`the row has no ${selector}`);
          }
          const box = element.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            height: box.height,
            center: box.top + box.height / 2,
          };
        };
        return {
          row: row.getBoundingClientRect(),
          picker: read(".lb-binding-move-target"),
          submit: read("[data-lb-binding-move]"),
        };
      }),
    );

    // Same height, same top, same centre: the destination and the button that sends it are
    // one line, not a field with a button floating above it.
    boxes.forEach(({ picker, submit }) => {
      expect(Math.round(picker.height)).toBe(Math.round(submit.height));
      expect(Math.abs(picker.center - submit.center)).toBeLessThan(1);
      expect(Math.abs(picker.top - submit.top)).toBeLessThan(1);
    });
    // A binding ends where its own border ends and the next begins below it with room between,
    // so the list is not one continuous column of chips.
    boxes.forEach((current, index) => {
      const next = boxes[index + 1];
      if (next === undefined) return;
      expect(next.row.top - current.row.bottom).toBeGreaterThanOrEqual(6);
    });

    const paints = await panel.evaluate(() => {
      const block = document.querySelector(".lb-binding");
      const box = document.querySelector(".lb-binding-panel");
      if (!(block instanceof HTMLElement) || !(box instanceof HTMLElement)) {
        throw new Error("the binding list was not painted");
      }
      const style = getComputedStyle(block);
      return {
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        fill: style.backgroundColor,
        panelFill: getComputedStyle(box).backgroundColor,
      };
    });
    expect(paints.border).toBe("1px");
    expect(paints.radius).toBe("6px");
    expect(paints.fill).not.toBe(paints.panelFill);
  });

  it("[TRI-06] prints every binding field in both languages", async () => {
    const card = await openTwoNodeStates();
    const panel = await openBindingList(card, 0);
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    const row = bindingRow(panel, 7);
    /** Every fact the compact row leaves to hover, in the order the markup writes them. The
     *  hover text of a row is exactly these values joined one per line, so a field that is
     *  missing here is missing from the tooltip too. */
    const hoverFacts = async (): Promise<unknown[]> =>
      hoverLine(row).evaluate((element) =>
        [...element.attributes]
          .filter((attribute) => attribute.name.startsWith("data-lb-hover-"))
          .map((attribute) => attribute.value),
      );
    // Four values are printed and nothing else is: what the row is read for, and no second
    // sentence beside them.
    await expectPage(row.locator(".lb-binding-title")).toHaveText("task-alpha");
    await expectPage(row.locator('[data-lb-binding-fact="activity"]')).toHaveText(
      "request in flight",
    );
    await expectPage(row.locator('[data-lb-binding-fact="requests"]')).toHaveText("requests 14");
    await expectPage(row.locator('[data-lb-binding-fact="cost"]')).toHaveText("input 18,400");
    await expectPage(hoverLine(row)).not.toContainText(
      /Routing revision|Incarnation|Last request|Cost:|targetId|normalized usage/,
    );
    // A history that answered is the ordinary case, so it wears no visible mark.
    await expectPage(row.locator(".lb-binding-coverage-state")).toHaveCount(0);
    expect(await hoverFacts()).toEqual([
      "#7",
      "Qwen3.8-Flash-Next",
      "responses /v1/responses",
      expect.stringMatching(/^Target: Fixture Target · targetId: /),
      "Routing revision: 3",
      "Incarnation: 3",
      expect.stringMatching(/^Last request: 8s · \d/),
      expect.stringMatching(/^Last response: 5s · \d/),
      "In flight: 1",
      expect.stringMatching(
        /^Cost: normalized usage · input tokens: 18,400 · cache read tokens: 12,000 · observed: \d/,
      ),
      "Linked tasks: 3 · high confidence · several candidates",
      "Tasks not shown on this row: task-beta (2) · task-gamma (1)",
      "history available",
      "exact key links · several linked tasks",
    ]);

    await page.locator("#languageSelect").selectOption("zh");
    // The language switch rebuilds the whole card. The list is redrawn from the state the
    // panel already holds - same rows, same count - and not read a second time for it.
    await expectPage(panel).toBeVisible();
    await expectPage(panel.locator(".lb-binding")).toHaveCount(20);
    await expectPage(panel.locator("[data-lb-binding-summary]")).toContainText(
      "本节点绑定: 20 / 25",
    );
    await expectPage(row.locator('[data-lb-binding-fact="activity"]')).toHaveText("请求在途");
    await expectPage(row.locator('[data-lb-binding-fact="requests"]')).toHaveText("请求 14");
    await expectPage(row.locator('[data-lb-binding-fact="cost"]')).toHaveText("输入 1.8 万");
    await expectPage(hoverLine(row)).not.toContainText(
      /路由版本|编号代次|最近请求|成本:|targetId|归一化用量/,
    );
    await expectPage(row.locator(".lb-binding-coverage-state")).toHaveCount(0);
    expect(await hoverFacts()).toEqual([
      "#7",
      "Qwen3.8-Flash-Next",
      "responses /v1/responses",
      expect.stringMatching(/^落点: Fixture Target · targetId: /),
      "路由版本: 3",
      "编号代次: 3",
      expect.stringMatching(/^最近请求: 8s · \d/),
      expect.stringMatching(/^最后响应: 5s · \d/),
      "进行中: 1",
      expect.stringMatching(
        /^成本: 归一化用量 · 输入 token: 18,400 · 缓存读取 token: 12,000 · 观测时间: \d/,
      ),
      "关联 task: 3 · 高置信 · 候选不唯一",
      "本行未显示的 task: task-beta (2) · task-gamma (1)",
      "历史可读",
      "精确 key 命中 · 一个绑定连到多个 task",
    ]);

    await page.locator("#languageSelect").selectOption("en");
    expect(await hoverFacts()).toEqual([
      "#7",
      "Qwen3.8-Flash-Next",
      "responses /v1/responses",
      expect.stringMatching(/^Target: Fixture Target · targetId: /),
      "Routing revision: 3",
      "Incarnation: 3",
      expect.stringMatching(/^Last request: 8s · \d/),
      expect.stringMatching(/^Last response: 5s · \d/),
      "In flight: 1",
      expect.stringMatching(
        /^Cost: normalized usage · input tokens: 18,400 · cache read tokens: 12,000 · observed: \d/,
      ),
      "Linked tasks: 3 · high confidence · several candidates",
      "Tasks not shown on this row: task-beta (2) · task-gamma (1)",
      "history available",
      "exact key links · several linked tasks",
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
});
