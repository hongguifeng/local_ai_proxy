import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createAdminApp } from "./admin/app.js";
import { registerStaticAssets } from "./admin/static-assets.js";
import type { CliOptions } from "./cli-options.js";
import { ConfigRepository } from "./config/repository.js";
import { createRuntimeConfigSnapshot } from "./config/schema.js";
import type { ApplicationRuntime } from "./lifecycle.js";
import { createRuntimeLogger } from "./logging.js";
import { ProxyServer } from "./proxy/proxy-server.js";
import { RuntimeRecovery } from "./runtime/recovery.js";
import { RuntimeManager } from "./runtime/runtime-manager.js";

export function createProductionRuntime(options: CliOptions): ApplicationRuntime {
  const logger = createRuntimeLogger({ development: process.env.LLM_PROXY_PRETTY_LOGS === "1" });
  const repository = new ConfigRepository(options.configFile);
  let manager: RuntimeManager | null = null;
  let admin: FastifyInstance | null = null;
  const recovery = new RuntimeRecovery({ restart: () => Promise.resolve() });
  return {
    async start(signal): Promise<void> {
      if (signal.aborted) throw new Error("Startup aborted");
      const snapshot = createRuntimeConfigSnapshot(await repository.load());
      manager = new RuntimeManager(
        snapshot.proxies,
        (proxy) =>
          new ProxyServer({
            host: proxy.listenHost,
            port: proxy.listenPort,
            proxy,
            maxRequestBodyBytes: snapshot.capture.maxRequestBodyBytes,
            requestCaptureBytes: snapshot.capture.requestBytes,
            responseCaptureBytes: snapshot.capture.responseBytes,
            totalRequestTimeoutMs: Math.max(...proxy.targets.map((target) => target.timeouts.idleMs), 600_000),
            logger,
          }),
      );
      await manager.startEnabled();
      admin = createAdminApp(
        {
          health: () => recovery.health(manager?.list() ?? []),
          registerRoutes: async (scope) =>
            registerStaticAssets(scope, fileURLToPath(new URL("./public", import.meta.url))),
        },
        { ...(options.adminToken ? { adminToken: options.adminToken } : {}) },
      );
      await admin.listen({ host: options.host, port: options.port });
    },
    async wait(signal): Promise<void> {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
    },
    async stop(): Promise<void> {
      await admin?.close();
      admin = null;
      await manager?.stopAll();
      manager = null;
    },
  };
}
