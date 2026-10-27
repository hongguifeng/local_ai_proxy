import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration rollback documentation", () => {
  it("covers shutdown, config, WAL, database, validation, and previous releases", async () => {
    const document = await readFile(
      new URL("../../docs/operations/migration-rollback.md", import.meta.url),
      "utf8",
    );
    for (const phrase of [
      "关闭你自己启动的隔离实例",
      "before-node",
      "traffic.db-wal",
      "npm run validate:migration",
      "以前接受的版本",
    ]) {
      expect(document).toContain(phrase);
    }
  });
});
