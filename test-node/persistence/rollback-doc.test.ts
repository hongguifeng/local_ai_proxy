import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration rollback documentation", () => {
  it("covers shutdown, config, WAL, database, validation, and previous releases", async () => {
    const document = await readFile(
      new URL("../../docs/migration-rollback.md", import.meta.url),
      "utf8",
    );
    for (const phrase of [
      "wait until all listening ports close",
      "before-node",
      "traffic.db-wal",
      "validate:migration",
      "previously accepted release",
    ]) {
      expect(document).toContain(phrase);
    }
  });
});
