import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildAdminAppScript } from "../../scripts/build_ui_bundle.js";
import {
  ADMIN_BUNDLE_FILE,
  GENERATED_ASSET_MARKER,
  readAdminAppScript,
} from "../../src/admin/static-assets.js";

const CONCURRENT_BUILDS = 8;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("admin UI script build", () => {
  it("publishes the first script atomically when the destination is absent", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "llm-proxy-admin-app-"));
    const outputFile = path.join(temporaryDirectory, ADMIN_BUNDLE_FILE);

    try {
      expect(await buildAdminAppScript(outputFile)).toBe(outputFile);
      expect(await readFile(outputFile, "utf8")).toContain(GENERATED_ASSET_MARKER);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps concurrent builds readable as complete generated files", async () => {
    const outputFile = await buildAdminAppScript();
    const expected = await readAdminAppScript();
    expect(outputFile).toContain("admin-app.js");
    expect(expected).toContain(GENERATED_ASSET_MARKER);

    const observed: string[] = [];
    const readerState = { finished: false };
    let readFailure: unknown;
    const reader = (async () => {
      while (!readerState.finished) {
        try {
          observed.push(await readAdminAppScript());
        } catch (error) {
          readFailure = error;
          return;
        }
        await nextTurn();
      }
    })();

    try {
      await Promise.all(Array.from({ length: CONCURRENT_BUILDS }, () => buildAdminAppScript()));
    } finally {
      readerState.finished = true;
      await reader;
    }

    expect(readFailure).toBeUndefined();
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((text) => text === expected)).toBe(true);
  });
});
