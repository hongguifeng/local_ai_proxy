import { isRecord } from "../shared/index.js";

import type { ModelMapping, TargetConfig } from "./config-schema.js";
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

function primitiveText(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}
