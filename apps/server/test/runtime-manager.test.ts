import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeConfigSnapshot, type RuntimeProxy } from "../src/config/schema.js";
import { RuntimeManager, RuntimeOperationError, type ManagedProxyServer } from "../src/runtime/runtime-manager.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => closeServer(server)));
});

describe("RuntimeManager", () => {
  it("starts multiple proxies independently and reports ephemeral actual ports", async () => {
    const proxies = runtimeProxies([
      { id: "proxy-a", enabled: true, listenPort: 0 },
      { id: "proxy-b", enabled: true, listenPort: 0 },
      { id: "proxy-c", enabled: false, listenPort: 0 },
    ]);
    const manager = new RuntimeManager(proxies, nodeServerFactory);
    expect(await manager.startEnabled()).toEqual({ "proxy-a": "running", "proxy-b": "running" });
    const running = manager.list();
    expect(running.map((entry) => entry.state)).toEqual(["running", "running", "configured"]);
    expect(running[0]?.actualListenPort).toBeGreaterThan(0);
    expect(running[1]?.actualListenPort).toBeGreaterThan(0);
    expect(running[0]?.actualListenPort).not.toBe(running[1]?.actualListenPort);
    await manager.stop("proxy-a");
    expect(manager.list()[0]).toMatchObject({ state: "configured", actualListenPort: null });
    expect(manager.list()[1]).toMatchObject({ state: "running" });
    await manager.restart("proxy-b");
    expect(manager.list()[1]).toMatchObject({ state: "running" });
    await manager.stopAll();
  });

  it("rejects duplicate IDs and configured listener conflicts", () => {
    const [proxy] = runtimeProxies([{ id: "same", enabled: true, listenPort: 31001 }]);
    if (!proxy) throw new Error("Expected proxy");
    expect(() => new RuntimeManager([proxy, proxy], nodeServerFactory)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_PROXY_ID" }),
    );
    const other = { ...proxy, id: "other" };
    expect(() => new RuntimeManager([proxy, other], nodeServerFactory)).toThrow(
      expect.objectContaining({ code: "LISTEN_CONFLICT" }),
    );
  });

  it("isolates one listen failure and exposes only a safe address and code", async () => {
    const proxies = runtimeProxies([
      { id: "good", enabled: true, listenPort: 0 },
      { id: "bad", enabled: true, listenPort: 1234, listenHost: "bad host\nvalue" },
    ]);
    const manager = new RuntimeManager(proxies, (proxy) =>
      proxy.id === "bad"
        ? failingServer(Object.assign(new Error("sensitive detail"), { code: "EADDRINUSE" }))
        : nodeServerFactory(proxy),
    );
    expect(await manager.startEnabled()).toEqual({ bad: "failed", good: "running" });
    expect(manager.list()).toEqual([
      expect.objectContaining({
        id: "bad",
        state: "failed",
        errorCode: "EADDRINUSE",
        errorAddress: "bad_host_value:1234",
      }),
      expect.objectContaining({ id: "good", state: "running", errorCode: null }),
    ]);
    expect(JSON.stringify(manager.list())).not.toContain("sensitive detail");
    await manager.stopAll();
  });

  it("serializes concurrent lifecycle operations per proxy", async () => {
    const [proxy] = runtimeProxies([{ id: "proxy", enabled: true, listenPort: 0 }]);
    if (!proxy) throw new Error("Expected proxy");
    const events: string[] = [];
    const manager = new RuntimeManager([proxy], () => ({
      start: async () => {
        events.push("start");
        await Promise.resolve();
        return address(4000);
      },
      stop: async () => {
        events.push("stop");
        await Promise.resolve();
      },
    }));
    await Promise.all([manager.start("proxy"), manager.restart("proxy"), manager.stop("proxy")]);
    expect(events).toEqual(["start", "stop", "start", "stop"]);
    expect(manager.list()[0]).toMatchObject({ state: "configured" });
    await expect(manager.start("missing")).rejects.toBeInstanceOf(RuntimeOperationError);
  });

  it("marks only the failed listener with a sanitized runtime code", () => {
    const proxies = runtimeProxies([
      { id: "one", enabled: true, listenPort: 1001 },
      { id: "two", enabled: true, listenPort: 1002 },
    ]);
    const manager = new RuntimeManager(proxies, nodeServerFactory);
    manager.markFailed("one", "LISTEN FAILED!\nsecret");
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: "one", state: "failed", errorCode: "LISTEN_FAILED__secret" }),
      expect.objectContaining({ id: "two", state: "configured", errorCode: null }),
    ]);
  });
});

function runtimeProxies(
  inputs: readonly { id: string; enabled: boolean; listenPort: number; listenHost?: string }[],
): readonly RuntimeProxy[] {
  return createRuntimeConfigSnapshot({
    version: 1,
    proxies: inputs.map((input, index) => ({
      id: input.id,
      name: input.id,
      enabled: input.enabled,
      listenHost: input.listenHost ?? "127.0.0.1",
      listenPort: input.listenPort,
      defaultTargetId: `target-${index.toString()}`,
      targets: [{ id: `target-${index.toString()}`, name: "Target", url: "http://127.0.0.1:1" }],
    })),
  }).proxies;
}

function nodeServerFactory(proxy: RuntimeProxy): ManagedProxyServer {
  const server = http.createServer((_request, response) => response.end("ok"));
  servers.push(server);
  return {
    start: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(proxy.listenPort, proxy.listenHost, resolvePromise);
      });
      return server.address() as AddressInfo;
    },
    stop: async () => {
      if (server.listening) await closeServer(server);
    },
  };
}

function failingServer(error: Error): ManagedProxyServer {
  return { start: () => Promise.reject(error), stop: () => Promise.resolve() };
}

function address(port: number): AddressInfo {
  return { address: "127.0.0.1", family: "IPv4", port };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectPromise(error);
      else resolvePromise();
    });
  });
}
