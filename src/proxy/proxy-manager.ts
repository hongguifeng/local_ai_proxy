import path from "node:path";

import {
  validateProxyConfigFile,
  type ProxyConfigFile,
  type ProxyPair,
  type PublicProxyPair,
} from "../config/index.js";
import { stableJsonStringify } from "../shared/index.js";
import { ProxyRuntimeRegistry } from "./proxy-runtime-registry.js";
import type { StartEnabledResult } from "./proxy-runtime-registry.js";

export type ProxyManagerState = "degraded" | "ready";
export type ConfigurationApplyStage = "save" | "start" | "stop";

export interface ProxyConfigSaver {
  save(config: ProxyConfigFile): Promise<void>;
}

export interface ProxyManagerOptions {
  readonly logRootBaseDirectory?: string;
  readonly registry?: ProxyRuntimeRegistry;
}

export class ProxyConfigurationApplyError extends Error {
  readonly code: string;
  readonly failedPairId: string | undefined;
  readonly rollbackFailures: readonly string[];
  readonly stage: ConfigurationApplyStage;
  readonly statusCode: number;

  constructor(
    stage: ConfigurationApplyStage,
    failedPairId: string | undefined,
    cause: unknown,
    rollbackFailures: readonly string[],
  ) {
    super(`Proxy configuration apply failed during ${stage}.`, { cause });
    this.name = "ProxyConfigurationApplyError";
    this.stage = stage;
    this.failedPairId = failedPairId;
    this.rollbackFailures = rollbackFailures;
    const listenConflict =
      typeof cause === "object" &&
      cause !== null &&
      (cause as NodeJS.ErrnoException).code === "EADDRINUSE";
    this.code = listenConflict ? "listen_conflict" : "configuration_apply_failed";
    this.statusCode = listenConflict ? 409 : 500;
  }
}

export class ProxyPairNotFoundError extends Error {
  readonly code = "pair_not_found";
  readonly statusCode = 404;

  constructor(pairId: string) {
    super(`Proxy pair not found: ${pairId}`);
    this.name = "ProxyPairNotFoundError";
  }
}

export class ProxyManager {
  readonly #logRootBaseDirectory: string;
  readonly #repository: ProxyConfigSaver;
  readonly #registry: ProxyRuntimeRegistry;
  #applyQueue: Promise<void> = Promise.resolve();
  #config: ProxyConfigFile;
  #state: ProxyManagerState = "ready";

  constructor(
    config: ProxyConfigFile,
    repository: ProxyConfigSaver,
    options: ProxyManagerOptions = {},
  ) {
    this.#config = validateProxyConfigFile(config);
    this.#repository = repository;
    this.#registry = options.registry ?? new ProxyRuntimeRegistry();
    this.#logRootBaseDirectory = path.resolve(options.logRootBaseDirectory ?? process.cwd());
  }

  get state(): ProxyManagerState {
    return this.#state;
  }

  listPairs(): readonly PublicProxyPair[] {
    return this.#config.pairs.map((pair) => this.#registry.publicPair(pair));
  }

  logRoots(): readonly string[] {
    return [
      ...new Set(
        this.#config.pairs.flatMap((pair) =>
          pair.targets
            .map((target) => resolveRuntimeLogRoot(target.log_root, this.#logRootBaseDirectory))
            .filter((root): root is string => root !== undefined),
        ),
      ),
    ];
  }

  startEnabled(): Promise<StartEnabledResult> {
    return this.#registry.startEnabled(this.#config.pairs.map((pair) => this.#runtimePair(pair)));
  }

  async stopAll(): Promise<void> {
    await this.#applyQueue;
    await this.#registry.stopAll();
  }

  replacePairs(pairs: readonly ProxyPair[]): Promise<readonly PublicProxyPair[]> {
    return this.applyConfiguration({ pairs: [...pairs] });
  }

  async setPairEnabled(pairId: string, enabled: boolean): Promise<PublicProxyPair> {
    const existing = this.#config.pairs.find((pair) => pair.id === pairId);
    if (existing === undefined) {
      throw new ProxyPairNotFoundError(pairId);
    }
    if (existing.enabled !== enabled) {
      await this.replacePairs(
        this.#config.pairs.map((pair) => (pair.id === pairId ? { ...pair, enabled } : pair)),
      );
    }
    const publicPair = this.listPairs().find((pair) => pair.id === pairId);
    if (publicPair === undefined) {
      throw new ProxyPairNotFoundError(pairId);
    }
    return publicPair;
  }

  applyConfiguration(config: ProxyConfigFile): Promise<readonly PublicProxyPair[]> {
    const validated = validateProxyConfigFile(config);
    assertNoEnabledListenConflicts(validated.pairs);
    // 多个管理 API 请求可能同时修改配置。Promise 尾链充当轻量互斥锁，
    // 保证每次 diff、启停和保存都基于上一轮已经完成的状态。
    const operation = this.#applyQueue.then(() => this.#applyValidated(validated));
    this.#applyQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #applyValidated(next: ProxyConfigFile): Promise<readonly PublicProxyPair[]> {
    const current = this.#config;
    const diff = diffProxyPairs(current.pairs, next.pairs);
    const oldAffected = [...diff.removed, ...diff.updated.map(({ before }) => before)];
    const newAffected = [...diff.added, ...diff.updated.map(({ after }) => after)];
    const stoppedOld: ProxyPair[] = [];
    const startedNew: ProxyPair[] = [];
    let stage: ConfigurationApplyStage = "stop";
    let failedPairId: string | undefined;
    try {
      // 配置应用是一个补偿式事务：先停止受影响的旧实例，再启动新实例，最后落盘。
      // 任一步失败都会在 catch 中尽力恢复旧运行态。
      for (const pair of oldAffected) {
        if (this.#registry.status(pair.id).running) {
          failedPairId = pair.id;
          await this.#registry.stopPair(pair.id);
          stoppedOld.push(pair);
        }
      }
      stage = "start";
      for (const pair of newAffected) {
        if (pair.enabled) {
          failedPairId = pair.id;
          await this.#registry.startPair(this.#runtimePair(pair));
          startedNew.push(pair);
        }
      }
      stage = "save";
      failedPairId = undefined;
      await this.#repository.save(next);
      this.#config = next;
      this.#state = "ready";
      return this.listPairs();
    } catch (error) {
      const rollbackFailures = await this.#rollback(startedNew, stoppedOld);
      this.#state = rollbackFailures.length === 0 ? "ready" : "degraded";
      throw new ProxyConfigurationApplyError(stage, failedPairId, error, rollbackFailures);
    }
  }

  async #rollback(
    startedNew: readonly ProxyPair[],
    stoppedOld: readonly ProxyPair[],
  ): Promise<string[]> {
    const failures: string[] = [];
    // 按启动的逆序停止新实例，和常见的资源栈释放顺序一致。
    for (const pair of [...startedNew].reverse()) {
      try {
        await this.#registry.stopPair(pair.id);
      } catch {
        failures.push(pair.id);
      }
    }
    for (const pair of stoppedOld) {
      try {
        await this.#registry.startPair(this.#runtimePair(pair));
      } catch {
        failures.push(pair.id);
      }
    }
    return failures;
  }

  #runtimePair(pair: ProxyPair): ProxyPair {
    return {
      ...pair,
      targets: pair.targets.map((target) => ({
        ...target,
        log_root: resolveRuntimeLogRoot(target.log_root, this.#logRootBaseDirectory) ?? "",
      })),
    };
  }
}

export function resolveRuntimeLogRoot(
  configuredPath: string,
  baseDirectory: string,
): string | undefined {
  const trimmed = configuredPath.trim();
  if (trimmed === "") return undefined;
  return path.resolve(baseDirectory, trimmed);
}

export interface UpdatedProxyPair {
  readonly before: ProxyPair;
  readonly after: ProxyPair;
}

export interface ProxyPairConfigDiff {
  readonly added: readonly ProxyPair[];
  readonly removed: readonly ProxyPair[];
  readonly unchanged: readonly ProxyPair[];
  readonly updated: readonly UpdatedProxyPair[];
}

export class ProxyListenConflictError extends Error {
  readonly code = "listen_conflict";
  readonly conflictingPairId: string;
  readonly host: string;
  readonly pairId: string;
  readonly port: number;
  readonly statusCode = 409;

  constructor(pair: ProxyPair, conflictingPair: ProxyPair) {
    super(
      `Proxy pair ${pair.id} conflicts with ${conflictingPair.id} on ${pair.listen_host}:${pair.listen_port}.`,
    );
    this.name = "ProxyListenConflictError";
    this.pairId = pair.id;
    this.conflictingPairId = conflictingPair.id;
    this.host = pair.listen_host;
    this.port = pair.listen_port;
  }
}

export function assertNoEnabledListenConflicts(pairs: readonly ProxyPair[]): void {
  const enabled = pairs.filter((pair) => pair.enabled && pair.listen_port !== 0);
  for (const [index, pair] of enabled.entries()) {
    const conflict = enabled
      .slice(0, index)
      .find(
        (candidate) =>
          candidate.listen_port === pair.listen_port &&
          hostsConflict(candidate.listen_host, pair.listen_host),
      );
    if (conflict !== undefined) {
      throw new ProxyListenConflictError(pair, conflict);
    }
  }
}

export function diffProxyPairs(
  current: readonly ProxyPair[],
  next: readonly ProxyPair[],
): ProxyPairConfigDiff {
  const currentById = new Map(current.map((pair) => [pair.id, pair]));
  const nextIds = new Set(next.map((pair) => pair.id));
  const added: ProxyPair[] = [];
  const unchanged: ProxyPair[] = [];
  const updated: UpdatedProxyPair[] = [];
  for (const pair of next) {
    const existing = currentById.get(pair.id);
    if (existing === undefined) {
      added.push(pair);
    } else if (stableJsonStringify(existing) === stableJsonStringify(pair)) {
      unchanged.push(pair);
    } else {
      updated.push({ before: existing, after: pair });
    }
  }
  return {
    added,
    removed: current.filter((pair) => !nextIds.has(pair.id)),
    unchanged,
    updated,
  };
}

function hostsConflict(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return (
    normalizedLeft === normalizedRight ||
    isWildcardHost(normalizedLeft) ||
    isWildcardHost(normalizedRight)
  );
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}
