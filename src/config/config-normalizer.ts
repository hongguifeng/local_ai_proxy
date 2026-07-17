import type { TargetConfig } from "./config-schema.js";
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
