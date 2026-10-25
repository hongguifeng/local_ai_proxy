import { isRecord } from "../shared/index.js";

export type JsonConfigValue =
  null | boolean | number | string | JsonConfigValue[] | JsonConfigObject;

export interface JsonConfigObject extends Record<string, JsonConfigValue> {
  readonly __jsonConfigObjectBrand?: never;
}

/** Internal metadata keeps legacy keys separate from the modeled configuration fields. */
export const PRESERVED_CONFIG_FIELDS = Symbol("preservedConfigFields");

export interface PreservedConfigFields {
  readonly [PRESERVED_CONFIG_FIELDS]?: Readonly<Record<string, JsonConfigValue>>;
}

export const PAIR_CONFIG_KEYS = [
  "id",
  "name",
  "enabled",
  "listen_host",
  "listen_port",
  "access_log",
  "targets",
  "default_target_id",
  "load_balancers",
] as const;

export const TARGET_CONFIG_KEYS = [
  "id",
  "name",
  "enabled",
  "target_url",
  "target_api_key",
  "target_headers",
  "strip_request_fields",
  "inject_request_fields",
  "log_root",
  "redact_logs",
  "model_mappings",
  "model_prices",
] as const;

/** Keys maintained by the control plane or UI and never written to proxies.json. */
export const CONTROL_PLANE_CONFIG_KEYS = [
  "running",
  "actual_listen_port",
  "expanded",
  "prices_expanded",
  "price_test_model",
  "catalog_rate",
] as const;

export function preserveUnknownConfigFields<T extends object>(
  normalized: T,
  source: unknown,
  modeledKeys: readonly string[],
): T {
  const fields: Record<string, JsonConfigValue> = {
    ...preservedConfigFields(normalized),
    ...preservedConfigFields(source),
  };
  const modeled = new Set(modeledKeys);
  if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (!modeled.has(key) && !CONTROL_PLANE_CONFIG_KEYS.includes(key as never)) {
        if (isJsonConfigValue(value)) {
          fields[key] = value;
        }
      }
    }
  }
  if (Object.keys(fields).length === 0) {
    return normalized;
  }
  Object.defineProperty(normalized, PRESERVED_CONFIG_FIELDS, {
    configurable: true,
    enumerable: false,
    value: fields,
    writable: false,
  });
  return normalized;
}

export function preservedConfigFields(value: unknown): Readonly<Record<string, JsonConfigValue>> {
  if (!isRecord(value)) {
    return {};
  }
  const fields = (value as PreservedConfigFields)[PRESERVED_CONFIG_FIELDS];
  return fields ?? {};
}

export function isJsonConfigValue(value: unknown): value is JsonConfigValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonConfigValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonConfigValue);
}

export function preserveConfigFileFields<T extends { readonly pairs: readonly object[] }>(
  normalized: T,
  source: unknown,
): T {
  const sourcePairsValue = isRecord(source) ? source["pairs"] : undefined;
  const sourcePairs: unknown[] = Array.isArray(sourcePairsValue)
    ? (sourcePairsValue as unknown[])
    : [];
  const pairs = normalized.pairs.map((pair, pairIndex) => {
    const sourcePair = sourcePairs[pairIndex];
    const preservedPair = preserveUnknownConfigFields(pair, sourcePair, PAIR_CONFIG_KEYS);
    const targets = getTargets(pair).map((target, targetIndex) => {
      const sourceTargets =
        isRecord(sourcePair) && Array.isArray(sourcePair["targets"]) ? sourcePair["targets"] : [];
      return preserveUnknownConfigFields(target, sourceTargets[targetIndex], TARGET_CONFIG_KEYS);
    });
    Object.assign(preservedPair, { targets });
    return preservedPair;
  });
  return { ...normalized, pairs };
}

function getTargets(value: object): readonly object[] {
  const targets = (value as { readonly targets?: unknown }).targets;
  return Array.isArray(targets) ? targets.filter(isObject) : [];
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
