import { describe, expect, it } from "vitest";

import { EMPTY_LOAD_METRICS, parseLoadMetrics } from "../../src/proxy/index.js";

describe("upstream load metrics parsing", () => {
  it("LB08-01 reads the running, waiting and KV numbers of each engine family", () => {
    expect(
      parseLoadMetrics(`# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="Qwen3.8-Flash-Next"} 3.0
vllm:num_requests_waiting{engine="0",model_name="Qwen3.8-Flash-Next"} 2.0
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8-Flash-Next"} 0.35
`),
    ).toEqual({
      awake: undefined,
      kvUsage: 0.35,
      running: 3,
      source: "vllm",
      waiting: 2,
    });

    expect(
      parseLoadMetrics(`sglang:num_running_reqs{model_name="Qwen3.8-Flash-Next"} 4
sglang:num_queue_reqs{model_name="Qwen3.8-Flash-Next"} 1
sglang:token_usage 0.62
`),
    ).toEqual({
      awake: undefined,
      kvUsage: 0.62,
      running: 4,
      source: "sglang",
      waiting: 1,
    });

    expect(
      parseLoadMetrics(`llamacpp:requests_processing 5
llamacpp:requests_deferred 2
# no cache ratio line at all
`),
    ).toEqual({ awake: undefined, kvUsage: undefined, running: 5, source: "llamacpp", waiting: 2 });

    // An engine that only reports the older cache gauge is still readable.
    expect(parseLoadMetrics(`gpu_cache_usage_perc 0.8\n`)).toEqual({
      awake: undefined,
      kvUsage: undefined,
      running: undefined,
      source: undefined,
      waiting: undefined,
    });
  });

  it("LB08-02 adds up every label set of one metric", () => {
    const parsed = parseLoadMetrics(`vllm:num_requests_running{engine="0",model_name="A"} 2.0
vllm:num_requests_running{engine="0",model_name="B"} 3.0
vllm:num_requests_waiting{engine="0",model_name="A"} 1.0
vllm:num_requests_waiting{engine="0",model_name="B"} 4.0
vllm:kv_cache_usage_perc{engine="0",model_name="A"} 0.3
vllm:kv_cache_usage_perc{engine="0",model_name="B"} 0.4
`);
    expect(parsed.running).toBe(5);
    expect(parsed.waiting).toBe(5);
    expect(parsed.kvUsage).toBe(0.7);
  });

  it("LB08-03 treats anything unreadable as missing instead of as zero load", () => {
    const unreadable = [
      "",
      "<html><body>502 Bad Gateway</body></html>\n",
      'vllm:num_requests_running{engine="0"} NaN\n',
      'vllm:num_requests_running{engine="0"} +Inf\n',
      'vllm:num_requests_running{engine="0"} -1\n',
      'vllm:num_requests_running{engine="0"}\n',
      'vllm:num_requests_running{engine="0"} not-a-number\n',
      "# TYPE vllm:num_requests_running gauge\nvllm:num_requests_runni",
    ];
    for (const text of unreadable) {
      expect(parseLoadMetrics(text)).toEqual(EMPTY_LOAD_METRICS);
    }

    // One bad line does not poison the good ones.
    const partial = parseLoadMetrics(`vllm:num_requests_running{engine="0"} 2.0
vllm:num_requests_waiting{engine="0"} NaN
vllm:kv_cache_usage_perc{engine="0"} 0.5
`);
    expect(partial).toEqual({
      awake: undefined,
      kvUsage: 0.5,
      running: 2,
      source: "vllm",
      waiting: undefined,
    });
  });

  it("LB08-04 reads the vLLM sleep state and stays quiet without it", () => {
    const awake = parseLoadMetrics(`vllm:num_requests_running{engine="0"} 1.0
vllm:engine_sleep_state{engine="0",sleep_state="awake"} 1.0
vllm:engine_sleep_state{engine="0",sleep_state="weights_offloaded"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="discard_all"} 0.0
`);
    expect(awake.awake).toBe(true);

    const sleeping = parseLoadMetrics(`vllm:num_requests_running{engine="0"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="awake"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="weights_offloaded"} 1.0
`);
    expect(sleeping.awake).toBe(false);
    expect(sleeping.running).toBe(0);

    const levelTwo = parseLoadMetrics(`vllm:num_requests_running{engine="0"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="awake"} 1.0
vllm:engine_sleep_state{engine="0",sleep_state="discard_all"} 1.0
`);
    expect(levelTwo.awake).toBe(false);

    const noSleepMetric = parseLoadMetrics(`vllm:num_requests_running{engine="0"} 0.0\n`);
    expect(noSleepMetric.awake).toBeUndefined();
  });
});
