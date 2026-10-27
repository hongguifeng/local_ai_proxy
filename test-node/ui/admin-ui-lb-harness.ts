import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { type Locator, expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbMoveCalls,
  lbStatusReads,
  pairs,
} from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";

/** Shared page and stub state for the load-balancing browser suites. Importing this module
 *  registers the four lifecycle hooks below in the file that imports it, so every split file
 *  owns its own stub server and browser page. Vitest only collects "*.test.ts", so this module
 *  is never treated as a suite of its own. */

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

/** A pair with two engine nodes plus one empty group card. */
export async function openPairWithGroup() {
  await loadAdminPage();
  const card = page.locator('.proxy-card[data-index="0"]');
  await card.locator("[data-add-target]").click();
  await expectPage(card.locator(".target-card")).toHaveCount(2);
  await card.locator("[data-add-lb-group]").click();
  await expectPage(card.locator(".lb-card")).toHaveCount(1);
  return card;
}

/** Wait for the next status poll to be answered.
 *
 *  The admin UI polls `/api/load-balancer/status` every 2000 ms
 *  (`loadBalancerStatusIntervalMs` in src/admin/static/modules/load-balancing.js), so a test that
 *  wants one more poll either waits that long in real time or advances the page clock by one
 *  multiple of the same interval. Advancing by another multiple silently skips a poll, so a runFor
 *  has to stay tied to that constant. */
export async function waitForLbPoll(previousCount: number) {
  await expect
    .poll(() => lbStatusReads.length, { timeout: UI_TEST_TIMEOUT_MS, interval: 200 })
    .toBeGreaterThan(previousCount);
}

export function savedGroup() {
  const group = pairs[0]?.load_balancers[0];
  if (group === undefined) throw new Error("no load balancing group was saved");
  return group;
}

/** The candidate nodes float over the card, so the list has to be opened before
 *  anything can be ticked. It stays open while ticking and Escape clears it. */
export async function tickMembers(group: Locator, indexes: number[]) {
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

// ------------------------------------------------------------ [TRI-06] the binding list

/** Save the group over both engine nodes and open the section that holds their rows. */
export async function openTwoNodeStates(): Promise<Locator> {
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
export async function openThreeNodeStates(): Promise<Locator> {
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

export function nodeState(card: Locator, nodeIndex: number): Locator {
  return card.locator(".lb-node-state").nth(nodeIndex);
}

export function bindingsToggle(card: Locator, nodeIndex: number): Locator {
  return nodeState(card, nodeIndex).locator("[data-lb-bindings-toggle]");
}

export function bindingPanel(card: Locator, nodeIndex: number): Locator {
  return nodeState(card, nodeIndex).locator(".lb-binding-panel");
}

/** The list is asked for, never pushed: closed until its button is pressed, then read once
 *  by the click that opened it. */
export async function openBindingList(card: Locator, nodeIndex: number): Promise<Locator> {
  const panel = bindingPanel(card, nodeIndex);
  await expectPage(panel).toBeHidden();
  await expectPage(bindingsToggle(card, nodeIndex)).toHaveAttribute("aria-expanded", "false");
  await bindingsToggle(card, nodeIndex).click();
  await expectPage(panel).toBeVisible();
  await expectPage(bindingsToggle(card, nodeIndex)).toHaveAttribute("aria-expanded", "true");
  return panel;
}

export function bindingRow(panel: Locator, bindingId: number): Locator {
  return panel.locator(`.lb-binding[data-lb-binding-id="${bindingId}"]`);
}

/** The node ids the saved group was configured with, in order. */
export function savedMemberIds(): string[] {
  return savedGroup().members.map((member) => member.target_id);
}

export function taskReadQuery(url: URL) {
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
export function bindingListJson(query: ReturnType<typeof taskReadQuery>, round: number): unknown {
  const reply = lbBindingFixturePage(query, round);
  if (!("response" in reply)) throw new Error("the stub refused the binding list");
  return reply.response;
}

/** The reads the browser made of the binding list, in the order they were made. A page
 *  answered by a route never reaches the stub, so the parameters are read back from the
 *  requests themselves. */
export function bindingReadParameters(): { offset: number; limit: number }[] {
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
 *  list apart, and how many of each are on screen. A compact row does not print the model,
 *  so it is read off the hover attribute the row's own line carries. */
export function shownModels(
  panel: Locator,
  labels: readonly string[],
): () => Promise<readonly string[]> {
  return async () =>
    (
      await panel
        .locator(".lb-binding-line[data-lb-hover-model]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-lb-hover-model") ?? ""),
        )
    ).filter((model) => labels.includes(model));
}

/** Where the facts a compact row leaves out are kept: the row's line carries every one of
 *  them as its own `data-lb-hover-*` attribute, and its hover text is those attributes
 *  joined one per line. Reading the same attributes is what lets a test check a field the
 *  reader only sees on hover without unpicking a sentence. */
export function hoverLine(row: Locator): Locator {
  return row.locator(".lb-binding-line");
}

/** More rows than the fixture's 25, built by cloning a quiet row under a fresh number and
 *  model. The shape is the one the service answers with - only the table is longer. */
export function lbBindingLongTable(targetId: string, rows: number) {
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

/** The destination a row on the first node can be moved to: the group's second member. */
export function moveDestinationId(): string {
  return savedMemberIds()[1] ?? "";
}

/** The node a panel was opened on, which is the source a move names. */
export function moveSourceId(): string {
  return savedMemberIds()[0] ?? "";
}

/** Every migration call the page made, in the order the browser made them. */
export function moveWrites(): string[] {
  return lbMoveCalls.map((call) => `${call.method} ${call.url}`);
}

/**
 * Every migration write the browser put on the wire, with the body it sent. A write the route
 * never let reach the server is still recorded here, which is the point: an unknown outcome has
 * to be compared with the request that never got an answer, not with what the stub happened to
 * be asked for.
 */
export function browserMoveWrites() {
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
export function writeRoutes(sent: { method: string; path: string }[]) {
  return sent.map((write) => `${write.method} ${write.path}`);
}

/** Put the browser's own clicks on every button of a row, whatever it thinks is clickable. A
 *  frozen row that is waiting for its own answer offers nothing clickable, so this reaches the
 *  handlers directly; a row whose outcome stayed unknown does offer its retry, and that is the
 *  instruction's own legitimate send, not a way around the submit. */
export async function dispatchRowButtons(bindingId: number): Promise<void> {
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
export async function dispatchRowSubmit(bindingId: number): Promise<void> {
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
export async function forcePickerChange(bindingId: number, value: string): Promise<void> {
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
export async function textOrEmpty(locator: Locator): Promise<string> {
  return (await locator.count()) === 0 ? "" : ((await locator.textContent()) ?? "");
}

/**
 * Everything a row can say about the instruction it is holding: the sentence and its detail,
 * the retry, the destination picker and the submit, and what the picker holds. Reading a row
 * back as one value is what proves an obsolete answer changed nothing - a callback that rewrote
 * the draft would move one of these fields, and a repaint it forced would show even with the
 * status poll stopped, because nothing else is left that can touch the row.
 */
export async function rowMoveState(row: Locator): Promise<{
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
export async function panelCancelState(panel: Locator): Promise<{
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
export async function hideThePage(): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

export async function showThePage(): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
