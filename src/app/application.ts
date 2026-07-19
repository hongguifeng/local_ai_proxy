export type ApplicationState = "created" | "starting" | "running" | "stopping" | "stopped";

export interface ApplicationLifecycle {
  readonly start?: () => Promise<void> | void;
  readonly stop?: () => Promise<void> | void;
}

export class Application {
  readonly #lifecycle: ApplicationLifecycle;
  #state: ApplicationState = "created";

  constructor(lifecycle: ApplicationLifecycle = {}) {
    this.#lifecycle = lifecycle;
  }

  get state(): ApplicationState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state === "running") {
      return;
    }
    if (this.#state !== "created" && this.#state !== "stopped") {
      throw new Error(`Cannot start application while state is ${this.#state}.`);
    }
    this.#state = "starting";
    try {
      await this.#lifecycle.start?.();
      this.#state = "running";
    } catch (error) {
      this.#state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "created" || this.#state === "stopped") {
      this.#state = "stopped";
      return;
    }
    if (this.#state !== "running") {
      throw new Error(`Cannot stop application while state is ${this.#state}.`);
    }
    this.#state = "stopping";
    try {
      await this.#lifecycle.stop?.();
    } finally {
      this.#state = "stopped";
    }
  }
}
