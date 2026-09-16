import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chromium,
  expect as expectPage,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
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
let useSummarizedLogFixture = false;
const deletedLogGroups = new Set<string>();
const detailReads = new Map<string, number>();
const UI_TEST_TIMEOUT_MS = 30_000;
const targetCheckCalls: {
  targetUrl: string;
  model: string;
  apiType?: "chat" | "responses" | "anthropic";
  apiKey?: string;
}[] = [];
let targetCheckOutcome: {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
  detail?: string;
} = { ok: true, status: 200, durationMs: 5 };

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
        model_prices: [],
      },
    ],
  };
}

function deploymentPromptFixture(): string {
  return [
    "Summarize the deployment log below and flag anything unusual.",
    "",
    "Deployment run #417 \u2014 target: prod-cluster-a",
    "Started:   2026-07-18 11:58:40",
    "Stage build   : ok (18s) \u2014 212 artifacts, 3 workers",
    "Stage package : ok (9s) \u2014 image 2.4 GB",
    "Stage migrate : ok (3s) \u2014 3 replicas, zero downtime",
    "Stage health  : ok (2s) \u2014 p99 latency 41 ms",
    "Stage verify  : ok (6s) \u2014 24/24 checks passed",
    "Stage canary  : ok (12s) \u2014 error rate 0.02%",
    "Verification:",
    "  - login flow     : ok",
    "  - search index   : ok",
    "  - billing webhook: ok",
    "  - cache warmup   : ok",
    "  - feature flags  : ok",
    "  - rate limiter   : ok",
    "  - replica 4321a  : healthy, 0 restarts",
    "  - replica 4321b  : healthy, 0 restarts",
    "  - replica 4321c  : healthy, 0 restarts",
    "Metrics before: cpu 31%, mem 42%, net 1.2 Gb/s",
    "Metrics after : cpu 28%, mem 39%, net 1.1 Gb/s",
    "Alerts during window: 0",
    "Slowest endpoint: /v1/responses (p99 412 ms)",
    "Artifacts: 212 built, 210 promoted, 2 skipped",
    "Image sha256    : 9f2c1a44d7e0b8c36f52a91e0d44b7c8 (matches build #417)",
    "Config checksum : ok (14 keys unchanged)",
    "Rollback plan retained until the next run",
    "Operator note: no manual intervention needed",
    "Finished:   2026-07-18 12:00:02, total 1m 22s",
  ].join("\n");
}

function fixtureRequestPricing(status: "pending" | "priced" | "unpriced" = "priced") {
  return {
    pricing_status: status,
    pricing_reason: status === "unpriced" ? "missing_usage" : null,
    billing_model: "gpt-5",
    cost_nano_cny: status === "priced" ? "41125000" : null,
    pricing_snapshot: {
      model_pattern: "gpt-5",
      target_name: "Fixture Target",
      input_per_million: "5",
      output_per_million: "30",
      cache_read_per_million: "0.5",
      cache_write_per_million: "6.25",
    },
    usage:
      status === "priced"
        ? {
            source: "responses",
            inputUncachedTokens: "1500",
            outputTokens: "1000",
            cacheReadTokens: "1000",
            cacheWriteTokens: "500",
          }
        : null,
  };
}

beforeAll(async () => {
  server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    targetCheckService: {
      checkTarget: (request) => {
        targetCheckCalls.push({ ...request });
        return Promise.resolve({ ...targetCheckOutcome });
      },
    },
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
              last_activity_at: `2026-07-18 12:${String(index % 60).padStart(2, "0")}:05`,
              model: "gpt-5",
              request_count: 1,
              target: `target-${index + 1}`,
            }))
          : [
              {
                id: "task-one",
                started_at: "2026-07-18 12:00:00",
                last_activity_at: "2026-07-18 12:00:05",
                model: "gpt-5",
                request_count: 5,
                target: "fixture-target",
                cost: {
                  currency: "CNY" as const,
                  known_amount: "0.042750000",
                  priced_request_count: 3,
                  unpriced_request_count: 1,
                  pending_request_count: 1,
                },
                decode_speed_tps: 2.47,
              },
              {
                id: "task-needle",
                started_at: "2026-07-18 11:30:00",
                last_activity_at: "2026-07-18 11:30:05",
                model: "claude",
                request_count: 1,
                target: "fixture-target",
                decode_speed_tps: 1250,
              },
              {
                id: "task-three",
                started_at: "2026-07-18 10:42:00",
                last_activity_at: "2026-07-18 10:44:30",
                model: "qwen3.6-27b",
                request_count: 3,
                target: "fixture-target",
              },
              {
                id: "task-four",
                started_at: "2026-07-18 09:15:00",
                last_activity_at: "2026-07-18 09:20:10",
                model: "gpt-4o-mini",
                request_count: 12,
                target: "fixture-target",
              },
            ];
        const groups = sourceGroups.filter(
          (group) =>
            !deletedLogGroups.has(group.id) &&
            [group.id, group.started_at, group.last_activity_at, group.model, group.target]
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
        if (groupId === "task-needle") {
          return {
            id: groupId,
            total: 0,
            limit,
            offset,
            next_offset: 0,
            has_more: false,
            logs: [],
          };
        }
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
              has_summary: false,
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
              has_summary: useSummarizedLogFixture,
              cost: { currency: "CNY", amount: "5", status: "priced", reason: null },
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
              has_summary: false,
              cost: { currency: "CNY", amount: null, status: "unpriced", reason: "missing_usage" },
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
              decode_speed_tps: 30.07,
              target: "fixture-target",
              has_summary: false,
              cost: { currency: "CNY", amount: "0.041125", status: "priced", reason: null },
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
              has_summary: false,
              cost: { currency: "CNY", amount: "0.00001", status: "priced", reason: null },
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
              has_summary: false,
              cost: { currency: "CNY", amount: null, status: "pending", reason: null },
            },
          ],
        };
      },
      getGroupPricing: (groupId) => {
        if (groupId !== "task-one") return undefined;
        return {
          target: "fixture-target",
          active_request_ms: 25321.4,
          total_request_ms: 5000,
          cost_nano_cny: "42750000",
          priced_request_count: 3,
          unpriced_request_count: 1,
          pending_request_count: 1,
          breakdown: {
            input_uncached: { tokens: "1500", amount: "0.0075" },
            output: { tokens: "1250", amount: "0.0375" },
            cache_read: { tokens: "1000", amount: "0.0005" },
            cache_write: { tokens: "500", amount: "0.003125" },
          },
          unpriced_reasons: { missing_usage: 1 },
          groups: [
            {
              billing_model: "gpt-5",
              request_count: 3,
              cost_nano_cny: "42750000",
              price: {
                input_per_million: "5",
                output_per_million: "30",
                cache_read_per_million: "0.5",
                cache_write_per_million: "6.25",
              },
              breakdown: {
                input_uncached: { tokens: "1500", amount: "0.0075" },
                output: { tokens: "1250", amount: "0.0375" },
                cache_read: { tokens: "1000", amount: "0.0005" },
                cache_write: { tokens: "500", amount: "0.003125" },
              },
            },
          ],
        };
      },
      getGroupTokenSeries: (groupId) => {
        if (groupId !== "task-one") return undefined;
        return [
          { sequence: 1, request_tokens: 10, response_tokens: 4, total_tokens: 14 },
          { sequence: 2, request_tokens: 8, response_tokens: 4, total_tokens: 12 },
          { sequence: 3, request_tokens: 24, response_tokens: 96, total_tokens: 120 },
          { sequence: 4, request_tokens: 12, response_tokens: 0, total_tokens: 12 },
          { sequence: 5, request_tokens: 46, response_tokens: 212, total_tokens: 258 },
        ];
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
              model: "gpt-5",
              input: deploymentPromptFixture(),
              stream: true,
              temperature: 0.3,
              max_output_tokens: 1024,
              metadata: {
                deployment: {
                  run_id: 417,
                  cluster: "prod-cluster-a",
                  window: {
                    start: "2026-07-18T11:58:40+08:00",
                    end: "2026-07-18T12:00:02+08:00",
                  },
                },
              },
            },
            response: pending
              ? null
              : {
                  id: "resp_9f1e0b6a2c4d4e7f8a1b2c3d4e5f6071",
                  object: "response",
                  created_at: 1784347202,
                  model: "gpt-5",
                  model_version: "gpt-5-2025-08-07",
                  status: "completed",
                  content_policy: null,
                  error: null,
                  incomplete_details: null,
                  instructions: null,
                  metadata: {},
                  output: [
                    {
                      id: "msg_4c7a9e2b8f1d4650b3a1c9e0d7f82436",
                      type: "message",
                      status: "completed",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: "The deployment completed successfully in six stages. build took the longest at 18 seconds, followed by canary (12s) and verify (6s). No errors were reported and the service is running on port 4321.",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  parallel_tool_calls: true,
                  temperature: 0.3,
                  tool_choice: "auto",
                  tools: [],
                  truncation: "disabled",
                  usage: {
                    input_tokens: 8,
                    input_tokens_details: { cached_tokens: 4 },
                    output_tokens: 4,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 12,
                  },
                },
            request_meta: { method: "POST", endpoint: "/v1/responses" },
            response_meta: pending
              ? {}
              : {
                  status: 200,
                  request_token_count: 8,
                  response_token_count: 4,
                  cached_token_count: 4,
                  first_token_ms: 2_400,
                  duration_ms: 65_678,
                },
            pricing: fixtureRequestPricing(pending ? "pending" : "priced"),
          };
        }
        const extra = {
          "record-three": {
            status: 200,
            input: "summarize the build log",
            output: "Build succeeded in 48 seconds.",
            request_token_count: 24,
            response_token_count: 96,
            first_token_ms: 1_200,
            duration_ms: 3_412,
          },
          "record-four": {
            status: 400,
            input: "broken prompt",
            output: null,
            request_token_count: 12,
            response_token_count: 0,
            first_token_ms: 110,
            duration_ms: 210,
          },
          "record-five": {
            status: 200,
            input: "translate to English",
            output: "Done.",
            request_token_count: 46,
            response_token_count: 212,
            first_token_ms: 2_600,
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
            first_token_ms: extra.first_token_ms,
            duration_ms: extra.duration_ms,
          },
          pricing: fixtureRequestPricing(recordId === "record-four" ? "unpriced" : "priced"),
        };
      },
    },
    staticAssets: await loadAdminStaticAssets(),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  const systemChrome =
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome";
  // Prefer the Playwright-bundled Chromium (deterministic across CI runners);
  // CHROME_PATH still wins, and the OS Chrome remains a fallback when the
  // bundled browser was not downloaded during install.
  const bundledChrome = chromium.executablePath();
  browser = await chromium.launch({
    executablePath:
      process.env["CHROME_PATH"] ?? (existsSync(bundledChrome) ? bundledChrome : systemChrome),
    headless: true,
    args: ["--no-sandbox"],
  });
}, 60_000);

beforeEach(async () => {
  pairs.splice(0, pairs.length, fixturePair());
  logQueries.splice(0);
  groupLogQueries.splice(0);
  useLargeLogFixture = false;
  useLargeGroupLogFixture = false;
  useSummarizedLogFixture = false;
  deletedLogGroups.clear();
  detailReads.clear();
  targetCheckCalls.length = 0;
  targetCheckOutcome = { ok: true, status: 200, durationMs: 5 };

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
    await expectPage(targets.nth(1)).toHaveCSS("background-color", "rgb(176, 211, 194)");
    await expectPage(targets.nth(2)).toHaveClass(/is-enabled-target/);
    await expectPage(targets.nth(2)).toHaveCSS("background-color", "rgb(172, 194, 219)");
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
    await expectPage(dialog.locator("#targetCheckModel")).toHaveAttribute(
      "list",
      "targetCheckModelOptions",
    );
    await expectPage(page.locator("#targetCheckModelOptions option")).toHaveCount(7);
    await dialog.locator("#targetCheckApiType").selectOption("anthropic");
    await dialog.locator("#targetCheckModel").fill("claude-opus-4-6");
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
    targetCheckOutcome = {
      ok: true,
      status: 401,
      durationMs: 12,
      detail: '{"error":{"message":"invalid api key"}}',
    };
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
    targetCheckOutcome = { ok: false, durationMs: 8, error: "connect ECONNREFUSED 127.0.0.1:9" };
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
    await expectPage(page.locator(".log-model")).toHaveCount(1);
    await expectPage(page.locator(".log-model")).toHaveText("claude");

    const clearResponse = page.waitForResponse((candidate) => candidate.url().includes("q="));
    await page.locator("#logSearch").fill("");
    await page.locator("#searchLogs").click();
    await clearResponse;
    await expectPage(page.locator("#autoRefreshLogs")).toBeEnabled();
  });

  it("searches when Enter is pressed in the search box", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    logQueries.splice(0);
    await expectPage(page.locator(".log-model")).toHaveCount(4, {
      timeout: UI_TEST_TIMEOUT_MS,
    });

    const response = page.waitForResponse((candidate) => candidate.url().includes("q=needle"));
    await page.locator("#logSearch").fill("needle");
    await page.locator("#logSearch").press("Enter");
    await response;
    expect(logQueries).toEqual(["needle"]);
    await expectPage(page.locator("#autoRefreshLogs")).toBeDisabled();
    await expectPage(page.locator(".log-model")).toHaveCount(1);
    await expectPage(page.locator(".log-model")).toHaveText("claude");
  });

  it("shows a progress bar below the search box while a search is running", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const progress = page.locator("#logSearchProgress");
    await expectPage(progress).toBeHidden();

    let releaseSearch: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    await page.route("**/api/logs**", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      await release;
      await route.fulfill({ response });
    });
    await page.locator("#searchLogs").click();
    await expectPage(progress).toBeVisible();
    releaseSearch?.();
    await expectPage(progress).toBeHidden();
    await page.unroute("**/api/logs**");
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
      page.locator('[data-group-id="task-one"] .log-target').click(),
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
    await expectPage(pendingItem.locator(".cost .log-metric-value")).toHaveText("$0.0411");
    await expectPage(pendingItem.locator(".log-status")).toHaveCount(0);
    await expectPage(pendingItem).not.toContainText("pending");
    await autoRefresh.uncheck();

    const completedReads = detailReads.get("record-one");
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator("#refreshLogs").click(),
    ]);
    expect(detailReads.get("record-one")).toBe(completedReads);
  });

  it("refreshes a visible task total when only its pricing summary changes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { groups: { id: string; cost?: unknown }[] };
      data.groups = data.groups.map((group) =>
        group.id === "task-one"
          ? {
              ...group,
              cost: {
                currency: "CNY",
                known_amount: "5",
                priced_request_count: 5,
                unpriced_request_count: 0,
                pending_request_count: 0,
              },
            }
          : group,
      );
      await route.fulfill({ response, json: data });
    });
    await page.locator("#refreshLogs").click();
    await expectPage(page.locator('[data-group-detail="task-one"]')).toHaveText("ⓘ");
    await page.unroute("**/api/logs?**");
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
      page.locator('[data-group-id="task-one"] .log-target').click(),
    ]);
    expect(groupLogQueries).toEqual(["task-one:"]);
    const completedItem = page.locator('[data-log-id="record-two"]');
    await expectPage(completedItem.locator(".request-tokens .log-metric-value")).toHaveText("8");
    await expectPage(completedItem.locator(".response-tokens .log-metric-value")).toHaveText("4");
    await expectPage(
      page.locator('[data-log-id="record-one"] .messages .log-metric-value'),
    ).toHaveText("1");
  });

  it("formats pricing precisely and keeps the two-level history layout compact", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);

    await expect(
      page.evaluate(
        (amounts) => {
          const formatter = (
            window as unknown as Window & {
              formatCurrencyAmount: (amount: string | null) => string;
            }
          ).formatCurrencyAmount;
          return amounts.map((amount) => formatter(amount));
        },
        ["5", "0.03", "0.041125", "0.042750", "0.00001", "0", null],
      ),
    ).resolves.toEqual(["$5", "$0.03", "$0.0411", "$0.0428", "< $0.0001", "$0", "—"]);

    const group = page.locator(".log-group").first();
    const summary = group.locator(".log-group-summary");
    await expectPage(summary.locator(".log-group-time")).toHaveCount(1);
    await expectPage(summary.locator(".log-group-fact-line")).toHaveCount(2);
    await expectPage(summary.locator(".log-group-fact-line").first()).toContainText("gpt-5");
    await expectPage(summary.locator(".log-group-fact-line").first()).toContainText("5 requests");
    await expectPage(summary.locator(".log-group-cost")).toHaveText("$0.0428");
    await expectPage(summary.locator(".log-group-decode-speed")).toHaveText("2.5t/s");
    await expectPage(summary.locator(".log-target")).toHaveText("fixture-target");
    await expectPage(group.locator("button button")).toHaveCount(0);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      summary.locator(".log-target").click(),
    ]);
    const priced = page.locator('[data-log-id="record-three"]');
    await expectPage(priced.locator(".decode-speed .log-metric-label")).toHaveText("Speed");
    await expectPage(priced.locator(".decode-speed .log-metric-value")).toHaveText("30.1t/s");
    expect(await priced.locator(".log-item-metrics .log-metric-label").allTextContents()).toEqual([
      "messages",
      "Request",
      "Response",
      "Speed",
      "Cost",
    ]);
    await expectPage(page.locator('[data-log-id="record-two"] .decode-speed')).toHaveCount(0);
    await expectPage(page.locator('[data-log-id="record-one"] .decode-speed')).toHaveCount(0);
    await expectPage(priced.locator(".cost .log-metric-label")).toHaveText("Cost");
    await expectPage(priced.locator(".cost .log-metric-value")).toHaveText("$0.0411");
    await expectPage(page.locator('[data-log-id="record-two"] .cost .log-metric-value')).toHaveText(
      "< $0.0001",
    );
    await expectPage(page.locator('[data-log-id="record-one"] .cost .log-metric-value')).toHaveText(
      "Calculating…",
    );
    await expectPage(
      page.locator('[data-log-id="record-four"] .cost .log-metric-value'),
    ).toHaveText("—");

    await group.locator(".log-group-head").press("Enter");
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await group.locator(".log-group-head").press(" ");
    await expectPage(group.locator(".log-group-body")).toHaveCount(1);
  });

  it("marks records with a generated intelligent summary with a star", async () => {
    useSummarizedLogFixture = true;
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-id="task-one"] .log-target').click(),
    ]);
    const starred = page.locator('[data-log-id="record-five"] .log-summary-star');
    await expectPage(starred).toHaveCount(1);
    await expectPage(starred).toHaveText("★");
    await expectPage(page.locator(".log-summary-star")).toHaveCount(1);
  });

  it("opens task and request pricing details without changing task selection or expansion", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const group = page.locator(".log-group").first();
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await expectPage(group.locator('[data-select-group="task-one"]')).not.toBeChecked();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/log-groups/task-one/pricing"),
      ),
      group.locator("[data-group-detail]").press("Enter"),
    ]);
    const panel = page.locator("#pricingPanel");
    await expectPage(panel).toBeVisible();
    await expectPage(panel).toContainText("Task details");
    await expectPage(panel).toContainText("$0.0428");
    await expectPage(panel).toContainText("fixture-target");
    await expectPage(panel).toContainText("Task time");
    await expectPage(panel).toContainText("00:05");
    await expectPage(panel).toContainText("Request time");
    await expectPage(panel).toContainText("00:25");
    // Task time renders directly above Request time.
    await expectPage(panel.locator("p.pricing-target")).toHaveText([
      "Target: fixture-target",
      "Task time: 00:05",
      "Request time: 00:25",
    ]);
    await expectPage(panel).toContainText("gpt-5 · 3 requests · $0.0428");
    const groupDetails = panel.locator("details");
    await expectPage(groupDetails).toBeVisible();
    await expectPage(groupDetails.locator("summary")).toContainText("gpt-5 · 3 requests · $0.0428");
    const groupBreakdown = groupDetails.locator(".task-breakdown");
    await expectPage(groupBreakdown.locator("thead")).toContainText("Price ($/M tokens)");
    await expectPage(groupBreakdown.locator("thead")).toContainText("Billed tokens");
    const taskBreakdown = panel.locator(".task-breakdown").first();
    await expectPage(taskBreakdown.locator("thead")).toContainText("Share");
    await expectPage(taskBreakdown.locator("tbody tr").first()).toContainText("17.54%");
    await expectPage(taskBreakdown.locator("tfoot")).toContainText("Total");
    await expectPage(taskBreakdown.locator("tfoot")).toContainText("4,250");
    await expectPage(taskBreakdown.locator("tfoot")).not.toContainText("%");
    await expectPage(taskBreakdown.locator("tbody tr").nth(1)).toContainText("1,250");
    // Token trend line chart: one dot per request with a known token total.
    await page.waitForResponse((response) =>
      response.url().endsWith("/api/log-groups/task-one/pricing/tokens"),
    );
    await expectPage(panel).toContainText("Token trend");
    const tokenChart = panel.locator(".token-chart svg");
    await expectPage(tokenChart).toBeVisible();
    await expectPage(tokenChart.locator(".token-chart-dot")).toHaveCount(5);
    await expectPage(tokenChart.locator(".token-chart-dot").first().locator("title")).toHaveText(
      "Request #1: 14 tokens",
    );
    await expectPage(tokenChart.locator(".token-chart-dot").last().locator("title")).toHaveText(
      "Request #5: 258 tokens",
    );
    await panel.screenshot({ path: "test-results/task-pricing-panel.png" });
    await expectPage(group.locator(".log-group-body")).toHaveCount(0);
    await expectPage(group.locator('[data-select-group="task-one"]')).not.toBeChecked();
    await panel.locator("[data-close-pricing]").click();
    await expectPage(panel).toBeHidden();

    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      group.locator(".log-target").click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/logs/record-two")),
      page.locator('[data-log-id="record-two"]').click(),
    ]);
    const requestPricing = page.locator("#responsePricing");
    const pricingButton = page.locator('[data-pricing="response"]');
    await expectPage(pricingButton).toBeEnabled();
    await expectPage(requestPricing).toBeHidden();
    await pricingButton.click();
    await expectPage(requestPricing).toBeVisible();
    await expectPage(requestPricing).toContainText("Cost estimate");
    await expectPage(requestPricing).toContainText("$0.0411");
    await expectPage(requestPricing).toContainText("Billing model");
    await expectPage(requestPricing).toContainText("gpt-5");
    await expectPage(requestPricing).toContainText("1,500");
    await expectPage(requestPricing.locator(".pricing-table thead")).toContainText("Share");
    await expectPage(requestPricing.locator(".pricing-table tbody tr").first()).toContainText(
      "18.24%",
    );
    await expectPage(requestPricing.locator(".pricing-table tfoot")).toContainText("Total");
    await expectPage(requestPricing.locator(".pricing-table tfoot")).toContainText("4,000");
    await expectPage(requestPricing.locator(".pricing-table tfoot")).not.toContainText("%");
    await pricingButton.click();
    await expectPage(requestPricing).toBeHidden();
  });

  it("expands search previews without a second request and replaces them on query changes", async () => {
    await page.route("**/api/logs?**", async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as { groups: { id: string }[] };
      const query = new URL(route.request().url()).searchParams.get("q");
      if (query) {
        data.groups = data.groups.map((group: { id: string }) => ({
          ...group,
          preview: {
            id: group.id,
            total: 21,
            limit: 20,
            offset: 0,
            next_offset: 20,
            has_more: true,
            logs: [
              {
                id: `preview-${query}`,
                sequence: "21",
                timestamp: "2026-07-18 12:00:00",
                method: "POST",
                path: "/v1/responses",
                status: 200,
              },
            ],
          },
        }));
      }
      await route.fulfill({ response, json: data });
    });
    await loadAdminPage();
    await page.locator('[data-tab="logs"]').click();
    await expectPage(page.locator('[data-group-id="task-one"]')).toBeVisible();
    await page.locator("#logSearch").fill("task");
    await page.locator("#searchLogs").click();
    await expectPage(page.locator("#logSearchProgress")).toBeHidden();
    await page.locator('[data-group-id="task-one"] .log-target').click();
    await expectPage(page.locator('[data-log-id="preview-task"]')).toBeVisible();
    expect(groupLogQueries).toEqual([]);
    await page.locator("#logSearch").fill("task-one");
    await page.locator("#searchLogs").click();
    await expectPage(page.locator('[data-log-id="preview-task-one"]')).toBeVisible();
    await expectPage(page.locator('[data-log-id="preview-task"]')).toHaveCount(0);
    expect(groupLogQueries).toEqual([]);
    const more = page.waitForRequest((request) => request.url().includes("limit=100&offset=20"));
    await page.locator('[data-load-more-records="task-one"]').click();
    await more;
  });

  it("refetches an expanded group's records when the search query changes", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/log-groups/task-one/logs")),
      page.locator('[data-group-id="task-one"] .log-target').click(),
    ]);
    expect(groupLogQueries).toEqual(["task-one:"]);

    // The term matches every fixture group, so the expanded group remains in
    // the list and must be refetched under the new query.
    const refetch = page.waitForResponse((response) =>
      response.url().includes("/api/log-groups/task-one/logs?q=task"),
    );
    await page.locator("#logSearch").fill("task");
    await page.locator("#searchLogs").click();
    await refetch;
    expect(groupLogQueries).toEqual(["task-one:", "task-one:task"]);
  });

  it("shows a placeholder when an expanded group has no matching records", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    await page.locator("#logSearch").fill("task-needle");
    const searchResponse = page.waitForResponse((response) =>
      response.url().includes("q=task-needle"),
    );
    await page.locator("#searchLogs").click();
    await searchResponse;
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/log-groups/task-needle/logs"),
      ),
      page.locator('[data-group-id="task-needle"] .log-target').click(),
    ]);
    const placeholder = page.locator(".log-group-empty");
    await expectPage(placeholder).toHaveCount(1);
    await expectPage(placeholder).toHaveText("No matching records in this group");
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
      page.locator('[data-group-id="task-one"] .log-target').click(),
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
      page.locator('[data-group-id="task-one"] .log-target').click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/logs/record-one")),
      page.locator('[data-log-id="record-one"]').click(),
    ]);
    await expectPage(page.locator("#requestJson")).toContainText("gpt-5");
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
    await expectPage(page.locator("#responseJson")).toContainText("completed");
    await expectPage(page.locator("#responseMeta")).toBeHidden();
    await expectPage(page.locator("#responseTiming")).toHaveText(
      "First token 00:02 · Total 01:06 · Prefill 1.7 tok/s · Decode 0.1 tok/s",
    );
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
    await expectPage.poll(async () => await scrollTop(requestJson)).toBeLessThan(2);
    await expectPage(
      requestJson.locator('details[data-json-depth="0"]'),
      "jump must not toggle the node",
    ).toHaveJSProperty("open", true);

    const nestedNaturalTop = await requestJson.evaluate((container) => {
      const detail = container.querySelector<HTMLElement>('details[data-json-depth="1"]');
      if (detail === null) throw new Error("Expected nested JSON detail");
      let top = 0;
      let node: HTMLElement | null = detail;
      while (node !== null && node !== container) {
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      return top;
    });
    await requestJson.evaluate((container) => {
      const detail = container.querySelector<HTMLElement>('details[data-json-depth="1"]');
      if (detail === null) throw new Error("Expected nested JSON detail");
      const spacer = container.ownerDocument.createElement("div");
      spacer.style.height = "1500px";
      detail.appendChild(spacer);
    });
    await setScrollTop(requestJson, Math.max(1, nestedNaturalTop - 8));

    await firstLevelParent.click();
    await expectPage
      .poll(async () => Math.abs((await scrollTop(requestJson)) - (nestedNaturalTop - 18)))
      .toBeLessThan(3);
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

    await expectPage(requestJson.locator(".json-str-body")).toContainText("Stage canary");
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toHaveCount(0);
    await page.locator('[data-format="request"]').click();
    await expectPage(requestJson.locator(".json-str-body")).toContainText("Stage canary");

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
    ).toContain('"model": "gpt-5"');

    const metadata = page.locator("#requestMeta");
    await expectPage(metadata).toBeHidden();
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeVisible();
    await expectPage(metadata).toContainText("/v1/responses");
    await page.locator('[data-meta="request"]').click();
    await expectPage(metadata).toBeHidden();
  });

  it("drags the column and row splitters without rebuilding the JSON panes", async () => {
    await openRecordDetail("record-two");
    await page.evaluate(`
      window.__jsonPaneMutationCount = 0;
      const observer = new MutationObserver((records) => {
        window.__jsonPaneMutationCount += records.length;
      });
      observer.observe(document.querySelector("#requestJson"), { childList: true, subtree: true });
      observer.observe(document.querySelector("#responseJson"), { childList: true, subtree: true });
    `);
    const logSplitter = page.locator("#logSplitter");
    const logBox = await requiredBox(logSplitter);
    await page.mouse.move(logBox.x + logBox.width / 2, logBox.y + logBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(logBox.x + 120, logBox.y + logBox.height / 2);
    await expectPage(logSplitter).toHaveClass(/dragging/);
    await expectPage(logSplitter).toHaveAttribute("style", /--splitter-preview-x:/);
    await expectPage(page.locator("#logs")).not.toHaveAttribute("style", /--sidebar-w:/);
    await page.mouse.up();
    await expectPage(page.locator("#logs")).toHaveAttribute("style", /--sidebar-w: \d+(\.\d+)?px/);

    const rowSplitter = page.locator("#splitter");
    const rowBox = await requiredBox(rowSplitter);
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + 80);
    await expectPage(rowSplitter).toHaveClass(/dragging/);
    await expectPage(rowSplitter).toHaveAttribute("style", /--splitter-preview-y:/);
    await expectPage(page.locator("#detail")).not.toHaveAttribute("style", /--request-fr:/);
    await page.mouse.up();
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--request-fr: \d+(\.\d+)?px/,
    );
    await expectPage(page.locator("#detail")).toHaveAttribute(
      "style",
      /--response-fr: \d+(\.\d+)?px/,
    );
    expect(await page.evaluate("window.__jsonPaneMutationCount")).toBe(0);
  });

  it("keeps the log toolbar on one row, clipping auto refresh when narrow", async () => {
    await loadAdminPage();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/logs?")),
      page.locator('[data-tab="logs"]').click(),
    ]);
    const span = page.locator(".auto-refresh span");
    const order = await page
      .locator(".log-actions")
      .evaluate((actions) =>
        [...actions.children].map((el) => (el as HTMLElement).id || el.className),
      );
    expect(order).toEqual([
      "selectAllLogs",
      "cleanupLogs",
      "exportLogs",
      "summaryModelSettings",
      "refreshLogs",
      "auto-refresh",
    ]);

    const row = page.locator(".log-actions");
    const refresh = page.locator("#refreshLogs");
    const measure = async () => {
      const box = await requiredBox(span);
      const actions = await requiredBox(row);
      const refreshBox = await requiredBox(refresh);
      return { box, actions, refreshBox };
    };
    const full = await measure();
    await page.evaluate(
      'document.querySelector("#logs").style.setProperty("--sidebar-w", "260px")',
    );
    const narrow = await measure();
    expect(narrow.actions.height).toBeCloseTo(full.actions.height, 0);
    expect(narrow.box.y).toBeCloseTo(full.box.y, 0);
    expect(narrow.box.width).toBeCloseTo(full.box.width, 0);
    expect(narrow.box.height).toBeLessThanOrEqual(20);
    expect(narrow.box.x).toBeGreaterThanOrEqual(narrow.refreshBox.x + narrow.refreshBox.width - 1);
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

  it("matches the Chinese statistics page baseline", async () => {
    await loadStatisticsBaseline("zh");
    expect(await screenshotDifference("doc/ui_stats_cn.png")).toBeLessThan(0.25);
  });

  it("matches the English statistics page baseline", async () => {
    await loadStatisticsBaseline("en");
    expect(await screenshotDifference("doc/ui_stats_en.png")).toBeLessThan(0.25);
  });

  it("renders and operates at the 760 px responsive breakpoint", async () => {
    pairs.splice(0, pairs.length, ...visualPairs());
    await page.setViewportSize({ width: 760, height: 1000 });
    await loadAdminPage();
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("header:not(.summary-dialog-head)")).toHaveCSS(
      "flex-direction",
      "column",
    );
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
    page.locator('[data-group-id="task-one"] .log-target').click(),
  ]);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith(`/api/logs/${recordId}`)),
    page.locator(`[data-log-id="${recordId}"]`).click(),
  ]);
}

// Fixed usage-statistics payloads so the statistics page baseline is reproducible.
function statisticsBaselineFixtures() {
  const options = {
    targets: [
      { id: "target-a", name: "Target A" },
      { id: "target-b", name: "Target B" },
    ],
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
  };
  const totals = {
    requests: 137,
    tasks: 19,
    input: "195716056",
    output: "52962962",
    cache_read: "133044107",
    cache_write: "14320984",
    cost: "305.500000000",
  };
  const overview = [
    { dataVersion: 1, totals, byTarget: [], byModel: [], unpriced: { missing_usage: 6 } },
    {
      dataVersion: 1,
      totals,
      byTarget: [
        { id: "Target A", value: "248320000", cost: "180.300000000", requests: 66, tasks: 9 },
        { id: "Target B", value: "147724109", cost: "125.200000000", requests: 71, tasks: 10 },
      ],
      byModel: [],
      unpriced: {},
    },
    {
      dataVersion: 1,
      totals,
      byTarget: [],
      byModel: [
        { id: "gpt-5", value: "213450000", cost: "168.750000000", requests: 74, tasks: 13 },
        { id: "gpt-5-mini", value: "118500000", cost: "92.350000000", requests: 45, tasks: 4 },
        { id: "gpt-5-nano", value: "64094109", cost: "44.400000000", requests: 18, tasks: 2 },
      ],
      unpriced: {},
    },
  ];
  const trend = {
    dataVersion: 1,
    granularity: "day",
    points: [
      {
        bucket: "2026-01-05",
        requests: 18,
        tasks: 3,
        input: "21456789",
        output: "5432100",
        cache_read: "12345678",
        cache_write: "1234567",
        cost: "41250000000",
        unpriced: 1,
        by_model: [
          {
            id: "gpt-5",
            requests: 11,
            tasks: 3,
            input: "11564247",
            output: "2927659",
            cache_read: "6653767",
            cache_write: "665377",
            cost: "22785392800",
            unpriced: 1,
          },
          {
            id: "gpt-5-mini",
            requests: 5,
            tasks: 0,
            input: "6420066",
            output: "1625333",
            cache_read: "3693939",
            cache_write: "369393",
            cost: "12469517184",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 2,
            tasks: 0,
            input: "3472476",
            output: "879108",
            cache_read: "1997972",
            cache_write: "199797",
            cost: "5995090016",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-06",
        requests: 24,
        tasks: 3,
        input: "30123456",
        output: "8765432",
        cache_read: "20487654",
        cache_write: "2345678",
        cost: "52300000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 13,
            tasks: 3,
            input: "16235192",
            output: "4724175",
            cache_read: "11041927",
            cache_write: "1264216",
            cost: "28889116203",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 8,
            tasks: 0,
            input: "9013212",
            output: "2622697",
            cache_read: "6130092",
            cache_write: "701848",
            cost: "15809836334",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 3,
            tasks: 0,
            input: "4875052",
            output: "1418560",
            cache_read: "3315635",
            cache_write: "379614",
            cost: "7601047463",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-07",
        requests: 9,
        tasks: 2,
        input: "15234567",
        output: "3456789",
        cache_read: "10234567",
        cache_write: "987654",
        cost: "27800000000",
        unpriced: 2,
        by_model: [
          {
            id: "gpt-5",
            requests: 5,
            tasks: 2,
            input: "8210748",
            output: "1863055",
            cache_read: "5515973",
            cache_write: "532302",
            cost: "15355973814",
            unpriced: 2,
          },
          {
            id: "gpt-5-mini",
            requests: 3,
            tasks: 0,
            input: "4558321",
            output: "1034302",
            cache_read: "3062275",
            cache_write: "295515",
            cost: "8403698854",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 1,
            tasks: 0,
            input: "2465498",
            output: "559432",
            cache_read: "1656319",
            cache_write: "159837",
            cost: "4040327332",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-08",
        requests: 31,
        tasks: 4,
        input: "44321098",
        output: "11234567",
        cache_read: "30987654",
        cache_write: "3456789",
        cost: "61450000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 17,
            tasks: 3,
            input: "23887084",
            output: "6054927",
            cache_read: "16700955",
            cache_write: "1863054",
            cost: "33943330606",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 10,
            tasks: 1,
            input: "13261275",
            output: "3361485",
            cache_read: "9271788",
            cache_write: "1034303",
            cost: "18575801964",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 4,
            tasks: 0,
            input: "7172739",
            output: "1818155",
            cache_read: "5014911",
            cache_write: "559432",
            cost: "8930867430",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-09",
        requests: 12,
        tasks: 2,
        input: "22112233",
        output: "6543210",
        cache_read: "15321789",
        cache_write: "1876543",
        cost: "35600000000",
        unpriced: 1,
        by_model: [
          {
            id: "gpt-5",
            requests: 7,
            tasks: 2,
            input: "11917502",
            output: "3526497",
            cache_read: "8257757",
            cache_write: "1011372",
            cost: "19664484452",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 4,
            tasks: 0,
            input: "6616181",
            output: "1957788",
            cache_read: "4584418",
            cache_write: "561479",
            cost: "10761571195",
            unpriced: 1,
          },
          {
            id: "gpt-5-nano",
            requests: 1,
            tasks: 0,
            input: "3578550",
            output: "1058925",
            cache_read: "2479614",
            cache_write: "303692",
            cost: "5173944353",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-10",
        requests: 27,
        tasks: 3,
        input: "35678901",
        output: "9876543",
        cache_read: "25432198",
        cache_write: "2876543",
        cost: "48950000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 14,
            tasks: 0,
            input: "19229326",
            output: "5323012",
            cache_read: "13706813",
            cache_write: "1550327",
            cost: "27038666120",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 9,
            tasks: 2,
            input: "10675452",
            output: "2955152",
            cache_read: "7609545",
            cache_write: "860688",
            cost: "14797160393",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 4,
            tasks: 1,
            input: "5774123",
            output: "1598379",
            cache_read: "4115840",
            cache_write: "465528",
            cost: "7114173487",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-11",
        requests: 16,
        tasks: 2,
        input: "26789012",
        output: "7654321",
        cache_read: "18234567",
        cache_write: "1543210",
        cost: "38150000000",
        unpriced: 2,
        by_model: [
          {
            id: "gpt-5",
            requests: 7,
            tasks: 0,
            input: "14438073",
            output: "4125334",
            cache_read: "9827610",
            cache_write: "831719",
            cost: "21073036005",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 6,
            tasks: 1,
            input: "8015517",
            output: "2290243",
            cache_read: "5455950",
            cache_write: "461743",
            cost: "11532414076",
            unpriced: 1,
          },
          {
            id: "gpt-5-nano",
            requests: 3,
            tasks: 1,
            input: "4335422",
            output: "1238744",
            cache_read: "2951007",
            cache_write: "249748",
            cost: "5544549919",
            unpriced: 1,
          },
        ],
      },
    ],
  };
  return { options, overview, trend };
}

async function loadStatisticsBaseline(language: "zh" | "en"): Promise<void> {
  const fixtures = statisticsBaselineFixtures();
  let overviewCalls = 0;
  await page.route("**/api/usage-statistics/options*", (route) =>
    route.fulfill({ json: fixtures.options }),
  );
  await page.route("**/api/usage-statistics/overview*", (route) =>
    route.fulfill({ json: fixtures.overview[overviewCalls++ % 3] }),
  );
  await page.route("**/api/usage-statistics/trend*", (route) =>
    route.fulfill({ json: fixtures.trend }),
  );
  await page.setViewportSize({ width: 1278, height: 900 });
  await loadAdminPage();
  await page.locator("#languageSelect").selectOption(language);
  await page.locator('[data-tab="statistics"]').click();
  await page.locator("#statsFollowNow").uncheck();
  await page.locator("#statsFrom").fill("2026-01-05T18:30");
  await page.locator("#statsTo").fill("2026-01-12T18:30");
  await expectPage(page.locator("#statsOverview .stat-card")).toHaveCount(4);
  await expectPage(page.locator(".trend-card table tbody tr")).toHaveCount(7);
  const height = await page.evaluate(() => {
    const el = document.querySelector("#statistics");
    return el ? el.scrollHeight : 0;
  });
  await page.setViewportSize({ width: 1278, height: Math.min(Math.max(height + 52, 900), 4200) });
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
    model_prices: [],
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
        target(
          "visual-disabled",
          "Disabled target",
          "http://127.0.0.1:12399",
          "sk-...",
          "gpt-5.4-nano",
          false,
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
  expect(actual.width).toBe(baseline.width);
  // The document height can drift a few pixels between environments because of
  // fractional-pixel rounding (e.g. aspect-ratio SVGs). Treat a page as
  // unchanged when the overlap is identical and any extra rows are blank.
  expect(Math.abs(actual.height - baseline.height)).toBeLessThanOrEqual(4);
  const rows = Math.min(actual.height, baseline.height);
  const stride = actual.width * 4;
  const sliceRows = (image: { data: Buffer }) => {
    const out = Buffer.alloc(rows * stride);
    for (let y = 0; y < rows; y++) {
      Buffer.from(image.data.subarray(y * stride, (y + 1) * stride)).copy(out, y * stride);
    }
    return out;
  };
  const differentPixels = pixelmatch(
    sliceRows(actual),
    sliceRows(baseline),
    undefined,
    actual.width,
    rows,
    { threshold: 0.2 },
  );
  for (const image of [actual, baseline]) {
    if (image.height <= rows) continue;
    for (let y = rows; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        const r = image.data[i] ?? 255,
          g = image.data[i + 1] ?? 255,
          b = image.data[i + 2] ?? 255,
          a = image.data[i + 3] ?? 255;
        expect(a < 10 || (r > 230 && g > 230 && b > 230)).toBe(true);
      }
    }
  }
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

describe("statistics page visual smoke", () => {
  it("renders bounded SVG charts with mock statistics", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {
            requests: 2,
            tasks: 1,
            input: "1234567",
            output: "7654321",
            cache_read: "11223344",
            cache_write: "0",
            cost: "88.5",
          },
          byTarget: [{ id: "a", value: "10" }],
          byModel: [
            { id: "gpt-6-astra", value: "65" },
            { id: "gpt-5.6-terra", value: "25" },
            { id: "gpt-5.6-sol", value: "9" },
            { id: "gpt-5.5", value: "1" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator(".pie-chart svg").first()).toHaveAttribute(
      "viewBox",
      "0 0 600 260",
    );
    await expectPage(page.locator(".stats-empty")).toHaveCount(1);
    await page.screenshot({ path: "test-results/statistics-page-smoke.png", fullPage: true });
  });
  it("groups low-share distribution and trend categories into Other", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [{ id: "target-a", value: "96", cost: "96" }],
          byModel: [
            { id: "model-a", value: "60", cost: "60" },
            { id: "model-b", value: "25", cost: "25" },
            { id: "model-c", value: "6", cost: "6" },
            { id: "model-d", value: "2", cost: "2" },
            { id: "model-e", value: "1", cost: "1" },
            { id: "model-f", value: "1", cost: "1" },
            { id: "model-g", value: "1", cost: "1" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({
        json: {
          dataVersion: 1,
          granularity: "day",
          points: [
            {
              bucket: "2026-09-01",
              requests: 5,
              tasks: 1,
              input: "96",
              output: "0",
              cache_read: "0",
              cache_write: "0",
              cost: "96000000000",
              by_model: [
                {
                  id: "model-a",
                  input: "60",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "60000000000",
                },
                {
                  id: "model-b",
                  input: "25",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "25000000000",
                },
                {
                  id: "model-c",
                  input: "6",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "6000000000",
                },
                {
                  id: "model-d",
                  input: "2",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "2000000000",
                },
                {
                  id: "model-e",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
                {
                  id: "model-f",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
                {
                  id: "model-g",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "1000000000",
                },
              ],
            },
          ],
        },
      }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    const modelPie = page.locator(".distribution-card").nth(1);
    await expectPage(modelPie.locator(".pie-segment")).toHaveCount(4);
    await expectPage(modelPie).toContainText("Other");
    await expectPage(modelPie).not.toContainText("model-d");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(4);
    await expectPage(page.locator(".trend-legend")).toContainText("Other");
    await expectPage(page.locator(".trend-legend")).not.toContainText("model-d");
  });
  it("re-renders statistics labels when the language switches", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [{ id: "a", name: "A" }], models: ["m"] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [{ id: "a", value: "10" }],
          byModel: [{ id: "m", value: "10" }],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "Target distribution",
    );
    await page.locator("#languageSelect").selectOption("zh");
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "转发地址分布",
    );
    await expectPage(page.locator("#statsTrend .trend-card h3")).toHaveText("使用趋势");
    await expectPage(page.locator("#statsTarget option").first()).toHaveText("全部转发地址");
    await page.screenshot({ path: "test-results/statistics-page-language-zh.png", fullPage: true });
    await page.locator("#languageSelect").selectOption("en");
    await expectPage(page.locator("#statsOverview .distribution-card h3").first()).toHaveText(
      "Target distribution",
    );
    await expectPage(page.locator("#statsTrend .trend-card h3")).toHaveText("Usage trend");
  }, 30000);
  it("serializes granularity and filter selections", async () => {
    const requests: string[] = [];
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [{ id: "a", name: "A" }], models: ["m"] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) => {
      requests.push(route.request().url());
      return route.fulfill({ json: { dataVersion: 1, granularity: "month", points: [] } });
    });
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator("#statsTarget option")).toHaveCount(2);
    await page.locator("#statsTarget").selectOption("a");
    await page.locator("#statsModel").selectOption("m");
    await page.locator("#statsGranularity").selectOption("month");
    await expectPage
      .poll(() => requests.some((url) => url.includes("granularity=month")))
      .toBe(true);
    expect(requests.some((url) => url.includes("targetId=a") && url.includes("model=m"))).toBe(
      true,
    );
  });
  it("recomputes trend scale and units when switching to cost", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: { totals: {}, byTarget: [], byModel: [], unpriced: {}, dataVersion: 1 },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({
        json: {
          dataVersion: 1,
          granularity: "day",
          points: [
            {
              bucket: "2026-09-01",
              requests: 1,
              tasks: 1,
              input: "100",
              output: "10",
              cache_read: "0",
              cache_write: "0",
              cost: "100000000",
              by_model: [
                {
                  id: "model-a",
                  input: "60",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "60000000",
                },
                {
                  id: "model-b",
                  input: "40",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "40000000",
                },
              ],
            },
            {
              bucket: "2026-09-02",
              requests: 100,
              tasks: 1,
              input: "1",
              output: "1",
              cache_read: "0",
              cache_write: "0",
              cost: "10000000",
              by_model: [
                {
                  id: "model-a",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "6000000",
                },
                {
                  id: "model-b",
                  input: "1",
                  output: "0",
                  cache_read: "0",
                  cache_write: "0",
                  cost: "4000000",
                },
              ],
            },
          ],
        },
      }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator(".trend-yaxis span")).toHaveCount(5);
    await expectPage(page.locator(".trend-gridline")).toHaveCount(5);
    // The trend grouping defaults to the stacked by-model breakdown.
    await expectPage(page.locator("#statsBreakdown")).toHaveValue("model");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(2);
    await page.locator("#statsBreakdown").selectOption("total");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(4);
    await page.locator("#statsMetricTrend").selectOption("cost");
    await expectPage(page.locator("#statsMetricTrend")).toHaveValue("cost");
    await expectPage(page.locator(".trend-segment.cost")).toHaveCount(2);
    await page.locator("#statsBreakdown").selectOption("model");
    await expectPage(page.locator(".trend-item").first().locator(".trend-segment")).toHaveCount(2);
    const costSegmentColors = await page
      .locator(".trend-item")
      .first()
      .locator(".trend-segment")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.backgroundColor));
    expect(new Set(costSegmentColors).size).toBe(2);
  });
  it("switches each distribution chart to cost independently with consistent controls", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {},
          byTarget: [
            { id: "hyperapi", value: "26189600000", cost: "26.189600000" },
            { id: "vllm", value: "7450700000", cost: "7.450700000" },
            { id: "deepseek", value: "11400000", cost: "0.011400000" },
          ],
          byModel: [
            { id: "gpt-6-astra", value: "20045700000", cost: "20.045700000" },
            { id: "gpt-5.6-terra", value: "6143900000", cost: "6.143900000" },
          ],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    const targetMetric = page.locator("#statsMetricTarget");
    const modelMetric = page.locator("#statsMetricModel");
    await expectPage(targetMetric).toHaveValue("token");
    await expectPage(modelMetric).toHaveValue("token");
    const controlStyle = await targetMetric.evaluate((el) => {
      const style = getComputedStyle(el);
      return { borderRadius: style.borderRadius, width: style.width };
    });
    expect(Number.parseFloat(controlStyle.borderRadius)).toBeGreaterThan(0);
    expect(Number.parseFloat(controlStyle.width)).toBeLessThan(130);
    await targetMetric.selectOption("cost");
    await expectPage(
      page.locator(".distribution-card").first().locator(".pie-center-value"),
    ).toHaveText("$33.6517");
    await expectPage(
      page.locator(".distribution-card").nth(1).locator(".pie-center-value"),
    ).not.toHaveText("$26.1896");
    await modelMetric.selectOption("cost");
    await expectPage(
      page.locator(".distribution-card").nth(1).locator(".pie-center-value"),
    ).toHaveText("$26.1896");
  });
  it("shows an explicit warning when records are unpriced", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({ json: { targets: [], models: [] } }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: { requests: 1 },
          byTarget: [],
          byModel: [],
          unpriced: { missing_usage: 2 },
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await expectPage(page.locator(".stats-unpriced")).toContainText("Unpriced");
    await expectPage(page.locator(".stat-card-unpriced")).toHaveCount(0);
  });

  it("exports the active statistics filters", async () => {
    await page.route("**/api/usage-statistics/options*", (route) =>
      route.fulfill({
        json: { targets: [{ id: "target-a", name: "Target A" }], models: ["model-a"] },
      }),
    );
    await page.route("**/api/usage-statistics/overview*", (route) =>
      route.fulfill({
        json: {
          totals: {
            requests: 0,
            tasks: 0,
            input: "0",
            output: "0",
            cache_read: "0",
            cache_write: "0",
            cost: "0",
          },
          byTarget: [],
          byModel: [],
          unpriced: {},
          dataVersion: 1,
        },
      }),
    );
    await page.route("**/api/usage-statistics/trend*", (route) =>
      route.fulfill({ json: { dataVersion: 1, granularity: "day", points: [] } }),
    );
    await loadAdminPage();
    await page.locator('[data-tab="statistics"]').click();
    await page.locator('[data-stats-range="0"]').click();
    const todayRangeValid = await page.evaluate(() => {
      const from = document.querySelector("#statsFrom");
      const to = document.querySelector("#statsTo");
      if (from === null || to === null) return false;
      return (
        from instanceof HTMLInputElement &&
        to instanceof HTMLInputElement &&
        new Date(from.value).getTime() < new Date(to.value).getTime()
      );
    });
    expect(todayRangeValid).toBe(true);
    await page.locator('[data-stats-range="1"]').click();
    await expectPage(page.locator('[data-stats-range="1"]')).toHaveClass(/active/);
    await page.locator("#statsTarget").selectOption("target-a");
    await page.locator("#statsModel").selectOption("model-a");
    await page.locator("#statsGranularity").selectOption("month");
    const popupPromise = page.waitForEvent("popup");
    await page.locator("#exportStatistics").click();
    const popup = await popupPromise;
    await expectPage(popup).toHaveURL(
      /\/api\/usage-statistics\/export\?.*granularity=month.*targetId=target-a.*model=model-a/,
    );
    await popup.close();
  });
});
