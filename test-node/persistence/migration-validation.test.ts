import path from "node:path";
import { describe, expect, it } from "vitest";

import { validateMigrationDatabase } from "../../scripts/validate_migration.js";

describe("validateMigrationDatabase", () => {
  it("counts and samples every relationship in the comprehensive fixture", () => {
    const result = validateMigrationDatabase(
      path.join(process.cwd(), "fixtures", "parity", "database", "comprehensive"),
    );
    expect(result.counts).toEqual({
      tasks: 5,
      records: 6,
      response_links: 2,
      context_links: 2,
      record_search: 6,
    });
    expect(result.orphanCounts).toEqual({
      records: 0,
      response_links: 0,
      context_links: 0,
      record_search: 0,
    });
    expect(result.sampleTask).toMatchObject({ id: "task-chat-fixture", model: "chat-fixture" });
    expect(result.sampleRecord).toMatchObject({
      id: "record-chat-1",
      task_id: "task-chat-fixture",
      status: 200,
    });
  });
});
