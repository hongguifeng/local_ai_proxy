import path from "node:path";

import {
  AdminControlPlane,
  applicationHealth,
  loadAdminStaticAssets,
  type AdminControlPlaneAddress,
} from "../admin/index.js";
import { ConfigRepository } from "../config/index.js";
import { LogQueryService } from "../maintenance/index.js";
import { ProxyManager } from "../proxy/index.js";
import { Application } from "./application.js";

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

/**
 * 应用的“组合根”（composition root）：在这里创建并连接配置仓库、代理管理器、
 * 日志查询服务和管理服务器。业务模块只依赖接口，具体对象统一在最外层组装。
 */
export function createNodeApplication(options: NodeApplicationOptions): NodeApplication {
  const repository = new ConfigRepository(options.configFile, options.logRoot);
  let manager: ProxyManager | undefined;
  let admin: AdminControlPlane | undefined;
  let address: AdminControlPlaneAddress | undefined;
  const application = new Application({
    start: async () => {
      // 启动顺序很重要：先加载配置并启动代理，成功后才开放管理端口。
      const config = await repository.load();
      manager = new ProxyManager(config, repository, {
        logRootBaseDirectory: path.dirname(options.applicationConfigFile),
      });
      const currentManager = manager;
      const startResult = await currentManager.startEnabled();
      if (startResult.failed.size > 0) {
        // 多个已启用代理中只要有一个失败，就撤销本次启动，避免“看似成功”的半启动状态。
        await currentManager.stopAll();
        throw new AggregateError(
          [...startResult.failed.values()],
          `Failed to start ${startResult.failed.size} enabled proxy pair(s).`,
        );
      }
      try {
        admin = new AdminControlPlane({
          host: options.host,
          port: options.port,
          getHealth: () =>
            applicationHealth(
              application.state,
              options.version ?? "development",
              currentManager.state === "degraded",
            ),
          pairService: currentManager,
          logService: new LogQueryService(() => currentManager.logRoots()),
          staticAssets: await loadAdminStaticAssets(),
        });
        address = await admin.start();
      } catch (error) {
        // 管理服务器启动失败时，已经打开的代理端口也必须关闭。
        await currentManager.stopAll();
        admin = undefined;
        throw error;
      }
    },
    stop: async () => {
      // 关闭时尽量执行全部清理动作，而不是遇到第一个错误就中断。
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
