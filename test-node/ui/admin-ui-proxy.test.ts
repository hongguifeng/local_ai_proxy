import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expect as expectPage } from "@playwright/test";
import {
  FIXTURE_METRIC_FAMILY_COUNT,
  NON_VLLM_FIXTURE_TEXT,
  UI_TEST_TIMEOUT_MS,
  modelCatalogCalls,
  pairs,
  setModelCatalogError,
  setModelCatalogOutcome,
  setTargetCheckOutcome,
  setTargetMetricsOutcome,
  setTargetModelsOutcome,
  targetCheckCalls,
  targetMetricsCalls,
  targetModelsCalls,
} from "./admin-ui-fixture.js";
import {
  closeStubAdminServer,
  closeTestPage,
  page,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";
import { loadAdminPage, requiredBox } from "./admin-ui-page.js";

beforeAll(startStubAdminServer);
beforeEach(resetStubAdminServer);
afterEach(closeTestPage);
afterAll(closeStubAdminServer);

describe("admin UI proxy page", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("loads and renders configured proxy pairs", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await expectPage(card).toHaveCount(1);
    await expectPage(card.locator('[data-field="name"]')).toHaveValue("Fixture Proxy");
    await expectPage(card.locator('[data-field="listen_host"]')).toHaveValue("127.0.0.1");
    await expectPage(card.locator('[data-field="listen_port"]')).toHaveValue("4321");
    await expectPage(card.locator(".status")).toHaveClass(/running/);
    await expectPage(card.locator('[data-target-field="name"]')).toHaveValue("Fixture Target");
    await expectPage(card.locator('[data-target-field="target_url"]')).toHaveValue(
      "https://example.test/v1",
    );
  });

  it("adds and deletes proxy pairs", async () => {
    await loadAdminPage();
    await page.locator("#addProxy").click();
    await expectPage(page.locator(".proxy-card")).toHaveCount(2);
    await expectPage(page.locator(".proxy-card").last().locator('[data-field="name"]')).toHaveValue(
      "New proxy",
    );

    await page.locator(".proxy-card").last().locator("[data-remove]").click();
    await expectPage(page.locator(".proxy-card")).toHaveCount(1);
    await expectPage(page.locator('.proxy-card[data-index="0"] [data-field="name"]')).toHaveValue(
      "Fixture Proxy",
    );
  });

  it("adds and deletes targets while keeping at least one", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(2);

    await card.locator(".target-card").last().locator("[data-remove-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(1);

    await card.locator(".target-card").first().locator("[data-remove-target]").click();
    await expectPage(card.locator(".target-card")).toHaveCount(1);
    await expectPage(card.locator('[data-target-field="name"]')).toHaveValue("Fixture Target");
  });

  it("reorders target cards by dragging the handle", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    // A single target cannot be reordered, so the handle stays disabled.
    await expectPage(card.locator("[data-drag-target]")).toBeDisabled();

    await card.locator("[data-add-target]").click();
    const handles = card.locator("[data-drag-target]");
    const names = card.locator('[data-target-field="name"]');
    await expectPage(handles).toHaveCount(2);
    await expectPage(handles.first()).toBeEnabled();
    await expectPage(names.nth(0)).toHaveValue("Fixture Target");
    await expectPage(names.nth(1)).toHaveValue("Target");

    const handle = await requiredBox(handles.first());
    const lastCard = await requiredBox(card.locator(".target-card").last());
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    // Right half of the second card, so the card is dropped after it.
    await page.mouse.move(lastCard.x + lastCard.width * 0.8, lastCard.y + lastCard.height / 2, {
      steps: 12,
    });
    await expectPage(card.locator(".target-card.is-dragging")).toHaveCount(1);
    await page.mouse.up();

    await expectPage(names.nth(0)).toHaveValue("Target");
    await expectPage(names.nth(1)).toHaveValue("Fixture Target");
    await expectPage(card.locator(".target-card.is-dragging")).toHaveCount(0);

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pairs") && response.request().method() === "PUT",
      ),
      page.locator("#saveProxies").click(),
    ]);
    expect(pairs[0]?.targets.map((target) => target.name)).toEqual(["Target", "Fixture Target"]);
  }, 20_000);

  it("moves target cards with the keyboard from the handle", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-target]").click();
    const names = card.locator('[data-target-field="name"]');
    await expectPage(names).toHaveCount(2);

    await card.locator(".target-card").last().locator("[data-drag-target]").focus();
    await page.keyboard.press("ArrowLeft");
    await expectPage(names.nth(0)).toHaveValue("Target");
    await expectPage(names.nth(1)).toHaveValue("Fixture Target");

    // Focus follows the moved card, so repeated presses keep working.
    await expectPage(
      card.locator(".target-card").first().locator("[data-drag-target]"),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expectPage(names.nth(0)).toHaveValue("Fixture Target");
    await expectPage(names.nth(1)).toHaveValue("Target");

    // The last card cannot move further right, and the order stays intact.
    await page.keyboard.press("ArrowRight");
    await expectPage(names.nth(0)).toHaveValue("Fixture Target");
    await expectPage(names.nth(1)).toHaveValue("Target");
  });

  it("keeps the selected default target enabled", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-target]").click();
    let targets = card.locator(".target-card");
    await targets.nth(1).locator("[data-default-target]").check();

    // Changing the default target updates both target controls immediately.
    targets = card.locator(".target-card");
    await expectPage(targets.nth(1).locator("[data-default-target]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toBeDisabled();
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).toBeChecked();

    // Adding another target collects the form and rerenders from the current default selection.
    await card.locator("[data-add-target]").click();
    targets = card.locator(".target-card");
    await expectPage(targets).toHaveCount(3);
    await expectPage(targets.nth(1).locator("[data-default-target]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toBeDisabled();
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).toBeChecked();
    await targets.nth(0).locator("[data-target-enabled]").uncheck();
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).not.toBeChecked();
    await expectPage(targets.nth(0)).toHaveClass(/is-disabled-target/);

    // Each state keeps its own washed-out fill and border color.
    const cardStyles: readonly {
      index: number;
      cls: string;
      fill: string;
      border: string;
    }[] = [
      {
        index: 0,
        cls: "is-disabled-target",
        fill: "rgb(245, 246, 248)",
        border: "rgb(197, 200, 204)",
      },
      {
        index: 1,
        cls: "is-default-target",
        fill: "rgb(215, 233, 224)",
        border: "rgb(53, 116, 81)",
      },
      {
        index: 2,
        cls: "is-enabled-target",
        fill: "rgb(213, 224, 237)",
        border: "rgb(60, 116, 166)",
      },
    ];
    for (const card of cardStyles) {
      await expectPage(targets.nth(card.index)).toHaveClass(new RegExp(card.cls));
      await expectPage(targets.nth(card.index)).toHaveCSS("background-color", card.fill);
      await expectPage(targets.nth(card.index)).toHaveCSS("border-top-color", card.border);
    }

    // The two flags sit in the card head, the three action buttons in the bottom row.
    await expectPage(targets.nth(1).locator(".target-head .default-target")).toBeVisible();
    await expectPage(targets.nth(1).locator(".target-head .switch")).toBeVisible();
    await expectPage(targets.nth(1).locator(".target-controls .target-actions")).toBeVisible();
    await expectPage(targets.nth(1).locator(".target-head [data-check-target]")).toHaveCount(0);
  });

  it("toggles and copies the target API key", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const input = target.locator('[data-target-field="target_api_key"]');
    await expectPage(input).toHaveAttribute("type", "password");

    await target.locator("[data-toggle-api-key]").click();
    await expectPage(input).toHaveAttribute("type", "text");
    await expectPage(target.locator("[data-toggle-api-key]")).toHaveAttribute(
      "title",
      "Hide API Key",
    );
    await target.locator("[data-toggle-api-key]").click();
    await expectPage(input).toHaveAttribute("type", "password");

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            Reflect.set(globalThis, "__copiedApiKey", text);
            return Promise.resolve();
          },
        },
      });
    });
    await target.locator("[data-copy-api-key]").click();
    await expectPage(page.locator("#toast")).toContainText("Copied API Key");
    expect(
      await page.evaluate(() => {
        const value: unknown = Reflect.get(globalThis, "__copiedApiKey");
        return typeof value === "string" ? value : "";
      }),
    ).toBe("secret-key");
  });

  it("expands and collapses target more settings", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const options = target.locator(".target-options");
    await expectPage(options).toBeHidden();

    await target.locator("[data-toggle-target-options]").click();
    await expectPage(options).toBeVisible();
    await expectPage(options.locator('[data-target-field="log_root"]')).toHaveValue("logs");
    await expectPage(options.locator('[data-target-field="strip_request_fields"]')).toHaveAttribute(
      "placeholder",
      /temperature/,
    );

    await target.locator("[data-toggle-target-options]").click();
    await expectPage(options).toBeHidden();
  });

  it("edits model prices as compact rule cards", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const prices = target.locator(".model-prices");
    await prices.locator("summary").click();
    await prices.locator("[data-add-price]").click();

    const rule = prices.locator(".model-price-rule");
    await expectPage(rule).toHaveCount(1);
    await expectPage(rule.locator(".price-rule-head")).toContainText("Rule 1");
    await expectPage(rule.locator(".price-field-grid label")).toHaveCount(6);
    await expectPage(rule.locator('[data-price-field="price_multiplier"]')).toHaveValue("1");
    await rule.locator('[data-price-field="model_pattern"]').fill("gpt-*");
    await rule.locator('[data-price-field="input_per_million"]').fill("2");
    await prices.locator("[data-price-test]").fill("gpt-5");
    await expectPage(prices.locator("output")).toHaveText("#1: gpt-*");

    await prices.locator("[data-add-price]").click();
    await expectPage(prices.locator(".model-price-rule")).toHaveCount(2);
    await expectPage(prices.locator("[data-price-up]").last()).toBeEnabled();
  });

  it("imports model prices from the models.dev catalog into the price rules", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const prices = target.locator(".model-prices");
    await prices.locator("summary").click();
    await prices.locator("[data-catalog-rate]").fill("7.1");
    setModelCatalogOutcome({
      models: ["gpt-5.5", "gpt-5.5-turbo", "weird-model"],
      rules: [
        {
          model_pattern: "gpt-5.5",
          input_per_million: "2.13",
          output_per_million: "8.875",
          cache_read_per_million: "0.213",
          cache_write_per_million: "0",
        },
        {
          model_pattern: "gpt-5.5-turbo",
          input_per_million: "1",
          output_per_million: "2",
          cache_read_per_million: "0",
          cache_write_per_million: "0",
        },
      ],
      unmatched: ["weird-model"],
      catalog: { source: "models.dev", fetchedAt: 1_700_000_000 },
    });
    await prices.locator("[data-fetch-catalog-prices]").click();

    const rule = prices.locator(".model-price-rule");
    await expectPage(rule).toHaveCount(2);
    await expectPage(rule.nth(0).locator('[data-price-field="model_pattern"]')).toHaveValue(
      "gpt-5.5",
    );
    await expectPage(rule.nth(1).locator('[data-price-field="model_pattern"]')).toHaveValue(
      "gpt-5.5-turbo",
    );
    await expectPage(rule.first().locator('[data-price-field="input_per_million"]')).toHaveValue(
      "2.13",
    );
    await expectPage(page.locator("#toast")).toContainText(
      "Added 2 price rule(s); 0 existing rule(s) untouched; 1 had no price",
    );
    // The import only fills price rules; the model mapping stays empty.
    await expectPage(target.locator('[data-target-field="model_mappings"]')).not.toHaveValue(
      /gpt-5\.5/,
    );
    expect(modelCatalogCalls).toEqual([
      { targetUrl: "https://example.test/v1", targetApiKey: "secret-key", priceRate: "7.1" },
    ]);
  });

  it("keeps existing price rules when importing catalog prices", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const prices = target.locator(".model-prices");
    await prices.locator("summary").click();
    await prices.locator("[data-add-price]").click();
    await prices
      .locator('[data-price-index="0"] [data-price-field="model_pattern"]')
      .fill("gpt-5.5");
    setModelCatalogOutcome({
      models: ["gpt-5.5", "gpt-5.5-turbo"],
      rules: [
        {
          model_pattern: "gpt-5.5",
          input_per_million: "2.13",
          output_per_million: "8.875",
          cache_read_per_million: "0.213",
          cache_write_per_million: "0",
        },
        {
          model_pattern: "gpt-5.5-turbo",
          input_per_million: "1",
          output_per_million: "2",
          cache_read_per_million: "0",
          cache_write_per_million: "0",
        },
      ],
      unmatched: [],
      catalog: { source: "models.dev", fetchedAt: 1_700_000_000 },
    });
    await prices.locator("[data-fetch-catalog-prices]").click();

    const rule = prices.locator(".model-price-rule");
    await expectPage(rule).toHaveCount(2);
    await expectPage(rule.nth(0).locator('[data-price-field="model_pattern"]')).toHaveValue(
      "gpt-5.5",
    );
    await expectPage(rule.nth(1).locator('[data-price-field="model_pattern"]')).toHaveValue(
      "gpt-5.5-turbo",
    );
    await expectPage(page.locator("#toast")).toContainText(
      "Added 1 price rule(s); 1 existing rule(s) untouched",
    );
  });

  it("shows a toast and adds no rules when the catalog import fails", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    const prices = target.locator(".model-prices");
    await prices.locator("summary").click();
    setModelCatalogError("The upstream answered 401 for /v1/models.");
    await prices.locator("[data-fetch-catalog-prices]").click();

    await expectPage(page.locator("#toast")).toContainText(/401/);
    await expectPage(prices.locator(".model-price-rule")).toHaveCount(0);
    expect(modelCatalogCalls).toEqual([
      { targetUrl: "https://example.test/v1", targetApiKey: "secret-key", priceRate: "1" },
    ]);
  });

  it("checks the forwarding target from the target card dialog", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await expectPage(dialog).toBeVisible();
    await expectPage(dialog.locator("#targetCheckUrl")).toHaveValue("https://example.test/v1");
    await expectPage(dialog.locator("#targetCheckApiKey")).toHaveValue("secret-key");
    await dialog.locator("#targetCheckModel").fill("gpt-5.5");
    await dialog.locator("#targetCheckStart").click();

    const result = dialog.locator("#targetCheckResult");
    await expectPage(result).toBeVisible();
    await expectPage(result).toHaveClass(/success/);
    await expectPage(result).toHaveText(/HTTP 200/);
    expect(targetCheckCalls).toEqual([
      {
        targetUrl: "https://example.test/v1",
        model: "gpt-5.5",
        apiType: "chat",
        apiKey: "secret-key",
      },
    ]);
  });

  it("sends the selected api type with the target check request", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await expectPage(dialog.locator("#targetCheckApiType")).toHaveValue("chat");
    await expectPage(dialog.locator("#targetCheckModelPop")).toBeHidden();
    await dialog.locator("#targetCheckModelCaret").click();
    await expectPage(dialog.locator("#targetCheckModelPop")).toBeVisible();
    await expectPage(dialog.locator("#targetCheckModelCaret")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(7);
    await dialog.locator("#targetCheckModelCaret").click();
    await expectPage(dialog.locator("#targetCheckModelPop")).toBeHidden();
    await dialog.locator("#targetCheckApiType").selectOption("anthropic");
    await dialog.locator("#targetCheckModel").fill("claude-opus-4-6");
    await dialog.locator("#targetCheckModel").press("Escape");
    await dialog.locator("#targetCheckStart").click();

    await expectPage(dialog.locator("#targetCheckResult")).toHaveText(/HTTP 200/);
    expect(targetCheckCalls).toEqual([
      {
        targetUrl: "https://example.test/v1",
        model: "claude-opus-4-6",
        apiType: "anthropic",
        apiKey: "secret-key",
      },
    ]);
  });

  it("shows a warning with the server error detail when the status is an error", async () => {
    setTargetCheckOutcome({
      ok: true,
      status: 401,
      durationMs: 12,
      detail: '{"error":{"message":"invalid api key"}}',
    });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await dialog.locator("#targetCheckModel").fill("gpt-5.5");
    await dialog.locator("#targetCheckStart").click();

    const result = dialog.locator("#targetCheckResult");
    await expectPage(result).toHaveClass(/warning/);
    await expectPage(result).toHaveText(/401/);
    await expectPage(result).toHaveText(/invalid api key/);
  });

  it("shows a failure when the target check cannot reach the endpoint", async () => {
    setTargetCheckOutcome({ ok: false, durationMs: 8, error: "connect ECONNREFUSED 127.0.0.1:9" });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await dialog.locator("#targetCheckModel").fill("gpt-5.5");
    await dialog.locator("#targetCheckStart").click();

    const result = dialog.locator("#targetCheckResult");
    await expectPage(result).toHaveClass(/failure/);
    await expectPage(result).toHaveText(/ECONNREFUSED/);
  });

  it("pulls the served model list into the model dropdown and preselects the first id", async () => {
    setTargetModelsOutcome({ ok: true, models: ["gpt-5.6-sol", "gpt-5.6-luna"], durationMs: 6 });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    const caret = dialog.locator("#targetCheckModelCaret");
    const pop = dialog.locator("#targetCheckModelPop");
    // Before any pull the dropdown only offers the hand-written suggestions.
    await caret.click();
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(7);
    await caret.click();
    await expectPage(pop).toBeHidden();

    await dialog.locator("#targetCheckModels").click();

    const notice = dialog.locator("#targetCheckModelsNotice");
    await expectPage(notice).toBeVisible();
    await expectPage(notice).toHaveClass(/success/);
    await expectPage(notice).toContainText("Fetched 2 model(s)");
    await expectPage(notice).toContainText("6 ms");
    await expectPage(dialog.locator("#targetCheckModels")).toBeEnabled();
    await expectPage(dialog.locator("#targetCheckModel")).toHaveValue("gpt-5.6-sol");

    // The whole pulled list is browsable, not just the prefix that was typed.
    await caret.click();
    await expectPage(pop).toBeVisible();
    const values = await dialog
      .locator(".target-check-model-option")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model-option")));
    expect(values).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
    expect(targetModelsCalls).toEqual([
      { targetUrl: "https://example.test/v1", apiKey: "secret-key" },
    ]);
  });

  it("keeps a model the address really serves when the list is pulled", async () => {
    setTargetModelsOutcome({ ok: true, models: ["gpt-5.6-sol", "gpt-5.6-luna"], durationMs: 4 });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await dialog.locator("#targetCheckModel").fill("gpt-5.6-luna");
    await dialog.locator("#targetCheckModel").press("Escape");
    await dialog.locator("#targetCheckModels").click();

    await expectPage(dialog.locator("#targetCheckModelsNotice")).toHaveClass(/success/);
    await expectPage(dialog.locator("#targetCheckModel")).toHaveValue("gpt-5.6-luna");
    await dialog.locator("#targetCheckModelCaret").click();
    const row = dialog.locator('[data-model-option="gpt-5.6-luna"]');
    await expectPage(row).toHaveClass(/is-current/u);
    await expectPage(row).toHaveAttribute("aria-selected", "true");
  });

  it("says when the pulled model list had to be cut short", async () => {
    setTargetModelsOutcome({
      ok: true,
      models: ["a-model", "b-model"],
      durationMs: 7,
      truncated: true,
    });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    await dialog.locator("#targetCheckModels").click();

    await expectPage(dialog.locator("#targetCheckModelsNotice")).toHaveText(
      /\(some models are not listed\)/u,
    );
  });

  it("restores the default suggestions and toasts the error when the pull fails", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    const caret = dialog.locator("#targetCheckModelCaret");
    const pop = dialog.locator("#targetCheckModelPop");
    await dialog.locator("#targetCheckModels").click();
    await caret.click();
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(2);
    await caret.click();

    setTargetModelsOutcome({
      ok: false,
      models: [],
      durationMs: 8,
      error: "The upstream answered 401 for /v1/models.",
    });
    await dialog.locator("#targetCheckModel").fill("gpt-5.5");
    await dialog.locator("#targetCheckModel").press("Escape");
    await dialog.locator("#targetCheckModels").click();

    const notice = dialog.locator("#targetCheckModelsNotice");
    await expectPage(notice).toHaveClass(/failure/);
    await expectPage(notice).toHaveText(/401/u);
    await caret.click();
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(7);
    await expectPage(dialog.locator("#targetCheckModel")).toHaveValue("gpt-5.5");
    await expectPage(page.locator("#toast")).toContainText(/401/u);
    expect(targetModelsCalls).toEqual([
      { targetUrl: "https://example.test/v1", apiKey: "secret-key" },
      { targetUrl: "https://example.test/v1", apiKey: "secret-key" },
    ]);
  });

  it("filters the model list while typing and fills the id picked from it", async () => {
    setTargetModelsOutcome({
      ok: true,
      models: ["gpt-5.6-sol", "gpt-5.6-luna", "deepseek-chat"],
      durationMs: 6,
    });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-check-target]").click();

    const dialog = page.locator("#targetCheckDialog");
    const caret = dialog.locator("#targetCheckModelCaret");
    const pop = dialog.locator("#targetCheckModelPop");
    await dialog.locator("#targetCheckModels").click();
    await caret.click();
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(3);

    await dialog.locator("#targetCheckModel").fill("gpt");
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(2);

    await dialog.locator('[data-model-option="gpt-5.6-luna"]').click();
    await expectPage(dialog.locator("#targetCheckModel")).toHaveValue("gpt-5.6-luna");
    await expectPage(pop).toBeHidden();
    await expectPage(caret).toHaveAttribute("aria-expanded", "false");

    // A value the address does not serve says so instead of showing an empty box.
    await dialog.locator("#targetCheckModel").fill("zzz");
    await expectPage(pop).toBeVisible();
    await expectPage(dialog.locator(".target-check-model-option")).toHaveCount(0);
    await expectPage(dialog.locator(".target-check-model-empty")).toContainText("zzz");

    // Escape closes the list and still leaves the dialog open for the test run.
    await dialog.locator("#targetCheckModel").press("Escape");
    await expectPage(pop).toBeHidden();
    await expectPage(dialog).toBeVisible();

    // The keyboard picks the highlighted row without submitting the form.
    await dialog.locator("#targetCheckModel").fill("");
    await dialog.locator("#targetCheckModel").press("ArrowDown");
    await expectPage(pop).toBeVisible();
    await dialog.locator("#targetCheckModel").press("ArrowUp");
    await dialog.locator("#targetCheckModel").press("Enter");
    await expectPage(dialog.locator("#targetCheckModel")).toHaveValue("gpt-5.6-sol");
    await expectPage(pop).toBeHidden();
    expect(targetCheckCalls).toEqual([]);
  });

  it("renders the vLLM dashboard with derived stats by default", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-metrics-target]").click();

    const dialog = page.locator("#metricsDialog");
    await expectPage(dialog).toBeVisible();
    await expectPage(dialog.locator("#metricsDashboard")).toBeVisible();
    await expectPage(dialog.locator("#metricsList")).toBeHidden();
    await expectPage(dialog.locator("#metricsDialogUrl")).toHaveText("https://example.test/v1");

    const card = (label: string) =>
      dialog.locator("#metricsDashboard .mds-stat", { hasText: label });
    await expectPage(card("Model").locator("strong")).toHaveText("fixture-model");
    await expectPage(card("Uptime").locator("strong")).toHaveText(/\d+:\d{2}:\d{2}/);
    await expectPage(dialog.locator(".mds-pill-ok")).toHaveText(/Awake/);
    await expectPage(card("Running requests").locator("strong")).toHaveText("2");
    await expectPage(card("Waiting requests").locator("strong")).toHaveText("3");
    await expectPage(card("Waiting requests").locator("em")).toHaveText("capacity=2 deferred=1");
    await expectPage(card("KV cache usage").locator("strong")).toHaveText("42.0%");
    await expectPage(card("Preemptions").locator("strong")).toHaveText("4");
    await expectPage(card("Prefix cache hit ratio").locator("strong")).toHaveText("75.0%");
    await expectPage(card("Speculative acceptance").locator("strong")).toHaveText("75.0%");
    await expectPage(card("GPU blocks").locator("strong")).toHaveText("100");
    await expectPage(card("KV capacity (tokens)").locator("strong")).toHaveText("1,600");
    await expectPage(card("Completed requests").locator("strong")).toHaveText("1,008");
    await expectPage(card("Decode speed (est.)").locator("strong")).toHaveText("1.1 t/s");
    await expectPage(card("Prompt tokens (total)").locator("strong")).toHaveText("10,000");
    await expectPage(card("Avg prompt length").locator("strong")).toHaveText("100");
    await expectPage(card("Resident memory").locator("strong")).toHaveText(/GB/);

    // Histogram percentiles are interpolated from buckets: p50 lands exactly
    // on the 0.1 s boundary, p99 falls back to the last finite bound.
    const ttftPanel = dialog.locator(".mds-panel", { hasText: "Time to first token" });
    await expectPage(ttftPanel.locator(".mds-quantile").nth(0).locator("strong")).toHaveText(
      "100.0 ms",
    );
    await expectPage(ttftPanel.locator(".mds-quantile").nth(1).locator("strong")).toHaveText(
      "1.00 s",
    );
    await expectPage(ttftPanel.locator(".mds-quantile").nth(2).locator("strong")).toHaveText(
      "1.00 s",
    );
    await expectPage(ttftPanel.locator(".mds-quantile-mean strong")).toHaveText("120.0 ms");
    await expectPage(ttftPanel.locator(".mds-bucket")).toHaveCount(4);

    // Prompt-token sources render as a stacked bar with a legend.
    await expectPage(dialog.locator(".mds-stack-segment")).toHaveCount(2);
    await expectPage(dialog.locator(".mds-legend").first()).toContainText("Local cache hit 75.0%");

    // Abort/error finish reasons are highlighted as danger chips.
    const dangerChips = dialog.locator(".mds-chip.mds-chip-danger");
    await expectPage(dangerChips).toHaveCount(2);
    await expectPage(dangerChips.first()).toHaveText(/abort 5/);

    // The latency section is pinned last, after process resources.
    const sectionTitles = await dialog.locator(".mds-section h3").allTextContents();
    expect(sectionTitles).toEqual([
      "Engine status",
      "Live load",
      "Cache & spec decoding",
      "Token throughput",
      "Process resources",
      "Latency distribution",
    ]);

    expect(targetMetricsCalls).toEqual([
      { targetUrl: "https://example.test/v1", apiKey: "secret-key" },
    ]);
  });

  it("auto-refreshes metrics on the selected interval and stops when closed", async () => {
    await page.clock.install();
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-metrics-target]").click();

    const dialog = page.locator("#metricsDialog");
    await expectPage(dialog.locator("#metricsDashboard")).toBeVisible();
    // Opening fires an immediate request; wait until it settles, otherwise a
    // timer tick that lands while it is still in flight is skipped by design.
    await expectPage(dialog.locator("#metricsRefresh")).toBeEnabled();
    expect(targetMetricsCalls).toHaveLength(1);

    const interval = dialog.locator("#metricsRefreshInterval");
    await expectPage(interval).toHaveValue("0");
    await expectPage(dialog.locator("#metricsRefreshCountdown")).toBeHidden();
    await interval.selectOption("5000");
    await expectPage(dialog.locator("#metricsRefreshCountdown")).toBeVisible();
    await expectPage(dialog.locator("#metricsRefreshCountdown")).toHaveText("5 s");

    // Selecting the interval does not fire an immediate request; the timer does.
    await expectPage.poll(() => targetMetricsCalls.length).toBe(1);
    await page.clock.runFor(5000);
    await expectPage.poll(() => targetMetricsCalls.length).toBe(2);

    // The scroll position survives the timed re-render (no loading flash,
    // and the re-render restores the captured scrollTop).
    const dashboard = dialog.locator("#metricsDashboard");
    const scrolled = await dashboard.evaluate((element) => {
      element.scrollTop = 400;
      return element.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await expectPage(dialog.locator("#metricsRefresh")).toBeEnabled();
    await page.clock.runFor(5000);
    await expectPage.poll(() => targetMetricsCalls.length).toBe(3);
    await expectPage(dashboard).toHaveJSProperty("scrollTop", scrolled);

    await dialog.locator("#metricsClose").click();
    await expectPage(dialog).toBeHidden();
    await page.clock.runFor(20000);
    expect(targetMetricsCalls).toHaveLength(3);

    // Reopening resumes the selection that is still shown in the select.
    await target.locator("[data-metrics-target]").click();
    await expectPage(interval).toHaveValue("5000");
    await expectPage(dialog.locator("#metricsRefreshCountdown")).toHaveText("5 s");
    await expectPage(dialog.locator("#metricsRefresh")).toBeEnabled();
    await page.clock.runFor(5000);
    await expectPage.poll(() => targetMetricsCalls.length).toBe(5);
    await dialog.locator("#metricsClose").click();

    // Switching back to "off" stops the timer without stopping the manual refresh.
    await target.locator("[data-metrics-target]").click();
    await interval.selectOption("0");
    await expectPage(dialog.locator("#metricsRefreshCountdown")).toBeHidden();
    const callsBeforeManual = targetMetricsCalls.length;
    await dialog.locator("#metricsRefresh").click();
    await expectPage.poll(() => targetMetricsCalls.length).toBe(callsBeforeManual + 1);
    await page.clock.runFor(20000);
    expect(targetMetricsCalls).toHaveLength(callsBeforeManual + 1);
    await dialog.locator("#metricsClose").click();
  });

  it("switches to the full metric list with filter and raw text", async () => {
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-metrics-target]").click();

    const dialog = page.locator("#metricsDialog");
    await dialog.locator("#metricsViewList").click();
    await expectPage(dialog.locator("#metricsList")).toBeVisible();
    await expectPage(dialog.locator("#metricsDashboard")).toBeHidden();
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(FIXTURE_METRIC_FAMILY_COUNT);
    await expectPage(dialog.locator("#metricsRawPre")).toContainText("vllm:kv_cache_usage_perc");

    await dialog.locator("#metricsFilter").fill("vllm:prefix_cache");
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(2);
    await expectPage(dialog.locator(".metrics-meta")).toHaveText(/2 \/ 58/);
    await dialog.locator("#metricsFilter").fill("nonexistent");
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(0);
    await dialog.locator("#metricsFilter").fill("");
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(FIXTURE_METRIC_FAMILY_COUNT);

    await dialog.locator("#metricsClose").click();
    await expectPage(dialog).toBeHidden();
  });

  it("falls back to the list view when the exposition has no vllm metrics", async () => {
    setTargetMetricsOutcome({
      ok: true,
      status: 200,
      durationMs: 5,
      text: NON_VLLM_FIXTURE_TEXT,
    });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-metrics-target]").click();

    const dialog = page.locator("#metricsDialog");
    await expectPage(dialog.locator("#metricsList")).toBeVisible();
    await expectPage(dialog.locator("#metricsDashboard")).toBeHidden();
    await expectPage(dialog.locator(".metrics-note")).toHaveText(/no vllm/i);
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(2);
  });

  it("shows a failure when the metrics endpoint cannot be reached", async () => {
    setTargetMetricsOutcome({ ok: false, durationMs: 8, error: "connect ECONNREFUSED" });
    await loadAdminPage();
    const target = page.locator('.proxy-card[data-index="0"] .target-card').first();
    await target.locator("[data-metrics-target]").click();

    const dialog = page.locator("#metricsDialog");
    const result = dialog.locator("#metricsResult");
    await expectPage(result).toHaveClass(/failure/);
    await expectPage(result).toHaveText(/ECONNREFUSED/);
    await expectPage(dialog.locator("#metricsDashboard")).toBeEmpty();
    await expectPage(dialog.locator(".metrics-family")).toHaveCount(0);
  });

  it("saves form changes and toggles the proxy enabled state", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator('[data-field="name"]').fill("Saved Proxy");
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pairs") && response.request().method() === "PUT",
      ),
      page.locator("#saveProxies").click(),
    ]);
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(pairs[0]?.name).toBe("Saved Proxy");

    await loadAdminPage();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pairs/proxy-one/enabled") &&
          response.request().method() === "POST",
      ),
      page.locator('.proxy-card[data-index="0"] [data-toggle]').evaluate((element) => {
        const click: unknown = Reflect.get(element, "click");
        if (typeof click === "function") {
          Reflect.apply(click, element, []);
        }
      }),
    ]);
    expect(pairs[0]?.enabled).toBe(false);
    expect(pairs[0]?.running).toBe(false);
    await expectPage(page.locator('.proxy-card[data-index="0"] [data-toggle]')).not.toBeChecked();
  }, 20_000);

  it("preserves unsaved form values while switching languages", async () => {
    await loadAdminPage();
    const name = page.locator('.proxy-card[data-index="0"] [data-field="name"]');
    await name.fill("Unsaved Name");

    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator('.proxy-card[data-index="0"] [data-field="name"]')).toHaveValue(
      "Unsaved Name",
    );
    await expectPage(page.locator("#saveProxies")).toHaveText("保存配置");

    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator('.proxy-card[data-index="0"] [data-field="name"]')).toHaveValue(
      "Unsaved Name",
    );
    await expectPage(page.locator("#saveProxies")).toHaveText("Save config");
  });

  it("wraps targets onto additional rows without horizontal scrolling", async () => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    for (let index = 0; index < 4; index += 1) {
      await card.locator("[data-add-target]").click();
    }
    const row = card.locator(".targets-row");
    const targets = card.locator(".target-card");
    const firstBox = await requiredBox(targets.nth(0));
    const secondBox = await requiredBox(targets.nth(1));
    const fourthBox = await requiredBox(targets.nth(3));

    expect(secondBox.y).toBe(firstBox.y);
    expect(fourthBox.y).toBeGreaterThan(firstBox.y + firstBox.height / 2);
    expect(
      await row.evaluate((element) => {
        const scrollWidth: unknown = Reflect.get(element, "scrollWidth");
        const clientWidth: unknown = Reflect.get(element, "clientWidth");
        return (
          typeof scrollWidth === "number" &&
          typeof clientWidth === "number" &&
          scrollWidth <= clientWidth
        );
      }),
    ).toBe(true);

    // The head row keeps the default radio and the enable switch on one line:
    // no clipping, and the label never collapses into a wrapped column.
    const headFit = await row.evaluate((element) =>
      [...element.querySelectorAll(".target-head")].map((head) => {
        const flag = head.querySelector(".default-target");
        const text = flag?.querySelector(":scope > span");
        const clipped = (node: Element) => {
          const scrollWidth: unknown = Reflect.get(node, "scrollWidth");
          const clientWidth: unknown = Reflect.get(node, "clientWidth");
          return (
            typeof scrollWidth === "number" &&
            typeof clientWidth === "number" &&
            scrollWidth > clientWidth + 1
          );
        };
        const box = flag?.getBoundingClientRect();
        return {
          headClipped: clipped(head),
          flagClipped: flag === null ? false : clipped(flag),
          textClipped: text === null || text === undefined ? false : clipped(text),
          flagHeight: box === undefined ? 0 : Math.round(box.height),
        };
      }),
    );
    expect(
      headFit.every((item) => !item.headClipped && !item.flagClipped && !item.textClipped),
    ).toBe(true);
    // One line of 12px text; a wrapped label measures two lines.
    expect(headFit.every((item) => item.flagHeight >= 15 && item.flagHeight <= 22)).toBe(true);

    // Both flags are pushed to the right end of the head, while the three action
    // buttons start the bottom row and the options toggle stays at its right end.
    const headLayout = await row.evaluate((element) =>
      [...element.querySelectorAll(".target-card")].map((card) => {
        const head = card.querySelector(".target-head");
        const flags = card.querySelector(".target-head-flags");
        const actions = card.querySelector(".target-actions");
        const more = card.querySelector("[data-toggle-target-options]");
        if (head === null || flags === null || actions === null || more === null) {
          throw new Error("the target card lost its head or its bottom row");
        }
        const edges = (node: Element) => {
          const box = node.getBoundingClientRect();
          return {
            left: Math.round(box.left),
            right: Math.round(box.right),
            top: Math.round(box.top),
          };
        };
        return {
          head: edges(head),
          flags: edges(flags),
          actions: edges(actions),
          more: edges(more),
        };
      }),
    );
    for (const item of headLayout) {
      expect(Math.abs(item.flags.right - item.head.right)).toBeLessThanOrEqual(2);
      expect(Math.abs(item.actions.left - item.head.left)).toBeLessThanOrEqual(2);
      expect(item.more.top).toBe(item.actions.top);
      expect(item.more.right).toBeGreaterThan(item.actions.right);
    }
  });
  it("preserves raw drafts, prices and focus across language and status refreshes", async () => {
    await loadAdminPage();
    await page.locator(".model-prices summary").click();
    await page.locator("[data-add-price]").click();
    const mapping = page.locator('[data-target-field="model_mappings"]');
    const name = page.locator('[data-field="name"]');
    const price = page.locator('[data-price-field="input_per_million"]');
    await name.fill("Unsaved proxy");
    await mapping.fill("  draft-*  =>  upstream-model  ");
    await price.fill("0.00100");
    await mapping.focus();
    await mapping.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) element.setSelectionRange(3, 9);
    });
    await page.evaluate('setLanguage("zh");');
    await expectPage(mapping).toHaveValue("  draft-*  =>  upstream-model  ");
    await expectPage(mapping).toBeFocused();
    expect(
      await mapping.evaluate((element) =>
        element instanceof HTMLTextAreaElement
          ? [element.selectionStart, element.selectionEnd]
          : [],
      ),
    ).toEqual([3, 9]);
    await page.evaluate("proxyConfig.load();");
    await expectPage(name).toHaveValue("Unsaved proxy");
    await expectPage(price).toHaveValue("0.00100");
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(mapping).toHaveValue("  draft-*  =>  upstream-model  ");
    await expectPage(price).toHaveValue("0.00100");
  });

  it("initializes once and removes form and language listeners on disposal", async () => {
    await loadAdminPage();
    await page.evaluate("initializeProxyConfig(); initializeProxyConfig();");
    await page.locator("#addProxy").click();
    await expectPage(page.locator(".proxy-card")).toHaveCount(2);
    await page.evaluate("proxyConfig.dispose(); proxyConfig.dispose();");
    await page.locator("#addProxy").click();
    await expectPage(page.locator(".proxy-card")).toHaveCount(2);
    // Disposal unregisters the feature panel, including its draft capture callback.
    await page.locator(".proxy-card").first().locator('[data-field="name"]').fill("Disposed draft");
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(
      page.locator(".proxy-card").first().locator('[data-field="name"]'),
    ).toHaveValue("Disposed draft");
    await page.evaluate("initializeProxyConfig(); initializeProxyConfig();");
    await page.locator("#addProxy").click();
    await expectPage(page.locator(".proxy-card")).toHaveCount(3);
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(
      page.locator(".proxy-card").first().locator('[data-field="name"]'),
    ).toHaveValue("Disposed draft");
  });

  it("keeps edits typed while a config save is in flight", async () => {
    await loadAdminPage();
    let releaseSave: (() => void) | undefined;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/api/pairs", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      await saveReleased;
      await route.continue();
    });
    const name = page.locator('[data-field="name"]');
    await name.fill("Submitted draft");
    await Promise.all([
      page.waitForRequest(
        (request) => request.url().endsWith("/api/pairs") && request.method() === "PUT",
      ),
      page.locator("#saveProxies").click(),
    ]);
    await name.fill("Later unsaved draft");
    const mapping = page.locator('[data-target-field="model_mappings"]');
    await mapping.fill("  draft-model  =>  upstream-model  ");
    releaseSave?.();
    await expectPage(page.locator("#toast")).toContainText("Config saved");
    expect(pairs[0]?.name).toBe("Submitted draft");
    await expectPage(name).toHaveValue("Later unsaved draft");
    await expectPage(mapping).toHaveValue("  draft-model  =>  upstream-model  ");
  });
});
