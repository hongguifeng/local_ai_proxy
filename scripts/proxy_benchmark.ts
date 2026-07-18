import { once } from "node:events";
import http, { type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";

import { ProxyListener, ProxyRequestPipeline, type TrafficLogWriter } from "../src/proxy/index.js";

const LATENCY_REQUESTS = 100;
const LATENCY_CONCURRENCY = 20;
const MEMORY_RESPONSE_BYTES = 64 * 1024 * 1024;
const MEMORY_CHUNK_BYTES = 64 * 1024;
const MAX_PROXY_P95_MS = 1_000;
const MAX_P95_OVERHEAD_MS = 500;
const MAX_RSS_DELTA_BYTES = 192 * 1024 * 1024;

const upstream = http.createServer((request, response) => {
  if (request.url === "/memory") {
    void writeLargeResponse(response);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
});

const upstreamPort = await listen(upstream);
const trafficLog: TrafficLogWriter = {
  write: () => Promise.resolve(),
  update: () => Promise.resolve(),
};
const pipeline = new ProxyRequestPipeline({
  responseCapture: {
    memoryThresholdBytes: 256 * 1024,
    maxBytes: 1024 * 1024,
  },
  targets: [
    {
      enabled: true,
      id: "benchmark-target",
      modelMappings: [],
      name: "Benchmark target",
      targetScheme: "http",
      targetHost: "127.0.0.1",
      targetPort: upstreamPort,
      targetBasePath: "",
      trafficLog,
    },
  ],
});
const listener = new ProxyListener({
  host: "127.0.0.1",
  port: 0,
  onRequest: (request, response, context) => pipeline.handle(request, response, context),
});
const proxyAddress = await listener.start();

try {
  await Promise.all(
    Array.from({ length: 10 }, () => requestAndDiscard(proxyAddress.port, "/latency")),
  );
  const direct = await latencyRun(upstreamPort);
  const proxy = await latencyRun(proxyAddress.port);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const receivedBytes = await requestAndDiscard(proxyAddress.port, "/memory");
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const result = {
    latency: {
      requests: LATENCY_REQUESTS,
      concurrency: LATENCY_CONCURRENCY,
      direct,
      proxy,
      p95_overhead_ms: round(proxy.p95_ms - direct.p95_ms),
    },
    memory: {
      streamed_response_bytes: receivedBytes,
      response_log_limit_bytes: 1024 * 1024,
      baseline_rss_bytes: baselineRss,
      peak_rss_bytes: peakRss,
      rss_delta_bytes: Math.max(0, peakRss - baselineRss),
    },
    limits: {
      max_proxy_p95_ms: MAX_PROXY_P95_MS,
      max_p95_overhead_ms: MAX_P95_OVERHEAD_MS,
      max_rss_delta_bytes: MAX_RSS_DELTA_BYTES,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    proxy.p95_ms > MAX_PROXY_P95_MS ||
    proxy.p95_ms - direct.p95_ms > MAX_P95_OVERHEAD_MS ||
    result.memory.rss_delta_bytes > MAX_RSS_DELTA_BYTES ||
    receivedBytes !== MEMORY_RESPONSE_BYTES
  ) {
    process.exitCode = 1;
  }
} finally {
  await listener.close();
  await close(upstream);
}

async function latencyRun(port: number): Promise<{
  p50_ms: number;
  p95_ms: number;
  requests_per_second: number;
}> {
  const durations: number[] = [];
  const started = performance.now();
  for (let offset = 0; offset < LATENCY_REQUESTS; offset += LATENCY_CONCURRENCY) {
    await Promise.all(
      Array.from({ length: Math.min(LATENCY_CONCURRENCY, LATENCY_REQUESTS - offset) }, async () => {
        const requestStarted = performance.now();
        await requestAndDiscard(port, "/latency");
        durations.push(performance.now() - requestStarted);
      }),
    );
  }
  const elapsed = performance.now() - started;
  durations.sort((left, right) => left - right);
  return {
    p50_ms: round(percentile(durations, 0.5)),
    p95_ms: round(percentile(durations, 0.95)),
    requests_per_second: round((LATENCY_REQUESTS * 1_000) / elapsed),
  };
}

async function writeLargeResponse(response: ServerResponse): Promise<void> {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  const chunk = Buffer.alloc(MEMORY_CHUNK_BYTES, 0x5a);
  for (let written = 0; written < MEMORY_RESPONSE_BYTES; written += chunk.byteLength) {
    if (!response.write(chunk)) {
      await once(response, "drain");
    }
  }
  response.end();
}

function requestAndDiscard(port: number, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
      });
      response.once("end", () => resolve(received));
      response.once("error", reject);
    });
    request.once("error", reject);
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Benchmark server did not bind to TCP."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
