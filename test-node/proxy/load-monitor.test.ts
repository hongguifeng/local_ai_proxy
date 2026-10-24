import http from "node:http";
import { describe, expect, it } from "vitest";

import {
  createDefaultProxyPair,
  createDefaultTarget,
  type ProxyPair,
  type TargetConfig,
} from "../../src/config/index.js";
import {
  LoadBalancer,
  LoadMonitor,
  METRIC_SAMPLE_INTERVAL_MS,
  taskIdentity,
} from "../../src/proxy/index.js";

type GroupShape = ProxyPair["load_balancers"][number];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a port");
      }
      resolve(address.port);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function target(id: string, url: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    ...createDefaultTarget("logs"),
    id,
    name: id,
    target_url: url,
    ...overrides,
  };
}

function group(
  id: string,
  nodeTargetIds: readonly string[],
  overrides: Partial<GroupShape> = {},
): GroupShape {
  return {
    id,
    name: id,
    enabled: true,
    model_pattern: "Qwen3.8-Flash-Next",
    members: nodeTargetIds.map((targetId) => ({ target_id: targetId, model_id: "" })),
    strategy: "least_load",
    metrics_enabled: true,
    failover_enabled: true,
    ...overrides,
  };
}

function pair(targets: readonly TargetConfig[], groups: readonly GroupShape[]): ProxyPair {
  return {
    ...createDefaultProxyPair("logs"),
    id: "pair-1",
    enabled: true,
    targets: [...targets],
    default_target_id: targets[0]?.id ?? "",
    load_balancers: [...groups],
  };
}

/** A task that carries its own session, so affinity can be observed. */
function identity(sessionId: string, turn = "one") {
  return taskIdentity({
    payload: {
      model: "Qwen3.8-Flash-Next",
      instructions: "rules",
      input: [{ role: "user", content: turn }],
    },
    headers: { "x-claude-code-session-id": [sessionId] },
    path: "/v1/responses",
  });
}

const VLLM_EXPOSITION = `# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="Qwen3.8-Flash-Next"} 3.0
vllm:num_requests_waiting{engine="0",model_name="Qwen3.8-Flash-Next"} 2.0
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8-Flash-Next"} 0.35
`;

/** A metrics endpoint that counts how often it was asked. */
async function startMetricsServer(
  text: string,
): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(text);
  });
  const port = await listen(server);
  return { server, port, requests: () => hits };
}

/** A metrics endpoint that answers late, so an overlapping sample can be observed. */
async function startDelayedMetricsServer(
  text: string,
  delayMs: number,
): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(text);
    }, delayMs);
  });
  const port = await listen(server);
  return { server, port, requests: () => hits };
}

/** An endpoint that refuses the first call and answers the next one. */
async function startFlakyMetricsServer(
  text: string,
): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    if (hits === 1) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("metrics unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(text);
  });
  const port = await listen(server);
  return { server, port, requests: () => hits };
}

/** An endpoint that accepts the connection and never answers. */
async function startHangingServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(() => {
    // No response at all: the client's timeout has to end this.
  });
  const port = await listen(server);
  return { server, port };
}

function collectingLogger(): {
  readonly entries: { level: "info" | "warn"; message: string; context: Record<string, unknown> }[];
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
} {
  const entries: {
    level: "info" | "warn";
    message: string;
    context: Record<string, unknown>;
  }[] = [];
  return {
    entries,
    info(message, context) {
      entries.push({ level: "info", message, context: context ?? {} });
    },
    warn(message, context) {
      entries.push({ level: "warn", message, context: context ?? {} });
    },
  };
}

describe("upstream metrics sampling", () => {
  it("LB08-05 samples one engine once, whatever spelling its targets use", async () => {
    const engine = await startMetricsServer(VLLM_EXPOSITION);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [
          target("target-loopback", `http://127.0.0.1:${engine.port}`),
          target("target-name", `http://localhost:${engine.port}`),
        ],
        [group("lb-metrics", ["target-loopback", "target-name"])],
      ),
    );
    const monitor = new LoadMonitor(balancer, { now: () => 1_000 });
    const result = await monitor.sampleNow();

    expect(result).toEqual({ failed: 0, sampled: 1, skipped: 0 });
    expect(engine.requests()).toBe(1);
    for (const targetId of ["target-loopback", "target-name"]) {
      expect(balancer.sampleFor(targetId)).toEqual({
        awake: undefined,
        kvUsage: 0.35,
        running: 3,
        sampledAt: 1_000,
        source: "vllm",
        waiting: 2,
      });
    }
    // Both spellings resolve to one physical engine, so one sample serves both targets.
    const canonicalKey = balancer.nodeFor("target-loopback")?.canonicalKey ?? "";
    expect(balancer.targetsForCanonicalKey(canonicalKey)).toEqual([
      "target-loopback",
      "target-name",
    ]);
    await close(engine.server);
  });

  it("LB08-06 times out, never overlaps, logs once and cleans up", async () => {
    const logger = collectingLogger();
    const hanging = await startHangingServer();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [target("target-hang", `http://127.0.0.1:${hanging.port}`)],
        [group("lb-hang", ["target-hang"])],
      ),
    );
    const monitor = new LoadMonitor(balancer, { logger, sampleTimeoutMs: 80 });

    const timedOut = await monitor.sampleNow();
    expect(timedOut).toEqual({ failed: 1, sampled: 0, skipped: 0 });
    expect(balancer.sampleFor("target-hang")).toBeUndefined();
    expect(logger.entries.map((entry) => entry.level)).toEqual(["warn"]);
    expect(String(logger.entries[0]?.context["error"])).toContain("timeout");
    // The failure is logged once, not on every tick.
    await monitor.sampleNow();
    expect(logger.entries).toHaveLength(1);

    // A sample already in flight is not started a second time.
    const slow = await startDelayedMetricsServer(VLLM_EXPOSITION, 150);
    balancer.reconfigure(
      pair(
        [target("target-slow", `http://127.0.0.1:${slow.port}`)],
        [group("lb-slow", ["target-slow"])],
      ),
    );
    const monitor2 = new LoadMonitor(balancer, {
      logger: collectingLogger(),
      sampleTimeoutMs: 2_000,
    });
    const first = monitor2.sampleNow();
    const overlapping = await monitor2.sampleNow();
    expect(overlapping.skipped).toBeGreaterThanOrEqual(1);
    expect(await first).toEqual({ failed: 0, sampled: 1, skipped: 0 });
    expect(slow.requests()).toBe(1);
    expect(balancer.sampleFor("target-slow")?.running).toBe(3);

    // Recovery logs exactly one line: the same engine failing and then answering.
    const recoveryLogger = collectingLogger();
    const flaky = await startFlakyMetricsServer(VLLM_EXPOSITION);
    balancer.reconfigure(
      pair(
        [target("target-flaky", `http://127.0.0.1:${flaky.port}`)],
        [group("lb-flaky", ["target-flaky"])],
      ),
    );
    const monitor3 = new LoadMonitor(balancer, { logger: recoveryLogger, sampleTimeoutMs: 500 });
    expect((await monitor3.sampleNow()).failed).toBe(1);
    expect(balancer.sampleFor("target-flaky")).toBeUndefined();
    expect((await monitor3.sampleNow()).sampled).toBe(1);
    expect(recoveryLogger.entries.map((entry) => entry.level)).toEqual(["warn", "info"]);
    expect(balancer.sampleFor("target-flaky")?.running).toBe(3);

    // Timers: the sampling timer never keeps the process alive, and stop removes it.
    const timeouts = (): number =>
      process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const baseline = Math.max(timeouts(), timeouts());
    monitor3.start();
    expect(monitor3.running).toBe(true);
    // An unref'd timer is absent from the active resource list, so the count stays put.
    expect(timeouts()).toBeLessThanOrEqual(baseline);
    monitor3.stop();
    expect(monitor3.running).toBe(false);
    expect(timeouts()).toBeLessThanOrEqual(baseline);
    expect(monitor3.sampleIntervalMs).toBe(METRIC_SAMPLE_INTERVAL_MS);

    await close(hanging.server);
  });

  it("LB08-04 an expired sample is treated as no sample, and sleep only counts while fresh", async () => {
    const awakeEngine = await startMetricsServer(VLLM_EXPOSITION);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [target("target-a", `http://127.0.0.1:${awakeEngine.port}`)],
        [group("lb-stale", ["target-a"])],
      ),
    );
    let now = 1_000;
    const monitor = new LoadMonitor(balancer, { now: () => now });
    await monitor.sampleNow();
    expect(monitor.nodeStatuses()[0]?.stale).toBe(false);
    expect(monitor.nodeStatuses()[0]?.metrics?.kvUsage).toBe(0.35);

    now = 1_000 + 15_001;
    expect(monitor.nodeStatuses()[0]?.stale).toBe(true);
    const aged = balancer.plan({
      group: group("lb-stale", ["target-a"]),
      identity: identity("session-stale"),
      now,
    });
    // Nothing fresh, so the decision carries no engine numbers at all.
    expect(aged?.decision.targetId).toBe("target-a");
    expect(aged?.decision.load).toBe(0);
    expect(aged?.decision.kvUsage).toBeUndefined();
    expect(aged?.decision.metricsSource).toBeUndefined();
    aged?.release();

    // A sleeping engine keeps new tasks away only while its answer is fresh.
    const sleepingEngine = await startMetricsServer(
      `vllm:num_requests_running{engine="0"} 0.0\nvllm:engine_sleep_state{engine="0",sleep_state="awake"} 0.0\n`,
    );
    balancer.reconfigure(
      pair(
        [target("target-a", `http://127.0.0.1:${sleepingEngine.port}`)],
        [group("lb-stale", ["target-a"])],
      ),
    );
    now = 20_000;
    await monitor.sampleNow();
    expect(balancer.sampleFor("target-a")?.awake).toBe(false);
    expect(
      balancer.plan({
        group: group("lb-stale", ["target-a"]),
        identity: identity("session-sleep"),
        now,
      }),
    ).toBeUndefined();

    now = 40_000;
    const revived = balancer.plan({
      group: group("lb-stale", ["target-a"]),
      identity: identity("session-sleep"),
      now,
    });
    expect(revived?.decision.targetId).toBe("target-a");
    revived?.release();

    await close(awakeEngine.server);
    await close(sleepingEngine.server);
  });

  it("LB08-07 selection still works when metrics never arrived", async () => {
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [target("target-a", "http://127.0.0.1:1"), target("target-b", "http://127.0.0.1:1")],
        [group("lb-no-metrics", ["target-a", "target-b"])],
      ),
    );
    const monitor = new LoadMonitor(balancer, { sampleTimeoutMs: 60 });
    expect((await monitor.sampleNow()).failed).toBe(1);
    expect(balancer.sampleFor("target-a")).toBeUndefined();

    // inFlight is the only signal left, and it is enough to spread new tasks.
    balancer.reserve("target-a");
    const first = balancer.plan({
      group: group("lb-no-metrics", ["target-a", "target-b"]),
      identity: identity("session-a"),
    });
    expect(first?.decision.targetId).toBe("target-b");
    expect(first?.decision.metricsSource).toBeUndefined();
    first?.release();
    balancer.release("target-a");
  });
});
