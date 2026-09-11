import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { LogQueryService } from "../src/maintenance/log-query-service.js";
import { TrafficRepository } from "../src/persistence/repository.js";

export interface PricingBenchmarkResult {
  readonly recordCount: number;
  readonly roots: number;
  readonly taskRecords: number;
  readonly medianDetailMs: number;
  readonly medianListMs: number;
  readonly medianSearchMs: number;
  readonly runs: number;
}

export async function runPricingBenchmark(
  recordCount = 10_000,
  runs = 5,
): Promise<PricingBenchmarkResult> {
  const roots = 4;
  const taskRecords = Math.max(2_500, Math.ceil(recordCount / roots));
  const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-pricing-benchmark-"));
  const logRoots = Array.from({ length: roots }, (_, index) => path.join(root, `logs-${index}`));
  try {
    for (const [rootIndex, logRoot] of logRoots.entries()) {
      const repository = new TrafficRepository(logRoot);
      const taskId = `benchmark-task-${rootIndex}`;
      repository.upsertTask({
        id: taskId,
        model: "pricing-benchmark-needle",
        target: `https://target-${rootIndex}.example/v1`,
        request_count: taskRecords,
        match_strategy_version: 4,
      });
      // One transaction per root so the fixture pays a single WAL fsync
      // instead of one per record; per-record commits made CI runners blow
      // past the test timeout.
      repository.transaction(() => {
        for (let index = 0; index < taskRecords; index += 1) {
          repository.upsertRecord({
            id: `${taskId}-record-${index}`,
            task_id: taskId,
            sequence: index + 1,
            method: "POST",
            path: "/v1/responses",
            pricing: {
              pricing_status: "priced",
              billing_model: "gpt-benchmark",
              pricing_snapshot: {
                model_pattern: "gpt-benchmark",
                input_per_million: "5",
                output_per_million: "30",
                cache_read_per_million: "0.5",
                cache_write_per_million: "6.25",
                algorithm_version: 1,
              },
              usage: {
                inputUncachedTokens: 1500,
                outputTokens: 1000,
                cacheReadTokens: 1000,
                cacheWriteTokens: 500,
              },
              cost_nano_cny: "41125000",
            },
          });
        }
      });
      repository.close();
    }
    const service = new LogQueryService(logRoots);
    const lists: number[] = [];
    const searches: number[] = [];
    const details: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      let started = performance.now();
      service.listGroups("", 100, 0);
      lists.push(performance.now() - started);
      started = performance.now();
      service.listGroups("needle", 100, 0);
      searches.push(performance.now() - started);
      started = performance.now();
      service.getGroupPricing("benchmark-task-0");
      details.push(performance.now() - started);
    }
    return {
      recordCount: taskRecords * roots,
      roots,
      taskRecords,
      runs,
      medianListMs: median(lists),
      medianSearchMs: median(searches),
      medianDetailMs: median(details),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

if (import.meta.main) {
  void runPricingBenchmark()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
