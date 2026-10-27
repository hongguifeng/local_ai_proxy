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
  type RebalanceGroupView,
  type RebalanceSuggestionView,
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
    rebalance_mode: "off",
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

const IDLE_EXPOSITION = `# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="Qwen3.8-Flash-Next"} 0.0
vllm:num_requests_waiting{engine="0",model_name="Qwen3.8-Flash-Next"} 0.0
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8-Flash-Next"} 0.1
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

/**
 * A metrics endpoint whose answer the test can flip. Used to end a live suggestion on purpose,
 * so the shape of a terminal log line is proven by the test instead of left to timing.
 */
async function startSwitchableMetricsServer(text: string): Promise<{
  server: http.Server;
  port: number;
  requests: () => number;
  set(next: string): void;
}> {
  let current = text;
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(current);
  });
  const port = await listen(server);
  return {
    server,
    port,
    requests: () => hits,
    set: (next: string): void => {
      current = next;
    },
  };
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
        sampleSequence: 1,
        sampledAt: 1_000,
        source: "vllm",
        waiting: 2,
      });
    }
    // Both spellings resolve to one physical engine, so one sample serves both targets and
    // both carry the same read number: one engine, one sample, whatever the alias count.
    expect(balancer.sampleFor("target-loopback")?.sampleSequence).toBe(
      balancer.sampleFor("target-name")?.sampleSequence,
    );
    expect(balancer.sampleFor("target-loopback")).toBe(balancer.sampleFor("target-name"));
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

describe("[TRI-03] metric completeness through the sampler", () => {
  /** An engine that answers the cache share and nothing else. */
  const KV_ONLY = `# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8-Flash-Next"} 0.35
`;

  /** An engine that says, in so many words, that it is idle. */
  const REPORTED_ZEROS = `vllm:num_requests_running{engine="0"} 0.0
vllm:num_requests_waiting{engine="0"} 0.0
`;

  /** One number readable, one not, cache share present. */
  const PARTIAL = `vllm:num_requests_running{engine="0"} 2.0
vllm:num_requests_waiting{engine="0"} NaN
vllm:kv_cache_usage_perc{engine="0"} 0.5
`;

  /** A 200 that is not an exposition at all. */
  const NOT_METRICS = "<html><body>502 Bad Gateway</body></html>\n";

  /** A sleep report with no load numbers behind it. */
  const SLEEP_WITHOUT_LOAD = `vllm:kv_cache_usage_perc{engine="0"} 0.35
vllm:engine_sleep_state{engine="0",sleep_state="awake"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="weights_offloaded"} 1.0
`;

  function singleTargetPair(url: string): ProxyPair {
    return pair([target("target-a", url)], [group("lb-tri-03", ["target-a"])]);
  }

  it("leaves the numbers an engine skipped missing, and shows them as unknown", async () => {
    const engine = await startMetricsServer(KV_ONLY);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(singleTargetPair(`http://127.0.0.1:${engine.port}`));
    const monitor = new LoadMonitor(balancer, { now: () => 1_000 });
    expect((await monitor.sampleNow()).sampled).toBe(1);

    // This is the probe the task asks to keep: the stored sample reports the missing fields
    // as missing, not as the zero an auto strategy would read as an idle node.
    expect(balancer.sampleFor("target-a")).toMatchObject({
      kvUsage: 0.35,
      running: undefined,
      sampleSequence: 1,
      sampledAt: 1_000,
      source: "vllm",
      waiting: undefined,
    });
    expect(balancer.sampleFor("target-a")?.running).toBeUndefined();

    const status = monitor.nodeStatuses()[0];
    // A partial answer is still a sample, so the console must not call it "no sample", and
    // must not call the unanswered fields zero either.
    expect(status?.metrics).not.toBeNull();
    expect(status?.metrics?.running).toBeNull();
    expect(status?.metrics?.waiting).toBeNull();
    expect(status?.metrics?.kvUsage).toBe(0.35);
    expect(status?.metrics?.source).toBe("vllm");
    expect(status?.stale).toBe(false);
    await close(engine.server);
  });

  it("keeps a reported zero apart from an unanswered field on the same pair", async () => {
    const idleEngine = await startMetricsServer(REPORTED_ZEROS);
    const quietEngine = await startMetricsServer(KV_ONLY);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [
          target("target-idle", `http://127.0.0.1:${idleEngine.port}`),
          target("target-quiet", `http://127.0.0.1:${quietEngine.port}`),
        ],
        [group("lb-tri-03", ["target-idle", "target-quiet"])],
      ),
    );
    const monitor = new LoadMonitor(balancer, { now: () => 2_000 });
    expect((await monitor.sampleNow()).sampled).toBe(2);

    const idle = monitor.nodeStatuses().find((status) => status.targetId === "target-idle");
    const quiet = monitor.nodeStatuses().find((status) => status.targetId === "target-quiet");
    expect(idle?.metrics?.running).toBe(0);
    expect(idle?.metrics?.waiting).toBe(0);
    expect(quiet?.metrics?.running).toBeNull();
    expect(quiet?.metrics?.waiting).toBeNull();
    // The zero came from the engine, the null did not: only the first may say "idle".
    expect(balancer.sampleFor("target-idle")?.running).toBe(0);
    expect(balancer.sampleFor("target-quiet")?.running).toBeUndefined();
    await close(idleEngine.server);
    await close(quietEngine.server);
  });

  it("reports one readable and one broken number as a partial answer, not a full one", async () => {
    const engine = await startMetricsServer(PARTIAL);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(singleTargetPair(`http://127.0.0.1:${engine.port}`));
    const monitor = new LoadMonitor(balancer, { now: () => 3_000 });
    expect((await monitor.sampleNow()).sampled).toBe(1);

    expect(balancer.sampleFor("target-a")?.running).toBe(2);
    expect(balancer.sampleFor("target-a")?.waiting).toBeUndefined();
    const status = monitor.nodeStatuses()[0];
    expect(status?.metrics?.running).toBe(2);
    expect(status?.metrics?.waiting).toBeNull();
    expect(status?.metrics?.kvUsage).toBe(0.5);
    expect(status?.stale).toBe(false);
    await close(engine.server);
  });

  it("numbers every accepted read of an engine once, shared by its target aliases", async () => {
    const engine = await startMetricsServer(VLLM_EXPOSITION);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      pair(
        [
          target("target-loopback", `http://127.0.0.1:${engine.port}`),
          target("target-name", `http://localhost:${engine.port}`),
        ],
        [group("lb-tri-03", ["target-loopback", "target-name"])],
      ),
    );
    const monitor = new LoadMonitor(balancer, { now: () => 4_000 });

    await monitor.sampleNow();
    expect(balancer.sampleFor("target-loopback")?.sampleSequence).toBe(1);
    expect(balancer.sampleFor("target-name")?.sampleSequence).toBe(1);

    await monitor.sampleNow();
    expect(engine.requests()).toBe(2);
    expect(balancer.sampleFor("target-loopback")?.sampleSequence).toBe(2);
    expect(balancer.sampleFor("target-name")?.sampleSequence).toBe(2);
    await close(engine.server);

    // A read that failed produced no sample, so it spent no number: the next accepted read
    // carries the next number after the last sample, not one per HTTP attempt.
    const flaky = await startFlakyMetricsServer(VLLM_EXPOSITION);
    balancer.reconfigure(singleTargetPair(`http://127.0.0.1:${flaky.port}`));
    const monitor2 = new LoadMonitor(balancer, { now: () => 4_500 });
    expect((await monitor2.sampleNow()).failed).toBe(1);
    expect(balancer.sampleFor("target-a")).toBeUndefined();
    expect((await monitor2.sampleNow()).sampled).toBe(1);
    expect(balancer.sampleFor("target-a")?.sampleSequence).toBe(1);
    await close(flaky.server);
  });

  it("treats a body that is not an exposition as no evidence at all", async () => {
    const good = await startMetricsServer(VLLM_EXPOSITION);
    const html = await startMetricsServer(NOT_METRICS);
    const balancer = new LoadBalancer("pair-1");
    let url = `http://127.0.0.1:${good.port}`;
    balancer.reconfigure(singleTargetPair(url));
    const monitor = new LoadMonitor(balancer, { now: () => 5_000 });
    await monitor.sampleNow();
    expect(balancer.sampleFor("target-a")?.running).toBe(3);

    // Same engine address, same HTTP success, no exposition: the node goes back to unknown
    // rather than keeping numbers that no longer describe it or inventing empty ones.
    url = `http://127.0.0.1:${html.port}`;
    balancer.reconfigure(singleTargetPair(url));
    expect((await monitor.sampleNow()).sampled).toBe(1);
    expect(balancer.sampleFor("target-a")).toBeUndefined();
    const status = monitor.nodeStatuses()[0];
    expect(status?.metrics).toBeNull();
    expect(status?.stale).toBe(true);

    // Recovery reports the next read number of that engine, so an old sample is never
    // confused with a new one, and the failed-looking read in between spent nothing.
    balancer.reconfigure(singleTargetPair(`http://127.0.0.1:${good.port}`));
    expect((await monitor.sampleNow()).sampled).toBe(1);
    expect(balancer.sampleFor("target-a")?.sampleSequence).toBe(2);
    await close(good.server);
    await close(html.server);
  });

  it("keeps a sleeping engine out of selection even when it answered no load numbers", async () => {
    const engine = await startMetricsServer(SLEEP_WITHOUT_LOAD);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(singleTargetPair(`http://127.0.0.1:${engine.port}`));
    const monitor = new LoadMonitor(balancer, { now: () => 6_000 });
    await monitor.sampleNow();

    expect(balancer.sampleFor("target-a")?.awake).toBe(false);
    expect(balancer.sampleFor("target-a")?.running).toBeUndefined();
    expect(
      balancer.plan({
        group: group("lb-tri-03", ["target-a"]),
        identity: identity("session-tri-03"),
        now: 6_000,
      }),
    ).toBeUndefined();
    await close(engine.server);
  });
});

// -------------------------------------------------------------------------------- [TRI-10]

const ADV_GROUP = "lb-adv";
const ADV_MEMBERS = ["target-a", "target-b", "target-c"];

/**
 * The exact keys a suggestion log line is allowed to carry. A line that announces a new
 * suggestion carries these seven; a line that reports one ended adds `stateReason` and nothing
 * else. Both are asserted exactly, so a widened set is a failing test, not a relaxed one.
 */
const SUGGESTION_LOG_KEYS = [
  "bindingId",
  "destinationTargetId",
  "groupId",
  "incarnation",
  "sourceTargetId",
  "stableSamples",
  "suggestionId",
].sort();

const TERMINAL_SUGGESTION_LOG_KEYS = [...SUGGESTION_LOG_KEYS, "stateReason"].sort();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One busy engine and two quiet ones, each its own physical key. */
async function startAdvisorTrio(): Promise<{
  busy: { server: http.Server; port: number; requests: () => number };
  idleB: { server: http.Server; port: number; requests: () => number };
  idleC: { server: http.Server; port: number; requests: () => number };
}> {
  const [busy, idleB, idleC] = await Promise.all([
    startMetricsServer(VLLM_EXPOSITION),
    startMetricsServer(IDLE_EXPOSITION),
    startMetricsServer(IDLE_EXPOSITION),
  ]);
  return { busy, idleB, idleC };
}

async function closeTrio(trio: Awaited<ReturnType<typeof startAdvisorTrio>>): Promise<void> {
  await Promise.all([close(trio.busy.server), close(trio.idleB.server), close(trio.idleC.server)]);
}

function advisorPair(
  ports: { busy: number; idleB: number; idleC: number },
  rebalanceMode: GroupShape["rebalance_mode"],
  groupOverrides: Partial<GroupShape> = {},
): ProxyPair {
  return pair(
    [
      target("target-a", `http://127.0.0.1:${ports.busy}`),
      target("target-b", `http://127.0.0.1:${ports.idleB}`),
      target("target-c", `http://127.0.0.1:${ports.idleC}`),
    ],
    [group(ADV_GROUP, ADV_MEMBERS, { rebalance_mode: rebalanceMode, ...groupOverrides })],
  );
}

/**
 * A binding that sits on the busy engine with everything the advisor may look at: a real
 * request boundary (zero in flight afterwards), a body size and a complete usage signal.
 * The route it proves is the one the request path already made; the advisor changes none.
 */
function bindOnBusyEngine(balancer: LoadBalancer, sessionId: string, turn = "one"): void {
  const table = balancer.tableFor(ADV_GROUP);
  if (table === undefined) {
    throw new Error("An enabled group must have an affinity table.");
  }
  const binding = table.bind(identity(sessionId, turn), "target-a");
  const ref = balancer.bindingRefFor(ADV_GROUP, binding);
  balancer.noteBindingRequestBytes(ref, 2_048);
  balancer.recordBindingUsage(ref, {
    status: "complete",
    endpoint: "responses",
    inputTokens: 1_840,
    cacheReadTokens: 900,
  });
  const reservation = balancer.plan({
    group: group(ADV_GROUP, ADV_MEMBERS),
    identity: identity(sessionId, turn),
  });
  // The bound task must route to the engine it was bound to; if it did not, the fixture
  // is wrong and every advice assertion below would be testing the wrong premise.
  expect(reservation?.decision.targetId).toBe("target-a");
  reservation?.release();
}

/** Watch the monitor's own tick until the advisor answers something for one group. */
async function waitForAdvice(
  monitor: LoadMonitor,
  groupId: string,
  timeoutMs = 5_000,
): Promise<RebalanceSuggestionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = monitor.rebalanceViews().find((item) => item.groupId === groupId);
    const live = view?.suggestions.find((suggestion) => suggestion.state === "suggested");
    if (live !== undefined) {
      return live;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No advice within ${timeoutMs} ms. Views: ${JSON.stringify(monitor.rebalanceViews())}`,
      );
    }
    await sleep(20);
  }
}

async function waitForNoAdvice(monitor: LoadMonitor, groupId: string): Promise<RebalanceGroupView> {
  await sleep(120); // Several ticks at the test's 25 ms sampling interval.
  const view = monitor.rebalanceViews().find((item) => item.groupId === groupId);
  if (view === undefined) {
    throw new Error(
      `The group left the monitor's views entirely: ${JSON.stringify(monitor.rebalanceViews())}`,
    );
  }
  return view;
}

describe("[TRI-10] the advisor wired onto the monitor's own tick", () => {
  it("advises on the monitor's timer and changes no route, no revision and no record", async () => {
    const trio = await startAdvisorTrio();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      advisorPair(
        { busy: trio.busy.port, idleB: trio.idleB.port, idleC: trio.idleC.port },
        "advise",
      ),
    );
    bindOnBusyEngine(balancer, "session-advise");

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    try {
      const advice = await waitForAdvice(monitor, ADV_GROUP);
      expect(advice.state).toBe("suggested");
      expect(advice.sourceTargetId).toBe("target-a");
      expect(advice.destinationTargetId).toBe("target-b");
      expect(advice.stableSamples).toBeGreaterThanOrEqual(2);
      expect(advice.costSource).toBe("normalized_usage");
      expect(advice.costEstimated).toBe(false);
      expect(advice.inputTokens).toBe(1_840);
      expect(advice.requestBytes).toBe(2_048);
      expect(advice.stateReason).toBeNull();

      const view = monitor.rebalanceViews().find((item) => item.groupId === ADV_GROUP);
      expect(view?.mode).toBe("advise");
      expect(view?.calibrated).toBe(false);
      expect(view?.disabledReason).toBeNull();

      // The advice changed nothing: the binding still sits where the request path put it,
      // with the revision it was created with, and no move was ever registered.
      const snapshot = balancer.bindingSnapshot(ADV_GROUP);
      expect(snapshot?.entries).toHaveLength(1);
      expect(snapshot?.entries[0]?.targetId).toBe("target-a");
      expect(snapshot?.entries[0]?.ref.routingRevision).toBe(0);
      expect(balancer.migrationOperations()).toEqual([]);

      // The advice lives on the monitor, not on any UI: the status views answer from the
      // monitor's memory after stop, and a stopped pair keeps nothing running.
      monitor.stop();
      expect(monitor.running).toBe(false);
      expect(
        monitor.rebalanceViews().find((item) => item.groupId === ADV_GROUP)?.suggestions,
      ).toEqual([]);
    } finally {
      monitor.stop();
      await closeTrio(trio);
    }
  });

  it("computes nothing while off, and switching to off forgets everything advise had seen", async () => {
    const trio = await startAdvisorTrio();
    const ports = { busy: trio.busy.port, idleB: trio.idleB.port, idleC: trio.idleC.port };
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(advisorPair(ports, "off"));
    bindOnBusyEngine(balancer, "session-off-then-advise");

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    try {
      const offView = await waitForNoAdvice(monitor, ADV_GROUP);
      expect(offView.mode).toBe("off");
      expect(offView.suggestions).toEqual([]);
      // Sampling itself keeps running under `off`: the mode stops the automatic judgement,
      // not the metric reading the manual status still shows. That metric is a real HTTP
      // request issued on a 25 ms tick, so the wait is written out instead of assumed: the
      // claim stays "a sample reached the busy engine", and it no longer rests on whether
      // real time happened to reach a tick while other suites were competing for the runner.
      await expect
        .poll(() => trio.busy.requests(), { timeout: 5_000, interval: 25 })
        .toBeGreaterThan(0);

      const revisionBefore = balancer.bindingSnapshot(ADV_GROUP)?.groupRevision;
      balancer.reconfigure(advisorPair(ports, "advise"));
      const advice = await waitForAdvice(monitor, ADV_GROUP);
      expect(advice.state).toBe("suggested");
      // The advisor mode is not a routing change: the group revision never moved, so what
      // vanishes next cannot be blamed on a group that "changed".
      expect(balancer.bindingSnapshot(ADV_GROUP)?.groupRevision).toBe(revisionBefore);

      balancer.reconfigure(advisorPair(ports, "off"));
      const dropped = await waitForNoAdvice(monitor, ADV_GROUP);
      expect(dropped.mode).toBe("off");
      // The whole store is gone - not an expiry trail of terminal records left behind. The
      // drop happens at the advisor's entry point, so `off` really computes nothing.
      expect(dropped.suggestions).toEqual([]);
      expect(balancer.bindingSnapshot(ADV_GROUP)?.groupRevision).toBe(revisionBefore);
    } finally {
      monitor.stop();
      await closeTrio(trio);
    }
  });

  it("runs an uncalibrated auto exactly like advise, says not_calibrated, and moves nothing", async () => {
    const trio = await startAdvisorTrio();
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      advisorPair({ busy: trio.busy.port, idleB: trio.idleB.port, idleC: trio.idleC.port }, "auto"),
    );
    bindOnBusyEngine(balancer, "session-auto-degraded");

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    try {
      const advice = await waitForAdvice(monitor, ADV_GROUP);
      expect(advice.state).toBe("suggested");
      expect(advice.destinationTargetId).toBe("target-b");

      const view = monitor.rebalanceViews().find((item) => item.groupId === ADV_GROUP);
      expect(view?.mode).toBe("auto");
      expect(view?.calibrated).toBe(false);
      expect(view?.disabledReason).toBe("not_calibrated");

      // Safe degradation, proved where it matters: a group asking for `auto` produced the
      // same advice `advise` produces, and still no binding moved, no revision stepped and
      // no migration was ever registered. Auto cannot act before TRI-11's calibration.
      const snapshot = balancer.bindingSnapshot(ADV_GROUP);
      expect(snapshot?.entries[0]?.targetId).toBe("target-a");
      expect(snapshot?.entries[0]?.ref.routingRevision).toBe(0);
      expect(balancer.migrationOperations()).toEqual([]);
    } finally {
      monitor.stop();
      await closeTrio(trio);
    }
  });

  it("drops advice for a metrics-off or disabled group, not merely an expiry trail", async () => {
    const trio = await startAdvisorTrio();
    const ports = { busy: trio.busy.port, idleB: trio.idleB.port, idleC: trio.idleC.port };
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(advisorPair(ports, "advise"));
    bindOnBusyEngine(balancer, "session-dropped-groups");

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    try {
      await waitForAdvice(monitor, ADV_GROUP);

      balancer.reconfigure(advisorPair(ports, "advise", { metrics_enabled: false }));
      const metricsOff = await waitForNoAdvice(monitor, ADV_GROUP);
      expect(metricsOff.mode).toBe("advise");
      expect(metricsOff.suggestions).toEqual([]);
      await sleep(120);
      expect(
        monitor.rebalanceViews().find((item) => item.groupId === ADV_GROUP)?.suggestions,
      ).toEqual([]);

      balancer.reconfigure(
        advisorPair(ports, "advise", { metrics_enabled: false, enabled: false }),
      );
      const disabled = await waitForNoAdvice(monitor, ADV_GROUP);
      expect(disabled.suggestions).toEqual([]);

      // The state was dropped outright, so bringing the group back starts a clean store:
      // advice only ever appears from fresh evidence, never from what the old run saw.
      balancer.reconfigure(advisorPair(ports, "advise"));
      const rebuilt = await waitForAdvice(monitor, ADV_GROUP);
      expect(rebuilt.state).toBe("suggested");
      expect(rebuilt.stableSamples).toBeGreaterThanOrEqual(2);
    } finally {
      monitor.stop();
      await closeTrio(trio);
    }
  });

  it("forgets advice when a group leaves configuration before the pair stops", async () => {
    const trio = await startAdvisorTrio();
    const ports = { busy: trio.busy.port, idleB: trio.idleB.port, idleC: trio.idleC.port };
    const configured = advisorPair(ports, "advise");
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(configured);
    bindOnBusyEngine(balancer, "session-removed-group");

    const monitor = new LoadMonitor(balancer, { sampleIntervalMs: 25 });
    monitor.start();
    try {
      await waitForAdvice(monitor, ADV_GROUP);

      // Proxy reloads reuse the balancer and monitor, so removing a group does not stop the
      // pair. The next monitor tick must still release the old advisor state.
      balancer.reconfigure(
        pair(
          [
            target("target-a", `http://127.0.0.1:${ports.busy}`),
            target("target-b", `http://127.0.0.1:${ports.idleB}`),
            target("target-c", `http://127.0.0.1:${ports.idleC}`),
          ],
          [],
        ),
      );
      await sleep(120);
      expect(monitor.rebalanceViews()).toEqual([]);

      // Reusing the id starts with no hidden suggestion from the removed configuration.
      balancer.reconfigure(configured);
      const restored = monitor.rebalanceViews().find((item) => item.groupId === ADV_GROUP);
      expect(restored?.suggestions).toEqual([]);
    } finally {
      monitor.stop();
      await closeTrio(trio);
    }
  });

  it("logs a suggestion with ids, targets and numbers only - never a session, body or key", async () => {
    const logger = collectingLogger();
    const [busy, quietB, quietC] = await Promise.all([
      startMetricsServer(VLLM_EXPOSITION),
      // The destination the advisor picks is the first quiet member in configuration order,
      // which is target-b. Flipping that engine is what ends the suggestion.
      startSwitchableMetricsServer(IDLE_EXPOSITION),
      startMetricsServer(IDLE_EXPOSITION),
    ]);
    const balancer = new LoadBalancer("pair-1");
    balancer.reconfigure(
      advisorPair({ busy: busy.port, idleB: quietB.port, idleC: quietC.port }, "advise"),
    );
    bindOnBusyEngine(balancer, "session-log-leak", "please keep this private");

    const monitor = new LoadMonitor(balancer, { logger, sampleIntervalMs: 25 });
    monitor.start();
    try {
      await waitForAdvice(monitor, ADV_GROUP);
      const suggestionLines = logger.entries.filter((entry) =>
        entry.message.startsWith("load rebalance suggestion"),
      );
      expect(suggestionLines.length).toBeGreaterThanOrEqual(1);
      for (const line of suggestionLines) {
        // A created suggestion has no reason yet, so its line carries exactly the seven keys.
        // A line about a suggestion that ended names why it ended - and that is the only extra
        // key either shape may carry.
        const keys = Object.keys(line.context).sort();
        if (line.message === "load rebalance suggestion") {
          expect(keys).toEqual(SUGGESTION_LOG_KEYS);
        } else {
          expect(keys).toEqual(TERMINAL_SUGGESTION_LOG_KEYS);
          expect(typeof line.context["stateReason"]).toBe("string");
        }
      }
      const serialized = JSON.stringify(logger.entries);
      expect(serialized).not.toContain("session-log-leak");
      expect(serialized).not.toContain("please keep this private");
      expect(serialized).not.toContain("response:");
      expect(serialized).not.toContain("context_key");
      expect(String(suggestionLines[0]?.context["suggestionId"])).toMatch(/^[0-9a-f]{32}$/);
      // Nothing that looks like an exact key or a message hash is carried anywhere.
      for (const line of suggestionLines) {
        for (const value of Object.values(line.context)) {
          expect(String(value)).not.toMatch(/^[0-9a-f]{64}$/);
        }
      }

      // Now prove the second shape on purpose: the quiet destination turns busy, so the live
      // suggestion must end and say why. Waiting for a refusal to appear by chance would leave
      // this branch of the contract asserted only when the timing happened to produce one.
      quietB.set(VLLM_EXPOSITION);
      const expiryDeadline = Date.now() + 5_000;
      while (
        !logger.entries.some((entry) => entry.message === "load rebalance suggestion expired") &&
        Date.now() < expiryDeadline
      ) {
        await sleep(50);
      }
      const expiredLine = logger.entries.find(
        (entry) => entry.message === "load rebalance suggestion expired",
      );
      if (expiredLine === undefined) {
        throw new Error(`the suggestion never ended: ${JSON.stringify(logger.entries)}`);
      }
      expect(Object.keys(expiredLine.context).sort()).toEqual(TERMINAL_SUGGESTION_LOG_KEYS);
      expect(expiredLine.context["stateReason"]).toBe("target_busy");
      expect(JSON.stringify(expiredLine.context)).not.toContain("session-log-leak");
      expect(String(expiredLine.context["suggestionId"])).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      monitor.stop();
      await Promise.all([close(busy.server), close(quietB.server), close(quietC.server)]);
    }
  });
});
