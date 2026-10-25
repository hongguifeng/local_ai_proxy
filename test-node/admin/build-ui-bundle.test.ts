import { describe, expect, it } from "vitest";

import { buildAdminModuleBridge } from "../../scripts/build_ui_bundle.js";
import { GENERATED_ASSET_MARKER, readAdminModuleBridge } from "../../src/admin/static-assets.js";

const CONCURRENT_BUILDS = 8;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("admin UI module bridge build", () => {
  it("keeps concurrent builds readable as complete generated files", async () => {
    const outputFile = await buildAdminModuleBridge();
    const expected = await readAdminModuleBridge();
    expect(outputFile).toContain("modules-bridge.js");
    expect(expected).toContain(GENERATED_ASSET_MARKER);

    const observed: string[] = [];
    const readerState = { finished: false };
    let readFailure: unknown;
    const reader = (async () => {
      while (!readerState.finished) {
        try {
          observed.push(await readAdminModuleBridge());
        } catch (error) {
          readFailure = error;
          return;
        }
        await nextTurn();
      }
    })();

    try {
      await Promise.all(Array.from({ length: CONCURRENT_BUILDS }, () => buildAdminModuleBridge()));
    } finally {
      readerState.finished = true;
      await reader;
    }

    expect(readFailure).toBeUndefined();
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((text) => text === expected)).toBe(true);
  });
});
