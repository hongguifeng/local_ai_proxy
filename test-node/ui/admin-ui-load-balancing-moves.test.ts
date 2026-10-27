import { describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  UI_TEST_TIMEOUT_MS,
  lbBindingFixturePage,
  lbBindingMoveOperation,
  lbBindingReads,
  lbMoveCall,
  lbMoveCalls,
  lbStatusReads,
  setLbBindingMigrationOperations,
  setLbBindingRound,
  setLbBindingRouteBump,
  setLbBindingRuntimeEpoch,
  setLbCancelReply,
  setLbMoveReply,
} from "./admin-ui-fixture.js";
import { page } from "./admin-ui-server.js";
import {
  bindingReadParameters,
  bindingRow,
  browserMoveWrites,
  dispatchRowButtons,
  dispatchRowSubmit,
  forcePickerChange,
  hideThePage,
  hoverLine,
  moveDestinationId,
  moveSourceId,
  moveWrites,
  openBindingList,
  openTwoNodeStates,
  panelCancelState,
  rowMoveState,
  savedGroup,
  showThePage,
  taskReadQuery,
  waitForLbPoll,
  writeRoutes,
} from "./admin-ui-lb-harness.js";

describe("admin UI load balancing groups", { timeout: UI_TEST_TIMEOUT_MS }, () => {
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
    await expectPage(requests).toHaveText("requests 14");

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
    await expectPage(requests).toHaveText("requests 14");
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
    await expectPage(requests).toHaveText("requests 14");

    // Leaving the picker ends the wait: the row is redrawn with the newer answer and the
    // choice the panel holds comes back with it.
    await picker.evaluate((element) => element.blur());
    await expectPage(requests).toHaveText("requests 999");
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
    await expectPage(hoverLine(row)).toHaveAttribute("data-lb-hover-revision", /: 7$/);
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
    await expectPage(hoverLine(row)).toHaveAttribute(
      "data-lb-hover-revision",
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
});
