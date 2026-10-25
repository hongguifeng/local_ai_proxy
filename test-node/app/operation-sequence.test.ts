import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeApplication } from "../../src/app/index.js";
import { TrafficRepository, type RecordRow } from "../../src/persistence/index.js";

/**
 * Operation sequences against the assembled application. Each case drives real
 * admin writes, real listeners and real proxied requests, then asserts on the
 * answers and on what the traffic database really holds - not on log strings.
 * The three families the todo asks for are covered here: going from an empty
 * configuration to a configured one, a settings update that changes observable
 * behaviour, and a failing write that must roll back with nothing half-written.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

interface CapturedUpstreamRequest {
  path: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

interface UpstreamFixture {
  server: http.Server;
  port: number;
  /** Requests the upstream received, in arrival order. */
  seen: () => CapturedUpstreamRequest[];
}

/** An upstream that answers chat completions and records what it was sent. */
async function startUpstream(): Promise<UpstreamFixture> {
  const seen: CapturedUpstreamRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      seen.push({
        path: request.url ?? "",
        body: parseJsonObject(Buffer.concat(chunks).toString("utf8")),
        headers: { ...request.headers },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-sequence",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "pong" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 6,
            total_tokens: 46,
            prompt_tokens_details: { cached_tokens: 10 },
          },
        }),
      );
    });
  });
  const port = await listenServer(server);
  return { server, port, seen: () => seen };
}

/** A request body that may not be JSON at all; the upstream capture never throws on it. */
function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function listenServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Test upstream did not bind to TCP."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

interface PairOptions {
  readonly id: string;
  readonly listenPort: number;
  readonly upstreamPort: number;
  readonly enabled?: boolean;
  readonly stripRequestFields?: string;
}

function targetFixture(
  id: string,
  upstreamPort: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${id}-target`,
    name: `target ${id}`,
    enabled: true,
    target_url: `http://127.0.0.1:${upstreamPort}`,
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: "logs",
    redact_logs: false,
    model_mappings: [],
    model_prices: [],
    ...overrides,
  };
}

function pairFixture(options: PairOptions): Record<string, unknown> {
  return {
    id: options.id,
    name: `pair ${options.id}`,
    enabled: options.enabled ?? true,
    listen_host: "127.0.0.1",
    listen_port: options.listenPort,
    access_log: false,
    default_target_id: `${options.id}-target`,
    load_balancers: [],
    targets: [
      targetFixture(options.id, options.upstreamPort, {
        strip_request_fields: options.stripRequestFields ?? "",
      }),
    ],
  };
}

interface AssembledApp {
  readonly runtime: ReturnType<typeof createNodeApplication>;
  readonly root: string;
  readonly configFile: string;
  readonly logRoot: string;
  readonly adminBase: string;
}

async function startAssembledApp(
  initialPairs: readonly Record<string, unknown>[],
): Promise<AssembledApp> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-sequence-"));
  temporaryRoots.push(root);
  const configFile = path.join(root, "proxies.json");
  await writeFile(configFile, JSON.stringify({ pairs: initialPairs }));
  const runtime = createNodeApplication({
    applicationConfigFile: path.join(root, "llm-proxy.json"),
    configFile,
    logRoot: path.join(root, "logs"),
    host: "127.0.0.1",
    port: 0,
  });
  await runtime.application.start();
  const adminPort = runtime.address()?.port;
  if (adminPort === undefined) {
    throw new Error("Assembled application did not report an admin address.");
  }
  return {
    runtime,
    root,
    configFile,
    logRoot: path.join(root, "logs"),
    adminBase: `http://127.0.0.1:${adminPort}`,
  };
}

function postPairs(
  adminBase: string,
  pairs: readonly Record<string, unknown>[],
): Promise<Response> {
  return fetch(`${adminBase}/api/pairs`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairs }),
  });
}

/** Send a chat completion through a proxy listener and read the answer. */
async function proxiedChat(
  proxyPort: number,
  model: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sequence-secret",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: `hello ${model}` }],
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Every finished record the traffic database holds for one log root. */
function finishedRecords(logRoot: string): readonly RecordRow[] {
  const repository = new TrafficRepository(logRoot);
  try {
    return repository
      .recentTasks(50)
      .flatMap((task) => repository.listTaskRecords(task.id, "", 50, 0).items)
      .filter((record) => record.event === "request_finished");
  } finally {
    repository.close();
  }
}

/** The finished record stored for one request model, which is what a setting change is judged on. */
function finishedRecordFor(logRoot: string, model: string): RecordRow | undefined {
  const repository = new TrafficRepository(logRoot);
  try {
    const task = repository.recentTasks(50).find((row) => row.model === model);
    if (task === undefined) {
      return undefined;
    }
    return repository
      .listTaskRecords(task.id, "", 50, 0)
      .items.find((record) => record.event === "request_finished");
  } finally {
    repository.close();
  }
}

describe("assembled application operation sequences", () => {
  it("[AI-14] goes from an empty configuration to a configured one and answers through it", async () => {
    const app = await startAssembledApp([]);
    const upstream = await startUpstream();
    try {
      // Nothing is configured: the console still answers with legal empty results
      // and no proxy port exists to reach.
      const emptyPairs = await fetch(`${app.adminBase}/api/pairs`);
      expect(emptyPairs.status).toBe(200);
      expect(await emptyPairs.json()).toEqual({ pairs: [] });
      const emptyLogs = await fetch(`${app.adminBase}/api/logs`);
      expect(emptyLogs.status).toBe(200);
      expect((await emptyLogs.json()) as { total: number }).toMatchObject({ total: 0 });

      const listenPort = await availablePort();
      const saved = await postPairs(app.adminBase, [
        pairFixture({ id: "fresh", listenPort, upstreamPort: upstream.port }),
      ]);
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as {
        pairs: { id: string; running: boolean; actual_listen_port: number | null }[];
      };
      expect(savedBody.pairs[0]?.id).toBe("fresh");
      expect(savedBody.pairs[0]?.running).toBe(true);
      const proxyPort = savedBody.pairs[0]?.actual_listen_port;
      expect(proxyPort).toBeTypeOf("number");
      if (typeof proxyPort !== "number") {
        throw new Error("The configured pair did not report a listener port.");
      }

      // The configured state is what the console reads back and what the file holds.
      const readBack = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { id: string; running: boolean }[];
      };
      expect(readBack.pairs.map((pair) => [pair.id, pair.running])).toEqual([["fresh", true]]);
      const persisted = JSON.parse(await readFile(app.configFile, "utf8")) as {
        pairs: { id: string; targets: { target_url: string }[] }[];
      };
      expect(persisted.pairs[0]?.id).toBe("fresh");
      expect(persisted.pairs[0]?.targets[0]?.target_url).toBe(`http://127.0.0.1:${upstream.port}`);

      // The configured listener really serves traffic and really reaches the upstream.
      const answered = await proxiedChat(proxyPort, "sequence-empty-model");
      expect(answered.status).toBe(200);
      expect(answered.body["object"]).toBe("chat.completion");
      expect(upstream.seen().map((request) => request.path)).toEqual(["/v1/chat/completions"]);

      // The log root now exists and holds the finished request.
      await expect.poll(() => finishedRecords(app.logRoot).length, { timeout: 5_000 }).toBe(1);
      const [record] = finishedRecords(app.logRoot);
      expect(record?.status).toBe(200);
      expect(record?.method).toBe("POST");
      expect(record?.path).toBe("/v1/chat/completions");
      expect(record?.proxy_id).toBe("fresh");
      const groups = (await (await fetch(`${app.adminBase}/api/logs`)).json()) as {
        total: number;
        groups: { model: string | null; request_count: number }[];
      };
      expect(groups.total).toBe(1);
      expect(groups.groups[0]).toMatchObject({ model: "sequence-empty-model", request_count: 1 });
    } finally {
      await app.runtime.application.stop();
      await closeServer(upstream.server);
    }
  });

  it("[AI-14] a pair enabled through the admin API starts answering and stops again", async () => {
    const listenPort = await availablePort();
    const upstream = await startUpstream();
    const app = await startAssembledApp([
      pairFixture({ id: "gated", listenPort, upstreamPort: upstream.port, enabled: false }),
    ]);
    try {
      const before = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { running: boolean; actual_listen_port: number | null }[];
      };
      expect(before.pairs[0]?.running).toBe(false);
      expect(before.pairs[0]?.actual_listen_port).toBeNull();
      await expect(fetch(`http://127.0.0.1:${listenPort}/v1/models`)).rejects.toThrow();

      const enabled = await fetch(`${app.adminBase}/api/pairs/gated/enabled`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enabled.status).toBe(200);
      const enabledBody = (await enabled.json()) as {
        pair: { running: boolean; actual_listen_port: number | null };
      };
      expect(enabledBody.pair.running).toBe(true);
      expect(enabledBody.pair.actual_listen_port).toBe(listenPort);

      const answered = await proxiedChat(listenPort, "sequence-enabled-model");
      expect(answered.status).toBe(200);
      expect(upstream.seen()).toHaveLength(1);

      const disabled = await fetch(`${app.adminBase}/api/pairs/gated/enabled`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect((await disabled.json()) as { pair: { running: boolean } }).toMatchObject({
        pair: { running: false },
      });
      await expect(fetch(`http://127.0.0.1:${listenPort}/v1/models`)).rejects.toThrow();

      // Both writes are on disk, and the second one is the state the console reads.
      const persisted = JSON.parse(await readFile(app.configFile, "utf8")) as {
        pairs: { enabled: boolean }[];
      };
      expect(persisted.pairs[0]?.enabled).toBe(false);
      const after = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { enabled: boolean; running: boolean; actual_listen_port: number | null }[];
      };
      expect(after.pairs[0]).toMatchObject({ enabled: false, running: false });
      expect(after.pairs[0]?.actual_listen_port).toBeNull();

      // Only the enabled request was logged; disabling the pair wrote nothing.
      expect(finishedRecords(app.logRoot).map((record) => record.path)).toEqual([
        "/v1/chat/completions",
      ]);
    } finally {
      await app.runtime.application.stop();
      await closeServer(upstream.server);
    }
  });

  it("[AI-14] a request-field setting changes what the next request sends upstream", async () => {
    const listenPort = await availablePort();
    const upstream = await startUpstream();
    const app = await startAssembledApp([
      pairFixture({
        id: "fields",
        listenPort,
        upstreamPort: upstream.port,
        stripRequestFields: "messages",
      }),
    ]);
    try {
      const first = await proxiedChat(listenPort, "sequence-stripped-model");
      expect(first.status).toBe(200);
      // The strip setting is in force: the upstream never received the messages.
      expect(upstream.seen()[0]?.body["messages"]).toBeUndefined();
      expect(upstream.seen()[0]?.body["model"]).toBe("sequence-stripped-model");

      const saved = await postPairs(app.adminBase, [
        pairFixture({ id: "fields", listenPort, upstreamPort: upstream.port }),
      ]);
      expect(saved.status).toBe(200);
      // The listener kept its port: a field change does not move it.
      expect((await saved.json()) as { pairs: { actual_listen_port: number }[] }).toMatchObject({
        pairs: [{ actual_listen_port: listenPort }],
      });

      const second = await proxiedChat(listenPort, "sequence-forwarded-model");
      expect(second.status).toBe(200);
      expect(upstream.seen()[1]?.body["messages"]).toEqual([
        { role: "user", content: "hello sequence-forwarded-model" },
      ]);

      // The database keeps both effects apart: the stripped request stores the body
      // that was forwarded and keeps the client's body as the original, while the
      // request made after the setting was cleared goes through untouched.
      await expect.poll(() => finishedRecords(app.logRoot).length, { timeout: 5_000 }).toBe(2);
      const strippedRecord = finishedRecordFor(app.logRoot, "sequence-stripped-model");
      expect(strippedRecord).toBeDefined();
      expect(strippedRecord?.stripped_fields).toEqual(["messages"]);
      expect(strippedRecord?.request_body).toMatchObject({ model: "sequence-stripped-model" });
      const forwardedBody = strippedRecord?.request_body as Record<string, unknown> | undefined;
      expect(forwardedBody?.["messages"]).toBeUndefined();
      // `original_request_body` is not a declared column: it only appears when the
      // forwarded body differed from the client's, so it is read as an extra key.
      expect(strippedRecord?.["original_request_body"]).toEqual({
        model: "sequence-stripped-model",
        messages: [{ role: "user", content: "hello sequence-stripped-model" }],
      });

      const forwardedRecord = finishedRecordFor(app.logRoot, "sequence-forwarded-model");
      expect(forwardedRecord).toBeDefined();
      expect(forwardedRecord?.stripped_fields).toEqual([]);
      expect(forwardedRecord?.request_body).toMatchObject({
        model: "sequence-forwarded-model",
        messages: [{ role: "user", content: "hello sequence-forwarded-model" }],
      });
      expect(forwardedRecord?.["original_request_body"]).toBeUndefined();

      const after = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { targets: { strip_request_fields: string }[] }[];
      };
      expect(after.pairs[0]?.targets[0]?.strip_request_fields).toBe("");
      const persisted = JSON.parse(await readFile(app.configFile, "utf8")) as {
        pairs: { targets: { strip_request_fields: string }[] }[];
      };
      expect(persisted.pairs[0]?.targets[0]?.strip_request_fields).toBe("");
    } finally {
      await app.runtime.application.stop();
      await closeServer(upstream.server);
    }
  });

  it("[AI-14] an invalid pair write is refused before anything is committed", async () => {
    const listenPort = await availablePort();
    const upstream = await startUpstream();
    const app = await startAssembledApp([
      pairFixture({ id: "keeper", listenPort, upstreamPort: upstream.port }),
    ]);
    try {
      const beforeFile = await readFile(app.configFile, "utf8");
      const beforeHealth = await fetch(`${app.adminBase}/api/health`);
      expect(beforeHealth.status).toBe(200);

      const rejected = await postPairs(app.adminBase, [
        {
          ...pairFixture({ id: "keeper", listenPort, upstreamPort: upstream.port }),
          targets: [targetFixture("keeper", upstream.port, { target_url: "not a url" })],
        },
      ]);
      expect(rejected.status).toBe(400);
      expect((await rejected.json()) as { error?: { code?: string } }).toMatchObject({
        error: { code: "invalid_config" },
      });

      // Nothing half-written: the file is byte-identical, the console still shows
      // the old pair, the listener still answers, and health is still ok.
      expect(await readFile(app.configFile, "utf8")).toBe(beforeFile);
      const pairs = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { id: string; targets: { target_url: string }[] }[];
      };
      expect(pairs.pairs).toHaveLength(1);
      expect(pairs.pairs[0]?.targets[0]?.target_url).toBe(`http://127.0.0.1:${upstream.port}`);
      const answered = await proxiedChat(listenPort, "sequence-after-invalid-write");
      expect(answered.status).toBe(200);
      const health = await fetch(`${app.adminBase}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", applicationState: "running" });
      await expect.poll(() => finishedRecords(app.logRoot).length, { timeout: 5_000 }).toBe(1);
    } finally {
      await app.runtime.application.stop();
      await closeServer(upstream.server);
    }
  });

  it("[AI-14] a listener that cannot bind is rolled back with nothing half-written", async () => {
    const listenPort = await availablePort();
    const squatter = http.createServer((_request, response) => {
      response.writeHead(500);
      response.end("squatter");
    });
    const squatterPort = await listenServer(squatter);
    const upstream = await startUpstream();
    const app = await startAssembledApp([
      pairFixture({ id: "keeper", listenPort, upstreamPort: upstream.port }),
    ]);
    try {
      const beforeFile = await readFile(app.configFile, "utf8");
      const firstRequest = await proxiedChat(listenPort, "sequence-before-conflict");
      expect(firstRequest.status).toBe(200);
      await expect.poll(() => finishedRecords(app.logRoot).length, { timeout: 5_000 }).toBe(1);

      const conflicting = await postPairs(app.adminBase, [
        pairFixture({ id: "keeper", listenPort, upstreamPort: upstream.port }),
        pairFixture({ id: "blocked", listenPort: squatterPort, upstreamPort: upstream.port }),
      ]);
      expect(conflicting.status).toBe(409);
      expect((await conflicting.json()) as { error?: { code?: string } }).toMatchObject({
        error: { code: "listen_conflict" },
      });

      // The pair that could not bind is gone, the pair that was already running
      // kept its listener, and the file was never rewritten.
      const pairs = (await (await fetch(`${app.adminBase}/api/pairs`)).json()) as {
        pairs: { id: string; running: boolean }[];
      };
      expect(pairs.pairs.map((pair) => [pair.id, pair.running])).toEqual([["keeper", true]]);
      expect(await readFile(app.configFile, "utf8")).toBe(beforeFile);
      const health = await fetch(`${app.adminBase}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });

      // The failed write added nothing to the log: the database still holds only
      // the request made before it.
      const groupsAfterRollback = (await (await fetch(`${app.adminBase}/api/logs`)).json()) as {
        total: number;
      };
      expect(groupsAfterRollback.total).toBe(1);

      const afterRollback = await proxiedChat(listenPort, "sequence-after-rollback");
      expect(afterRollback.status).toBe(200);
      await expect.poll(() => finishedRecords(app.logRoot).length, { timeout: 5_000 }).toBe(2);
      // Only the two real requests are stored, and both went through the pair that
      // kept its listener.
      expect(finishedRecords(app.logRoot).map((record) => record.proxy_id)).toEqual([
        "keeper",
        "keeper",
      ]);
      // The squatter still holds its port: the rolled-back listener never took it.
      const squatterAnswer = await fetch(`http://127.0.0.1:${squatterPort}/`);
      expect(squatterAnswer.status).toBe(500);
    } finally {
      await app.runtime.application.stop();
      await closeServer(squatter);
      await closeServer(upstream.server);
    }
  });
});
