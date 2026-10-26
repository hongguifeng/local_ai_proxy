/**
 * [TRI-09] a move made through the real console against the real proxy. The admin server, the
 * proxy listener and the browser are the product's own; the only fixtures are two HTTP upstreams
 * whose traffic this file can count. Together they answer what the stub tests cannot: does a
 * destination chosen in the UI actually take the next request of the same conversation, and does
 * the record the console shows match the write the proxy persisted?
 *
 * A move is applied only at the request boundary of the task waiting on the binding, so the
 * proof needs a response that really stays open. The upstream sends its first frame and then
 * stops until this file lets it go: the console registers its intent while that frame is the
 * only thing the client has, and the route changes only when the released stream finishes. The
 * next request of the same conversation is what turns `applied` into `observed`, and the evidence
 * for that is the destination's own response headers - not the upstream's business result.
 *
 * The three cases are independent on purpose. Each one opens its own conversation and resets the
 * fixtures it touches, so none of them can fail because an earlier case went wrong.
 */
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  expect as expectPage,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeApplication, type NodeApplication } from "../../src/app/index.js";
import { TrafficRepository, type RecordRow } from "../../src/persistence/index.js";
import type {
  LoadBalancerBindingListItem,
  LoadBalancerBindingListResponse,
  LoadBalancerMigrationOperation,
} from "../../src/proxy/index.js";

const MODEL = "Qwen3.6-35B-A3B";
const FIRST_NAME = "Node One";
const SECOND_NAME = "Node Two";
/** What one streamed answer says, in the frames it says it in. */
const STREAM_PARTS = ["alpha", " beta", " gamma", "!"];

function sseFrame(model: string, content: string): string {
  return `data: ${JSON.stringify({
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

/** One upstream: it counts the chat requests it answered, can hold a stream after its first
 *  frame, and can be told whether a plain answer should carry a response id. */
interface Upstream {
  readonly port: number;
  readonly label: string;
  chatHits(): number;
  otherHits(): number;
  /** Whether the next plain answer carries a response id. That is what teaches a binding a
   *  `response:` key, and that key is what the state gate refuses a later move for. */
  emitIds(emitting: boolean): void;
  /** Whether the next streamed answer stops after its first frame until `releaseFrames`. */
  holdFirstFrame(holding: boolean): void;
  /** Let every stream that stopped mid-answer send what it has left. */
  releaseFrames(): void;
  close(): Promise<void>;
}

async function startUpstream(label: string): Promise<Upstream> {
  let chats = 0;
  let others = 0;
  let emitting = false;
  let holdFrames = false;
  /** The streams that stopped after their first frame, each holding its own resume. */
  const held: { resume: () => void }[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    const isChat = request.method === "POST" && (request.url ?? "").startsWith("/v1/chat");
    if (isChat) chats += 1;
    else others += 1;
    const counted = isChat ? chats : others;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let model = MODEL;
      let wantsStream = false;
      try {
        const parsed = JSON.parse(body) as { model?: unknown; stream?: unknown };
        if (typeof parsed.model === "string") model = parsed.model;
        wantsStream = parsed.stream === true;
      } catch {
        // A body this fixture cannot read is still a request it was asked to answer.
      }
      void (async () => {
        if (wantsStream) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          response.write(sseFrame(model, STREAM_PARTS[0] ?? ""));
          if (holdFrames) {
            await new Promise<void>((resolve) => {
              held.push({ resume: resolve });
            });
          }
          for (const part of STREAM_PARTS.slice(1)) {
            if (response.writableEnded || response.destroyed) return;
            response.write(sseFrame(model, part));
          }
          if (response.writableEnded || response.destroyed) return;
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            // An engine that answers with a response id teaches the table a `response:` key,
            // and that key is what a later move is refused for. Whether this fixture teaches
            // that is switched here, so both outcomes can be shown.
            ...(emitting ? { id: `chatcmpl-${label}-${String(counted)}` } : {}),
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `answered by ${label}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      })().catch(() => {
        // A client that went away mid-write is not this fixture's failure to report.
        if (!response.writableEnded) response.destroy();
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fixture upstream did not report a port.");
  }
  return {
    port: address.port,
    label,
    chatHits: () => chats,
    otherHits: () => others,
    emitIds: (emittingIds: boolean) => {
      emitting = emittingIds;
    },
    holdFirstFrame: (holding: boolean) => {
      holdFrames = holding;
    },
    releaseFrames: () => {
      for (const stream of held.splice(0, held.length)) stream.resume();
    },
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

/** One turn of one conversation, sent through the real proxy. */
function chatBody(conversationId: string, content: string, stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    conversation_id: conversationId,
    messages: [{ role: "user", content }],
    stream,
  });
}

/** The same conversation one turn later: the earlier question comes first, so the affinity table
 *  sees a continuation of the task it already bound rather than a different task. */
function followUpBody(conversationId: string, firstQuestion: string, nextQuestion: string): string {
  return JSON.stringify({
    model: MODEL,
    conversation_id: conversationId,
    messages: [
      { role: "user", content: firstQuestion },
      { role: "assistant", content: "the answer the first node gave" },
      { role: "user", content: nextQuestion },
    ],
    stream: true,
  });
}

async function sendChat(
  proxyPort: number,
  body: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.text() };
}

/** One streamed answer read as it arrives. The frames are collected in the order they reached
 *  the client, so a frame that arrived late or out of order cannot pass. */
interface ChatStream {
  readonly status: number;
  readonly contentType: string | null;
  payloads(): readonly string[];
  answeredText(): string;
  ended(): boolean;
}

async function startChatStream(proxyPort: number, body: string): Promise<ChatStream> {
  const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("The proxy answered the streamed request without a body to read.");
  }
  const decoder = new TextDecoder();
  const payloads: string[] = [];
  let pendingText = "";
  let answered = "";
  let ended = false;
  const take = (block: string): void => {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "") continue;
      payloads.push(payload);
      if (payload === "[DONE]") continue;
      const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === "string") answered += content;
    }
  };
  void (async () => {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      pendingText += decoder.decode(read.value, { stream: true });
      let boundary = pendingText.indexOf("\n\n");
      while (boundary >= 0) {
        take(pendingText.slice(0, boundary));
        pendingText = pendingText.slice(boundary + 2);
        boundary = pendingText.indexOf("\n\n");
      }
    }
    if (pendingText.trim() !== "") take(pendingText);
    ended = true;
  })().catch(() => {
    ended = true;
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    payloads: () => [...payloads],
    answeredText: () => answered,
    ended: () => ended,
  };
}

interface LiveApp {
  readonly root: string;
  readonly adminPort: number;
  readonly proxyPort: number;
  readonly runtime: NodeApplication;
}

async function startLiveApp(root: string, firstUrl: string, secondUrl: string): Promise<LiveApp> {
  const logRoot = path.join(root, "logs");
  const target = (id: string, name: string, url: string, enabled: boolean) => ({
    id,
    name,
    enabled,
    target_url: url,
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: logRoot,
    redact_logs: false,
    model_mappings: [],
  });
  await writeFile(
    path.join(root, "proxies.json"),
    JSON.stringify({
      pairs: [
        {
          id: "pair-live",
          name: "Live",
          enabled: true,
          listen_host: "127.0.0.1",
          listen_port: 0,
          access_log: false,
          upstream_url: "http://127.0.0.1:9/",
          model_mapping_mode: "disabled",
          default_model: "",
          default_upstream_model: "",
          preserve_route_model: false,
          allow_unnamed_model: false,
          unknown_model_policy: "reject",
          unknown_param_mode: "strip",
          unknown_param_paths: [],
          stream_keepalive_interval_seconds: 0,
          target_retry_limit: 0,
          target_retry_backoff_milliseconds: 0,
          failover_reuse_connection: false,
          target_connect_timeout_milliseconds: 5_000,
          target_first_byte_timeout_milliseconds: 5_000,
          target_idle_chunk_timeout_milliseconds: 5_000,
          target_headers: [],
          strip_request_fields: "",
          inject_request_fields: "",
          log_root: logRoot,
          redact_logs: false,
          model_mappings: [],
          targets: [
            target("node-one", FIRST_NAME, firstUrl, true),
            target("node-two", SECOND_NAME, secondUrl, true),
            target("node-off", "Node Off", "http://127.0.0.1:9/", false),
          ],
          load_balancers: [
            {
              id: "lb-live",
              name: "live-group",
              enabled: true,
              model_pattern: MODEL,
              strategy: "least_load",
              metrics_source: "auto",
              kv_cache_strategy: "prefer_cache",
              sticky_session: true,
              session_header_names: ["x-session-id"],
              queue_bias: 0.2,
              queue_weight: 0.2,
              load_weight: 0.5,
              kv_weight: 0.3,
              candidate_limit: 5,
              max_waiting: 100,
              max_inflight_per_target: 0,
              cooldown_seconds: 30,
              failure_threshold: 3,
              metrics_path: "/v1/load",
              metrics_timeout_ms: 2_000,
              metrics_transport: "http",
              metrics_cache_ttl_seconds: 5,
              probe_path: "/v1/models",
              probe_method: "GET",
              probe_timeout_ms: 2_000,
              sleep_grace_ms: 0,
              sleep_retry_ms: 500,
              members: [
                { target_id: "node-one", model_id: "" },
                { target_id: "node-two", model_id: "" },
                { target_id: "node-off", model_id: "" },
              ],
            },
          ],
        },
      ],
    }),
  );
  const runtime = createNodeApplication({
    applicationConfigFile: path.join(root, "llm-proxy.json"),
    configFile: path.join(root, "proxies.json"),
    logRoot,
    host: "127.0.0.1",
    port: 0,
  });
  await runtime.application.start();
  const adminPort = runtime.address()?.port;
  if (adminPort === undefined) {
    await runtime.application.stop();
    throw new Error("The assembled application did not report an admin port.");
  }
  const pairs = await fetch(`http://127.0.0.1:${String(adminPort)}/api/pairs`);
  const listed = (await pairs.json()) as { pairs: { actual_listen_port?: number }[] };
  const proxyPort = listed.pairs[0]?.actual_listen_port;
  if (typeof proxyPort !== "number") {
    await runtime.application.stop();
    throw new Error("The running pair did not report a proxy port.");
  }
  return { root, adminPort, proxyPort, runtime };
}

/** Open the status fold once; it is closed when the page first shows it. */
async function ensureStatusOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fold = document.querySelector<HTMLDetailsElement>(".lb-status");
    if (fold instanceof HTMLDetailsElement && !fold.open) {
      fold.querySelector("summary")?.click();
    }
  });
  await page.waitForSelector(".lb-node-state");
}

/** Open one node's binding list without closing a list that is already open, and wait for the
 *  read it starts to answer - rows, or the honest "no bindings" line. */
async function openBindingPanel(page: Page, targetId: string): Promise<Locator> {
  const panel = page.locator(`.lb-binding-panel[data-lb-binding-node="${targetId}"]`);
  const toggle = page.locator(
    `.lb-node-state[data-lb-status-target="${targetId}"] [data-lb-bindings-toggle]`,
  );
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  try {
    await panel
      .locator(".lb-binding, [data-lb-binding-empty]")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    const markup = await panel.evaluate((node) => node.outerHTML.slice(0, 1_200));
    const expanded = await toggle.getAttribute("aria-expanded");
    throw new Error(
      `The binding list for ${targetId} answered nothing (aria-expanded ${String(expanded)}): ${markup}`,
    );
  }
  return panel;
}

/** The row this file works on, addressed by the pair of numbers the list gave it. The panel is
 *  rebuilt by the status poll, so the address has to be looked up again every time - and finding
 *  exactly one row is what proves the console is showing the binding this file created rather
 *  than some other binding on the same node. */
function bindingRow(panel: Locator, row: LoadBalancerBindingListItem): Locator {
  return panel.locator(
    `.lb-binding[data-lb-binding-id="${String(row.bindingId)}"][data-lb-binding-incarnation="${String(row.incarnation)}"]`,
  );
}

/** The admin list read performed over HTTP, so the proof is not only in the DOM. */
async function readTasks(
  adminPort: number,
  targetId: string | undefined,
): Promise<LoadBalancerBindingListResponse> {
  const query =
    "?pairId=pair-live&groupId=lb-live" + (targetId === undefined ? "" : `&targetId=${targetId}`);
  const response = await fetch(
    `http://127.0.0.1:${String(adminPort)}/api/load-balancer/tasks${query}`,
  );
  if (!response.ok) {
    throw new Error(
      `The binding list answered ${String(response.status)}: ${await response.text()}`,
    );
  }
  return (await response.json()) as LoadBalancerBindingListResponse;
}

function bindingAddress(row: LoadBalancerBindingListItem): string {
  return `${String(row.bindingId)}#${String(row.incarnation)}`;
}

function rowOf(
  list: LoadBalancerBindingListResponse,
  wanted: LoadBalancerBindingListItem,
): LoadBalancerBindingListItem {
  const found = list.items.find(
    (item) => item.bindingId === wanted.bindingId && item.incarnation === wanted.incarnation,
  );
  if (found === undefined) {
    throw new Error(
      `Binding ${String(wanted.bindingId)}#${String(wanted.incarnation)} left the list: ${JSON.stringify(
        list.items.map((item) => [item.bindingId, item.targetId]),
      )}`,
    );
  }
  return found;
}

function operationOf(
  list: LoadBalancerBindingListResponse,
  operationId: string,
): LoadBalancerMigrationOperation {
  const found = list.migrationOperations.find((item) => item.operationId === operationId);
  if (found === undefined) {
    throw new Error(
      `The list no longer reports operation ${operationId}: ${JSON.stringify(
        list.migrationOperations.map((item) => item.state),
      )}`,
    );
  }
  return found;
}

/** The state the console shows for one operation record, read out of the panel it belongs to. */
async function operationStateText(panel: Locator, operationId: string): Promise<string | null> {
  return panel.evaluate(
    (node: Element, id: string) =>
      node.querySelector(
        `.lb-binding-operation[data-lb-binding-operation="${id}"] .lb-binding-operation-state`,
      )?.textContent ?? null,
    operationId,
  );
}

/** Wait for the console's own status poll to put a named state on a named operation record. The
 *  list read is what carries that state, so this waits on the product's lifecycle rather than on
 *  a refresh button invented for the test. */
async function waitForOperationState(
  panel: Locator,
  operationId: string,
  wanted: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const shown = await operationStateText(panel, operationId);
    if (shown?.includes(wanted)) return;
    if (Date.now() > deadline) {
      const markup = await panel.evaluate((node) => node.outerHTML.slice(0, 1_500));
      throw new Error(
        `The panel never showed operation ${operationId} as "${wanted}" (last: ${String(shown)}): ${markup}`,
      );
    }
    await delay(250);
  }
}

/** The load-balance detail of a record, or nothing when that record carried no route detail. */
function balanceOf(record: RecordRow): Record<string, unknown> {
  const route = record.model_route;
  if (typeof route !== "object" || route === null) return {};
  const balance = (route as Record<string, unknown>)["load_balance"];
  if (typeof balance !== "object" || balance === null) return {};
  return balance as Record<string, unknown>;
}

/**
 * The traffic database the application wrote, polled until the record of the request that landed
 * at the destination has arrived. Reading it is the only way to compare what the console shows
 * with what the proxy persisted.
 */
async function movedRecordOf(
  logRoot: string,
  operationId: string,
): Promise<{ task: string; records: readonly RecordRow[]; landed: RecordRow }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const repository = new TrafficRepository(logRoot);
    try {
      for (const task of repository.recentTasks(50)) {
        if (task.model !== MODEL) continue;
        const records = repository.listTaskRecords(task.id, "", 20, 0).items;
        const landed = records.find(
          (record) => balanceOf(record)["move_operation_id"] === operationId,
        );
        if (landed !== undefined) {
          return { task: task.id, records, landed };
        }
      }
    } finally {
      repository.close();
    }
    if (Date.now() > deadline) {
      throw new Error("The move the console made never reached the traffic database.");
    }
    await delay(250);
  }
}

/** Wait for a binding this file created: an address the list had not shown before, and - for a
 *  request still being answered - one that says a request is in flight on it. */
async function waitForNewBinding(
  adminPort: number,
  known: ReadonlySet<string>,
  whileInFlight: boolean,
): Promise<LoadBalancerBindingListItem> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const item of (await readTasks(adminPort, undefined)).items) {
      if (known.has(bindingAddress(item))) continue;
      if (whileInFlight && item.inFlight !== 1) continue;
      return item;
    }
    if (Date.now() > deadline) {
      throw new Error("The proxy left no new binding for the console to read.");
    }
    await delay(100);
  }
}

/** Wait until the state gate refuses this binding's move, which is what an id learned from a
 *  response body does. The id is taught after the response ended, so the refusal arrives late. */
async function waitForMoveRefusal(
  adminPort: number,
  created: LoadBalancerBindingListItem,
): Promise<LoadBalancerBindingListItem> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const list = await readTasks(adminPort, undefined);
    const row = list.items.find(
      (item) => item.bindingId === created.bindingId && item.incarnation === created.incarnation,
    );
    if (row !== undefined && !row.movable.ok) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `The binding kept ${JSON.stringify(row?.movable ?? null)}; a response id never taught it a refusal.`,
      );
    }
    await delay(100);
  }
}

/** Wait until the console has re-read the row and shows the server's refusal in the server's words. */
async function waitForMoveReason(row: Locator, wanted: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const shown = await row.evaluate(
      (node) => node.querySelector("[data-lb-binding-move-reasons]")?.textContent ?? "",
    );
    if (shown.includes(wanted)) return;
    if (Date.now() > deadline) {
      const markup = await row.evaluate((node) => node.outerHTML.slice(0, 1_500));
      throw new Error(`The row never showed "${wanted}": ${markup}`);
    }
    await delay(250);
  }
}

async function waitForPayloads(stream: ChatStream, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (stream.payloads().length >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `The streamed answer sent ${String(stream.payloads().length)} frames; ${String(count)} were needed.`,
      );
    }
    await delay(50);
  }
}

async function waitForStreamEnd(stream: ChatStream): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (stream.ended()) return;
    if (Date.now() > deadline) {
      throw new Error("The streamed answer never reached [DONE].");
    }
    await delay(50);
  }
}

describe("[TRI-09] a move made through the real console", () => {
  let root = "";
  let first: Upstream | undefined;
  let second: Upstream | undefined;
  let live: LiveApp | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  /** How many binding lists the page itself has read, so a state the console shows can be
   *  traced to a GET the page performed rather than to a value this file handed it. */
  let consoleReads = 0;

  beforeAll(async () => {
    first = await startUpstream("first");
    second = await startUpstream("second");
    root = await mkdtemp(path.join(tmpdir(), "llm-proxy-move-"));
    live = await startLiveApp(
      root,
      `http://127.0.0.1:${String(first.port)}`,
      `http://127.0.0.1:${String(second.port)}`,
    );
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("response", (response) => {
      if (
        response.url().includes("/api/load-balancer/tasks?") &&
        response.request().method() === "GET"
      ) {
        consoleReads += 1;
      }
    });
    await page.addInitScript(() => {
      localStorage.setItem("llmProxyLanguage", "en");
    });
    await page.goto(`http://127.0.0.1:${String(live.adminPort)}/`);
    // The load-balancing fold lives inside the pair card on the proxies tab, which is the one
    // the page shows first; there is no separate navigation to click.
    await page.waitForSelector(".lb-status", { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await live?.runtime.application.stop();
    await first?.close();
    await second?.close();
    if (root !== "") {
      await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
  }, 60_000);

  function runtime(): {
    first: Upstream;
    second: Upstream;
    live: LiveApp;
    page: Page;
  } {
    if (first === undefined || second === undefined || live === undefined || page === undefined) {
      throw new Error("The live application, the browser or the upstreams did not start.");
    }
    return { first, second, live, page };
  }

  it("LB09-01 a long streamed answer is moved at its boundary and the next request is observed", async () => {
    const { first, second, live, page } = runtime();
    const conversation = "tri09-stream";
    const question = "the long first question";
    // These answers carry no response id. An id would teach the binding a `response:` key, which
    // is what the state gate refuses a later move for; the case after this one shows that.
    first.emitIds(false);
    second.emitIds(false);
    first.holdFirstFrame(true);
    second.holdFirstFrame(true);

    const before = await readTasks(live.adminPort, undefined);
    const known = new Set(before.items.map(bindingAddress));
    const heldStream = await startChatStream(
      live.proxyPort,
      chatBody(conversation, question, true),
    );

    // The request is at a node only when the row says it is: one in flight, on a node this list
    // had not shown before, and one of the two upstreams has been counted.
    const binding = await waitForNewBinding(live.adminPort, known, true);
    const sourceTarget = binding.targetId;
    const destinationTarget = sourceTarget === "node-one" ? "node-two" : "node-one";
    const sourceUpstream = sourceTarget === "node-one" ? first : second;
    const destinationUpstream = sourceTarget === "node-one" ? second : first;

    // The first frame really reached the client through the proxy.
    await waitForPayloads(heldStream, 1);
    expect(heldStream.status).toBe(200);
    expect(heldStream.contentType).toContain("text/event-stream");
    expect(sourceUpstream.chatHits()).toBe(1);
    expect(destinationUpstream.chatHits()).toBe(0);

    await ensureStatusOpen(page);
    const sourcePanel = await openBindingPanel(page, sourceTarget);
    const row = bindingRow(sourcePanel, binding);
    await expectPage(row).toHaveCount(1);
    await expectPage(row).toHaveAttribute("data-lb-binding-node", sourceTarget);
    await expectPage(row.locator('[data-lb-binding-fact="inFlight"]')).toHaveText(
      `In flight: ${String(binding.inFlight)}`,
    );

    // The picker is built from what the list answered: the member that is switched off is named
    // there but cannot be chosen, and the one that can be is this move's destination.
    const options = row.locator(".lb-binding-move-target option");
    await expectPage(options).toHaveCount(3);
    await expectPage(options.nth(0)).toHaveJSProperty("disabled", false);
    await expectPage(options.nth(1)).toHaveJSProperty("disabled", false);
    await expectPage(options.nth(1)).toHaveAttribute("value", destinationTarget);
    await expectPage(options.nth(2)).toHaveJSProperty("disabled", true);
    await expectPage(options.nth(2)).toHaveAttribute("value", "node-off");

    // Neither node has been measured, so the submit stays locked until the person says they
    // accept a destination the console cannot judge.
    const submit = row.locator("[data-lb-binding-move]");
    await expectPage(submit).toBeDisabled();
    await row.locator("[data-lb-binding-move-target]").selectOption(destinationTarget);
    await expectPage(
      row.locator(`.lb-binding-move-target option[value="${destinationTarget}"]`),
    ).toContainText("destination metrics unknown");
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toBeVisible();
    await row.locator("[data-lb-binding-move-confirm]").check();
    await expectPage(submit).toBeEnabled();

    await submit.click();
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".lb-binding-move-notice")?.textContent ?? "";
        return text.includes("Registered; the route changes when the current request ends");
      },
      undefined,
      { timeout: 10_000 },
    );
    const afterSubmit = await readTasks(live.adminPort, sourceTarget);
    const registered = afterSubmit.migrationOperations.filter(
      (item) => item.bindingId === binding.bindingId && item.incarnation === binding.incarnation,
    );
    expect(registered).toHaveLength(1);
    const [recorded] = registered;
    if (recorded === undefined) {
      throw new Error("the list reported an operation without its record");
    }
    const operationId = recorded.operationId;
    expect(recorded.state).toBe("pending_boundary");
    expect(recorded.cancellable).toBe(true);
    expect(recorded.sourceTargetId).toBe(sourceTarget);
    expect(recorded.destinationTargetId).toBe(destinationTarget);
    // The two facts a page has no business seeing stay out of the projection.
    expect(Object.keys(recorded)).not.toContain("requestDigest");
    expect(Object.keys(recorded)).not.toContain("idempotencyKey");

    // Registering the intent wrote nothing and forwarded nothing: the held stream still has one
    // frame, the source is still this binding's node, and only the source has been counted.
    expect(heldStream.payloads()).toHaveLength(1);
    expect(rowOf(afterSubmit, binding).targetId).toBe(sourceTarget);
    expect(sourceUpstream.chatHits()).toBe(1);
    expect(destinationUpstream.chatHits()).toBe(0);
    await waitForOperationState(sourcePanel, operationId, "waiting for the current request");

    // The latch is what ends the response. The released stream runs to [DONE], and its own
    // boundary is what applies the intent.
    first.releaseFrames();
    second.releaseFrames();
    await waitForStreamEnd(heldStream);
    expect(heldStream.payloads()).toHaveLength(STREAM_PARTS.length + 1);
    expect(heldStream.payloads()[STREAM_PARTS.length]).toBe("[DONE]");
    expect(heldStream.answeredText()).toBe(STREAM_PARTS.join(""));
    expect(destinationUpstream.chatHits()).toBe(0);
    expect(sourceUpstream.chatHits()).toBe(1);

    const afterBoundary = await readTasks(live.adminPort, undefined);
    expect(operationOf(afterBoundary, operationId).state).toBe("applied");
    const moved = rowOf(afterBoundary, binding);
    expect(moved.targetId).toBe(destinationTarget);
    expect(moved.routingRevision).toBe(binding.routingRevision + 1);
    expect(moved.requestCount).toBe(1);

    // The console follows the same answer through its own status poll: the source page lost the
    // row the move took away and still shows the record of the move.
    const readsBefore = consoleReads;
    await expectPage(sourcePanel.locator(".lb-binding")).toHaveCount(0);
    await expectPage(sourcePanel.locator("[data-lb-binding-empty]")).toBeVisible();
    await waitForOperationState(sourcePanel, operationId, "route changed, waiting for the next");
    expect(consoleReads).toBeGreaterThan(readsBefore);

    // The next request of the same conversation is the proof: it goes to the node the console
    // named, and only to it. Its response headers are the evidence, so `observed` cannot be
    // claimed before the destination answered. The latch is off now: this answer is the one that
    // has to arrive and finish, not the one held open to give the console a boundary to work at.
    first.holdFirstFrame(false);
    second.holdFirstFrame(false);
    const readsBeforeObserved = consoleReads;
    const followUp = await startChatStream(
      live.proxyPort,
      followUpBody(conversation, question, "the question after the move"),
    );
    expect(followUp.status).toBe(200);
    expect(followUp.contentType).toContain("text/event-stream");
    expect(destinationUpstream.chatHits()).toBe(1);
    expect(sourceUpstream.chatHits()).toBe(1);

    const observed = await readTasks(live.adminPort, undefined);
    expect(operationOf(observed, operationId).state).toBe("observed");
    expect(operationOf(observed, operationId).cancellable).toBe(false);
    await waitForStreamEnd(followUp);
    expect(followUp.payloads()).toHaveLength(STREAM_PARTS.length + 1);
    expect(followUp.answeredText()).toBe(STREAM_PARTS.join(""));

    // The source page still reports the move as seen, with no row of its own left to show it.
    await waitForOperationState(sourcePanel, operationId, "a later request was seen");
    expect(consoleReads).toBeGreaterThan(readsBeforeObserved);
    const destinationPanel = await openBindingPanel(page, destinationTarget);
    await expectPage(bindingRow(destinationPanel, moved)).toHaveCount(1);
    await expectPage(
      bindingRow(destinationPanel, moved).locator('[data-lb-binding-fact="target"]'),
    ).toHaveText(`Target: ${SECOND_NAME}`);

    // The application's own persistence says what the console says, in the product's own field
    // names: a move a person asked for is `manual`, and the record of the request that proved the
    // landing carries the operation, both ends and the revision the write produced.
    const persisted = await movedRecordOf(path.join(root, "logs"), operationId);
    expect(persisted.task).toBeTypeOf("string");
    const landed = balanceOf(persisted.landed);
    expect(landed["moved_to"]).toBe(destinationTarget);
    expect(landed["moved_from"]).toBe(sourceTarget);
    expect(landed["moved_by"]).toBe("manual");
    expect(landed["move_routing_revision"]).toBe(moved.routingRevision);
    expect(landed["move_operation_id"]).toBe(operationId);
    // The request that was moved is the only one whose record says so: the one before it was
    // routed by the load balancer's own choice, not by a write the console asked for.
    const earlier = persisted.records.filter((record) => record !== persisted.landed);
    expect(earlier).toHaveLength(1);
    const [earlierRecord] = earlier;
    if (earlierRecord === undefined) {
      throw new Error("the moved conversation left only one record behind");
    }
    const untouched = balanceOf(earlierRecord);
    expect(untouched["move_operation_id"]).toBeUndefined();
    expect(untouched["moved_to"]).toBeUndefined();
    expect(untouched["moved_by"]).toBeUndefined();
    await access(path.join(root, "logs", "traffic.db"));
  }, 120_000);

  it("LB09-02 a member the server refuses is named in the picker and cannot be chosen", async () => {
    const { first, second, live, page } = runtime();
    const conversation = "tri09-refused";
    // This case reads the gate without writing, and the destination it offers has never been
    // measured - so it needs the same fixtures the move case needs, set up here rather than left
    // over from the case before it.
    first.emitIds(false);
    second.emitIds(false);
    first.holdFirstFrame(false);
    second.holdFirstFrame(false);

    const before = await readTasks(live.adminPort, undefined);
    const known = new Set(before.items.map(bindingAddress));
    const answered = await sendChat(
      live.proxyPort,
      chatBody(conversation, "a question about the switched-off node", false),
    );
    expect(answered.status).toBe(200);
    const binding = await waitForNewBinding(live.adminPort, known, false);
    const otherTarget = binding.targetId === "node-one" ? "node-two" : "node-one";

    // The refusal is the server's, with the server's code, and the eligible member is offered.
    const refusal = binding.movable.destinations.find(
      (destination) => destination.targetId === "node-off",
    );
    if (refusal === undefined) {
      throw new Error("The switched-off member was not listed as a candidate at all.");
    }
    expect(refusal.eligible).toBe(false);
    expect(refusal.reason).toBe("target_disabled");
    // A member that is switched off is never probed, so its numbers are as unknown as the two
    // that are running. The refusal is a separate fact, and it is the one that decides.
    expect(refusal.metricsUnknown).toBe(true);
    const offered = binding.movable.destinations.find(
      (destination) => destination.targetId === otherTarget,
    );
    expect(offered?.eligible).toBe(true);
    expect(offered?.reason).toBeNull();
    expect(binding.movable.ok).toBe(true);
    expect(binding.movable.reasons).toEqual([]);

    await ensureStatusOpen(page);
    const panel = await openBindingPanel(page, binding.targetId);
    const row = bindingRow(panel, binding);
    await expectPage(row).toHaveCount(1);
    const options = row.locator(".lb-binding-move-target option");
    await expectPage(options).toHaveCount(3);
    await expectPage(options.nth(2)).toHaveJSProperty("disabled", true);
    await expectPage(options.nth(2)).toHaveText(/that destination is disabled/);
    await expectPage(row.locator(".lb-binding-move-target")).toHaveValue("");
    // Nothing was chosen, so nothing may be submitted.
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();

    // An unmeasured destination is offered with a warning and has to be accepted on purpose; a
    // refused one never gets that treatment, because it cannot be chosen at all.
    await row.locator(".lb-binding-move-target").selectOption(otherTarget);
    await expectPage(row.locator("[data-lb-binding-move-confirm]")).toBeVisible();
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    await row.locator("[data-lb-binding-move-confirm]").check();
    await expectPage(row.locator("[data-lb-binding-move]")).toBeEnabled();
    // Reading the gate moves nothing: the submit is the only path that writes a route, and this
    // page never uses it, so the binding is still where the load balancer put it.
    const stillHere = await readTasks(live.adminPort, binding.targetId);
    expect(rowOf(stillHere, binding).targetId).toBe(binding.targetId);
    // Reading the gate registers nothing: no record was opened for this binding, and a read that
    // wrote one would be a side effect the list is not allowed to have.
    expect(
      stillHere.migrationOperations.filter(
        (item) => item.bindingId === binding.bindingId && item.incarnation === binding.incarnation,
      ),
    ).toEqual([]);
  }, 60_000);

  it("LB09-03 a response id the engine emitted is what a later move is refused for", async () => {
    const { first, second, live, page } = runtime();
    const conversation = "tri09-response-id";
    first.emitIds(true);
    second.emitIds(true);
    first.holdFirstFrame(false);
    second.holdFirstFrame(false);

    const before = await readTasks(live.adminPort, undefined);
    const known = new Set(before.items.map(bindingAddress));
    const answered = await sendChat(
      live.proxyPort,
      chatBody(conversation, "the answer that carries a response id", false),
    );
    expect(answered.status).toBe(200);
    expect((JSON.parse(answered.body) as { id?: unknown }).id).toBeTypeOf("string");

    const created = await waitForNewBinding(live.adminPort, known, false);
    const refused = await waitForMoveRefusal(live.adminPort, created);
    expect(refused.movable.ok).toBe(false);
    expect(refused.movable.reasons).toEqual(["response_state_dependency"]);
    // The refusal is the binding's own. A candidate is never the node the binding already sits
    // on, and the console offers nothing to pick while the binding itself may not move.
    expect(refused.movable.destinations.map((item) => item.targetId)).not.toContain(
      refused.targetId,
    );

    await ensureStatusOpen(page);
    const panel = await openBindingPanel(page, refused.targetId);
    const row = bindingRow(panel, refused);
    await expectPage(row).toHaveCount(1);
    await waitForMoveReason(row, "addressed through a response id");
    await expectPage(row.locator(".lb-binding-move-target")).toHaveCount(0);
    await expectPage(row.locator("[data-lb-binding-move]")).toBeDisabled();
    // A refusal to move again moves nothing: the route the request was answered on stands.
    expect(refused.targetId).toBe(created.targetId);
  }, 60_000);
});
