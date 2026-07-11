import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "apps", "web", "dist");
const target = {
  id: "target-1",
  name: "Fixture",
  enabled: true,
  url: "http://127.0.0.1:9999",
  apiKey: { configured: true, masked: "...ture" },
  headers: [],
  stripRequestFields: [],
  injectRequestFields: {},
  timeouts: { connectMs: 10000, responseHeadersMs: 60000, idleMs: 600000 },
  logRoot: "fixture-root",
  redactLogs: true,
  modelMappings: [],
};
let proxies = [
  {
    id: "proxy-1",
    name: "Fixture Proxy",
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort: 1234,
    accessLog: true,
    targets: [target],
    defaultTargetId: target.id,
    runtime: { state: "running", actualListenPort: 1234 },
  },
];
let tasks = [task("task-normal", "responses", "gpt-normal"), task("task-sse", "responses", "gpt-sse")];
tasks.push(
  ...Array.from({ length: 55 }, (_, index) =>
    task(`task-page-${String(index)}`, "responses", `gpt-page-${String(index)}`),
  ),
);

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (url.pathname === "/api/v1/health") return json(response, { status: "ok" });
  if (url.pathname === "/api/v1/proxies" && request.method === "GET") return json(response, { proxies });
  if (url.pathname === "/api/v1/proxies" && request.method === "PUT") {
    const body = await bodyJson(request);
    proxies = body.proxies.map((proxy) => ({
      ...proxy,
      targets: proxy.targets.map(({ apiKey, ...item }) => ({
        ...item,
        apiKey: apiKey.action === "clear" ? { configured: false } : { configured: true, masked: "...ture" },
      })),
      runtime: {
        state: proxy.enabled ? "running" : "configured",
        actualListenPort: proxy.enabled ? proxy.listenPort : null,
      },
    }));
    return json(response, { proxies });
  }
  const enabled = url.pathname.match(/^\/api\/v1\/proxies\/([^/]+)\/enabled$/u);
  if (enabled && request.method === "POST") {
    const body = await bodyJson(request);
    proxies = proxies.map((proxy) =>
      proxy.id === enabled[1]
        ? {
            ...proxy,
            enabled: body.enabled,
            runtime: {
              state: body.enabled ? "running" : "configured",
              actualListenPort: body.enabled ? proxy.listenPort : null,
            },
          }
        : proxy,
    );
    return json(response, { proxies });
  }
  if (url.pathname === "/api/v1/tasks") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const matches = tasks.filter((entry) => JSON.stringify(entry).toLowerCase().includes(query));
    return json(response, {
      total: matches.length,
      limit: 50,
      offset,
      hasMore: offset + 50 < matches.length,
      tasks: matches.slice(offset, offset + 50).map((entry) => ({ logRoot: "fixture-root", task: entry })),
      failures: [],
    });
  }
  const records = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/records$/u);
  if (records) return json(response, { total: 1, limit: 50, offset: 0, hasMore: false, records: [record(records[1])] });
  const detail = url.pathname.match(/^\/api\/v1\/records\/([^/]+)$/u);
  if (detail) return json(response, recordDetail(detail[1]));
  if (url.pathname === "/api/v1/tasks/cleanup" && request.method === "POST") {
    tasks = [];
    return json(response, { results: [{ logRoot: "fixture-root", deletedTasks: 2 }] });
  }
  if (url.pathname === "/api/v1/tasks/export") {
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=fixture.zip",
    });
    return response.end(Buffer.from("PK\u0005\u0006"));
  }
  await staticFile(url.pathname, response);
}).listen(4174, "127.0.0.1");

function task(id, kind, model) {
  return {
    id,
    kind,
    endpoint: "/v1/responses",
    model,
    target: "Fixture",
    startedAt: "2026-07-11T00:00:00.000Z",
    lastSeenAt: "2026-07-11T00:00:00.000Z",
    requestCount: 1,
    pending: false,
  };
}
function record(taskId) {
  return {
    id: `record-${taskId}`,
    taskId,
    sequence: 1,
    event: "request_finished",
    timestamp: "2026-07-11T00:00:00.000Z",
    durationMs: 12,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    errorCode: null,
    messageCount: 1,
    tokenCount: 2,
  };
}
function recordDetail(id) {
  const base = record(id.replace("record-", ""));
  const empty = { kind: "empty", observedBytes: 0, capturedBytes: 0, truncated: false };
  return {
    ...base,
    id,
    client: { host: "127.0.0.1", port: 5000 },
    proxy: { id: "proxy-1", name: "Fixture Proxy" },
    target: { id: "target-1", name: "Fixture", url: "http://127.0.0.1:9999" },
    request: { headers: {}, body: empty },
    response: {
      headers: { "content-type": [id.includes("sse") ? "text/event-stream" : "application/json"] },
      body: empty,
    },
  };
}
function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function staticFile(pathname, response) {
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/u, "");
  const file = join(root, relative);
  if (!file.startsWith(root)) {
    response.writeHead(404);
    return response.end();
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not file");
    response.writeHead(200, { "content-type": mime(extname(file)) });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404);
    response.end();
  }
}
function mime(extension) {
  return extension === ".html"
    ? "text/html"
    : extension === ".js"
      ? "text/javascript"
      : extension === ".css"
        ? "text/css"
        : "application/octet-stream";
}
