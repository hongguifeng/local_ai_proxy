import type { TargetConfig } from "./config-schema.js";
import { createDefaultTarget, DEFAULT_LOG_ROOT } from "./defaults.js";

export function ensureAtLeastOneTarget(
  targets: readonly TargetConfig[],
  logRoot = DEFAULT_LOG_ROOT,
): TargetConfig[] {
  return targets.length > 0 ? [...targets] : [createDefaultTarget(logRoot)];
}
