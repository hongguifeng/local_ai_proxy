import { chromium, type Browser, type Page } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { buildAdminAppScript } from "../../scripts/build_ui_bundle.js";
import {
  applicationHealth,
  createAdminServer,
  loadAdminStaticAssets,
} from "../../src/admin/index.js";
import { ConfigValidationError } from "../../src/config/index.js";
import { Readable } from "node:stream";
import type { LogPendingRecord } from "../../src/maintenance/index.js";
import { existsSync } from "node:fs";
import {
  TASK_BRIEF_GENERATED_TEXT,
  deletedLogGroups,
  deploymentPromptFixture,
  detailReads,
  fixtureRequestPricing,
  groupLogQueries,
  lbBindingFixturePage,
  lbBindingReads,
  lbStatusReads,
  loadBalancerStatusFixture,
  logQueries,
  modelCatalogCalls,
  modelCatalogError,
  modelCatalogOutcome,
  pairs,
  pairsSaveIssues,
  publicPair,
  resetFixtureData,
  setTaskBriefFixture,
  targetCheckCalls,
  targetCheckOutcome,
  targetMetricsCalls,
  targetMetricsOutcome,
  targetModelsCalls,
  targetModelsOutcome,
  taskBriefFixtureValue,
  taskBriefPosts,
  taskOneLogFixture,
  useLargeGroupLogFixture,
  useLargeLogFixture,
  useLargeLogRequestCount,
} from "./admin-ui-fixture.js";

export let browser: Browser;
export let page: Page;
export let server: ReturnType<typeof createAdminServer>;
export let baseUrl: string;

type AdminServer = ReturnType<typeof createAdminServer>;

let activeBrowser: Browser | undefined;
let activePage: Page | undefined;
let activeServer: AdminServer | undefined;

/**
 * Every page this suite creates reports its unhandled script errors.
 *
 * Before the listener existed, a page that threw while a test drove it looked like a
 * passing test: Chromium printed the error to its console and nothing read it, so a
 * render that died halfway could still pass on whatever the page had drawn before it
 * died. The listener is attached where the page is created - the only place a page is
 * created in this suite - so every file in this directory is covered by the same rule,
 * and `closeTestPage` raises what was collected before the page goes away, so the
 * failure names the test that caused it and carries the message and the stack.
 */
export interface RecordedPageError {
  readonly message: string;
  readonly stack: string;
}

let recordedPageErrors: RecordedPageError[] = [];

/** Unhandled page errors recorded against the page the current test is driving. */
export function unhandledPageErrors(): readonly RecordedPageError[] {
  return recordedPageErrors;
}

function recordPageError(error: Error): void {
  recordedPageErrors.push({ message: error.message, stack: error.stack ?? error.message });
}

/** Raise every recorded error, so a broken page cannot be reported as a passing test. */
function assertNoUnhandledPageErrors(): void {
  const collected = recordedPageErrors;
  recordedPageErrors = [];
  if (collected.length === 0) {
    return;
  }
  const reported = collected
    .map((recorded, index) => `${index + 1}. ${recorded.message}\n${recorded.stack}`)
    .join("\n\n");
  throw new Error(
    `The page threw ${collected.length} unhandled script error(s) while the test ran:\n\n${reported}`,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function startStubAdminServer(): Promise<void> {
  // The page this suite drives is the product page, so it needs the generated admin UI
  // bundle. A lone `npx vitest run test-node/ui` does not go through the pretest hook that
  // builds it, so build it here: the stub then serves the same bytes the product build
  // serves, instead of a script with the helpers missing.
  await buildAdminAppScript();
  server = createAdminServer({
    getHealth: () => applicationHealth("running"),
    targetCheckService: {
      checkTarget: (request) => {
        targetCheckCalls.push({ ...request });
        return Promise.resolve({ ...targetCheckOutcome });
      },
    },
    targetMetricsService: {
      fetchTargetMetrics: (request) => {
        targetMetricsCalls.push({ ...request });
        return Promise.resolve({ ...targetMetricsOutcome });
      },
    },
    targetModelsService: {
      fetchTargetModels: (request) => {
        targetModelsCalls.push({ ...request });
        return Promise.resolve({ ...targetModelsOutcome });
      },
    },
    modelCatalogService: {
      importModelPrices: (request) => {
        modelCatalogCalls.push({ ...request });
        if (modelCatalogError !== null) {
          return Promise.reject(new Error(modelCatalogError));
        }
        return Promise.resolve({ ...modelCatalogOutcome });
      },
    },
    loadBalancerService: {
      getStatus: () => {
        lbStatusReads.push(lbStatusReads.length);
        return loadBalancerStatusFixture();
      },
      // [TRI-06] The node list reads this route, so the stub answers it the way the service
      // does: the two 404 causes are named apart, a filter outside the group answers a legal
      // empty page, and the page carries the group's whole node counts.
      getBindings: (query) => {
        const asked = { ...query };
        lbBindingReads.push(asked);
        return lbBindingFixturePage(asked);
      },
      // [TRI-08] The migration write and its cancel are not part of the UI either (TRI-09): the
      // page has no button that asks for a move, so the stub answers the named refusal an empty
      // assembly gives. The shape is the reply the real service returns, not a new one.
      moveBinding: () => ({
        rejection: { code: "pair_not_found", detail: undefined },
      }),
      cancelMoveBinding: () => ({
        rejection: { code: "operation_not_found", detail: undefined },
      }),
    },
    pairService: {
      listPairs: () => pairs,
      replacePairs: (nextPairs) => {
        if (pairsSaveIssues !== null) {
          throw new ConfigValidationError(pairsSaveIssues);
        }
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
              request_count: useLargeLogRequestCount ? useLargeLogRequestCount(index) : 1,
              target: `target-${index + 1}`,
            }))
          : [
              {
                id: "task-one",
                started_at: "2026-07-18 12:00:00",
                last_activity_at: "2026-07-18 12:00:05",
                model: "gpt-5",
                request_count: 6,
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
        if (groupId !== "task-one" && !useLargeGroupLogFixture) {
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
          total: 6,
          limit: 200,
          offset: 0,
          next_offset: 6,
          has_more: false,
          logs: taskOneLogFixture(),
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
              algorithm_version: null,
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
      getGroupCostSeries: (groupId) => {
        if (groupId !== "task-one") return undefined;
        return [
          { sequence: 1, cost_nano_cny: "10400000" },
          { sequence: 3, cost_nano_cny: "8600000" },
          { sequence: 5, cost_nano_cny: "23750000" },
        ];
      },
      getGroupOutputTokenSeries: (groupId) => {
        if (groupId !== "task-one") return undefined;
        return [
          { sequence: 1, output_tokens: 4 },
          { sequence: 3, output_tokens: 96 },
          { sequence: 5, output_tokens: 212 },
        ];
      },
      getTaskBrief: (groupId) =>
        groupId === "task-one" ? taskBriefFixtureValue(groupId) : undefined,
      generateTaskBrief: (groupId) => {
        taskBriefPosts.push(groupId);
        setTaskBriefFixture(groupId === "task-one" ? TASK_BRIEF_GENERATED_TEXT : null);
        const brief = taskBriefFixtureValue(groupId);
        if (brief === undefined) {
          // The stub only knows how to generate a brief for the fixture task; every
          // browser test posts for that one.
          throw new Error(`Task brief stub has no answer for ${groupId}`);
        }
        return Promise.resolve(brief);
      },
      cleanupSelectedGroups: (groupIds) => {
        groupIds.forEach((groupId) => deletedLogGroups.add(groupId));
        return { deleted: groupIds, deleted_count: groupIds.length };
      },
      exportLogs: () => Readable.from([Buffer.from("zip-fixture")]),
      listRecordsByIds: (ids): { records: readonly LogPendingRecord[] } => ({
        records: taskOneLogFixture()
          .filter((record) => ids.includes(record.id))
          .map((record) => {
            // Only record-one is still in flight in this fixture; every other
            // row is already finished, so the batch read mirrors the list.
            const pending = record.id === "record-one" && (detailReads.get(record.id) ?? 0) === 0;
            if (pending) return { ...record, pending };
            return {
              ...record,
              pending: false,
              message_count: record.message_count ?? 1,
              status: record.status ?? 200,
              request_token_count: record.request_token_count ?? 8,
              response_token_count: record.response_token_count ?? 4,
              cost: record.cost?.amount
                ? record.cost
                : { currency: "CNY", amount: "0.041125", status: "priced", reason: null },
            };
          }),
      }),
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
          "record-six": {
            // A tool-call-only stream that never delivered a generated text
            // payload: first_token_ms is null and the full duration is the
            // decode window, so the detail view still shows a speed estimate.
            status: 200,
            input: "call the tool",
            output: null,
            request_token_count: 30,
            response_token_count: 50,
            duration_ms: 1_000,
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
            ...(extra.first_token_ms === undefined ? {} : { first_token_ms: extra.first_token_ms }),
            duration_ms: extra.duration_ms,
            // The tool-call-only request has no measured first-token time;
            // the service falls back to the full duration as decode window.
            ...(recordId === "record-six" ? { decode_window_ms: 0 } : {}),
          },
          pricing: fixtureRequestPricing(recordId === "record-four" ? "unpriced" : "priced"),
        };
      },
    },
    staticAssets: await loadAdminStaticAssets(),
  });
  activeServer = server;
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
  activeBrowser = browser;
}

export async function resetStubAdminServer(): Promise<void> {
  resetFixtureData();
  page = await browser.newPage();
  activePage = page;
  recordedPageErrors = [];
  page.on("pageerror", recordPageError);
  await page.addInitScript(() => {
    localStorage.setItem("llmProxyLanguage", "en");
  });
}

export async function closeTestPage(): Promise<void> {
  const currentPage = activePage;
  if (currentPage === undefined) {
    return;
  }
  let pageError: Error | undefined;
  let closeError: Error | undefined;
  // Drain the page's task queue first. A script that throws from a timer or a microtask
  // may have raised its error a moment before this hook runs, and the report travels back
  // over the same ordered connection as the command below, so a round trip the browser
  // answers only after its queued work cannot return before an earlier exception.
  try {
    try {
      await currentPage.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      assertNoUnhandledPageErrors();
    } catch (error: unknown) {
      pageError = asError(error);
    }
  } finally {
    try {
      await currentPage.close();
    } catch (error: unknown) {
      closeError = asError(error);
    } finally {
      activePage = undefined;
    }
  }
  if (pageError !== undefined) {
    throw pageError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

export async function closeStubAdminServer(): Promise<void> {
  let firstCleanupError: Error | undefined;
  const currentBrowser = activeBrowser;
  if (currentBrowser !== undefined) {
    try {
      await currentBrowser.close();
    } catch (error: unknown) {
      firstCleanupError = asError(error);
    } finally {
      activeBrowser = undefined;
    }
  }
  const currentServer = activeServer;
  if (currentServer !== undefined) {
    try {
      await currentServer.close();
    } catch (error: unknown) {
      firstCleanupError ??= asError(error);
    } finally {
      activeServer = undefined;
    }
  }
  if (firstCleanupError !== undefined) {
    throw firstCleanupError;
  }
}
