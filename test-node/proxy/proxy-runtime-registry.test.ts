import http, { type ServerResponse } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { ProxyPair } from "../../src/config/index.js";
import { ProxyRuntimeRegistry } from "../../src/proxy/index.js";
import { TrafficRepository } from "../../src/persistence/index.js";
import { isRecord } from "../../src/shared/index.js";

describe("ProxyRuntimeRegistry", () => {
  it("starts a pair and serves traffic on its actual port", async () => {
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`upstream ${request.url}`);
    });
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry();
    const pair = pairFixture(upstreamPort);

    try {
      expect(registry.publicPair(pair)).toMatchObject({
        id: pair.id,
        running: false,
        actual_listen_port: null,
      });
      const started = await registry.startPair(pair);
      expect(started).toMatchObject({ state: "running", running: true });
      expect(started.actualListenPort).toBeTypeOf("number");
      expect(registry.publicPair(pair)).toMatchObject({
        id: pair.id,
        running: true,
        actual_listen_port: started.actualListenPort,
      });
      await expect(requestText(started.actualListenPort ?? 0, "/runtime-start")).resolves.toBe(
        "upstream /runtime-start",
      );
      expect(await registry.startPair(pair)).toEqual(started);
      const stopped = await registry.stopPair(pair.id);
      expect(stopped).toEqual({
        state: "stopped",
        running: false,
        actualListenPort: null,
        error: undefined,
      });
      expect(registry.publicPair(pair)).toMatchObject({
        running: false,
        actual_listen_port: null,
      });
      await expect(requestText(started.actualListenPort ?? 0, "/after-stop")).rejects.toBeDefined();
      expect(await registry.stopPair(pair.id)).toEqual(stopped);
    } finally {
      await registry.stopPair(pair.id);
      await close(upstream);
    }
  });

  it("restarts a pair with updated target configuration", async () => {
    const firstUpstream = http.createServer((_request, response) => response.end("first"));
    const secondUpstream = http.createServer((_request, response) => response.end("second"));
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const registry = new ProxyRuntimeRegistry();
    const firstPair = pairFixture(firstPort);

    try {
      const firstRuntime = await registry.startPair(firstPair);
      await expect(requestText(firstRuntime.actualListenPort ?? 0, "/restart")).resolves.toBe(
        "first",
      );
      const restarted = await registry.restartPair(pairFixture(secondPort));
      expect(restarted).toMatchObject({ state: "running", running: true });
      await expect(requestText(restarted.actualListenPort ?? 0, "/restart")).resolves.toBe(
        "second",
      );
    } finally {
      await registry.stopPair(firstPair.id);
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
    }
  });

  it("reloads a pair in place and keeps in-flight requests on the old configuration", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstUpstream = http.createServer((_request, response) => {
      markStarted?.();
      void gate.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("old upstream");
      });
    });
    const secondUpstream = http.createServer((_request, response) => response.end("new upstream"));
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-runtime-reload-"));
    const registry = new ProxyRuntimeRegistry();
    const pair = withLogRoot(pairFixture(firstPort, "reload-pair"), logRoot);
    const runtime = await registry.startPair(pair);
    const listenPort = runtime.actualListenPort ?? 0;
    const inFlight = requestText(listenPort, "/reload-inflight");

    try {
      await started;
      expect(registry.diagnostics()).toEqual({
        activeRequests: 1,
        resourcePairs: 1,
        runningPairs: 1,
      });

      const reloaded = await registry.reloadPair(
        withLogRoot(pairFixture(secondPort, "reload-pair"), logRoot),
      );
      expect(reloaded).toEqual({
        state: "running",
        running: true,
        actualListenPort: listenPort,
        error: undefined,
      });
      await expect(requestText(listenPort, "/reload-new")).resolves.toBe("new upstream");
      // The request that started before the reload is still running on the superseded pipeline.
      await expect
        .poll(() => registry.diagnostics(), { timeout: 5_000 })
        .toEqual({ activeRequests: 1, resourcePairs: 1, runningPairs: 1 });

      release?.();
      await expect(inFlight).resolves.toBe("old upstream");
      await expect.poll(() => registry.diagnostics().activeRequests, { timeout: 5_000 }).toBe(0);

      const repository = new TrafficRepository(logRoot);
      try {
        const events = new Set(
          [...repository.recentTasks(10)].flatMap((task) => {
            const taskId = task["id"];
            return typeof taskId === "string"
              ? repository.listTaskRecords(taskId).items.map((record) => String(record["event"]))
              : [];
          }),
        );
        expect(events).toContain("request_finished");
      } finally {
        repository.close();
      }
    } finally {
      await registry.stopAll();
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
      await rm(logRoot, { force: true, recursive: true });
    }
  });

  it("closes the superseded log store once a reload drains", async () => {
    const upstream = http.createServer((_request, response) => response.end("drained"));
    const upstreamPort = await listen(upstream);
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-drain-first-"));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-drain-second-"));
    const registry = new ProxyRuntimeRegistry();
    const pair = withLogRoot(pairFixture(upstreamPort, "drain-pair"), firstRoot);
    const runtime = await registry.startPair(pair);
    const listenPort = runtime.actualListenPort ?? 0;

    try {
      await expect(requestText(listenPort, "/drain-a")).resolves.toBe("drained");
      await registry.reloadPair(withLogRoot(pairFixture(upstreamPort, "drain-pair"), secondRoot));
      await expect(requestText(listenPort, "/drain-b")).resolves.toBe("drained");
      expect(registry.diagnostics()).toEqual({
        activeRequests: 0,
        resourcePairs: 1,
        runningPairs: 1,
      });
      await expect
        .poll(
          async () => {
            try {
              await rm(firstRoot, { force: true, recursive: true });
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      await expect(access(path.join(secondRoot, "traffic.db"))).resolves.toBeUndefined();
    } finally {
      await registry.stopAll();
      await close(upstream);
      await rm(firstRoot, { force: true, recursive: true });
      await rm(secondRoot, { force: true, recursive: true });
    }
  });

  it("keeps a pending priced request untouched when a reload reuses its log store", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstUpstream = http.createServer((_request, response) => {
      markStarted?.();
      void gate.then(() => sendChatCompletion(response));
    });
    const secondUpstream = http.createServer((_request, response) => {
      sendChatCompletion(response);
    });
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-reload-pricing-"));
    const registry = new ProxyRuntimeRegistry();
    const pair = withPricing(withLogRoot(pairFixture(firstPort, "pricing-pair"), logRoot));
    const runtime = await registry.startPair(pair);
    const listenPort = runtime.actualListenPort ?? 0;
    const inFlight = postJson(listenPort, "/chat/completions", {
      model: "gpt-reuse",
      messages: [{ role: "user", content: "hello" }],
    });

    try {
      await started;
      const repository = new TrafficRepository(logRoot);
      try {
        await expect.poll(() => pricingStatus(repository), { timeout: 5_000 }).toBe("pending");
        await registry.reloadPair(
          withPricing(withLogRoot(pairFixture(secondPort, "pricing-pair"), logRoot)),
        );
        // The store was reused, so the in-flight row was not marked as interrupted.
        expect(pricingStatus(repository)).toBe("pending");
        release?.();
        await expect(inFlight).resolves.toContain("gpt-reuse");
        await expect.poll(() => pricingStatus(repository), { timeout: 5_000 }).toBe("priced");
      } finally {
        repository.close();
      }
    } finally {
      await registry.stopAll();
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
      await rm(logRoot, { force: true, recursive: true });
    }
  });

  it("starts a stopped pair when it is reloaded", async () => {
    const upstream = http.createServer((_request, response) => response.end("cold reload"));
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry();
    const pair = pairFixture(upstreamPort, "cold-reload-pair");

    try {
      expect(registry.status(pair.id).state).toBe("stopped");
      const reloaded = await registry.reloadPair(pair);
      expect(reloaded).toMatchObject({ state: "running", running: true });
      await expect(requestText(reloaded.actualListenPort ?? 0, "/cold")).resolves.toBe(
        "cold reload",
      );
    } finally {
      await registry.stopAll();
      await close(upstream);
    }
  });

  it("starts enabled pairs and stops all registered runtimes", async () => {
    const upstream = http.createServer((_request, response) => response.end("batch"));
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry();
    const first = pairFixture(upstreamPort, "enabled-one");
    const second = pairFixture(upstreamPort, "enabled-two");
    const disabled = { ...pairFixture(upstreamPort, "disabled"), enabled: false };

    try {
      const started = await registry.startEnabled([first, disabled, second]);
      expect([...started.started.keys()]).toEqual(["enabled-one", "enabled-two"]);
      expect(started.failed.size).toBe(0);
      expect(registry.status(first.id).running).toBe(true);
      expect(registry.status(second.id).running).toBe(true);
      expect(registry.status(disabled.id).state).toBe("stopped");

      await registry.stopAll();
      expect(registry.status(first.id).state).toBe("stopped");
      expect(registry.status(second.id).state).toBe("stopped");
    } finally {
      await registry.stopAll();
      await close(upstream);
    }
  });

  it("continues starting other pairs when one listener fails", async () => {
    const upstream = http.createServer((_request, response) => response.end("isolated"));
    const blocker = http.createServer();
    const [upstreamPort, occupiedPort] = await Promise.all([listen(upstream), listen(blocker)]);
    const registry = new ProxyRuntimeRegistry();
    const failing = { ...pairFixture(upstreamPort, "failing"), listen_port: occupiedPort };
    const healthy = pairFixture(upstreamPort, "healthy");

    try {
      const result = await registry.startEnabled([failing, healthy]);
      expect(result.failed.get(failing.id)).toMatchObject({ code: "EADDRINUSE" });
      expect(result.started.get(healthy.id)).toMatchObject({ state: "running" });
      expect(registry.status(failing.id).state).toBe("failed");
      await expect(
        requestText(result.started.get(healthy.id)?.actualListenPort ?? 0, "/isolated"),
      ).resolves.toBe("isolated");
    } finally {
      await registry.stopAll();
      await Promise.all([close(upstream), close(blocker)]);
    }
  });

  it("waits for active requests before the graceful shutdown timeout", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = http.createServer((_request, response) => {
      markStarted?.();
      void gate.then(() => response.end("graceful"));
    });
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry({ shutdownTimeoutMs: 500 });
    const pair = pairFixture(upstreamPort, "graceful");
    const runtime = await registry.startPair(pair);
    const client = requestText(runtime.actualListenPort ?? 0, "/graceful");

    try {
      await started;
      const stopping = registry.stopPair(pair.id);
      release?.();
      await expect(client).resolves.toBe("graceful");
      await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    } finally {
      await registry.stopAll();
      await close(upstream);
    }
  });

  it("forces hung requests closed after the shutdown timeout", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const upstream = http.createServer((_request, response) => {
      markStarted?.();
      response.once("close", () => markClosed?.());
    });
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry({ shutdownTimeoutMs: 20 });
    const pair = pairFixture(upstreamPort, "timeout");
    const runtime = await registry.startPair(pair);
    const client = requestText(runtime.actualListenPort ?? 0, "/timeout").catch(() => "aborted");

    try {
      await started;
      const stopStarted = performance.now();
      await expect(registry.stopPair(pair.id)).resolves.toMatchObject({ state: "stopped" });
      expect(performance.now() - stopStarted).toBeLessThan(500);
      await closed;
      expect(await client).toBe("aborted");
    } finally {
      await registry.stopAll();
      await close(upstream);
    }
  });

  it("releases sockets, timers, active requests, and log databases after stop all", async () => {
    const upstream = http.createServer((_request, response) => response.end("cleanup"));
    const upstreamPort = await listen(upstream);
    const portReservation = http.createServer();
    const fixedPort = await listen(portReservation);
    await close(portReservation);
    const logRoot = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-runtime-cleanup-"));
    const basePair = pairFixture(upstreamPort, "cleanup");
    const pair: ProxyPair = {
      ...basePair,
      listen_port: fixedPort,
      targets: basePair.targets.map((target) => ({ ...target, log_root: logRoot })),
    };
    const timeoutCountBefore = activeResourceCount("Timeout");
    const registry = new ProxyRuntimeRegistry({ shutdownTimeoutMs: 100 });

    try {
      await registry.startPair(pair);
      await expect(requestText(fixedPort, "/cleanup")).resolves.toBe("cleanup");
      expect(registry.diagnostics()).toEqual({
        activeRequests: 0,
        resourcePairs: 1,
        runningPairs: 1,
      });
      await registry.stopAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(registry.diagnostics()).toEqual({
        activeRequests: 0,
        resourcePairs: 0,
        runningPairs: 0,
      });
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timeoutCountBefore);

      const rebound = http.createServer();
      await expect(listenOn(rebound, fixedPort)).resolves.toBeUndefined();
      await close(rebound);
      await rm(logRoot, { force: true, recursive: true });
      await expect(access(logRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await registry.stopAll();
      await close(upstream);
      await rm(logRoot, { force: true, recursive: true });
    }
  });
});

function pairFixture(upstreamPort: number, pairId = "runtime-pair"): ProxyPair {
  return {
    id: pairId,
    name: "Runtime pair",
    enabled: true,
    listen_host: "127.0.0.1",
    listen_port: 0,
    access_log: false,
    default_target_id: "runtime-target",
    targets: [
      {
        id: "runtime-target",
        name: "Runtime target",
        enabled: true,
        target_url: `http://127.0.0.1:${upstreamPort}`,
        target_api_key: "",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        log_root: "",
        redact_logs: false,
        model_mappings: [],
        model_prices: [],
      },
    ],
  };
}

function withLogRoot(pair: ProxyPair, logRoot: string): ProxyPair {
  return {
    ...pair,
    targets: pair.targets.map((target) => ({ ...target, log_root: logRoot })),
  };
}

function withPricing(pair: ProxyPair): ProxyPair {
  return {
    ...pair,
    targets: pair.targets.map((target) => ({
      ...target,
      model_prices: [
        {
          model_pattern: "gpt-reuse",
          input_per_million: "1",
          output_per_million: "1",
          cache_read_per_million: "1",
          cache_write_per_million: "1",
        },
      ],
    })),
  };
}

function sendChatCompletion(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-reload",
      object: "chat.completion",
      model: "gpt-reuse",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "reloaded" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

function postJson(port: number, requestPath: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

/** Pricing status of the newest record of the most recently seen task. */
function pricingStatus(repository: TrafficRepository): string {
  const taskId = repository.recentTasks(1)[0]?.["id"];
  if (typeof taskId !== "string") {
    return "no-task";
  }
  const pricing = repository.listTaskRecords(taskId).items[0]?.["pricing"];
  if (!isRecord(pricing)) {
    return "no-pricing";
  }
  const status = pricing["pricing_status"];
  return typeof status === "string" ? status : "no-status";
}

function requestText(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Runtime test server did not bind."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function activeResourceCount(type: string): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === type).length;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
