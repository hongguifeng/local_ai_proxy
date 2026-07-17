import { readFile } from "node:fs/promises";

import type { ProxyConfigFile } from "./config-schema.js";
import { normalizeProxyConfigFile } from "./config-normalizer.js";
import { createDefaultProxyPair, DEFAULT_LOG_ROOT } from "./defaults.js";

export class ConfigRepository {
  readonly #configPath: string;
  readonly #defaultLogRoot: string;

  constructor(configPath: string, defaultLogRoot = DEFAULT_LOG_ROOT) {
    this.#configPath = configPath;
    this.#defaultLogRoot = defaultLogRoot;
  }

  async load(): Promise<ProxyConfigFile> {
    try {
      const text = await readFile(this.#configPath, "utf8");
      const value: unknown = JSON.parse(text);
      return normalizeProxyConfigFile(value, this.#defaultLogRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { pairs: [createDefaultProxyPair(this.#defaultLogRoot)] };
      }
      throw error;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
