import { ConfigV1Schema, type ConfigV1, type ProxyConfig, type TargetConfig } from "@llm-proxy/contracts";

export type PersistedConfig = ConfigV1;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type RuntimeTargetEndpoint = Readonly<{
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  origin: string;
  basePath: string;
}>;

export type RuntimeTarget = DeepReadonly<TargetConfig & { endpoint: RuntimeTargetEndpoint }>;
export type RuntimeProxy = DeepReadonly<Omit<ProxyConfig, "targets"> & { targets: RuntimeTarget[] }>;
export type RuntimeConfigSnapshot = DeepReadonly<Omit<ConfigV1, "proxies"> & { proxies: RuntimeProxy[] }>;

export type ConfigIssue = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

export class ConfigValidationError extends Error {
  public readonly issues: readonly ConfigIssue[];

  public constructor(issues: readonly ConfigIssue[]) {
    super("Configuration is invalid");
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function parsePersistedConfig(input: unknown): PersistedConfig {
  const result = ConfigV1Schema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues.map(toConfigIssue));
  }
  return result.data;
}

export function createRuntimeConfigSnapshot(input: unknown): RuntimeConfigSnapshot {
  const persisted = parsePersistedConfig(input);
  const snapshot = {
    ...persisted,
    proxies: persisted.proxies.map((proxy) => ({
      ...proxy,
      targets: proxy.targets.map((target) => ({
        ...target,
        endpoint: parseTargetEndpoint(target.url),
      })),
    })),
  };
  return deepFreeze(snapshot);
}

function parseTargetEndpoint(rawUrl: string): RuntimeTargetEndpoint {
  const url = new URL(rawUrl);
  const protocol = url.protocol === "https:" ? "https:" : "http:";
  const defaultPort = protocol === "https:" ? 443 : 80;
  return {
    protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    origin: url.origin,
    basePath: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""),
  };
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function toConfigIssue(issue: Readonly<{ path: readonly PropertyKey[]; message: string }>): ConfigIssue {
  return {
    path: issue.path.map((segment) => (typeof segment === "symbol" ? (segment.description ?? "symbol") : segment)),
    message: issue.message,
  };
}
