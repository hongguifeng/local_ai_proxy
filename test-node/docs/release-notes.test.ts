import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("RC release notes", () => {
  it("lists every approved behavior difference and operational warning", async () => {
    const notes = await readFile(
      new URL("../../docs/release-notes-v0.3.0-rc.4.md", import.meta.url),
      "utf8",
    );
    for (const required of [
      "ADR-002",
      "ADR-003",
      "ADR-004",
      "ADR-005",
      "ADR-006",
      "original-request.json",
      "64 MiB",
      "SmartScreen",
      "NSIS installer",
      "portable EXE",
      "CLI ZIP",
      "npm ci --omit=dev",
      "7.58 GB",
      "migration-rollback.md",
    ]) {
      expect(notes).toContain(required);
    }
  });
});
