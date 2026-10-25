import { describe, expect, it, vi } from "vitest";

const { bridgeFailure } = vi.hoisted(() => ({
  bridgeFailure: new Error("admin module bridge failed"),
}));

vi.mock("../../scripts/build_ui_bundle.js", () => ({
  buildAdminModuleBridge: vi.fn(() => Promise.reject(bridgeFailure)),
}));

import { closeStubAdminServer, closeTestPage, startStubAdminServer } from "./admin-ui-server.js";

describe("admin UI fixture lifecycle", () => {
  it("keeps setup errors when teardown runs before resources initialize", async () => {
    await expect(startStubAdminServer()).rejects.toBe(bridgeFailure);
    await expect(closeTestPage()).resolves.toBeUndefined();
    await expect(closeStubAdminServer()).resolves.toBeUndefined();
  });
});
