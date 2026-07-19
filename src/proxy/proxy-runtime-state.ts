export type ProxyRuntimeState = "failed" | "running" | "starting" | "stopped" | "stopping";

export interface ProxyRuntimeSnapshot {
  readonly actualListenPort: number | null;
  readonly error: Error | undefined;
  readonly running: boolean;
  readonly state: ProxyRuntimeState;
}

export class ProxyRuntimeStateMachine {
  #actualListenPort: number | null = null;
  #error: Error | undefined;
  #state: ProxyRuntimeState = "stopped";

  get snapshot(): ProxyRuntimeSnapshot {
    return {
      actualListenPort: this.#actualListenPort,
      error: this.#error,
      running: this.#state === "running",
      state: this.#state,
    };
  }

  beginStart(): void {
    this.#transition(["failed", "stopped"], "starting");
    this.#actualListenPort = null;
    this.#error = undefined;
  }

  markRunning(actualListenPort: number): void {
    if (!Number.isInteger(actualListenPort) || actualListenPort < 1 || actualListenPort > 65_535) {
      throw new RangeError("Actual listen port must be an integer between 1 and 65535.");
    }
    this.#transition(["starting"], "running");
    this.#actualListenPort = actualListenPort;
    this.#error = undefined;
  }

  markStartFailed(error: unknown): void {
    this.#transition(["starting"], "failed");
    this.#actualListenPort = null;
    this.#error = normalizeError(error);
  }

  beginStop(): void {
    this.#transition(["failed", "running"], "stopping");
  }

  markStopped(): void {
    this.#transition(["stopping"], "stopped");
    this.#actualListenPort = null;
    this.#error = undefined;
  }

  markStopFailed(error: unknown): void {
    this.#transition(["stopping"], "failed");
    this.#actualListenPort = null;
    this.#error = normalizeError(error);
  }

  #transition(allowed: readonly ProxyRuntimeState[], next: ProxyRuntimeState): void {
    if (!allowed.includes(this.#state)) {
      throw new Error(`Cannot transition proxy runtime from ${this.#state} to ${next}.`);
    }
    this.#state = next;
  }
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
