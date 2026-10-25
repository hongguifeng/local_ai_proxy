import path from "node:path";

import {
  AdminControlPlane,
  applicationHealth,
  loadAdminStaticAssets,
  type AdminControlPlaneAddress,
  type AdminControlPlaneOptions,
} from "../admin/index.js";
import { ConfigRepository } from "../config/index.js";
import { LogQueryService } from "../maintenance/index.js";
import { ProxyManager } from "../proxy/index.js";
import { Application } from "./application.js";
import { assembleAdminServices, assertAdminServicesComplete } from "./admin-services.js";

export interface NodeApplicationOptions {
  readonly applicationConfigFile: string;
  readonly configFile: string;
  readonly host: string;
  readonly logRoot: string;
  readonly port: number;
  readonly version?: string;
}

export interface NodeApplication {
  readonly application: Application;
  readonly address: () => AdminControlPlaneAddress | undefined;
}

export function createNodeApplication(options: NodeApplicationOptions): NodeApplication {
  const repository = new ConfigRepository(options.configFile, options.logRoot);
  let manager: ProxyManager | undefined;
  let admin: AdminControlPlane | undefined;
  let address: AdminControlPlaneAddress | undefined;
  const application = new Application({
    start: async () => {
      const loadedConfig = await repository.load();
      manager = new ProxyManager(loadedConfig, repository, {
        logRootBaseDirectory: path.dirname(options.applicationConfigFile),
      });
      const currentManager = manager;
      const startResult = await currentManager.startEnabled();
      if (startResult.failed.size > 0) {
        await currentManager.stopAll();
        throw new AggregateError(
          [...startResult.failed.values()],
          `Failed to start ${startResult.failed.size} enabled proxy pair(s).`,
        );
      }
      // One query service owns every log-backed admin view, including usage statistics, for
      // as long as this start lasts. The services it feeds are assembled from it and the
      // manager, and are handed to the control plane below; nothing else holds them.
      const logs = new LogQueryService(() => currentManager.logRoots());
      try {
        const adminOptions: AdminControlPlaneOptions = {
          host: options.host,
          port: options.port,
          staticAssets:
            options.version !== undefined ? await loadAdminStaticAssets() : loadAdminStaticAssets,
          ...assembleAdminServices({
            manager: currentManager,
            logQuery: logs,
            getHealth: () =>
              applicationHealth(
                application.state,
                options.version ?? "development",
                currentManager.state === "degraded",
              ),
          }),
        };
        // Checked before the control plane is built, so a service the assembly left out fails
        // here with its name instead of answering 404 from an unregistered route later.
        assertAdminServicesComplete(adminOptions);
        admin = new AdminControlPlane(adminOptions);
        address = await admin.start();
      } catch (error) {
        await currentManager.stopAll();
        admin = undefined;
        throw error;
      }
    },
    stop: async () => {
      const failures: Error[] = [];
      if (admin !== undefined) {
        await admin.close().catch((error: unknown) => failures.push(asError(error)));
      }
      if (manager !== undefined) {
        await manager.stopAll().catch((error: unknown) => failures.push(asError(error)));
      }
      admin = undefined;
      manager = undefined;
      address = undefined;
      if (failures.length > 0) {
        throw new AggregateError(failures, "Application shutdown failed.");
      }
    },
  });

  return { application, address: () => address };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
