import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { rehearseRealData } from "../../scripts/rehearse_real_data.js";

describe("real-data copy rehearsal", () => {
  it("backs up, migrates, validates, rolls back, and reopens an isolated copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-real-rehearsal-"));
    const source = path.join(root, "source");
    const rehearsal = path.join(root, "rehearsal");
    await mkdir(source);
    try {
      await copyFile(
        path.join(process.cwd(), "fixtures/parity/database/comprehensive/traffic.db"),
        path.join(source, "traffic.db"),
      );
      await copyFile(
        path.join(process.cwd(), "fixtures/parity/config/proxies-comprehensive.json"),
        path.join(source, "proxies.json"),
      );

      const result = await rehearseRealData(source, rehearsal);

      expect(result.configPairCount).toBeGreaterThan(0);
      expect(result.migrated.counts).toMatchObject({ tasks: 5, records: 6 });
      expect(result.migrated.orphanCounts).toEqual({
        context_links: 0,
        record_search: 0,
        records: 0,
        response_links: 0,
      });
      expect(result.rollbackHashMatch).toBe(true);
      expect(result.rollbackReopen.counts).toEqual(result.migrated.counts);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
