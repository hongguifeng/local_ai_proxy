import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ProxyConfigFile } from "./config-schema.js";
import { normalizeProxyConfigFile } from "./config-normalizer.js";
import { ConfigValidationError, type ConfigFieldError } from "./config-validation.js";
import { createDefaultProxyPair, DEFAULT_LOG_ROOT } from "./defaults.js";

export type ConfigLoadErrorKind = "invalid_json" | "invalid_schema";

export interface ConfigFileSystem {
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly readFile: typeof readFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
}

export interface ConfigRepositoryOptions {
  readonly createId?: () => string;
  readonly fileSystem?: ConfigFileSystem;
}

const DEFAULT_FILE_SYSTEM: ConfigFileSystem = { mkdir, open, readFile, rename, unlink };

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
  readonly #createId: () => string;
  readonly #defaultLogRoot: string;
  readonly #fileSystem: ConfigFileSystem;

  constructor(
    configPath: string,
    defaultLogRoot = DEFAULT_LOG_ROOT,
    options: ConfigRepositoryOptions = {},
  ) {
    this.#configPath = configPath;
    this.#createId = options.createId ?? randomUUID;
    this.#defaultLogRoot = defaultLogRoot;
    this.#fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  }

  async load(): Promise<ProxyConfigFile> {
    let text: string;
    try {
      text = await this.#fileSystem.readFile(this.#configPath, "utf8");
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

  async save(value: ProxyConfigFile): Promise<void> {
    const config = normalizeProxyConfigFile(value, this.#defaultLogRoot);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    await this.#writeThroughSiblingTempFile(text);
  }

  async #writeThroughSiblingTempFile(text: string): Promise<void> {
    const directory = path.dirname(this.#configPath);
    const tempPath = path.join(
      directory,
      `.${path.basename(this.#configPath)}.${this.#createId()}.tmp`,
    );
    await this.#fileSystem.mkdir(directory, { recursive: true });
    let handle: FileHandle | undefined;
    try {
      handle = await this.#fileSystem.open(tempPath, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fileSystem.rename(tempPath, this.#configPath);
    } catch (error) {
      await closeQuietly(handle);
      await this.#fileSystem.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  await handle.close().catch(() => undefined);
}
