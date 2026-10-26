/**
 * Turns a Prometheus exposition into the three numbers the load balancer needs: how many
 * requests are running, how many are waiting, and how full the KV cache is. Everything
 * unreadable becomes missing rather than zero, because a zero that never existed would
 * make an unhealthy node look idle.
 */

export const VLLM_SLEEP_AWAKE_LABEL = "awake";

interface EngineAlias {
  readonly source: string;
  readonly prefix: string;
  readonly running: string;
  readonly waiting: string;
  readonly kvUsage: readonly string[];
  readonly sleepState?: string | undefined;
}

const ENGINE_ALIASES: readonly EngineAlias[] = [
  {
    source: "vllm",
    prefix: "vllm:",
    running: "vllm:num_requests_running",
    waiting: "vllm:num_requests_waiting",
    kvUsage: ["vllm:kv_cache_usage_perc", "gpu_cache_usage_perc"],
    sleepState: "vllm:engine_sleep_state",
  },
  {
    source: "sglang",
    prefix: "sglang:",
    running: "sglang:num_running_reqs",
    waiting: "sglang:num_queue_reqs",
    kvUsage: ["sglang:token_usage"],
  },
  {
    source: "llamacpp",
    prefix: "llamacpp:",
    running: "llamacpp:requests_processing",
    waiting: "llamacpp:requests_deferred",
    kvUsage: ["llamacpp:kv_cache_usage_ratio", "gpu_cache_usage_perc"],
  },
];

/**
 * The numbers the balancer needs, plus what the engine said about sleeping. `undefined` means
 * the exposition never answered that field; a zero the engine reported stays a zero.
 */
export interface LoadMetricsSnapshot {
  readonly running: number | undefined;
  readonly waiting: number | undefined;
  readonly kvUsage: number | undefined;
  /** False only when the engine says it is asleep; then it cannot take a new task. */
  readonly awake: boolean | undefined;
  readonly source: string | undefined;
}

/**
 * Nothing readable came back: an empty body, a page that is not an exposition at all, or an
 * exposition that names no engine. This is a read that told the proxy nothing, which is a
 * different fact from a partial answer - a partial one keeps its `source` and `running` and
 * leaves only the fields the engine skipped missing. Neither is ever turned into zero.
 */
export const EMPTY_LOAD_METRICS: LoadMetricsSnapshot = {
  awake: undefined,
  kvUsage: undefined,
  running: undefined,
  source: undefined,
  waiting: undefined,
};

/**
 * Sums every label set of a metric: one engine per GPU reports a series per model, and the
 * real load is the sum across them. Values that are not a plain non-negative finite number
 * are dropped, so a truncated line or an `NaN` cannot invent load.
 */
export function parseLoadMetrics(text: string): LoadMetricsSnapshot {
  if (text === "") {
    return EMPTY_LOAD_METRICS;
  }
  const sums = new Map<string, number>();
  let awakeValue: number | undefined;
  let asleepValue: number | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.lastIndexOf(" ");
    if (separator <= 0) {
      continue;
    }
    const rawName = trimmed.slice(0, separator);
    const rawValue = trimmed.slice(separator + 1);
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    const braceIndex = rawName.indexOf("{");
    const name = braceIndex === -1 ? rawName : rawName.slice(0, braceIndex);
    const labels = braceIndex === -1 ? "" : rawName.slice(braceIndex);
    sums.set(name, (sums.get(name) ?? 0) + value);
    for (const engine of ENGINE_ALIASES) {
      if (engine.sleepState !== undefined && name === engine.sleepState) {
        if (labels.includes(`sleep_state="${VLLM_SLEEP_AWAKE_LABEL}"`)) {
          awakeValue = value;
        } else if (value === 1) {
          asleepValue = value;
        }
      }
    }
  }

  const engine = ENGINE_ALIASES.find(({ running }) => sums.has(running)) ?? byPrefix(sums);
  if (engine === undefined) {
    return EMPTY_LOAD_METRICS;
  }
  const kvUsage = engine.kvUsage.map((name) => sums.get(name)).find((value) => value !== undefined);
  const awake =
    engine.sleepState === undefined || (awakeValue === undefined && asleepValue === undefined)
      ? undefined
      : asleepValue === undefined && awakeValue === 1;
  return {
    running: sums.get(engine.running),
    waiting: sums.get(engine.waiting),
    kvUsage,
    awake,
    source: engine.source,
  };
}

function byPrefix(sums: ReadonlyMap<string, number>): EngineAlias | undefined {
  for (const engine of ENGINE_ALIASES) {
    for (const name of sums.keys()) {
      if (name.startsWith(engine.prefix)) {
        return engine;
      }
    }
  }
  return undefined;
}
