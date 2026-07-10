import { chmod, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AtomicWriteOperations = Readonly<{
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
  chmod: typeof chmod;
}>;

const DEFAULT_OPERATIONS: AtomicWriteOperations = { open, rename, unlink, chmod };

export class AtomicWriteError extends Error {
  public readonly code: string;
  public readonly targetPath: string;

  public constructor(code: string, targetPath: string, cause: unknown) {
    super(`Atomic configuration write failed (${code})`, { cause });
    this.name = "AtomicWriteError";
    this.code = code;
    this.targetPath = targetPath;
  }
}

export async function atomicWriteText(
  targetPath: string,
  contents: string,
  operationOverrides: Partial<AtomicWriteOperations> = {},
): Promise<void> {
  const operations = { ...DEFAULT_OPERATIONS, ...operationOverrides };
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await operations.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.chmod(temporaryPath, 0o600);
    await operations.rename(temporaryPath, targetPath);
    renamed = true;
    await operations.chmod(targetPath, 0o600);
    await syncDirectory(dirname(targetPath), operations);
  } catch (error) {
    throw new AtomicWriteError(errorCode(error), targetPath, error);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!renamed) {
      await operations.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function syncDirectory(directory: string, operations: AtomicWriteOperations): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await operations.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return process.platform === "win32" && new Set(["EACCES", "EINVAL", "EPERM"]).has(errorCode(error));
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}
