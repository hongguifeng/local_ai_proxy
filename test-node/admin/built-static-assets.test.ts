import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_SCRIPT_PARTS } from "../../src/admin/static-assets.js";

const DIST_STATIC_DIR = path.resolve("dist-node/src/admin/static");

describe("built admin static assets", () => {
  it("copies every browser entry asset and drops assets the source no longer has", async () => {
    // copy_static_assets.ts runs on import (top-level await, no exports), so this
    // import is what performs the copy; the test does not depend on a previous
    // build having left dist-node behind.
    await mkdir(DIST_STATIC_DIR, { recursive: true });
    // Plant the pre-split single script: the built app serves whatever sits in this
    // directory, so the copier must not keep shipping an asset the source deleted.
    const stale = path.join(DIST_STATIC_DIR, "app.js");
    await writeFile(stale, "// stale build leftover\n");

    const script = await import("../../scripts/copy_static_assets.js");
    expect(script).toBeDefined();

    for (const name of ["index.html", "app.css", ...ADMIN_SCRIPT_PARTS]) {
      await access(path.join(DIST_STATIC_DIR, name));
    }
    await expect(access(stale)).rejects.toThrow();
  });
});
