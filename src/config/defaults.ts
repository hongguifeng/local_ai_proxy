import type { ProxyPair, TargetConfig } from "./config-schema.js";

export const DEFAULT_CONFIG_PATH = "logs/proxies.json";
export const DEFAULT_LOG_ROOT = "logs";
export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 1234;
export const DEFAULT_TARGET_URL = "http://127.0.0.1:1235";

export const SUGGESTED_STRIP_REQUEST_FIELDS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "typical_p",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "seed",
] as const;

export function createDefaultTarget(logRoot = DEFAULT_LOG_ROOT): TargetConfig {
  return {
    id: "target-1",
    name: "Target",
    enabled: true,
    target_url: DEFAULT_TARGET_URL,
    target_api_key: "",
    target_headers: [],
    strip_request_fields: "",
    inject_request_fields: "",
    log_root: logRoot,
    redact_logs: false,
    model_mappings: [],
  };
}

export function createDefaultProxyPair(logRoot = DEFAULT_LOG_ROOT): ProxyPair {
  const target = createDefaultTarget(logRoot);
  return {
    id: "default",
    name: "Default proxy",
    enabled: false,
    listen_host: DEFAULT_PROXY_HOST,
    listen_port: DEFAULT_PROXY_PORT,
    access_log: false,
    targets: [target],
    default_target_id: target.id,
  };
}
