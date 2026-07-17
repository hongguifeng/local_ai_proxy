import type { ProxyConfigFile } from "./config-schema.js";
import { proxyConfigFileSchema } from "./config-schema.js";

export interface ConfigFieldError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigFieldError[];

  constructor(issues: readonly ConfigFieldError[]) {
    super(
      `Invalid proxy configuration (${issues.length} field error${issues.length === 1 ? "" : "s"}).`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function validateProxyConfigFile(value: unknown): ProxyConfigFile {
  const result = proxyConfigFileSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new ConfigValidationError(
    result.error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.map(formatPathSegment).join("."),
    })),
  );
}

function formatPathSegment(value: PropertyKey): string {
  if (typeof value === "symbol") {
    return value.description ?? "symbol";
  }
  return String(value);
}
