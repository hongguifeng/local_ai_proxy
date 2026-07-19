export type ShutdownTask = (reason: string) => Promise<void> | void;

interface RegisteredShutdownTask {
  readonly id: symbol;
  readonly name: string;
  readonly task: ShutdownTask;
}

export class ShutdownCoordinator {
  readonly #tasks: RegisteredShutdownTask[] = [];
  #shutdownPromise: Promise<void> | undefined;

  get shuttingDown(): boolean {
    return this.#shutdownPromise !== undefined;
  }

  register(name: string, task: ShutdownTask): () => void {
    if (this.shuttingDown) {
      throw new Error(`Cannot register shutdown task ${name} after shutdown started.`);
    }
    const registered = { id: Symbol(name), name, task };
    this.#tasks.push(registered);
    return () => {
      const index = this.#tasks.findIndex(({ id }) => id === registered.id);
      if (index >= 0) {
        this.#tasks.splice(index, 1);
      }
    };
  }

  shutdown(reason = "shutdown"): Promise<void> {
    this.#shutdownPromise ??= this.#run(reason);
    return this.#shutdownPromise;
  }

  async #run(reason: string): Promise<void> {
    const errors: Error[] = [];
    for (const registered of [...this.#tasks].reverse()) {
      try {
        await registered.task(reason);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.#tasks.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, `Shutdown failed in ${errors.length} task(s).`);
    }
  }
}
