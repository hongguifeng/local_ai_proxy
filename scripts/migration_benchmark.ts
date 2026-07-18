import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { TrafficRepository, backupDatabase, connectLogDatabase } from "../src/persistence/index.js";

export interface MigrationBenchmarkResult {
  readonly backupBytes: number;
  readonly backupDurationMs: number;
  readonly databaseBytes: number;
  readonly recordCount: number;
  readonly recommendedFreeBytes: number;
}

export async function runMigrationBenchmark(
  recordCount: number,
  workingRoot?: string,
): Promise<MigrationBenchmarkResult> {
  if (!Number.isInteger(recordCount) || recordCount < 1) {
    throw new RangeError("recordCount must be a positive integer.");
  }
  const ownsRoot = workingRoot === undefined;
  const root = workingRoot ?? (await mkdtemp(path.join(tmpdir(), "llm-proxy-large-db-")));
  const logRoot = path.join(root, "logs");
  const repository = new TrafficRepository(logRoot, { now: () => "2026-07-18T06:00:00.000Z" });
  repository.upsertTask({
    id: "task-large-rehearsal",
    kind: "responses",
    model: "large-fixture-model",
    match_strategy_version: 4,
  });
  const payload = "migration-payload-".repeat(128);
  for (let index = 0; index < recordCount; index += 1) {
    repository.upsertRecord({
      id: `record-large-${index}`,
      task_id: "task-large-rehearsal",
      sequence: index + 1,
      method: "POST",
      path: "/v1/responses",
      request_body: { index, input: payload },
      response_body: { id: `response-${index}`, output: payload },
    });
  }
  repository.close();
  const databasePath = path.join(logRoot, "traffic.db");
  const databaseBytes = (await stat(databasePath)).size;
  const backupPath = path.join(root, "backup", "traffic.db");
  const database = connectLogDatabase(logRoot);
  const started = performance.now();
  await backupDatabase(database, backupPath);
  const backupDurationMs = performance.now() - started;
  database.close();
  const backupBytes = (await stat(backupPath)).size;
  const result = {
    recordCount,
    databaseBytes,
    backupBytes,
    backupDurationMs,
    recommendedFreeBytes: Math.ceil((databaseBytes + backupBytes) * 1.2),
  };
  if (ownsRoot) await rm(root, { recursive: true });
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = Number(process.argv[2] ?? "1000");
  process.stdout.write(`${JSON.stringify(await runMigrationBenchmark(count), null, 2)}\n`);
}
