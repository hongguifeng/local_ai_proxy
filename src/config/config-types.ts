import type { ModelMapping, ProxyPair } from "./config-schema.js";

export type HeaderPair = readonly [name: string, value: string];
export type TargetScheme = "http" | "https";

export interface PublicProxyPair extends ProxyPair {
  readonly actual_listen_port: number | null;
  readonly running: boolean;
}

export interface RuntimeTarget {
  readonly enabled: boolean;
  readonly id: string;
  readonly injectRequestFields: Readonly<Record<string, unknown>>;
  readonly logRoot: string | undefined;
  readonly modelMappings: readonly ModelMapping[];
  readonly name: string;
  readonly redactLogs: boolean;
  readonly stripRequestFields: ReadonlySet<string>;
  readonly targetApiKey: string;
  readonly targetBasePath: string;
  readonly targetDisplayUrl: string;
  readonly targetHeaders: readonly HeaderPair[];
  readonly targetHost: string;
  readonly targetPort: number;
  readonly targetScheme: TargetScheme;
}

export interface RuntimeProxyConfig {
  readonly accessLog: boolean;
  readonly defaultTargetId: string;
  readonly pairId: string;
  readonly pairName: string;
  readonly targets: readonly RuntimeTarget[];
}

export interface ProxyRuntimeStatus {
  readonly actualListenPort: number | null;
  readonly running: boolean;
}
