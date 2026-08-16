import http from "node:http";

import { describe, expect, it } from "vitest";

import type { ProxyPair } from "../../src/config/index.js";
import { ProxyManager, ProxyRuntimeRegistry } from "../../src/proxy/index.js";
import type { ProxyConfigurationApplyError } from "../../src/proxy/index.js";

describe("ProxyManager configuration apply", () => {
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
      },
    ],
  };
}

function requestText(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/managed" }, (response) => {
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
