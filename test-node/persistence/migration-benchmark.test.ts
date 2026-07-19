import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runMigrationBenchmark } from "../../scripts/migration_benchmark.js";

describe("runMigrationBenchmark", () => {
  it("measures backup time and conservative free disk requirements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-benchmark-test-"));
    try {
      const result = await runMigrationBenchmark(10, root);
      expect(result.recordCount).toBe(10);
      expect(result.databaseBytes).toBeGreaterThan(0);
      expect(result.backupBytes).toBeGreaterThan(0);
      expect(result.backupDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.recommendedFreeBytes).toBeGreaterThan(
        result.databaseBytes + result.backupBytes,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
