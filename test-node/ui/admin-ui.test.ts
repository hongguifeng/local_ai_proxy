import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chromium,
  expect as expectPage,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import {
  applicationHealth,
  createAdminServer,
  loadAdminStaticAssets,
} from "../../src/admin/index.js";
import type { ProxyPair, PublicProxyPair } from "../../src/config/index.js";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof createAdminServer>;
let baseUrl: string;
const logQueries: string[] = [];
const groupLogQueries: string[] = [];
let useLargeLogFixture = false;
let useLargeGroupLogFixture = false;
const deletedLogGroups = new Set<string>();
const detailReads = new Map<string, number>();
const UI_TEST_TIMEOUT_MS = 30_000;

const pairs: PublicProxyPair[] = [];

function fixturePair(): PublicProxyPair {
  return {
    id: "proxy-one",
    name: "Fixture Proxy",
    enabled: true,
    running: true,
    actual_listen_port: 4321,
    listen_host: "127.0.0.1",
    listen_port: 4321,
    access_log: false,
    default_target_id: "target-one",
    targets: [
      {
        id: "target-one",
        name: "Fixture Target",
        enabled: true,
        target_url: "https://example.test/v1",
        target_api_key: "secret-key",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        log_root: "logs",
        redact_logs: false,
        model_mappings: [],
      },
    ],
  };
}

function sessionTranscriptFixture(): string {
  return [
    "=== LLM session transcript ===",
    "model: gpt-5",
    "window: 2026-07-18 12:00:01 -> 12:00:02 (1.9s)",
    "",
    "--- request #1 ---",
    "user: Summarize the deployment log below.",
    "",
    "Deployment started at 11:58:40.",
    "Stage build   : ok (18s)",
    "Stage migrate : ok (3s)",
    "Stage health  : ok (2s)",
    "Deployment finished successfully in 2m 21s.",
    "",
    "--- response #1 ---",
    "assistant: The deployment completed successfully in three stages.",
    "  build took the longest at 18 seconds, followed by",
    "  migration (3s) and the health check (2s). No errors",
    "  were reported and the service is running on port 4321.",
    "",
    "--- raw payload tail ---",
    "long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text",
    "long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text",
    "long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text-long-text",
    "",
    "=== end of transcript ===",
  ].join("\n");
}

beforeAll(async () => {
  server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    pairService: {
      listPairs: () => pairs,
      replacePairs: (nextPairs) => {
        const publicPairs = nextPairs.map(publicPair);
        pairs.splice(0, pairs.length, ...publicPairs);
        return Promise.resolve(pairs);
      },
      setPairEnabled: (pairId, enabled) => {
        const pair = pairs.find(({ id }) => id === pairId);
        if (pair === undefined) {
          throw new Error(`Unknown pair: ${pairId}`);
        }
        const updated = { ...pair, enabled, running: enabled };
        pairs.splice(pairs.indexOf(pair), 1, updated);
        return Promise.resolve(updated);
      },
    },
    logService: {
      listGroups: (query, limit, offset) => {
        logQueries.push(query);
        const sourceGroups = useLargeLogFixture
          ? Array.from({ length: 101 }, (_, index) => ({
              id: `task-${index + 1}`,
              started_at: `2026-07-18 12:${String(index % 60).padStart(2, "0")}:00`,
              ended_at: `2026-07-18 12:${String(index % 60).padStart(2, "0")}:05`,
              model: "gpt-5",
              request_count: 1,
              target: `target-${index + 1}`,
            }))
          : [
              {
                id: "task-one",
                started_at: "2026-07-18 12:00:00",
                ended_at: "2026-07-18 12:00:05",
                model: "gpt-5",
                request_count: 5,
                target: "fixture-target",
              },
              {
                id: "task-needle",
                started_at: "2026-07-18 11:30:00",
                ended_at: "2026-07-18 11:30:05",
                model: "claude",
                request_count: 1,
                target: "fixture-target",
              },
              {
                id: "task-three",
                started_at: "2026-07-18 10:42:00",
                ended_at: "2026-07-18 10:44:30",
                model: "qwen3.6-27b",
                request_count: 3,
                target: "fixture-target",
              },
              {
                id: "task-four",
                started_at: "2026-07-18 09:15:00",
                ended_at: "2026-07-18 09:20:10",
                model: "gpt-4o-mini",
                request_count: 12,
                target: "fixture-target",
              },
            ];
        const groups = sourceGroups.filter(
          (group) =>
            !deletedLogGroups.has(group.id) &&
            [group.id, group.started_at, group.ended_at, group.model, group.target]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
        const pageGroups = groups.slice(offset, offset + limit);
        const nextOffset = offset + pageGroups.length;
        return {
          groups: pageGroups,
          total: groups.length,
          limit,
          offset,
          next_offset: nextOffset,
          has_more: nextOffset < groups.length,
        };
      },
      getGroupLogs: (groupId, query, limit, offset) => {
        groupLogQueries.push(`${groupId}:${query}`);
        if (groupId !== "task-one") {
          return undefined;
        }
        if (useLargeGroupLogFixture) {
          const logs = Array.from({ length: 301 }, (_, index) => {
            const sequence = 301 - index;
            return {
              id: `record-${sequence}`,
              timestamp: `2026-07-18 12:${String(sequence % 60).padStart(2, "0")}:00`,
              sequence: String(sequence),
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 1,
              status: 200,
              request_token_count: sequence * 2,
              response_token_count: sequence,
              target: "fixture-target",
            };
          });
          const pageLogs = logs.slice(offset, offset + limit);
          const nextOffset = offset + pageLogs.length;
          return {
            id: groupId,
            total: logs.length,
            limit,
            offset,
            next_offset: nextOffset,
            has_more: nextOffset < logs.length,
            logs: pageLogs,
          };
        }
        return {
          id: groupId,
          total: 5,
          limit: 200,
          offset: 0,
          next_offset: 5,
          has_more: false,
          logs: [
            {
              id: "record-five",
              timestamp: "2026-07-18 12:00:05",
              sequence: "5",
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 3,
              status: 200,
              request_token_count: 46,
              response_token_count: 212,
              target: "fixture-target",
            },
            {
              id: "record-four",
              timestamp: "2026-07-18 12:00:04",
              sequence: "4",
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 1,
              status: 400,
              request_token_count: 12,
              response_token_count: 0,
              target: "fixture-target",
            },
            {
              id: "record-three",
              timestamp: "2026-07-18 12:00:03",
              sequence: "3",
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 2,
              status: 200,
              request_token_count: 24,
              response_token_count: 96,
              target: "fixture-target",
            },
            {
              id: "record-two",
              timestamp: "2026-07-18 12:00:02",
              sequence: "2",
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 2,
              status: 200,
              request_token_count: 8,
              response_token_count: 4,
              target: "fixture-target",
            },
            {
              id: "record-one",
              timestamp: "2026-07-18 12:00:01",
              sequence: "1",
              method: "POST",
              path: "/v1/responses",
              endpoint: "/v1/responses",
              message_count: 1,
              status: null,
              request_token_count: null,
              response_token_count: null,
              target: "fixture-target",
            },
          ],
        };
      },
      cleanupSelectedGroups: (groupIds) => {
        groupIds.forEach((groupId) => deletedLogGroups.add(groupId));
        return { deleted: groupIds, deleted_count: groupIds.length };
      },
      exportLogs: () => Readable.from([Buffer.from("zip-fixture")]),
      getRecordDetail: (recordId) => {
        const reads = (detailReads.get(recordId) ?? 0) + 1;
        detailReads.set(recordId, reads);
        if (recordId === "record-one" || recordId === "record-two") {
          const pending = recordId === "record-one" && reads === 1;
          return {
            id: recordId,
            pending,
            request: {
              input: "hello",
              formatted: sessionTranscriptFixture(),
              nested: { deep: { deeper: { value: 1 } } },
            },
            response: pending
              ? null
              : { output: "done", nested: { deep: { deeper: { value: 2 } } } },
            request_meta: { method: "POST", endpoint: "/v1/responses" },
            response_meta: pending
              ? {}
              : {
                  status: 200,
                  request_token_count: 8,
                  response_token_count: 4,
                  first_byte_ms: 1_234,
                  duration_ms: 65_678,
                },
          };
        }
        const extra = {
          "record-three": {
            status: 200,
            input: "summarize the build log",
            output: "Build succeeded in 48 seconds.",
            request_token_count: 24,
            response_token_count: 96,
            first_byte_ms: 820,
            duration_ms: 3_412,
          },
          "record-four": {
            status: 400,
            input: "broken prompt",
            output: null,
            request_token_count: 12,
            response_token_count: 0,
            first_byte_ms: 95,
            duration_ms: 210,
          },
          "record-five": {
            status: 200,
            input: "translate to English",
            output: "Done.",
            request_token_count: 46,
            response_token_count: 212,
            first_byte_ms: 1_480,
            duration_ms: 9_032,
          },
        }[recordId];
        if (extra === undefined) {
          return undefined;
        }
        return {
          id: recordId,
          pending: false,
          request: { input: extra.input, nested: { stage: "chat" } },
          response:
            extra.output === null
              ? { error: { message: "Invalid request payload", code: "invalid_request_error" } }
              : { output: extra.output, usage: { tokens: extra.response_token_count } },
          request_meta: { method: "POST", endpoint: "/v1/responses" },
          response_meta: {
            status: extra.status,
            request_token_count: extra.request_token_count,
            response_token_count: extra.response_token_count,
            first_byte_ms: extra.first_byte_ms,
            duration_ms: extra.duration_ms,
          },
        };
      },
    },
    staticAssets: await loadAdminStaticAssets(),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath:
      process.env["CHROME_PATH"] ??
      (process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "/usr/bin/google-chrome"),
    headless: true,
    args: ["--no-sandbox"],
  });
}, 30_000);

beforeEach(async () => {
  pairs.splice(0, pairs.length, fixturePair());
  logQueries.splice(0);
  groupLogQueries.splice(0);
  useLargeLogFixture = false;
  useLargeGroupLogFixture = false;
  deletedLogGroups.clear();
  detailReads.clear();

  page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("llmProxyLanguage", "en");
  });
});

afterEach(async () => {
  await page.close();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

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

  it("keeps the selected default target enabled", async () => {
    await loadAdminPage();
    const card = page.locator('.proxy-card[data-index="0"]');
    await card.locator("[data-add-target]").click();
    let targets = card.locator(".target-card");
    await targets.nth(1).locator("[data-default-target]").check();

    // Changing the default target updates both target controls immediately.
    targets = card.locator(".target-card");
    await expectPage(targets.nth(1).locator("[data-default-target]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toHaveCount(0);
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).toBeChecked();

    // Adding another target collects the form and rerenders from the current default selection.
    await card.locator("[data-add-target]").click();
    targets = card.locator(".target-card");
    await expectPage(targets).toHaveCount(3);
    await expectPage(targets.nth(1).locator("[data-default-target]")).toBeChecked();
    await expectPage(targets.nth(1).locator("[data-target-enabled]")).toHaveCount(0);
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).toBeChecked();
    await targets.nth(0).locator("[data-target-enabled]").uncheck();
    await expectPage(targets.nth(0).locator("[data-target-enabled]")).not.toBeChecked();
    await expectPage(targets.nth(0)).toHaveClass(/is-disabled-target/);
    await expectPage(targets.nth(0)).toHaveCSS("background-color", "rgb(243, 244, 246)");
    await expectPage(targets.nth(1)).toHaveClass(/is-default-target/);
    await expectPage(targets.nth(1)).toHaveCSS("background-color", "rgb(237, 247, 240)");
    await expectPage(targets.nth(2)).toHaveClass(/is-enabled-target/);
    await expectPage(targets.nth(2)).toHaveCSS("background-color", "rgb(232, 241, 251)");
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
  });
});

describe("admin UI history page", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("searches only after the search button is clicked", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);

    await page.locator("#logSearch").fill("needle");
    await page.waitForTimeout(250);
    expect(logQueries).toEqual([]);

    await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/api/logs?q=")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(logQueries).toEqual([""]);

    logQueries.splice(0);
    const response = page.waitForResponse((candidate) => candidate.url().includes("q=needle"));
    await page.locator("#searchLogs").click();
    await response;
    expect(logQueries).toEqual(["needle"]);
    await expectPage(page.locator("#autoRefreshLogs")).toBeDisabled();
    await expectPage(page.locator(".log-model")).toHaveText("claude");

    const clearResponse = page.waitForResponse((candidate) => candidate.url().includes("q="));
    await page.locator("#logSearch").fill("");
    await page.locator("#searchLogs").click();
    await clearResponse;
    await expectPage(page.locator("#autoRefreshLogs")).toBeEnabled();
  });

  it("supports manual and automatic history refresh", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(logQueries).toEqual([""]);

    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    logQueries.splice(0);
    const automaticResponse = page.waitForResponse((response) =>
      response.url().includes("/api/logs?"),
    );
    const startedAt = Date.now();
    await autoRefresh.check();
    await automaticResponse;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(logQueries).toEqual([""]);
    await autoRefresh.uncheck();
  });

  it("refreshes a pending list item when its response finishes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    const pendingItem = page.locator('[data-log-id="record-one"]');
    await expectPage(pendingItem).toContainText("pending");

    detailReads.set("record-one", 1);
    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    const finishedDetail = page.waitForResponse((response) =>
      response.url().endsWith("/api/logs/record-one"),
    );
    await autoRefresh.check();
    await finishedDetail;

    await expectPage(pendingItem.locator(".request-tokens .log-metric-value")).toHaveText("8");
    await expectPage(pendingItem.locator(".response-tokens .log-metric-value")).toHaveText("4");
    await expectPage(pendingItem.locator(".log-status")).toHaveText("200");
    await expectPage(pendingItem).not.toContainText("pending");
    await autoRefresh.uncheck();

    const completedReads = detailReads.get("record-one");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(detailReads.get("record-one")).toBe(completedReads);
  });

  it("loads task records only when a group is expanded", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-item")).toHaveCount(0);
    expect(groupLogQueries).toEqual([]);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    expect(groupLogQueries).toEqual(["task-one:"]);
    const completedItem = page.locator('[data-log-id="record-two"]');
    await expectPage(completedItem.locator(".request-tokens .log-metric-value")).toHaveText("8");
    await expectPage(completedItem.locator(".response-tokens .log-metric-value")).toHaveText("4");
    await expectPage(
      page.locator('[data-log-id="record-one"] .messages .log-metric-value'),
    ).toHaveText("1");
  });

  it("loads 100 more records within an expanded task", async () => {
    useLargeGroupLogFixture = true;
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-one/logs?q=&limit=200&offset=0"),
      ),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(200);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toContainText("200/301");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("limit=100&offset=200")),
      page.locator('[data-load-more-records="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(300);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toContainText("300/301");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("limit=100&offset=300")),
      page.locator('[data-load-more-records="task-one"]').click(),
    ]);
    await expectPage(page.locator('[data-log-id^="record-"]')).toHaveCount(301);
    await expectPage(page.locator('[data-load-more-records="task-one"]')).toHaveCount(0);
  });

  it("loads and merges the next page of task groups", async () => {
    useLargeLogFixture = true;
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=0")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(100);
    await expectPage(page.locator("[data-load-more]")).toContainText("100/101");

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("offset=100")),
      page.locator("[data-load-more]").click(),
    ]);
    await expectPage(page.locator(".log-group")).toHaveCount(101);
    await expectPage(page.locator("[data-load-more]")).toHaveCount(0);
    await expectPage(page.locator('[data-group-id="task-101"]')).toHaveCount(1);
  });

  it("cleans selected task groups and refreshes the list", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator('[data-select-group="task-one"]').check();

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/logs/cleanup") && response.request().method() === "POST",
      ),
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#cleanupLogs").click(),
    ]);
    expect(deletedLogGroups).toEqual(new Set(["task-one"]));
    await expectPage(page.locator('[data-group-id="task-one"]')).toHaveCount(0);
    await expectPage(page.locator('[data-group-id="task-needle"]')).toHaveCount(1);
    await expectPage(page.locator("#toast")).toContainText("Logs cleaned: 1");
  });

  it("downloads the log ZIP archive", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportLogs").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("llm-proxy-logs.zip");
    const downloadPath = await download.path();
    expect(await readFile(downloadPath)).toEqual(Buffer.from("zip-fixture"));
    await expectPage(page.locator("#toast")).toContainText("Logs exported");
  });

  it("loads record detail and refreshes a pending response to finished", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-id="task-one"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/logs/record-one")),
      page.locator('[data-log-id="record-one"]').click(),
    ]);
    await expectPage(page.locator("#requestJson")).toContainText("hello");
    await expectPage(page.locator("#responseJson")).toContainText("null");
    await expectPage(page.locator("#responseTiming")).toBeHidden();
    expect(detailReads.get("record-one")).toBe(1);
    const formattedString = page.locator("#requestJson .json-str-detail");
    await expectPage(formattedString).toHaveJSProperty("open", false);
    await formattedString.locator("summary").click();
    await expectPage(formattedString).toHaveJSProperty("open", true);
    const requestJson = page.locator("#requestJson");
    const formattedBody = formattedString.locator(".json-str-body");
    const scrollPositions = {
      pane: await setScrollTop(requestJson, 40),
      body: await setScrollTop(formattedBody, 120),
    };
    expect(scrollPositions.pane).toBeGreaterThan(0);
    expect(scrollPositions.body).toBeGreaterThan(0);

    const autoRefresh = page.locator("#autoRefreshLogs");
    await autoRefresh.uncheck();
    const finishedDetail = page.waitForResponse((response) =>
      response.url().endsWith("/api/logs/record-one"),
    );
    await autoRefresh.check();
    await finishedDetail;
    await expectPage(page.locator("#responseJson")).toContainText("done");
    await expectPage(page.locator("#responseMeta")).toBeHidden();
    await expectPage(page.locator("#responseTiming")).toHaveText("First byte 00:01 · Total 01:06");
    await expectPage(formattedString).toHaveJSProperty("open", true);
    await expect.poll(() => scrollTop(requestJson)).toBe(scrollPositions.pane);
    await expect.poll(() => scrollTop(formattedBody)).toBe(scrollPositions.body);
    expect(detailReads.get("record-one")).toBe(2);
    await autoRefresh.uncheck();
  });

  it("expands nested JSON trees one level at a time", async () => {
    await openRecordDetail("record-two");
    const details = page.locator("#requestJson details[data-json-node-path]:not(.json-str-detail)");
    const formattedString = page.locator("#requestJson .json-str-detail");
    const expandButton = page.locator('[data-expand="request"]');
    await expectPage(details).toHaveCount(4);
    await expectPage(details.nth(2)).toHaveJSProperty("open", false);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    await expectPage(expandButton).toHaveAttribute("title", "Expand one level");

    await expandButton.click();
    await expectPage(details.nth(2)).toHaveJSProperty("open", true);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    // The expand button only walks JSON structure levels; formatted string blocks
    // stay collapsed until the user opens them manually.
    await expectPage(formattedString).toHaveJSProperty("open", false);

    await expandButton.click();
    await expectPage(details.nth(3)).toHaveJSProperty("open", true);
    await expectPage(expandButton).toHaveAttribute("title", "Collapse JSON");

    await expandButton.click();
    await expectPage(details.nth(0)).toHaveJSProperty("open", true);
    await expectPage(details.nth(1)).toHaveJSProperty("open", true);
    await expectPage(details.nth(2)).toHaveJSProperty("open", false);
    await expectPage(details.nth(3)).toHaveJSProperty("open", false);
    await expectPage(formattedString).toHaveJSProperty("open", false);
  });

  it("keeps JSON parent summaries sticky while scrolling", async () => {
    await openRecordDetail("record-two");
    const requestJson = page.locator("#requestJson");
    const root = requestJson.locator('details[data-json-depth="0"] > summary');
    const firstLevelParent = requestJson.locator('details[data-json-depth="1"] > summary').first();

    await expectPage(root).toHaveCSS("position", "sticky");
    await expectPage(firstLevelParent).toHaveCSS("position", "sticky");
    await expectPage(
      firstLevelParent.locator(".."),
      "first-level parent should be open",
    ).toHaveJSProperty("open", true);
    await requestJson.locator(".json-str-detail summary").click();

    const initialTop = (await requiredBox(root)).y;
    const scrollPosition = await setScrollTop(requestJson, 100);
    expect(scrollPosition).toBeGreaterThan(0);
    const paneBox = await requiredBox(requestJson);
    const rootBox = await requiredBox(root);
    const firstLevelBox = await requiredBox(firstLevelParent);

    expect(rootBox.y).toBeGreaterThanOrEqual(paneBox.y);
    expect(rootBox.y).toBeLessThanOrEqual(initialTop + 1);
    expect(firstLevelBox.y).toBeGreaterThan(rootBox.y);

    await root.click();
    await expectPage
      .poll(async () => await scrollTop(requestJson))
      .toBeLessThan(2, { timeout: 3000 });
    await expectPage(
      requestJson.locator('details[data-json-depth="0"]'),
      "jump must not toggle the node",
    ).toHaveJSProperty("open", true);

    const nestedNaturalTop = await requestJson.evaluate((container) => {
      const detail = container.querySelector('details[data-json-depth="1"]');
      let top = 0;
      let node: Element | null = detail;
      while (node && node !== container) {
        top += node.offsetTop;
        node = node.offsetParent;
      }
      return top;
    });
    await requestJson.evaluate((container) => {
      const detail = container.querySelector('details[data-json-depth="1"]');
      const spacer = document.createElement("div");
      spacer.style.height = "1500px";
      detail.appendChild(spacer);
    });
    await setScrollTop(requestJson, Math.max(1, nestedNaturalTop - 8));

    await firstLevelParent.click();
    await expectPage
      .poll(
        async () => Math.abs((await scrollTop(requestJson)) - (nestedNaturalTop - 18)),
        "stuck row in the transition band should jump, not toggle",
      )
      .toBeLessThan(3, { timeout: 3000 });
    await expectPage(firstLevelParent.locator(".."), "band click must not toggle").toHaveJSProperty(
      "open",
      true,
    );
  });

  it("wraps, formats, copies, and shows JSON metadata", async () => {
    await openRecordDetail("record-two");
    const requestJson = page.locator("#requestJson");
    await expectPage(requestJson).toHaveClass(/nowrap/);
    await page.locator('[data-wrap="request"]').click();
    await expectPage(requestJson).toHaveClass(/wrap/);

    await expectPage(requestJson.locator(".json-str-body")).toContainText("long-text-long-text");
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toHaveCount(0);
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toContainText("long-text-long-text");

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            Reflect.set(globalThis, "__copiedJson", text);
            return Promise.resolve();
          },
        },
      });
    });
    await page.locator('[data-copy="request"]').click();
    await expectPage(page.locator("#toast")).toContainText("Copied JSON");
    expect(
      await page.evaluate(() => {
        const value: unknown = Reflect.get(globalThis, "__copiedJson");
        return typeof value === "string" ? value : "";
      }),
    ).toContain('"input": "hello"');

    const metadata = page.locator("#requestMeta");
    await expectPage(metadata).toBeHidden();
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeVisible();
    await expectPage(metadata).toContainText("/v1/responses");
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeHidden();
  });

  it("drags the column and row splitters", async () => {
    await openRecordDetail("record-two");
    const logSplitter = page.locator("#logSplitter");
    const logBox = await requiredBox(logSplitter);
    await page.mouse.move(logBox.x + logBox.width / 2, logBox.y + logBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(logBox.x + 120, logBox.y + logBox.height / 2);
    await page.mouse.up();
    await expectPage(page.locator("#logs")).toHaveAttribute("style", /--sidebar-w: \d+(\.\d+)?px/);

    const rowSplitter = page.locator("#splitter");
    const rowBox = await requiredBox(rowSplitter);
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + 80);
    await page.mouse.up();
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--request-fr: \d+(\.\d+)?px/,
    );
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--response-fr: \d+(\.\d+)?px/,
    );
  });

  it("clips the auto refresh label instead of wrapping it when the sidebar narrows", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const span = page.locator(".auto-refresh span");
    const label = page.locator(".auto-refresh");
    const fullSpan = await requiredBox(span);
    const fullLabel = await requiredBox(label);
    await page.evaluate(
      'document.querySelector("#logs").style.setProperty("--sidebar-w", "260px")',
    );
    const clippedSpan = await requiredBox(span);
    expect(clippedSpan.height).toBeCloseTo(fullSpan.height, 0);
    expect(clippedSpan.width).toBeLessThan(fullSpan.width);
    expect((await requiredBox(label)).height).toBeCloseTo(fullLabel.height, 0);
  });
});

describe("admin UI visual regression", { timeout: UI_TEST_TIMEOUT_MS }, () => {
  it("matches the Chinese proxy page baseline", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 1278, height: 1215 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("#saveProxies")).toHaveText("保存配置");

    expect(await screenshotDifference("doc/ui_proxy_cn.png")).toBeLessThan(0.12);
  });

  it("matches the English proxy page baseline", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 1278, height: 1208 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator("#saveProxies")).toHaveText("Save config");

    expect(await screenshotDifference("doc/ui_proxy_en.png")).toBeLessThan(0.12);
  });

  it("matches the Chinese history page baseline", async () => {
    await page.setViewportSize({ width: 1384, height: 1212 });
    await openRecordDetail("record-two");
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator('[data-i18n="request"]')).toHaveText("请求");
    await page.locator("#requestJson .json-str-detail summary").click();
    await moveRowSplitterTo(875);

    expect(await screenshotDifference("doc/ui_logs_cn.png")).toBeLessThan(0.25);
  });

  it("matches the English history page baseline", async () => {
    await page.setViewportSize({ width: 1384, height: 1224 });
    await openRecordDetail("record-two");
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator('[data-i18n="request"]')).toHaveText("Request");
    await page.locator("#requestJson .json-str-detail summary").click();
    await moveRowSplitterTo(883);

    expect(await screenshotDifference("doc/ui_logs_en.png")).toBeLessThan(0.25);
  });

  it("renders and operates at the 760 px responsive breakpoint", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 760, height: 1000 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("header")).toHaveCSS("flex-direction", "column");
    await expectPage(page.locator(".proxy-head").first()).toHaveCSS(
      "grid-template-columns",
      "698px",
    );
    const mobileTargets = page.locator(".target-card");
    const firstMobileTarget = await requiredBox(mobileTargets.nth(0));
    const secondMobileTarget = await requiredBox(mobileTargets.nth(1));
    expect(secondMobileTarget.y).toBeGreaterThan(
      firstMobileTarget.y + firstMobileTarget.height / 2,
    );
    expect(
      screenshotContentRatio(await page.screenshot({ animations: "disabled" })),
    ).toBeGreaterThan(0.05);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await expectPage(page.locator(".log-list")).toHaveCSS("border-right-width", "0px");
    await expectPage(page.locator(".log-list")).toHaveCSS("border-bottom-width", "1px");
    const screenshot = PNG.sync.read(await page.screenshot({ animations: "disabled" }));
    expect({ width: screenshot.width, height: screenshot.height }).toEqual({
      width: 760,
      height: 1000,
    });
  });
});

function publicPair(pair: ProxyPair): PublicProxyPair {
  return { ...structuredClone(pair), actual_listen_port: null, running: pair.enabled };
}

async function setScrollTop(locator: Locator, value: number): Promise<number> {
  return locator.evaluate((element, nextValue) => {
    Reflect.set(element, "scrollTop", nextValue);
    const actual: unknown = Reflect.get(element, "scrollTop");
    return typeof actual === "number" ? actual : 0;
  }, value);
}

async function scrollTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const value: unknown = Reflect.get(element, "scrollTop");
    return typeof value === "number" ? value : 0;
  });
}

async function openRecordDetail(recordId: string): Promise<void> {
  await loadAdminPage();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/logs?")),
    page.locator('[data-tab="logs"]').click(),
  ]);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
    page.locator('[data-group-id="task-one"]').click(),
  ]);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/logs/${recordId}`)),
    page.locator(`[data-log-id="${recordId}"]`).click(),
  ]);
}

async function loadAdminPage(): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/api/pairs") && response.request().method() === "GET",
    ),
    page.goto(baseUrl, { waitUntil: "domcontentloaded" }),
  ]);
}

async function requiredBox(
  locator: Locator,
): Promise<NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Expected a visible element bounding box.");
  }
  return box;
}

function visualPairs(): PublicProxyPair[] {
  const target = (
    id: string,
    name: string,
    targetUrl: string,
    apiKey: string,
    mapping: string,
    enabled: boolean,
  ) => ({
    id,
    name,
    enabled,
    target_url: targetUrl,
    target_api_key: apiKey,
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: "logs",
    redact_logs: false,
    model_mappings: [
      {
        listen: mapping.split(" => ")[0] ?? mapping,
        upstream: mapping.split(" => ")[1] ?? mapping,
      },
    ],
  });
  return [
    {
      id: "visual-proxy-one",
      name: "New proxy",
      enabled: true,
      running: true,
      actual_listen_port: 12346,
      listen_host: "127.0.0.1",
      listen_port: 12346,
      access_log: false,
      default_target_id: "visual-hyperapi",
      targets: [
        target(
          "visual-hyperapi",
          "hyperapi",
          "https://hyperapi.cc/v1",
          "sk-...",
          "hyper-gpt-5.5 => gpt-5.5",
          true,
        ),
        target(
          "visual-lmstudio",
          "lmstudio",
          "http://127.0.0.1:12345",
          "sk-...",
          "qwen3.6-27b-mtp@q4_k_m",
          true,
        ),
        target(
          "visual-target",
          "Target",
          "https://api2.aigcbest.top/v1",
          "sk-abcdefghijklmnopqrstuvwxyz-0123456789-abcdef",
          "gpt-4o-mini",
          true,
        ),
      ],
    },
    {
      id: "visual-proxy-two",
      name: "新代理",
      enabled: false,
      running: false,
      actual_listen_port: null,
      listen_host: "127.0.0.1",
      listen_port: 1234,
      access_log: false,
      default_target_id: "visual-default",
      targets: [
        target(
          "visual-default",
          "Target",
          "http://127.0.0.1:1235",
          "sk-...",
          "A-gpt-5.5 => gpt-5.5",
          true,
        ),
      ],
    },
  ];
}

async function screenshotDifference(baselinePath: string): Promise<number> {
  if (process.env["REGEN_BASELINES"] === "1") {
    await writeFile(baselinePath, await page.screenshot({ animations: "disabled" }));
    console.log(`[regen] wrote ${baselinePath}`);
    return 0;
  }
  const [actualBuffer, baselineBuffer] = await Promise.all([
    page.screenshot({ animations: "disabled" }),
    readFile(baselinePath),
  ]);
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  expect({ width: actual.width, height: actual.height }).toEqual({
    width: baseline.width,
    height: baseline.height,
  });
  const differentPixels = pixelmatch(
    actual.data,
    baseline.data,
    undefined,
    baseline.width,
    baseline.height,
    { threshold: 0.2 },
  );
  return differentPixels / (baseline.width * baseline.height);
}

async function moveRowSplitterTo(y: number): Promise<void> {
  const splitter = page.locator("#splitter");
  const box = await requiredBox(splitter);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.up();
}

function screenshotContentRatio(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
  let nonWhitePixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      (image.data[offset] ?? 255) < 250 ||
      (image.data[offset + 1] ?? 255) < 250 ||
      (image.data[offset + 2] ?? 255) < 250
    ) {
      nonWhitePixels += 1;
    }
  }
  return nonWhitePixels / (image.width * image.height);
}
