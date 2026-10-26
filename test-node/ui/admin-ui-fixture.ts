import type { ProxyPair, PublicProxyPair } from "../../src/config/index.js";
import type { LogListItem, TaskBrief } from "../../src/maintenance/index.js";

export const logQueries: string[] = [];

export const groupLogQueries: string[] = [];

export let useLargeLogFixture = false;

export let useLargeLogRequestCount: ((index: number) => number) | null = null;

export let useLargeGroupLogFixture = false;

export let useSummarizedLogFixture = false;

export let taskBriefFixture: string | null = null;

export const TASK_BRIEF_GENERATED_TEXT =
  "Relaying a multi-turn coding session through the local proxy and debugging its streaming relay.";

export const TASK_BRIEF_GENERATED_FACTS: Record<string, string> = {
  agent: "pi 0.39 (win32 10.0.26100; x64)",
  cwd: "d:/code/local_ai_proxy",
  git_branch: "main",
  os: "Windows 11 + PowerShell",
};

export const taskBriefPosts: string[] = [];

/**
 * The one brief payload the stub answers with. Undefined is the "never generated" state,
 * which is what a task without a stored brief really returns.
 */
export function taskBriefFixtureValue(groupId: string): TaskBrief | undefined {
  return taskBriefFixture === null
    ? undefined
    : {
        task_id: groupId,
        text: taskBriefFixture,
        context: TASK_BRIEF_GENERATED_FACTS,
        model: "summary-model",
        generated_at: "2026-07-18T12:05:00.000+08:00",
        source_record_id: "record-six",
      };
}

export const deletedLogGroups = new Set<string>();

export const detailReads = new Map<string, number>();

export const UI_TEST_TIMEOUT_MS = 30_000;

export const targetCheckCalls: {
  targetUrl: string;
  model: string;
  apiType?: "chat" | "responses" | "anthropic";
  apiKey?: string;
}[] = [];

export let targetCheckOutcome: {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
  detail?: string;
} = { ok: true, status: 200, durationMs: 5 };

export const targetMetricsCalls: { targetUrl: string; apiKey?: string }[] = [];

export const targetModelsCalls: { targetUrl: string; apiKey?: string }[] = [];

export let targetModelsOutcome: {
  ok: boolean;
  models: string[];
  durationMs: number;
  truncated?: boolean;
  error?: string;
} = { ok: true, models: ["deepseek-chat", "deepseek-reasoner"], durationMs: 6 };

export let lbStatusRound = 0;

/** [TRI-03] When on, the second node reports null for the numbers its engine skipped. */
export let lbStatusPartialMetrics = false;

export let pairsSaveIssues: readonly { code: string; message: string; path: string }[] | null =
  null;

export const lbStatusReads: number[] = [];

export function loadBalancerStatusFixture() {
  return {
    now: 1_792_830_671_228,
    pairs: pairs.map((pair) => ({
      id: pair.id,
      name: pair.name,
      enabled: pair.enabled,
      running: pair.running,
      groups: pair.load_balancers.map((group) => ({
        id: group.id,
        name: group.name,
        modelPattern: group.model_pattern,
        strategy: group.strategy,
        metricsEnabled: group.metrics_enabled,
        failoverEnabled: group.failover_enabled,
        enabled: group.enabled,
        nodeTargetIds: group.members.map(({ target_id }) => target_id),
        bindings: group.members.length,
        nodes: group.members.map(({ target_id }, index) => ({
          targetId: target_id,
          canonicalKey: `http://127.0.0.1:939${3 + index}`,
          enabled: true,
          inRotation: index === 0,
          inFlight: lbStatusRound + index,
          bindings: index,
          cooldownRemainingMs: index === 0 ? 0 : 4_000,
          failures: index === 0 ? 0 : 2,
          lastDispatchedAt: null,
          stale: false,
          metrics: {
            // A null here means the engine did not answer that number. The console has to
            // show it as unknown, never as the zero that would make the node look idle.
            running: lbStatusPartialMetrics && index === 1 ? null : 1 + index,
            waiting: lbStatusPartialMetrics && index === 1 ? null : 3 + index,
            kvUsage: 0.42,
            source: "vllm",
            sampledAt: 1_792_830_670_000,
          },
        })),
      })),
    })),
  };
}

export const TARGET_METRICS_FIXTURE_TEXT = [
  "# TYPE process_start_time_seconds gauge",
  "process_start_time_seconds 1790000000.0",
  "# TYPE process_resident_memory_bytes gauge",
  "process_resident_memory_bytes 2.1e+09",
  "# TYPE process_virtual_memory_bytes gauge",
  "process_virtual_memory_bytes 1.2e+11",
  "# TYPE process_cpu_seconds_total counter",
  "process_cpu_seconds_total 100.0",
  "# TYPE process_open_fds gauge",
  "process_open_fds 64.0",
  "# TYPE process_max_fds gauge",
  "process_max_fds 1024.0",
  "# TYPE vllm:num_requests_running gauge",
  'vllm:num_requests_running{engine="0",model_name="fixture-model"} 2.0',
  "# TYPE vllm:num_requests_waiting gauge",
  'vllm:num_requests_waiting{engine="0",model_name="fixture-model"} 3.0',
  "# TYPE vllm:num_requests_waiting_by_reason gauge",
  'vllm:num_requests_waiting_by_reason{engine="0",model_name="fixture-model",reason="capacity"} 2.0',
  'vllm:num_requests_waiting_by_reason{engine="0",model_name="fixture-model",reason="deferred"} 1.0',
  "# TYPE vllm:engine_sleep_state gauge",
  'vllm:engine_sleep_state{engine="0",model_name="fixture-model",sleep_state="awake"} 1.0',
  'vllm:engine_sleep_state{engine="0",model_name="fixture-model",sleep_state="weights_offloaded"} 0.0',
  'vllm:engine_sleep_state{engine="0",model_name="fixture-model",sleep_state="discard_all"} 0.0',
  "# TYPE vllm:kv_cache_usage_perc gauge",
  'vllm:kv_cache_usage_perc{engine="0",model_name="fixture-model"} 0.42',
  "# TYPE vllm:num_preemptions_total counter",
  'vllm:num_preemptions_total{engine="0",model_name="fixture-model"} 4.0',
  "# TYPE vllm:prefix_cache_queries_total counter",
  'vllm:prefix_cache_queries_total{engine="0",model_name="fixture-model"} 1000.0',
  "# TYPE vllm:prefix_cache_hits_total counter",
  'vllm:prefix_cache_hits_total{engine="0",model_name="fixture-model"} 750.0',
  "# TYPE vllm:external_prefix_cache_queries_total counter",
  'vllm:external_prefix_cache_queries_total{engine="0",model_name="fixture-model"} 0.0',
  "# TYPE vllm:external_prefix_cache_hits_total counter",
  'vllm:external_prefix_cache_hits_total{engine="0",model_name="fixture-model"} 0.0',
  "# TYPE vllm:mm_cache_queries_total counter",
  'vllm:mm_cache_queries_total{engine="0",model_name="fixture-model"} 0.0',
  "# TYPE vllm:mm_cache_hits_total counter",
  'vllm:mm_cache_hits_total{engine="0",model_name="fixture-model"} 0.0',
  "# TYPE vllm:spec_decode_num_draft_tokens_total counter",
  'vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="fixture-model"} 200.0',
  "# TYPE vllm:spec_decode_num_accepted_tokens_total counter",
  'vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="fixture-model"} 150.0',
  "# TYPE vllm:cache_config_info gauge",
  'vllm:cache_config_info{block_size="16",cache_dtype="auto",enable_prefix_caching="true",engine="0",gpu_memory_utilization="0.9",kv_cache_size_tokens="1600",model_name="fixture-model",num_gpu_blocks="100"} 1.0',
  "# TYPE vllm:prompt_tokens_total counter",
  'vllm:prompt_tokens_total{engine="0",model_name="fixture-model"} 10000.0',
  "# TYPE vllm:prompt_tokens_cached_total counter",
  'vllm:prompt_tokens_cached_total{engine="0",model_name="fixture-model"} 7500.0',
  "# TYPE vllm:prompt_tokens_by_source_total counter",
  'vllm:prompt_tokens_by_source_total{engine="0",model_name="fixture-model",source="local_compute"} 2500.0',
  'vllm:prompt_tokens_by_source_total{engine="0",model_name="fixture-model",source="local_cache_hit"} 7500.0',
  "# TYPE vllm:generation_tokens_total counter",
  'vllm:generation_tokens_total{engine="0",model_name="fixture-model"} 5000.0',
  "# TYPE vllm:request_success_total counter",
  'vllm:request_success_total{engine="0",finished_reason="stop",model_name="fixture-model"} 900.0',
  'vllm:request_success_total{engine="0",finished_reason="length",model_name="fixture-model"} 100.0',
  'vllm:request_success_total{engine="0",finished_reason="abort",model_name="fixture-model"} 5.0',
  'vllm:request_success_total{engine="0",finished_reason="error",model_name="fixture-model"} 3.0',
  "# TYPE vllm:time_to_first_token_seconds histogram",
  'vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="fixture-model"} 500.0',
  'vllm:time_to_first_token_seconds_bucket{engine="0",le="0.25",model_name="fixture-model"} 800.0',
  'vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="fixture-model"} 950.0',
  'vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:time_to_first_token_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:time_to_first_token_seconds_sum{engine="0",model_name="fixture-model"} 120.0',
  "# TYPE vllm:inter_token_latency_seconds histogram",
  'vllm:inter_token_latency_seconds_bucket{engine="0",le="0.05",model_name="fixture-model"} 600.0',
  'vllm:inter_token_latency_seconds_bucket{engine="0",le="0.1",model_name="fixture-model"} 900.0',
  'vllm:inter_token_latency_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:inter_token_latency_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:inter_token_latency_seconds_sum{engine="0",model_name="fixture-model"} 62.0',
  "# TYPE vllm:request_queue_time_seconds histogram",
  'vllm:request_queue_time_seconds_bucket{engine="0",le="0.1",model_name="fixture-model"} 1000.0',
  'vllm:request_queue_time_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:request_queue_time_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:request_queue_time_seconds_sum{engine="0",model_name="fixture-model"} 10.0',
  "# TYPE vllm:request_prefill_time_seconds histogram",
  'vllm:request_prefill_time_seconds_bucket{engine="0",le="1.0",model_name="fixture-model"} 1000.0',
  'vllm:request_prefill_time_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:request_prefill_time_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:request_prefill_time_seconds_sum{engine="0",model_name="fixture-model"} 200.0',
  "# TYPE vllm:request_decode_time_seconds histogram",
  'vllm:request_decode_time_seconds_bucket{engine="0",le="1.0",model_name="fixture-model"} 600.0',
  'vllm:request_decode_time_seconds_bucket{engine="0",le="10.0",model_name="fixture-model"} 1000.0',
  'vllm:request_decode_time_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:request_decode_time_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:request_decode_time_seconds_sum{engine="0",model_name="fixture-model"} 4500.0',
  "# TYPE vllm:e2e_request_latency_seconds histogram",
  'vllm:e2e_request_latency_seconds_bucket{engine="0",le="1.0",model_name="fixture-model"} 500.0',
  'vllm:e2e_request_latency_seconds_bucket{engine="0",le="10.0",model_name="fixture-model"} 900.0',
  'vllm:e2e_request_latency_seconds_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:e2e_request_latency_seconds_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:e2e_request_latency_seconds_sum{engine="0",model_name="fixture-model"} 2000.0',
  "# TYPE vllm:request_prompt_tokens histogram",
  'vllm:request_prompt_tokens_bucket{engine="0",le="512",model_name="fixture-model"} 400.0',
  'vllm:request_prompt_tokens_bucket{engine="0",le="2048",model_name="fixture-model"} 1000.0',
  'vllm:request_prompt_tokens_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:request_prompt_tokens_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:request_prompt_tokens_sum{engine="0",model_name="fixture-model"} 100000.0',
  "# TYPE vllm:request_generation_tokens histogram",
  'vllm:request_generation_tokens_bucket{engine="0",le="100",model_name="fixture-model"} 500.0',
  'vllm:request_generation_tokens_bucket{engine="0",le="500",model_name="fixture-model"} 1000.0',
  'vllm:request_generation_tokens_bucket{engine="0",le="+Inf",model_name="fixture-model"} 1000.0',
  'vllm:request_generation_tokens_count{engine="0",model_name="fixture-model"} 1000.0',
  'vllm:request_generation_tokens_sum{engine="0",model_name="fixture-model"} 50000.0',
].join("\n");

export const NON_VLLM_FIXTURE_TEXT = [
  "# HELP vllm_cache_config_usage Percent of KV cache in use.",
  "# TYPE vllm_cache_config_usage gauge",
  "vllm_cache_config_usage 0.25",
  "# HELP process_resident_memory_bytes Resident memory size in bytes.",
  "# TYPE process_resident_memory_bytes gauge",
  "process_resident_memory_bytes 3.013369856e+09",
].join("\n");

export const FIXTURE_METRIC_FAMILY_COUNT = 58;

export let targetMetricsOutcome: {
  ok: boolean;
  status?: number;
  durationMs: number;
  text?: string;
  truncated?: boolean;
  error?: string;
} = { ok: true, status: 200, durationMs: 5, text: TARGET_METRICS_FIXTURE_TEXT };

export const modelCatalogCalls: {
  targetUrl: string;
  targetApiKey?: string;
  priceRate?: string;
}[] = [];

export let modelCatalogError: string | null = null;

export let modelCatalogOutcome: {
  models: string[];
  rules: {
    model_pattern: string;
    input_per_million: string;
    output_per_million: string;
    cache_read_per_million: string;
    cache_write_per_million: string;
  }[];
  unmatched: string[];
  catalog: { source: string; fetchedAt: number };
} = {
  models: [],
  rules: [],
  unmatched: [],
  catalog: { source: "models.dev", fetchedAt: 1_700_000_000 },
};

export const pairs: PublicProxyPair[] = [];

export function fixturePair(): PublicProxyPair {
  return {
    id: "proxy-one",
    name: "Fixture Proxy",
    enabled: true,
    running: true,
    actual_listen_port: 4321,
    listen_host: "127.0.0.1",
    listen_port: 4321,
    access_log: false,
    default_target_id: "target-one",
    load_balancers: [],
    targets: [
      {
        id: "target-one",
        name: "Fixture Target",
        enabled: true,
        target_url: "https://example.test/v1",
        target_api_key: "secret-key",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        log_root: "logs",
        redact_logs: false,
        model_mappings: [],
        model_prices: [],
      },
    ],
  };
}

export function deploymentPromptFixture(): string {
  return [
    "Summarize the deployment log below and flag anything unusual.",
    "",
    "Deployment run #417 \u2014 target: prod-cluster-a",
    "Started:   2026-07-18 11:58:40",
    "Stage build   : ok (18s) \u2014 212 artifacts, 3 workers",
    "Stage package : ok (9s) \u2014 image 2.4 GB",
    "Stage migrate : ok (3s) \u2014 3 replicas, zero downtime",
    "Stage health  : ok (2s) \u2014 p99 latency 41 ms",
    "Stage verify  : ok (6s) \u2014 24/24 checks passed",
    "Stage canary  : ok (12s) \u2014 error rate 0.02%",
    "Verification:",
    "  - login flow     : ok",
    "  - search index   : ok",
    "  - billing webhook: ok",
    "  - cache warmup   : ok",
    "  - feature flags  : ok",
    "  - rate limiter   : ok",
    "  - replica 4321a  : healthy, 0 restarts",
    "  - replica 4321b  : healthy, 0 restarts",
    "  - replica 4321c  : healthy, 0 restarts",
    "Metrics before: cpu 31%, mem 42%, net 1.2 Gb/s",
    "Metrics after : cpu 28%, mem 39%, net 1.1 Gb/s",
    "Alerts during window: 0",
    "Slowest endpoint: /v1/responses (p99 412 ms)",
    "Artifacts: 212 built, 210 promoted, 2 skipped",
    "Image sha256    : 9f2c1a44d7e0b8c36f52a91e0d44b7c8 (matches build #417)",
    "Config checksum : ok (14 keys unchanged)",
    "Rollback plan retained until the next run",
    "Operator note: no manual intervention needed",
    "Finished:   2026-07-18 12:00:02, total 1m 22s",
  ].join("\n");
}

export function fixtureRequestPricing(status: "pending" | "priced" | "unpriced" = "priced") {
  return {
    pricing_status: status,
    pricing_reason: status === "unpriced" ? "missing_usage" : null,
    billing_model: "gpt-5",
    cost_nano_cny: status === "priced" ? "41125000" : null,
    pricing_snapshot: {
      model_pattern: "gpt-5",
      target_name: "Fixture Target",
      input_per_million: "5",
      output_per_million: "30",
      cache_read_per_million: "0.5",
      cache_write_per_million: "6.25",
    },
    usage:
      status === "priced"
        ? {
            source: "responses",
            inputUncachedTokens: "1500",
            outputTokens: "1000",
            cacheReadTokens: "1000",
            cacheWriteTokens: "500",
          }
        : null,
  };
}

export function taskOneLogFixture(): readonly LogListItem[] {
  return [
    {
      id: "record-six",
      timestamp: "2026-07-18 12:00:06",
      sequence: "6",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 1,
      status: 200,
      request_token_count: 30,
      response_token_count: 50,
      end_to_end_speed_tps: 50,
      target: "fixture-target",
      has_summary: false,
      cost: { currency: "CNY", amount: "0.00002", status: "priced", reason: null },
    },
    {
      id: "record-five",
      timestamp: "2026-07-18 12:00:05",
      sequence: "5",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 3,
      status: 200,
      request_token_count: 46,
      response_token_count: 212,
      target: "fixture-target",
      has_summary: useSummarizedLogFixture,
      cost: { currency: "CNY", amount: "5", status: "priced", reason: null },
    },
    {
      id: "record-four",
      timestamp: "2026-07-18 12:00:04",
      sequence: "4",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 1,
      status: 400,
      request_token_count: 12,
      response_token_count: 0,
      target: "fixture-target",
      has_summary: false,
      cost: { currency: "CNY", amount: null, status: "unpriced", reason: "missing_usage" },
    },
    {
      id: "record-three",
      timestamp: "2026-07-18 12:00:03",
      sequence: "3",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 2,
      status: 200,
      request_token_count: 24,
      response_token_count: 96,
      decode_speed_tps: 30.07,
      target: "fixture-target",
      has_summary: false,
      cost: { currency: "CNY", amount: "0.041125", status: "priced", reason: null },
    },
    {
      id: "record-two",
      timestamp: "2026-07-18 12:00:02",
      sequence: "2",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 2,
      status: 200,
      request_token_count: 8,
      response_token_count: 4,
      target: "fixture-target",
      has_summary: false,
      cost: { currency: "CNY", amount: "0.00001", status: "priced", reason: null },
    },
    {
      id: "record-one",
      timestamp: "2026-07-18 12:00:01",
      sequence: "1",
      method: "POST",
      path: "/v1/responses",
      endpoint: "/v1/responses",
      message_count: 1,
      status: null,
      request_token_count: null,
      response_token_count: null,
      target: "fixture-target",
      has_summary: false,
      cost: { currency: "CNY", amount: null, status: "pending", reason: null },
    },
  ];
}

export function publicPair(pair: ProxyPair): PublicProxyPair {
  return { ...structuredClone(pair), actual_listen_port: null, running: pair.enabled };
}

export function statisticsBaselineFixtures() {
  const options = {
    targets: [
      { id: "target-a", name: "Target A" },
      { id: "target-b", name: "Target B" },
    ],
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
  };
  const totals = {
    requests: 137,
    tasks: 19,
    input: "195716056",
    output: "52962962",
    cache_read: "133044107",
    cache_write: "14320984",
    cost: "305.500000000",
  };
  const overview = [
    { dataVersion: 1, totals, byTarget: [], byModel: [], unpriced: { missing_usage: 6 } },
    {
      dataVersion: 1,
      totals,
      byTarget: [
        { id: "Target A", value: "248320000", cost: "180.300000000", requests: 66, tasks: 9 },
        { id: "Target B", value: "147724109", cost: "125.200000000", requests: 71, tasks: 10 },
      ],
      byModel: [],
      unpriced: {},
    },
    {
      dataVersion: 1,
      totals,
      byTarget: [],
      byModel: [
        { id: "gpt-5", value: "213450000", cost: "168.750000000", requests: 74, tasks: 13 },
        { id: "gpt-5-mini", value: "118500000", cost: "92.350000000", requests: 45, tasks: 4 },
        { id: "gpt-5-nano", value: "64094109", cost: "44.400000000", requests: 18, tasks: 2 },
      ],
      unpriced: {},
    },
  ];
  const trend = {
    dataVersion: 1,
    granularity: "day",
    points: [
      {
        bucket: "2026-01-05",
        requests: 18,
        tasks: 3,
        input: "21456789",
        output: "5432100",
        cache_read: "12345678",
        cache_write: "1234567",
        cost: "41250000000",
        unpriced: 1,
        by_model: [
          {
            id: "gpt-5",
            requests: 11,
            tasks: 3,
            input: "11564247",
            output: "2927659",
            cache_read: "6653767",
            cache_write: "665377",
            cost: "22785392800",
            unpriced: 1,
          },
          {
            id: "gpt-5-mini",
            requests: 5,
            tasks: 0,
            input: "6420066",
            output: "1625333",
            cache_read: "3693939",
            cache_write: "369393",
            cost: "12469517184",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 2,
            tasks: 0,
            input: "3472476",
            output: "879108",
            cache_read: "1997972",
            cache_write: "199797",
            cost: "5995090016",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-06",
        requests: 24,
        tasks: 3,
        input: "30123456",
        output: "8765432",
        cache_read: "20487654",
        cache_write: "2345678",
        cost: "52300000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 13,
            tasks: 3,
            input: "16235192",
            output: "4724175",
            cache_read: "11041927",
            cache_write: "1264216",
            cost: "28889116203",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 8,
            tasks: 0,
            input: "9013212",
            output: "2622697",
            cache_read: "6130092",
            cache_write: "701848",
            cost: "15809836334",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 3,
            tasks: 0,
            input: "4875052",
            output: "1418560",
            cache_read: "3315635",
            cache_write: "379614",
            cost: "7601047463",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-07",
        requests: 9,
        tasks: 2,
        input: "15234567",
        output: "3456789",
        cache_read: "10234567",
        cache_write: "987654",
        cost: "27800000000",
        unpriced: 2,
        by_model: [
          {
            id: "gpt-5",
            requests: 5,
            tasks: 2,
            input: "8210748",
            output: "1863055",
            cache_read: "5515973",
            cache_write: "532302",
            cost: "15355973814",
            unpriced: 2,
          },
          {
            id: "gpt-5-mini",
            requests: 3,
            tasks: 0,
            input: "4558321",
            output: "1034302",
            cache_read: "3062275",
            cache_write: "295515",
            cost: "8403698854",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 1,
            tasks: 0,
            input: "2465498",
            output: "559432",
            cache_read: "1656319",
            cache_write: "159837",
            cost: "4040327332",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-08",
        requests: 31,
        tasks: 4,
        input: "44321098",
        output: "11234567",
        cache_read: "30987654",
        cache_write: "3456789",
        cost: "61450000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 17,
            tasks: 3,
            input: "23887084",
            output: "6054927",
            cache_read: "16700955",
            cache_write: "1863054",
            cost: "33943330606",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 10,
            tasks: 1,
            input: "13261275",
            output: "3361485",
            cache_read: "9271788",
            cache_write: "1034303",
            cost: "18575801964",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 4,
            tasks: 0,
            input: "7172739",
            output: "1818155",
            cache_read: "5014911",
            cache_write: "559432",
            cost: "8930867430",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-09",
        requests: 12,
        tasks: 2,
        input: "22112233",
        output: "6543210",
        cache_read: "15321789",
        cache_write: "1876543",
        cost: "35600000000",
        unpriced: 1,
        by_model: [
          {
            id: "gpt-5",
            requests: 7,
            tasks: 2,
            input: "11917502",
            output: "3526497",
            cache_read: "8257757",
            cache_write: "1011372",
            cost: "19664484452",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 4,
            tasks: 0,
            input: "6616181",
            output: "1957788",
            cache_read: "4584418",
            cache_write: "561479",
            cost: "10761571195",
            unpriced: 1,
          },
          {
            id: "gpt-5-nano",
            requests: 1,
            tasks: 0,
            input: "3578550",
            output: "1058925",
            cache_read: "2479614",
            cache_write: "303692",
            cost: "5173944353",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-10",
        requests: 27,
        tasks: 3,
        input: "35678901",
        output: "9876543",
        cache_read: "25432198",
        cache_write: "2876543",
        cost: "48950000000",
        unpriced: 0,
        by_model: [
          {
            id: "gpt-5",
            requests: 14,
            tasks: 0,
            input: "19229326",
            output: "5323012",
            cache_read: "13706813",
            cache_write: "1550327",
            cost: "27038666120",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 9,
            tasks: 2,
            input: "10675452",
            output: "2955152",
            cache_read: "7609545",
            cache_write: "860688",
            cost: "14797160393",
            unpriced: 0,
          },
          {
            id: "gpt-5-nano",
            requests: 4,
            tasks: 1,
            input: "5774123",
            output: "1598379",
            cache_read: "4115840",
            cache_write: "465528",
            cost: "7114173487",
            unpriced: 0,
          },
        ],
      },
      {
        bucket: "2026-01-11",
        requests: 16,
        tasks: 2,
        input: "26789012",
        output: "7654321",
        cache_read: "18234567",
        cache_write: "1543210",
        cost: "38150000000",
        unpriced: 2,
        by_model: [
          {
            id: "gpt-5",
            requests: 7,
            tasks: 0,
            input: "14438073",
            output: "4125334",
            cache_read: "9827610",
            cache_write: "831719",
            cost: "21073036005",
            unpriced: 0,
          },
          {
            id: "gpt-5-mini",
            requests: 6,
            tasks: 1,
            input: "8015517",
            output: "2290243",
            cache_read: "5455950",
            cache_write: "461743",
            cost: "11532414076",
            unpriced: 1,
          },
          {
            id: "gpt-5-nano",
            requests: 3,
            tasks: 1,
            input: "4335422",
            output: "1238744",
            cache_read: "2951007",
            cache_write: "249748",
            cost: "5544549919",
            unpriced: 1,
          },
        ],
      },
    ],
  };
  return { options, overview, trend };
}

export function visualPairs(): PublicProxyPair[] {
  const target = (
    id: string,
    name: string,
    targetUrl: string,
    apiKey: string,
    mapping: string,
    enabled: boolean,
  ) => ({
    id,
    name,
    enabled,
    target_url: targetUrl,
    target_api_key: apiKey,
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: "logs",
    redact_logs: false,
    model_mappings: [
      {
        listen: mapping.split(" => ")[0] ?? mapping,
        upstream: mapping.split(" => ")[1] ?? mapping,
      },
    ],
    model_prices: [],
  });
  return [
    {
      id: "visual-proxy-one",
      name: "New proxy",
      enabled: true,
      running: true,
      actual_listen_port: 12346,
      listen_host: "127.0.0.1",
      listen_port: 12346,
      access_log: false,
      default_target_id: "visual-openrouter",
      load_balancers: [],
      targets: [
        target(
          "visual-openrouter",
          "openrouter",
          "https://openrouter.ai/api/v1",
          "sk-...",
          "or-gpt-5.5 => gpt-5.5",
          true,
        ),
        target(
          "visual-lmstudio",
          "lmstudio",
          "http://127.0.0.1:12345",
          "sk-...",
          "qwen3.6-27b-mtp@q4_k_m",
          true,
        ),
        target(
          "visual-target",
          "Target",
          "https://api.example.com/v1",
          "sk-abcdefghijklmnopqrstuvwxyz-0123456789-abcdef",
          "gpt-4o-mini",
          true,
        ),
      ],
    },
    {
      id: "visual-proxy-two",
      name: "新代理",
      enabled: false,
      running: false,
      actual_listen_port: null,
      listen_host: "127.0.0.1",
      listen_port: 1234,
      access_log: false,
      default_target_id: "visual-default",
      load_balancers: [],
      targets: [
        target(
          "visual-default",
          "Target",
          "http://127.0.0.1:1235",
          "sk-...",
          "A-gpt-5.5 => gpt-5.5",
          true,
        ),
        target(
          "visual-disabled",
          "Disabled target",
          "http://127.0.0.1:12399",
          "sk-...",
          "gpt-5.4-nano",
          false,
        ),
      ],
    },
  ];
}

export function visualLbPairs(): PublicProxyPair[] {
  const fixture = visualPairs();
  const first = fixture[0];
  if (first === undefined) throw new Error("the visual fixture lost its first pair");
  first.load_balancers = [
    {
      id: "visual-lb-dual",
      name: "Dual GPU",
      enabled: true,
      model_pattern: "qwen3.6-27b*",
      members: ["visual-lmstudio", "visual-target"].map((target_id) => ({
        target_id,
        model_id: "",
      })),
      strategy: "least_load",
      metrics_enabled: true,
      failover_enabled: true,
    },
    {
      id: "visual-lb-cloud",
      name: "Cloud relay",
      enabled: true,
      model_pattern: "Qwen*",
      members: ["visual-openrouter", "visual-lmstudio"].map((target_id) => ({
        target_id,
        model_id: "",
      })),
      strategy: "round_robin",
      metrics_enabled: true,
      failover_enabled: true,
    },
  ];
  return [first];
}

export function resetFixtureData(): void {
  pairs.splice(0, pairs.length, fixturePair());
  logQueries.splice(0);
  groupLogQueries.splice(0);
  useLargeLogFixture = false;
  useLargeLogRequestCount = null;
  useLargeGroupLogFixture = false;
  useSummarizedLogFixture = false;
  taskBriefFixture = null;
  taskBriefPosts.length = 0;
  deletedLogGroups.clear();
  detailReads.clear();
  targetCheckCalls.length = 0;
  targetCheckOutcome = { ok: true, status: 200, durationMs: 5 };
  targetMetricsCalls.length = 0;
  targetModelsCalls.length = 0;
  targetModelsOutcome = { ok: true, models: ["deepseek-chat", "deepseek-reasoner"], durationMs: 6 };
  targetMetricsOutcome = {
    ok: true,
    status: 200,
    durationMs: 5,
    text: TARGET_METRICS_FIXTURE_TEXT,
  };
  modelCatalogCalls.length = 0;
  modelCatalogError = null;
  lbStatusRound = 0;
  lbStatusPartialMetrics = false;
  lbStatusReads.length = 0;
  pairsSaveIssues = null;
  modelCatalogOutcome = {
    models: [],
    rules: [],
    unmatched: [],
    catalog: { source: "models.dev", fetchedAt: 1_700_000_000 },
  };
}

export function setModelCatalogOutcome(value: typeof modelCatalogOutcome): void {
  modelCatalogOutcome = value;
}
export function setModelCatalogError(value: typeof modelCatalogError): void {
  modelCatalogError = value;
}
export function setTargetCheckOutcome(value: typeof targetCheckOutcome): void {
  targetCheckOutcome = value;
}
export function setTargetModelsOutcome(value: typeof targetModelsOutcome): void {
  targetModelsOutcome = value;
}
export function setTargetMetricsOutcome(value: typeof targetMetricsOutcome): void {
  targetMetricsOutcome = value;
}
export function setUseSummarizedLogFixture(value: typeof useSummarizedLogFixture): void {
  useSummarizedLogFixture = value;
}
export function setUseLargeLogFixture(value: typeof useLargeLogFixture): void {
  useLargeLogFixture = value;
}
export function setUseLargeGroupLogFixture(value: typeof useLargeGroupLogFixture): void {
  useLargeGroupLogFixture = value;
}
export function setUseLargeLogRequestCount(value: typeof useLargeLogRequestCount): void {
  useLargeLogRequestCount = value;
}
export function setPairsSaveIssues(value: typeof pairsSaveIssues): void {
  pairsSaveIssues = value;
}
export function setLbStatusRound(value: typeof lbStatusRound): void {
  lbStatusRound = value;
}
export function setLbStatusPartialMetrics(value: typeof lbStatusPartialMetrics): void {
  lbStatusPartialMetrics = value;
}
export function setTaskBriefFixture(value: typeof taskBriefFixture): void {
  taskBriefFixture = value;
}
