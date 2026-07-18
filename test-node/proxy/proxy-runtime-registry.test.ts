import http from "node:http";

import { describe, expect, it } from "vitest";

import type { ProxyPair } from "../../src/config/index.js";
import { ProxyRuntimeRegistry } from "../../src/proxy/index.js";

describe("ProxyRuntimeRegistry", () => {
  it("starts a pair and serves traffic on its actual port", async () => {
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`upstream ${request.url}`);
    });
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry();
    const pair = pairFixture(upstreamPort);

    try {
      expect(registry.publicPair(pair)).toMatchObject({
        id: pair.id,
        running: false,
        actual_listen_port: null,
      });
      const started = await registry.startPair(pair);
      expect(started).toMatchObject({ state: "running", running: true });
      expect(started.actualListenPort).toBeTypeOf("number");
      expect(registry.publicPair(pair)).toMatchObject({
        id: pair.id,
        running: true,
        actual_listen_port: started.actualListenPort,
      });
      await expect(requestText(started.actualListenPort ?? 0, "/runtime-start")).resolves.toBe(
        "upstream /runtime-start",
      );
      expect(await registry.startPair(pair)).toEqual(started);
      const stopped = await registry.stopPair(pair.id);
      expect(stopped).toEqual({
        state: "stopped",
        running: false,
        actualListenPort: null,
        error: undefined,
      });
      expect(registry.publicPair(pair)).toMatchObject({
        running: false,
        actual_listen_port: null,
      });
      await expect(requestText(started.actualListenPort ?? 0, "/after-stop")).rejects.toBeDefined();
      expect(await registry.stopPair(pair.id)).toEqual(stopped);
    } finally {
      await registry.stopPair(pair.id);
      await close(upstream);
    }
  });

  it("restarts a pair with updated target configuration", async () => {
    const firstUpstream = http.createServer((_request, response) => response.end("first"));
    const secondUpstream = http.createServer((_request, response) => response.end("second"));
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const registry = new ProxyRuntimeRegistry();
    const firstPair = pairFixture(firstPort);

    try {
      const firstRuntime = await registry.startPair(firstPair);
      await expect(requestText(firstRuntime.actualListenPort ?? 0, "/restart")).resolves.toBe(
        "first",
      );
      const restarted = await registry.restartPair(pairFixture(secondPort));
      expect(restarted).toMatchObject({ state: "running", running: true });
      await expect(requestText(restarted.actualListenPort ?? 0, "/restart")).resolves.toBe(
        "second",
      );
    } finally {
      await registry.stopPair(firstPair.id);
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
    }
  });

  it("starts enabled pairs and stops all registered runtimes", async () => {
    const upstream = http.createServer((_request, response) => response.end("batch"));
    const upstreamPort = await listen(upstream);
    const registry = new ProxyRuntimeRegistry();
    const first = pairFixture(upstreamPort, "enabled-one");
    const second = pairFixture(upstreamPort, "enabled-two");
    const disabled = { ...pairFixture(upstreamPort, "disabled"), enabled: false };

    try {
      const started = await registry.startEnabled([first, disabled, second]);
      expect([...started.started.keys()]).toEqual(["enabled-one", "enabled-two"]);
      expect(started.failed.size).toBe(0);
      expect(registry.status(first.id).running).toBe(true);
      expect(registry.status(second.id).running).toBe(true);
      expect(registry.status(disabled.id).state).toBe("stopped");

      await registry.stopAll();
      expect(registry.status(first.id).state).toBe("stopped");
      expect(registry.status(second.id).state).toBe("stopped");
    } finally {
      await registry.stopAll();
      await close(upstream);
    }
  });

  it("continues starting other pairs when one listener fails", async () => {
    const upstream = http.createServer((_request, response) => response.end("isolated"));
    const blocker = http.createServer();
    const [upstreamPort, occupiedPort] = await Promise.all([listen(upstream), listen(blocker)]);
    const registry = new ProxyRuntimeRegistry();
    const failing = { ...pairFixture(upstreamPort, "failing"), listen_port: occupiedPort };
    const healthy = pairFixture(upstreamPort, "healthy");

    try {
      const result = await registry.startEnabled([failing, healthy]);
      expect(result.failed.get(failing.id)).toMatchObject({ code: "EADDRINUSE" });
      expect(result.started.get(healthy.id)).toMatchObject({ state: "running" });
      expect(registry.status(failing.id).state).toBe("failed");
      await expect(
        requestText(result.started.get(healthy.id)?.actualListenPort ?? 0, "/isolated"),
      ).resolves.toBe("isolated");
    } finally {
      await registry.stopAll();
      await Promise.all([close(upstream), close(blocker)]);
    }
  });
});

function pairFixture(upstreamPort: number, pairId = "runtime-pair"): ProxyPair {
  return {
    id: pairId,
    name: "Runtime pair",
    enabled: true,
    listen_host: "127.0.0.1",
    listen_port: 0,
    access_log: false,
    default_target_id: "runtime-target",
    targets: [
      {
        id: "runtime-target",
        name: "Runtime target",
        enabled: true,
        target_url: `http://127.0.0.1:${upstreamPort}`,
        target_api_key: "",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        timeout: 10,
        log_root: "",
        redact_logs: false,
        model_mappings: [],
      },
    ],
  };
}

function requestText(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Runtime test server did not bind."));
      } else {
        resolve(address.port);
      }
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
