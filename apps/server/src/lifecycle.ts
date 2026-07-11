import type { CliOptions } from "./cli-options.js";

export type ApplicationRuntime = Readonly<{
  start: (signal: AbortSignal) => Promise<void>;
  wait: (signal: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
}>;

export type SignalSource = Readonly<{
  once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  off: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}>;

export type FatalSource = Readonly<{
  once: (event: "uncaughtException" | "unhandledRejection", listener: () => void) => unknown;
  off: (event: "uncaughtException" | "unhandledRejection", listener: () => void) => unknown;
}>;

export function createScaffoldRuntime(options: CliOptions): ApplicationRuntime {
  void options;
  return {
    start: () => Promise.resolve(),
    async wait(signal): Promise<void> {
      await waitForAbort(signal);
    },
    stop: () => Promise.resolve(),
  };
}

export function installShutdownHooks(controller: AbortController, source: SignalSource = process): () => void {
  const abort = (): void => {
    controller.abort();
  };
  source.once("SIGINT", abort);
  source.once("SIGTERM", abort);
  return () => {
    source.off("SIGINT", abort);
    source.off("SIGTERM", abort);
  };
}

export function installFatalHooks(controller: AbortController, source: FatalSource = process): () => void {
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  source.once("uncaughtException", abort);
  source.once("unhandledRejection", abort);
  return () => {
    source.off("uncaughtException", abort);
    source.off("unhandledRejection", abort);
  };
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
