export type ApplicationState = "created" | "starting" | "running" | "stopping" | "stopped";

export class Application {
  #state: ApplicationState = "created";

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
    await Promise.resolve();
    this.#state = "running";
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
    await Promise.resolve();
    this.#state = "stopped";
  }
}
