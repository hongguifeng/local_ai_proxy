import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("usage statistics API contract", () => {
  it("declares strict metric and granularity enums", async () => {
    const source = await readFile("src/admin/admin-server.ts", "utf8");
    expect(source).toContain('["token", "cost"]');
    expect(source).toContain('["day", "week", "month", "auto"]');
    expect(source).toContain("additionalProperties: false");
  });
});
