import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { generateChecksums } from "../../scripts/generate_checksums.js";

describe("generateChecksums", () => {
  it("writes stable SHA-256 entries for release artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-checksum-"));
    try {
      await writeFile(path.join(root, "LLM-Proxy-portable.exe"), "abc");
      const output = await generateChecksums(root);
      expect(output).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  LLM-Proxy-portable.exe\n",
      );
      await expect(readFile(path.join(root, "SHA256SUMS.txt"), "utf8")).resolves.toBe(output);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
