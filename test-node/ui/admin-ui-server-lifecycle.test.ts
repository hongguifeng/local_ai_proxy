import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDoubles = vi.hoisted(() => ({
  buildAdminModuleBridge: vi.fn(),
  createAdminServer: vi.fn(),
  loadAdminStaticAssets: vi.fn(),
  chromium: {
    executablePath: vi.fn(),
    launch: vi.fn(),
  },
}));

vi.mock("../../scripts/build_ui_bundle.js", () => ({
  buildAdminModuleBridge: testDoubles.buildAdminModuleBridge,
}));

vi.mock("../../src/admin/index.js", () => ({
  applicationHealth: vi.fn(() => "running"),
  createAdminServer: testDoubles.createAdminServer,
  loadAdminStaticAssets: testDoubles.loadAdminStaticAssets,
}));

vi.mock("@playwright/test", () => ({ chromium: testDoubles.chromium }));

import {
  closeStubAdminServer,
  closeTestPage,
  resetStubAdminServer,
  startStubAdminServer,
} from "./admin-ui-server.js";

function makeServer(listen: () => Promise<void> = () => Promise.resolve()) {
  return {
    listen: vi.fn(listen),
    close: vi.fn(() => Promise.resolve()),
    server: {
      address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: 4123 })),
    },
  };
}

function makePage() {
  return {
    on: vi.fn(),
    addInitScript: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
}

function makeBrowser(newPage: () => Promise<unknown> = () => Promise.resolve(makePage())) {
  return {
    newPage: vi.fn(newPage),
    close: vi.fn(() => Promise.resolve()),
  };
}

function configureStart(
  server: ReturnType<typeof makeServer>,
  browser: ReturnType<typeof makeBrowser>,
): void {
  testDoubles.createAdminServer.mockReturnValue(server);
  testDoubles.chromium.launch.mockResolvedValue(browser);
}

describe("admin UI fixture lifecycle", () => {
  beforeEach(() => {
    testDoubles.buildAdminModuleBridge.mockResolvedValue(undefined);
    testDoubles.loadAdminStaticAssets.mockResolvedValue({});
    testDoubles.chromium.executablePath.mockReturnValue("fixture-chrome");
  });

  afterEach(async () => {
    await closeTestPage();
    await closeStubAdminServer();
  });

  it("keeps setup errors when teardown runs before resources initialize", async () => {
    const bridgeFailure = new Error("admin module bridge failed");
    testDoubles.buildAdminModuleBridge.mockRejectedValue(bridgeFailure);

    await expect(startStubAdminServer()).rejects.toBe(bridgeFailure);
    await expect(closeTestPage()).resolves.toBeUndefined();
    await expect(closeStubAdminServer()).resolves.toBeUndefined();
  });

  it("closes a server owned before listening fails and preserves the setup error", async () => {
    const listenFailure = new Error("admin server listen failed");
    const server = makeServer(() => Promise.reject(listenFailure));
    configureStart(server, makeBrowser());

    await expect(startStubAdminServer()).rejects.toBe(listenFailure);
    await expect(closeStubAdminServer()).resolves.toBeUndefined();

    expect(server.close).toHaveBeenCalledOnce();
    await expect(closeStubAdminServer()).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("closes browser and server when page setup fails after browser ownership", async () => {
    const pageSetupFailure = new Error("page setup failed");
    const server = makeServer();
    const browser = makeBrowser(() => Promise.reject(pageSetupFailure));
    configureStart(server, browser);

    await startStubAdminServer();
    await expect(resetStubAdminServer()).rejects.toBe(pageSetupFailure);
    await expect(closeStubAdminServer()).resolves.toBeUndefined();

    expect(browser.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    await expect(closeStubAdminServer()).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("closes and clears a page owned before page setup fails", async () => {
    const pageSetupFailure = new Error("page init script failed");
    const page = makePage();
    page.addInitScript.mockRejectedValue(pageSetupFailure);
    const server = makeServer();
    const browser = makeBrowser(() => Promise.resolve(page));
    configureStart(server, browser);

    await startStubAdminServer();
    await expect(resetStubAdminServer()).rejects.toBe(pageSetupFailure);
    await expect(closeTestPage()).resolves.toBeUndefined();

    expect(page.close).toHaveBeenCalledOnce();
    await expect(closeTestPage()).resolves.toBeUndefined();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("attempts both cleanup operations and preserves the first cleanup error", async () => {
    const browserFailure = new Error("browser close failed");
    const serverFailure = new Error("server close failed");
    const server = makeServer();
    server.close.mockRejectedValue(serverFailure);
    const browser = makeBrowser();
    browser.close.mockRejectedValue(browserFailure);
    configureStart(server, browser);

    await startStubAdminServer();
    await expect(closeStubAdminServer()).rejects.toBe(browserFailure);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();

    await expect(closeStubAdminServer()).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("preserves successful page, browser, and server teardown", async () => {
    const page = makePage();
    const server = makeServer();
    const browser = makeBrowser(() => Promise.resolve(page));
    configureStart(server, browser);

    await startStubAdminServer();
    await resetStubAdminServer();
    await closeTestPage();
    await closeStubAdminServer();

    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });
});
