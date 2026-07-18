import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findPortableArtifact } from "../../scripts/artifact_smoke.js";

describe("artifact smoke test", () => {
  it("selects the portable executable and rejects a missing artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-artifact-"));
    try {
      await writeFile(path.join(root, "LLM Proxy-0.1.0-x64-setup.exe"), "fixture");
      await expect(findPortableArtifact(root)).rejects.toThrow("Portable artifact not found");
      const portable = path.join(root, "LLM Proxy-0.1.0-x64-portable.exe");
      await writeFile(portable, "fixture");
      await expect(findPortableArtifact(root)).resolves.toBe(portable);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
