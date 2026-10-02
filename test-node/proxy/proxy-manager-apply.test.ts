import http from "node:http";

import { describe, expect, it } from "vitest";

import type { ProxyPair } from "../../src/config/index.js";
import { ProxyManager, ProxyRuntimeRegistry } from "../../src/proxy/index.js";
import type { ProxyConfigurationApplyError } from "../../src/proxy/index.js";

describe("ProxyManager configuration apply", () => {
  it("rejects invalid price configuration without changing the active pair", () => {
    const pair = pairFixture(12_345, "Current pair");
    const manager = new ProxyManager({ pairs: [pair] }, { save: () => Promise.resolve() });
    const firstTarget = pair.targets[0];
    if (firstTarget === undefined) throw new Error("Pair fixture needs a target.");
    const invalid: ProxyPair = {
      ...pair,
      name: "Invalid pair",
      targets: [
        {
          ...firstTarget,
          model_prices: [
            {
              model_pattern: "gpt-*",
              input_per_million: "",
              output_per_million: "1",
              cache_read_per_million: "1",
              cache_write_per_million: "1",
            },
          ],
        },
      ],
    };

    expect(() => manager.applyConfiguration({ pairs: [invalid] })).toThrow(
      expect.objectContaining({
        code: "invalid_config",
      }),
    );
    expect(manager.listPairs()).toMatchObject([{ name: "Current pair" }]);
  });

  it("applies a target change without moving the listener or interrupting requests", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstUpstream = http.createServer((_request, response) => {
      markStarted?.();
      void gate.then(() => response.end("old"));
    });
    const secondUpstream = http.createServer((_request, response) => response.end("new"));
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const oldPair = pairFixture(firstPort, "Old pair");
    const newPair = pairFixture(secondPort, "New pair");
    const registry = new ProxyRuntimeRegistry();
    await registry.startPair(oldPair);
    const manager = new ProxyManager(
      { pairs: [oldPair] },
      { save: () => Promise.resolve() },
      { registry },
    );
    const listenPort = registry.status(oldPair.id).actualListenPort ?? 0;
    const inFlight = requestText(listenPort, "/managed");

    try {
      await started;
      const pairs = await manager.applyConfiguration({ pairs: [newPair] });
      expect(pairs[0]).toMatchObject({
        name: "New pair",
        running: true,
        actual_listen_port: listenPort,
      });
      await expect(requestText(listenPort, "/managed")).resolves.toBe("new");

      release?.();
      await expect(inFlight).resolves.toBe("old");
      expect(manager.state).toBe("ready");
    } finally {
      await manager.stopAll();
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
    }
  });

  it("moves the listener when the listen address changes", async () => {
    const upstream = http.createServer((_request, response) => response.end("rebound"));
    const upstreamPort = await listen(upstream);
    const reserved = http.createServer();
    const fixedPort = await listen(reserved);
    await close(reserved);
    const registry = new ProxyRuntimeRegistry();
    const before: ProxyPair = pairFixture(upstreamPort, "Before");
    const firstRuntime = await registry.startPair(before);
    const manager = new ProxyManager(
      { pairs: [before] },
      { save: () => Promise.resolve() },
      { registry },
    );
    const oldPort = firstRuntime.actualListenPort ?? 0;
    const after: ProxyPair = { ...before, name: "After", listen_port: fixedPort };

    try {
      await expect(requestText(oldPort, "/managed")).resolves.toBe("rebound");
      const pairs = await manager.applyConfiguration({ pairs: [after] });
      expect(pairs[0]).toMatchObject({
        name: "After",
        running: true,
        actual_listen_port: fixedPort,
      });
      await expect(requestText(fixedPort, "/managed")).resolves.toBe("rebound");
      await expect(requestText(oldPort, "/managed")).rejects.toBeDefined();
    } finally {
      await manager.stopAll();
      await close(upstream);
    }
  });

  it("restores old config and runtime when saving the replacement fails", async () => {
    const firstUpstream = http.createServer((_request, response) => response.end("old"));
    const secondUpstream = http.createServer((_request, response) => response.end("new"));
    const [firstPort, secondPort] = await Promise.all([
      listen(firstUpstream),
      listen(secondUpstream),
    ]);
    const oldPair = pairFixture(firstPort, "Old pair");
    const newPair = pairFixture(secondPort, "New pair");
    const registry = new ProxyRuntimeRegistry();
    await registry.startPair(oldPair);
    const manager = new ProxyManager(
      { pairs: [oldPair] },
      {
        save: () => Promise.reject(new Error("save fixture failed")),
      },
      { registry },
    );

    try {
      await expect(manager.applyConfiguration({ pairs: [newPair] })).rejects.toMatchObject({
        name: "ProxyConfigurationApplyError",
        stage: "save",
        failedPairId: undefined,
        rollbackFailures: [],
      } satisfies Partial<ProxyConfigurationApplyError>);
      expect(manager.state).toBe("ready");
      const publicPair = manager.listPairs()[0];
      expect(publicPair).toMatchObject({ name: "Old pair", running: true });
      await expect(requestText(publicPair?.actual_listen_port ?? 0)).resolves.toBe("old");
    } finally {
      await registry.stopAll();
      await Promise.all([close(firstUpstream), close(secondUpstream)]);
    }
  });
});

function pairFixture(upstreamPort: number, name: string): ProxyPair {
  return {
    id: "managed-pair",
    name,
    enabled: true,
    listen_host: "127.0.0.1",
    listen_port: 0,
    access_log: false,
    default_target_id: "managed-target",
    targets: [
      {
        id: "managed-target",
        name: "Managed target",
        enabled: true,
        target_url: `http://127.0.0.1:${upstreamPort}`,
        target_api_key: "",
        target_headers: [],
        strip_request_fields: "",
        inject_request_fields: "",
        log_root: "",
        redact_logs: false,
        model_mappings: [],
        model_prices: [],
      },
    ],
  };
}

function requestText(port: number, requestPath = "/managed"): Promise<string> {
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
        reject(new Error("Manager test server did not bind."));
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
