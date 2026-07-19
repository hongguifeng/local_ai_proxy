import path from "node:path";

export function resolveConfiguredPath(value: string, cwd = process.cwd()): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  return path.resolve(cwd, trimmed);
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
