import { isRecord } from "../shared/index.js";

import type {
  LoadBalancerGroup,
  LoadBalancerMember,
  LoadBalancerStrategy,
  ModelMapping,
  ModelPrice,
  ProxyConfigFile,
  ProxyPair,
  TargetConfig,
} from "./config-schema.js";
import { validateProxyConfigFile } from "./config-validation.js";
import { createDefaultTarget, DEFAULT_LOG_ROOT } from "./defaults.js";

export function ensureAtLeastOneTarget(
  targets: readonly TargetConfig[],
  logRoot = DEFAULT_LOG_ROOT,
): TargetConfig[] {
  return targets.length > 0 ? [...targets] : [createDefaultTarget(logRoot)];
}

export function normalizeDefaultTargetId(
  requestedId: unknown,
  targets: readonly TargetConfig[],
): string {
  const firstTarget = targets[0];
  if (firstTarget === undefined) {
    throw new Error("Cannot choose a default target from an empty target list.");
  }
  const requested = typeof requestedId === "string" ? requestedId.trim() : "";
  return targets.some(({ id }) => id === requested) ? requested : firstTarget.id;
}

export function normalizeModelMappings(value: unknown): ModelMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mappings: ModelMapping[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const listen = primitiveText(item["listen"]).trim();
    if (listen === "") {
      continue;
    }
    const configuredUpstream = item["upstream"] ? primitiveText(item["upstream"]).trim() : "";
    mappings.push({ listen, upstream: configuredUpstream || listen });
  }
  return mappings;
}

export function normalizeLogRoot(value: unknown, fallback: string | undefined): string {
  if (value === "") {
    return "";
  }
  const configured = primitiveText(value);
  return configured !== "" ? configured : (fallback ?? "");
}

export function runtimeLogRoot(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export function normalizeInjectRequestFields(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return primitiveText(value);
}

export function normalizeProxyConfigFile(
  value: unknown,
  defaultLogRoot = DEFAULT_LOG_ROOT,
): ProxyConfigFile {
  if (!isRecord(value) || !Array.isArray(value["pairs"])) {
    return validateProxyConfigFile(value);
  }
  const pairs = value["pairs"]
    .filter((pair) => isRecord(pair))
    .map((pair, index) => normalizeProxyPair(pair, index, defaultLogRoot));
  return validateProxyConfigFile({
    pairs,
    ...(value["summary_model"] === undefined ? {} : { summary_model: value["summary_model"] }),
  });
}

export function normalizeProxyPair(
  value: unknown,
  index: number,
  defaultLogRoot = DEFAULT_LOG_ROOT,
): ProxyPair {
  const raw = isRecord(value) ? value : {};
  const pairId = primitiveText(raw["id"]).trim() || `proxy-${index + 1}`;
  const rawTargets = Array.isArray(raw["targets"])
    ? raw["targets"]
        .filter((target) => isRecord(target))
        .map((target, targetIndex) => normalizeTargetConfig(target, targetIndex, defaultLogRoot))
    : [];
  const targets = ensureAtLeastOneTarget(rawTargets, defaultLogRoot);
  return {
    id: pairId,
    name: primitiveText(raw["name"]) || pairId,
    enabled: Boolean(raw["enabled"] ?? false),
    listen_host: primitiveText(raw["listen_host"]) || "127.0.0.1",
    listen_port: positiveNumber(raw["listen_port"], 1234),
    access_log: Boolean(raw["access_log"] ?? false),
    targets,
    default_target_id: normalizeDefaultTargetId(raw["default_target_id"], targets),
    load_balancers: normalizeLoadBalancerGroups(raw["load_balancers"]),
  };
}

export function normalizeTargetConfig(
  value: unknown,
  index: number,
  defaultLogRoot = DEFAULT_LOG_ROOT,
): TargetConfig {
  const raw = isRecord(value) ? value : {};
  const targetId = primitiveText(raw["id"]).trim() || `target-${index + 1}`;
  const rawHeaders = Array.isArray(raw["target_headers"])
    ? raw["target_headers"].map((header) => primitiveText(header)).filter((header) => header !== "")
    : [];
  return {
    id: targetId,
    name: primitiveText(raw["name"]) || targetId,
    enabled: raw["enabled"] === undefined ? true : Boolean(raw["enabled"]),
    target_url: primitiveText(raw["target_url"]).trim() || "http://127.0.0.1:1235",
    target_api_key: primitiveText(raw["target_api_key"]).trim(),
    target_headers: rawHeaders,
    strip_request_fields: primitiveText(raw["strip_request_fields"]),
    inject_request_fields: normalizeInjectRequestFields(raw["inject_request_fields"]),
    log_root: normalizeLogRoot(raw["log_root"], defaultLogRoot),
    redact_logs: Boolean(raw["redact_logs"] ?? false),
    model_mappings: normalizeModelMappings(raw["model_mappings"] ?? raw["models"]),
    model_prices: normalizeModelPrices(raw["model_prices"]),
  };
}

/**
 * Retain supplied values for schema validation. Unlike legacy model mappings,
 * pricing rules must never be silently discarded because an omitted price is
 * materially different from a zero price.
 */
export function normalizeModelPrices(value: unknown): ModelPrice[] {
  if (value === undefined) {
    return [];
  }
  return value as ModelPrice[];
}

/**
 * Fill in generated ids and defaults for load balancing groups. Unknown node
 * target ids and unknown strategy text are kept so schema validation can report
 * them with an exact path instead of silently dropping configuration.
 */
export function normalizeLoadBalancerGroups(value: unknown): LoadBalancerGroup[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return value as LoadBalancerGroup[];
  }
  return value.map((group, index) =>
    isRecord(group) ? normalizeLoadBalancerGroup(group, index) : (group as LoadBalancerGroup),
  );
}

function normalizeLoadBalancerMembers(value: Record<string, unknown>): LoadBalancerMember[] {
  const listed = value["members"];
  const legacy = value["node_target_ids"];
  const source: unknown[] = Array.isArray(listed)
    ? listed
    : // A group saved before per-node model ids existed listed only target ids.
      // Those ids become unmapped members, which forwards the requested model.
      Array.isArray(legacy)
      ? legacy.map((targetId: unknown) => ({ target_id: targetId, model_id: "" }))
      : legacy === undefined
        ? []
        : [{ target_id: legacy, model_id: "" }];
  const members: LoadBalancerMember[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const record: Record<string, unknown> = isRecord(item)
      ? item
      : { target_id: item, model_id: "" };
    const targetId = primitiveText(record["target_id"]).trim();
    // An empty id stays: the schema can then name the exact entry that is missing one.
    if (seen.has(targetId)) {
      continue;
    }
    seen.add(targetId);
    members.push({ target_id: targetId, model_id: primitiveText(record["model_id"]).trim() });
  }
  return members;
}

function normalizeLoadBalancerGroup(
  value: Record<string, unknown>,
  index: number,
): LoadBalancerGroup {
  const id = primitiveText(value["id"]).trim() || `lb-${index + 1}`;
  return {
    id,
    name: primitiveText(value["name"]) || id,
    enabled: value["enabled"] === undefined ? true : Boolean(value["enabled"]),
    model_pattern: primitiveText(value["model_pattern"]).trim(),
    members: normalizeLoadBalancerMembers(value),
    strategy: normalizeLoadBalancerStrategy(value["strategy"]),
    metrics_enabled:
      value["metrics_enabled"] === undefined ? true : Boolean(value["metrics_enabled"]),
    failover_enabled:
      value["failover_enabled"] === undefined ? true : Boolean(value["failover_enabled"]),
  };
}

function normalizeLoadBalancerStrategy(value: unknown): LoadBalancerStrategy {
  const text = primitiveText(value).trim();
  if (text === "" || text === "least_load") {
    return "least_load";
  }
  if (text === "round_robin") {
    return "round_robin";
  }
  // Any other text is handed to the schema, which rejects it with the group path.
  return text as LoadBalancerStrategy;
}

function primitiveText(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

function positiveNumber(value: unknown, fallback: number): number {
  const converted = typeof value === "number" ? value : Number(primitiveText(value));
  return Number.isFinite(converted) && converted > 0 ? converted : fallback;
}
