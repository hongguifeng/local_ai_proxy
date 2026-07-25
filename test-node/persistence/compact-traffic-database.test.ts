import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { compactTrafficDatabase } from "../../scripts/compact_traffic_database.js";
import { TrafficRepository } from "../../src/persistence/repository.js";

describe("compactTrafficDatabase", () => {
  it("copies, migrates, verifies, and vacuums without losing bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-compact-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(source);
    try {
      await copyFile(
        path.join(process.cwd(), "fixtures/parity/database/comprehensive/traffic.db"),
        path.join(source, "traffic.db"),
      );
      const result = await compactTrafficDatabase(source, destination);

      expect(result).toMatchObject({
        tasks: 5,
        records: 6,
        integrity_check: "ok",
        foreign_key_violations: 0,
      });
      expect(result.body_digest).toMatch(/^[a-f0-9]{64}$/u);

      const repository = new TrafficRepository(destination);
      expect(repository.getRecord("record-responses-1")).toMatchObject({
        request_body: { model: "gpt-fixture", stream: true },
        response_body: { stream_summary: { content: "hello from fixture" } },
      });
      repository.close();

      const inspection = new Database(path.join(destination, "traffic.db"), { readonly: true });
      expect(
        inspection
          .prepare(
            `SELECT COUNT(*) FROM records
             WHERE request_body_json IS NOT NULL
                OR original_request_body_json IS NOT NULL
                OR response_body_json IS NOT NULL`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(inspection.prepare("SELECT COUNT(*) FROM body_chunks").pluck().get()).toBeGreaterThan(
        0,
      );
      inspection.close();
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
