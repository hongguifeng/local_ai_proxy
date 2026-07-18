import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromBufferPromise } from "yauzl";

import { createCliArchive } from "../../scripts/create_cli_archive.js";

describe("createCliArchive", () => {
  it("packages the compiled CLI without the Electron entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-proxy-cli-"));
    try {
      await mkdir(path.join(root, "dist-node/src"), { recursive: true });
      await writeFile(path.join(root, "dist-node/src/main.js"), "fixture");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
      await writeFile(path.join(root, "package-lock.json"), "{}");
      await writeFile(path.join(root, "README.md"), "readme");
      await writeFile(path.join(root, "README.cn.md"), "readme");
      const output = await createCliArchive(root);
      const zip = await fromBufferPromise(await readFile(output), { lazyEntries: true });
      const names: string[] = [];
      for await (const entry of zip.eachEntry()) names.push(entry.fileName);
      expect(names).toContain("dist-node/src/main.js");
      expect(names).toContain("package.json");
      expect(names.some((name) => name.startsWith("dist-node/electron"))).toBe(false);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
