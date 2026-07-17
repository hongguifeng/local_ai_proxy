import { readFile } from "node:fs/promises";

import type { ProxyConfigFile } from "./config-schema.js";
import { normalizeProxyConfigFile } from "./config-normalizer.js";
import { ConfigValidationError, type ConfigFieldError } from "./config-validation.js";
import { createDefaultProxyPair, DEFAULT_LOG_ROOT } from "./defaults.js";

export type ConfigLoadErrorKind = "invalid_json" | "invalid_schema";

export class ConfigLoadError extends Error {
  readonly configPath: string;
  readonly issues: readonly ConfigFieldError[] | undefined;
  readonly kind: ConfigLoadErrorKind;

  constructor(
    kind: ConfigLoadErrorKind,
    configPath: string,
    options: { cause: unknown; issues?: readonly ConfigFieldError[] },
  ) {
    super(
      kind === "invalid_json"
        ? `Config file is not valid JSON: ${configPath}`
        : `Config file has an invalid schema: ${configPath}`,
      { cause: options.cause },
    );
    this.name = "ConfigLoadError";
    this.configPath = configPath;
    this.issues = options.issues;
    this.kind = kind;
  }
}

export class ConfigRepository {
  readonly #configPath: string;
  readonly #defaultLogRoot: string;

  constructor(configPath: string, defaultLogRoot = DEFAULT_LOG_ROOT) {
    this.#configPath = configPath;
    this.#defaultLogRoot = defaultLogRoot;
  }

  async load(): Promise<ProxyConfigFile> {
    let text: string;
    try {
      text = await readFile(this.#configPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { pairs: [createDefaultProxyPair(this.#defaultLogRoot)] };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ConfigLoadError("invalid_json", this.#configPath, { cause: error });
    }

    try {
      return normalizeProxyConfigFile(value, this.#defaultLogRoot);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw new ConfigLoadError("invalid_schema", this.#configPath, {
          cause: error,
          issues: error.issues,
        });
      }
      throw error;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
