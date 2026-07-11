import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createServer, request } from "node:http";
import { memoryUsage, cpuUsage } from "node:process";

import { createRuntimeConfigSnapshot } from "../apps/server/dist/config/schema.js";
import { ProxyServer } from "../apps/server/dist/proxy/proxy-server.js";
import { StorageWriteQueue } from "../apps/server/dist/storage/write-queue.js";

const durationMs = Number(process.env.LLM_PROXY_SSE_BENCHMARK_MS ?? 60_000);
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const cpuStart = cpuUsage();
const heapStart = memoryUsage().heapUsed;
const upstream = createServer((incoming, response) => {
  if (incoming.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => response.write('data: {"type":"tick"}\n\n'), 1_000);
    incoming.once("close", () => clearInterval(timer));
    return;
  }
  incoming.resume();
  incoming.once("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
});
await listen(upstream);
const upstreamPort = upstream.address().port;
const proxyConfig = createRuntimeConfigSnapshot({
  version: 1,
  proxies: [
    {
      id: "benchmark",
      name: "Benchmark",
      enabled: true,
      listenHost: "127.0.0.1",
      listenPort: 0,
      accessLog: false,
      defaultTargetId: "target",
      targets: [{ id: "target", name: "Target", url: `http://127.0.0.1:${upstreamPort}` }],
    },
  ],
}).proxies[0];
const proxy = new ProxyServer({
  host: "127.0.0.1",
  port: 0,
  proxy: proxyConfig,
  maxRequestBodyBytes: 1024 * 1024,
  requestCaptureBytes: 0,
  responseCaptureBytes: 0,
  totalRequestTimeoutMs: durationMs + 10_000,
  agentOptions: { maxSockets: 128, maxFreeSockets: 32 },
});
const proxyPort = (await proxy.start()).port;

const latencies = [];
const jsonStarted = performance.now();
await Promise.all(
  Array.from({ length: 50 }, async () => {
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await jsonRequest(proxyPort);
      latencies.push(performance.now() - started);
    }
  }),
);
const jsonElapsed = performance.now() - jsonStarted;
const sseStarted = performance.now();
const sse = Array.from({ length: 100 }, () => sseRequest(proxyPort, durationMs));
await Promise.all(sse);
const sseElapsed = performance.now() - sseStarted;
const storageStarted = performance.now();
const queue = new StorageWriteQueue(
  { writeTraffic: () => Promise.resolve() },
  { maxPendingCount: 20_000, maxPendingBytes: 20_000_000, maxEventBytes: 2_000 },
);
for (let index = 0; index < 10_000; index += 1)
  queue.enqueue({ record: { id: `benchmark-${index}`, event: "request_finished" }, estimatedBytes: 1_000 });
await queue.drain();
const storageElapsed = performance.now() - storageStarted;
await proxy.stop();
await close(upstream);
eventLoop.disable();
latencies.sort((a, b) => a - b);
const cpu = cpuUsage(cpuStart);
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      json: {
        requests: 1_000,
        elapsedMs: jsonElapsed,
        requestsPerSecond: 1_000 / (jsonElapsed / 1_000),
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99),
      },
      sse: { concurrency: 100, targetDurationMs: durationMs, elapsedMs: sseElapsed },
      storageQueue: {
        events: 10_000,
        elapsedMs: storageElapsed,
        eventsPerSecond: 10_000 / (storageElapsed / 1_000),
        metrics: queue.metrics(),
      },
      resources: {
        eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
        cpuUserMs: cpu.user / 1_000,
        cpuSystemMs: cpu.system / 1_000,
        heapDeltaBytes: memoryUsage().heapUsed - heapStart,
      },
    },
    null,
    2,
  ),
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
function jsonRequest(port) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path: "/json", method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        response.resume();
        response.once("end", resolve);
      },
    );
    outgoing.once("error", reject);
    outgoing.end('{"model":"benchmark","input":"hello"}');
  });
}
function sseRequest(port, duration) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/sse" }, (response) => {
      response.resume();
      setTimeout(() => {
        response.destroy();
        resolve();
      }, duration);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
}
