import { readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";

describe("admin UI source migration", () => {
  it("keeps the migrated index HTML identical to the visual baseline source", async () => {
    const [migrated, baseline] = await Promise.all([
      readFile(path.resolve("src/admin/static/index.html"), "utf8"),
      readFile(path.resolve("llm_proxy/static/index.html"), "utf8"),
    ]);
    expect(migrated).toBe(await format(baseline, { parser: "html", printWidth: 100 }));
  });
});
