import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { atomicWriteText, AtomicWriteError } from "./atomic-write.js";
import { ConfigValidationError, parsePersistedConfig, type PersistedConfig } from "./schema.js";

export const DEFAULT_MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

export type AtomicConfigWriter = (path: string, contents: string) => Promise<void>;

export type ConfigRepositoryOptions = Readonly<{
  maxFileBytes?: number;
  atomicWriter?: AtomicConfigWriter;
}>;

export class ConfigFileError extends Error {
  public readonly code: string;
  public readonly configPath: string;

  public constructor(code: string, configPath: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConfigFileError";
    this.code = code;
    this.configPath = configPath;
  }
}

export class ConfigRepository {
  readonly #configPath: string;
  readonly #maxFileBytes: number;
  readonly #atomicWriter: AtomicConfigWriter;
  #saveTail: Promise<void> = Promise.resolve();

  public constructor(configPath: string, options: ConfigRepositoryOptions = {}) {
    this.#configPath = configPath;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_CONFIG_FILE_BYTES;
    this.#atomicWriter = options.atomicWriter ?? atomicWriteText;
  }

  public async load(): Promise<PersistedConfig> {
    let handle;
    try {
      handle = await open(this.#configPath, "r");
      const metadata = await handle.stat();
      if (metadata.size > this.#maxFileBytes) {
        throw this.#fileTooLarge(metadata.size);
      }
      const contents = await handle.readFile();
      if (contents.byteLength > this.#maxFileBytes) {
        throw this.#fileTooLarge(contents.byteLength);
      }
      let input: unknown;
      try {
        input = JSON.parse(contents.toString("utf8"));
      } catch (error) {
        throw new ConfigFileError("INVALID_JSON", this.#configPath, "Configuration file is not valid JSON", error);
      }
      return parsePersistedConfig(input);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return parsePersistedConfig({ version: 1 });
      }
      if (error instanceof ConfigFileError || error instanceof ConfigValidationError) {
        throw error;
      }
      throw new ConfigFileError(
        "READ_FAILED",
        this.#configPath,
        `Could not read configuration (${errorCode(error)})`,
        error,
      );
    } finally {
      await handle?.close();
    }
  }

  public save(input: unknown): Promise<void> {
    const operation = this.#saveTail.then(async () => {
      const config = parsePersistedConfig(input);
      await mkdir(dirname(this.#configPath), { recursive: true });
      const contents = `${JSON.stringify(config, null, 2)}\n`;
      try {
        await this.#atomicWriter(this.#configPath, contents);
      } catch (error) {
        const code = error instanceof AtomicWriteError ? error.code : errorCode(error);
        throw new ConfigFileError(
          "WRITE_FAILED",
          this.#configPath,
          `Could not replace configuration file (${code})`,
          error,
        );
      }
    });
    this.#saveTail = operation.catch(() => undefined);
    return operation;
  }

  #fileTooLarge(actualBytes: number): ConfigFileError {
    return new ConfigFileError(
      "FILE_TOO_LARGE",
      this.#configPath,
      `Configuration file exceeds ${this.#maxFileBytes.toString()} bytes (actual: ${actualBytes.toString()})`,
    );
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}
