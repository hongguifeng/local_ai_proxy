import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";

import { UI_TEST_TIMEOUT_MS } from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
  unhandledPageErrors,
} from "./admin-ui-server.js";
import { loadAdminPage } from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

/**
 * [AI-14] the rule every browser file in this directory is subject to.
 *
 * A page that threw while a test drove it used to pass: Chromium logged the error and
 * nothing read it, so a render that died halfway could still satisfy an assertion written
 * against what the page had drawn beforehand. The listener is attached to every page the
 * suite creates, and the hook that closes that page raises whatever it collected - which is
 * what these two cases pin.
 */
describe("unhandled page error collection", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("records nothing while a page renders the admin view", async () => {
    await loadAdminPage();
    await expectPage(page.locator('.proxy-card[data-index="0"]')).toHaveCount(1);
    expect(unhandledPageErrors()).toEqual([]);
  });

  it("raises a page error left unhandled, with its message and stack", async () => {
    await loadAdminPage();
    // Thrown from a timer, not from the evaluate callback itself: Playwright hands an
    // error returned by evaluate back to Node, while one the page leaves unhandled is
    // the kind a browser test must not miss.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("deliberate page failure");
      }, 0);
    });
    await expect.poll(() => unhandledPageErrors().length).toBe(1);
    const recorded = unhandledPageErrors()[0];
    expect(recorded?.message).toBe("deliberate page failure");
    expect(recorded?.stack).toContain("deliberate page failure");

    // `closeTestPage` is the hook every browser file registers, so calling it here is how
    // the test shows what the hook does. Catching the throw is the only way to read the
    // message without failing this file: nothing else consumes a page error, and the
    // registered hook still closes the page afterwards because the raise empties the list.
    const raised = await closeTestPage().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raised).toBeInstanceOf(Error);
    const message = raised instanceof Error ? raised.message : "";
    expect(message).toContain("The page threw 1 unhandled script error(s)");
    expect(message).toContain("deliberate page failure");
    expect(message).toContain("at ");
    expect(unhandledPageErrors()).toEqual([]);
  });
});
