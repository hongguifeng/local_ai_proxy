import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("usage statistics API contract", () => {
  it("declares strict metric and granularity enums", async () => {
    // The statistics query schema lives with the statistics routes.
    const source = await readFile("src/admin/routes/statistics.ts", "utf8");
    expect(source).toContain('["token", "cost"]');
    expect(source).toContain('["day", "week", "month", "auto"]');
    expect(source).toContain("additionalProperties: false");
  });
});
