import type { Application } from "../app/index.js";

export interface SignalProcess {
  off(event: NodeJS.Signals, listener: () => void): unknown;
  on(event: NodeJS.Signals, listener: () => void): unknown;
}

export function installShutdownSignals(
  application: Application,
  signalProcess: SignalProcess = process,
  onError: (error: unknown) => void = console.error,
): () => void {
  let stopping = false;
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      if (stopping) return;
      stopping = true;
      void application.stop().catch(onError).finally(remove);
    };
    listeners.set(signal, listener);
    signalProcess.on(signal, listener);
  }
  function remove(): void {
    for (const [signal, listener] of listeners) signalProcess.off(signal, listener);
    listeners.clear();
  }
  return remove;
}
