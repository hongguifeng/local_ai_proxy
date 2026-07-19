import { unwatchFile, watchFile } from "node:fs";
import path from "node:path";

export function installSmokeExitSignal(
  configuredPath: string | undefined,
  exit: () => Promise<void>,
  interval = 100,
): () => void {
  const value = configuredPath?.trim();
  if (!value) return () => undefined;
  const resolved = path.resolve(value);
  let triggered = false;
  const listener = (current: { isFile(): boolean }): void => {
    if (triggered || !current.isFile()) return;
    triggered = true;
    unwatchFile(resolved, listener);
    void exit();
  };
  watchFile(resolved, { interval }, listener);
  return () => unwatchFile(resolved, listener);
}
